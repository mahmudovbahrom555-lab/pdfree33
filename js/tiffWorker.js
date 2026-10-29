// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  tiffWorker.js — TIFF → PDF without re-encoding where PDF allows it
//
//  Chrome, Edge and Firefox can't decode TIFF (Safari only), and a
//  scanner's or fax's TIFF often holds many pages — "TIF转PDF" was a real
//  on-site search that found nothing (2026-10). Decoding every page and
//  re-encoding it as JPEG made a black-and-white fax page ~13× bigger and
//  blurry (113 KB of G4 → 1.5 MB of JPEG, A4 at 300 dpi), so each page
//  goes into the PDF the way libtiff's tiff2pdf and img2pdf do it:
//
//    - single-strip CCITT G4: its bytes as they are (CCITTFaxDecode)
//    - single-strip JPEG: its bytes as they are (DCTDecode), shared
//      JPEGTables spliced in after SOI — no second compression
//    - anything else is decoded (UTIF.js) and stored losslessly — 1-bit
//      Flate for black-and-white, 8-bit Flate for grey/colour — or as
//      JPEG when "compress" is on, the same choice Images → PDF offers
//
//  Page size comes from the file's own resolution, X and Y separately
//  (a fax at 204 × 98 dpi is an A4 page, not a squashed one); the
//  Orientation tag is applied by the PDF placement, never to the pixels.
//  A4 / Letter / Fit and orientation follow js/worker.js's handleJpg2Pdf
//  placement exactly (worker.js is off-limits, so mirrored, not shared —
//  tests/e2e/jpg2pdf-tiff.e2e.mjs compares the two).
//
//  In:  { type: 'preview', buffer }            → { page: Blob (PNG) | null }
//       { type: 'pdf', files: ArrayBuffer[], options }
//                                              → progress…, { pdfs: [ArrayBuffer|null], pageCount, skipped }
//       { type: 'merge', pdfs: ArrayBuffer[] }  → { pdfs: [ArrayBuffer], pageCount }
//       a failure                              → { type: 'error', error }
// ============================================================

importScripts('./vendor/pako_inflate.min.js', './vendor/UTIF.js', './vendor/pdf-lib.min.js');

const { PDFDocument, PDFName, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = PDFLib;

// same numbers as js/worker.js
const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
const MAX_PT = 14400;                       // largest page a PDF reader accepts

const tag = (ifd, t) => (ifd['t' + t] ? ifd['t' + t][0] : undefined);

// The document's pages: the main IFD chain, without thumbnails or
// reduced-resolution copies (NewSubfileType bit 0).
function pagesOf(buffer) {
  const ifds = UTIF.decode(buffer);
  return { ifds, pages: ifds.filter(ifd => !((tag(ifd, 254) || 0) & 1) && tag(ifd, 256) && tag(ifd, 257)) };
}

// physical size in points: X and Y resolution apply separately (fax 204 × 98)
function physicalSize(ifd) {
  const w = tag(ifd, 256), h = tag(ifd, 257);
  const unit = tag(ifd, 296) ?? 2;                  // 1 none, 2 inch, 3 cm
  const ok = r => Number.isFinite(r) && r >= 1 && r <= 10000;
  let xr = tag(ifd, 282), yr = tag(ifd, 283);
  if (unit === 3) { xr *= 2.54; yr *= 2.54; }
  if (unit === 1 || (!ok(xr) && !ok(yr))) return [w, h];   // no resolution: 1 px = 1 pt, as for a JPG
  if (!ok(xr)) xr = yr;
  if (!ok(yr)) yr = xr;
  let pw = w * 72 / xr, ph = h * 72 / yr;
  const s = Math.min(1, MAX_PT / Math.max(pw, ph));
  return [pw * s, ph * s];
}

// ── the image XObject for one page ──────────────────────────────────────
function stripBytes(buffer, ifd) {
  const offs = ifd.t273, cnts = ifd.t279;
  if (!offs || !cnts || offs.length !== 1 || ifd.t322) return null;   // tiled or multi-strip
  return new Uint8Array(buffer, offs[0], cnts[0]).slice();
}
const REV = new Uint8Array(256).map((_, i) => { let r = 0; for (let b = 0; b < 8; b++) if (i & (1 << b)) r |= 0x80 >> b; return r; });

function passthroughCcitt(buffer, ifd) {
  if (tag(ifd, 259) !== 4 || (tag(ifd, 258) ?? 1) !== 1 || (tag(ifd, 277) ?? 1) !== 1) return null;
  const photo = tag(ifd, 262);
  if (photo !== 0 && photo !== 1) return null;
  if ((tag(ifd, 293) || 0) & 2) return null;        // uncompressed mode inside G4: decode instead
  const bytes = stripBytes(buffer, ifd);
  if (!bytes) return null;
  if (tag(ifd, 266) === 2) for (let i = 0; i < bytes.length; i++) bytes[i] = REV[bytes[i]];
  const w = tag(ifd, 256), h = tag(ifd, 257);
  // PDF's decoder gives black runs as 0 (BlackIs1 false); a BlackIsZero TIFF
  // stored its picture with the colours the other way round — checked
  // pixel for pixel against libtiff in MuPDF, poppler and PDFium.
  return {
    bytes, dict: {
      Width: w, Height: h, BitsPerComponent: 1, ColorSpace: 'DeviceGray', Filter: 'CCITTFaxDecode',
      DecodeParms: { K: -1, Columns: w, Rows: h }, ...(photo === 1 ? { Decode: [1, 0] } : {}),
    },
  };
}

// SOI + the TIFF's shared JPEGTables (DQT/DHT…, without their own SOI/EOI) + the rest
function withTables(bytes, ifd) {
  const tables = ifd.t347;
  if (!tables || tables.length <= 4) return bytes;
  const t = Uint8Array.from(tables), end = t[t.length - 2] === 0xFF && t[t.length - 1] === 0xD9 ? t.length - 2 : t.length;
  const inner = t.subarray(2, end), out = new Uint8Array(bytes.length + inner.length);
  out.set(bytes.subarray(0, 2)); out.set(inner, 2); out.set(bytes.subarray(2), 2 + inner.length);
  return out;
}

function passthroughJpeg(buffer, ifd) {
  if (tag(ifd, 259) !== 7 || (tag(ifd, 258) ?? 8) !== 8) return null;
  const spp = tag(ifd, 277) ?? 1, photo = tag(ifd, 262);
  const gray = spp === 1 && (photo === 1 || photo === 0);
  const rgb = spp === 3 && (photo === 6 || photo === 2) && (tag(ifd, 284) ?? 1) === 1;
  if (!gray && !rgb) return null;                    // CMYK, alpha, planar: decode instead
  const strip = stripBytes(buffer, ifd);
  if (!strip || strip[0] !== 0xFF || strip[1] !== 0xD8) return null;
  const bytes = withTables(strip, ifd);
  return {
    bytes, dict: {
      Width: tag(ifd, 256), Height: tag(ifd, 257), BitsPerComponent: 8,
      ColorSpace: gray ? 'DeviceGray' : 'DeviceRGB', Filter: 'DCTDecode',
      // RGB-coded JPEG (Photometric 2) carries no YCbCr transform
      ...(rgb && photo === 2 ? { DecodeParms: { ColorTransform: 0 } } : {}),
      ...(gray && photo === 0 ? { Decode: [1, 0] } : {}),
    },
  };
}

// PlanarConfiguration 2 (each colour in its own strips): UTIF.js places the
// strips as if interleaved and runs its Predictor over 3 channels, so a
// planar page came out red-only. Each strip is unpacked here as a 1-channel
// image (same decompressor, Predictor per plane) into its own plane.
function planarRGBA(buffer, ifd, ifds) {
  const w = tag(ifd, 256), h = tag(ifd, 257), spp = tag(ifd, 277) ?? 1, photo = tag(ifd, 262);
  const bps = tag(ifd, 258) ?? 8;
  if ((bps !== 8 && bps !== 16) || ifd.t322 || spp > 4 || photo === 5 || (tag(ifd, 339) ?? 1) !== 1) throw new Error('planar layout not supported');
  const rps = Math.min(tag(ifd, 278) ?? h, h), per = Math.ceil(h / rps), n = w * h;
  const B = bps / 8, raw = new Uint8Array(n * spp * B), one = { ...ifd, width: w, height: h, t277: [1], t258: [bps] }, data = new Uint8Array(buffer);
  ifd.t273.forEach((off, i) => {
    UTIF.decode._decompress(one, ifds, data, off, ifd.t279[i], tag(ifd, 259) ?? 1, raw,
      (Math.floor(i / per) * n + (i % per) * rps * w) * B, tag(ifd, 266) ?? 1);
  });
  const planes = B === 1 ? raw : raw.filter((_, i) => i % 2 === 1);   // 16-bit: the high byte (little-endian)
  const rgba = new Uint8Array(n * 4), color = spp >= 3, alpha = spp === 2 || spp === 4;
  for (let i = 0; i < n; i++) {
    const v = planes[i], o = i * 4;
    rgba[o] = v;
    rgba[o + 1] = color ? planes[n + i] : v;
    rgba[o + 2] = color ? planes[2 * n + i] : v;
    rgba[o + 3] = alpha ? planes[(spp - 1) * n + i] : 255;
    if (!color && photo === 0) rgba[o] = rgba[o + 1] = rgba[o + 2] = 255 - v;
  }
  return rgba;
}

// A JPEG TIFF in several strips or tiles (can't go in as one DCT stream):
// each piece decoded by the browser's own JPEG decoder — UTIF.js's turned an
// RGB-coded one (Photometric 2) into wrong colours, mean error 79/255. JPEG
// readers take three components for YCbCr unless an Adobe marker says
// otherwise, so an RGB-coded piece gets one (APP14, transform 0).
const ADOBE_RGB = Uint8Array.of(0xFF, 0xEE, 0, 14, 0x41, 0x64, 0x6F, 0x62, 0x65, 0, 100, 0, 0, 0, 0, 0);
async function jpegPiecesRGBA(buffer, ifd) {
  const w = tag(ifd, 256), h = tag(ifd, 257), photo = tag(ifd, 262);
  const tiled = !!ifd.t322, pw = tiled ? tag(ifd, 322) : w, ph = tiled ? tag(ifd, 323) : Math.min(tag(ifd, 278) ?? h, h);
  const across = Math.ceil(w / pw), offs = tiled ? ifd.t324 : ifd.t273, cnts = tiled ? ifd.t325 : ifd.t279;
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
  for (let i = 0; i < offs.length; i++) {
    let bytes = withTables(new Uint8Array(buffer, offs[i], cnts[i]), ifd);
    if (photo === 2) {
      const b = new Uint8Array(bytes.length + ADOBE_RGB.length);
      b.set(bytes.subarray(0, 2)); b.set(ADOBE_RGB, 2); b.set(bytes.subarray(2), 2 + ADOBE_RGB.length);
      bytes = b;
    }
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    g.drawImage(bmp, (i % across) * pw, Math.floor(i / across) * ph);
    bmp.close();
  }
  return new Uint8Array(g.getImageData(0, 0, w, h).data.buffer);
}

// Decoded samples → RGBA, for exactly the layouts checked against libtiff
// (tests/fixtures/tiff + libtiff's own test images). UTIF.js's toRGBA8
// returned a black or wrong picture, silently, for the rest — 4-bit grey,
// 2/4-bit palettes, 16-bit CMYK, YCbCr without JPEG — so anything not
// listed here is refused: the file is reported, never a wrong page.
function toRGBA(ifd, data) {
  const w = tag(ifd, 256), h = tag(ifd, 257), n = w * h;
  const photo = tag(ifd, 262), bps = tag(ifd, 258) ?? 1, spp = tag(ifd, 277) ?? 1;
  if ((tag(ifd, 339) ?? 1) !== 1) throw new Error('unsupported sample format');
  const gray = photo === 0 || photo === 1, rgb = photo === 2, pal = photo === 3, cmyk = photo === 5;
  const colours = gray || pal ? 1 : rgb ? 3 : cmyk ? 4 : 0;
  const ok = colours && spp >= colours && spp <= colours + 1 &&
    (gray ? [1, 2, 4, 8, 16].includes(bps) : pal ? [1, 2, 4, 8].includes(bps) : [8, 16].includes(bps));
  if (!ok) throw new Error(`unsupported layout: photometric ${photo}, ${spp} × ${bps} bit`);
  const bpl = Math.ceil(w * spp * bps / 8), max = (1 << Math.min(bps, 8)) - 1;
  // sample k of pixel x on row y, scaled to 0–255 (16-bit: its high byte, little-endian after UTIF.js)
  const at = (y, x, k) => {
    const i = x * spp + k;
    if (bps === 16) return data[y * bpl + 2 * i + 1];
    if (bps === 8) return data[y * bpl + i];
    const bit = i * bps;
    return (data[y * bpl + (bit >> 3)] >> (8 - bps - (bit & 7))) & max;
  };
  const map = ifd.t320, assoc = (tag(ifd, 338) ?? 0) === 1, rgba = new Uint8Array(n * 4);
  for (let y = 0, o = 0; y < h; y++) for (let x = 0; x < w; x++, o += 4) {
    let r, g, b, a = spp > colours ? at(y, x, colours) : 255;
    if (gray) { const v = at(y, x, 0) * 255 / max; r = g = b = photo === 0 ? 255 - v : v; }
    else if (pal) { const k = at(y, x, 0), m = 1 << bps; r = map[k] >> 8; g = map[m + k] >> 8; b = map[2 * m + k] >> 8; }
    else if (rgb) { r = at(y, x, 0); g = at(y, x, 1); b = at(y, x, 2); }
    else { const k = 255 - at(y, x, 3); r = (255 - at(y, x, 0)) * k / 255; g = (255 - at(y, x, 1)) * k / 255; b = (255 - at(y, x, 2)) * k / 255; }
    if (a < 255) {                                   // onto white paper; associated alpha is premultiplied already
      const f = assoc ? 1 : a / 255;
      r = r * f + 255 - a; g = g * f + 255 - a; b = b * f + 255 - a;
    }
    rgba[o] = Math.round(r); rgba[o + 1] = Math.round(g); rgba[o + 2] = Math.round(b); rgba[o + 3] = 255;
  }
  return rgba;
}

async function rgbaOf(buffer, ifd, ifds) {
  const cmpr = tag(ifd, 259) ?? 1;
  if (cmpr === 7 && [1, 2, 6].includes(tag(ifd, 262)) && tag(ifd, 284) !== 2) return jpegPiecesRGBA(buffer, ifd);
  if (tag(ifd, 262) === 6) throw new Error('YCbCr without JPEG');
  if (![1, 2, 3, 4, 5, 8, 32773, 32946].includes(cmpr)) throw new Error(`compression ${cmpr}`);
  // Old-style LZW (libtiff before 5.0, other bit order) sent UTIF.js's LZW
  // decoder into an endless loop — libtiff's own test: 0x00 then an odd byte.
  const s0 = (ifd.t273 || ifd.t324 || [])[0];
  if (cmpr === 5 && s0 != null && new Uint8Array(buffer, s0, 2).every((v, i) => (i ? v & 1 : v === 0))) throw new Error('old-style LZW');
  if (tag(ifd, 284) === 2) return planarRGBA(buffer, ifd, ifds);
  UTIF.decodeImage(buffer, ifd, ifds);
  const rgba = toRGBA(ifd, ifd.data);
  ifd.data = null;
  return rgba;
}

// anything else: decode, then lossless Flate (or JPEG when compressing grey/colour)
async function decoded(buffer, ifd, ifds, { compress, quality }) {
  const rgba = await rgbaOf(buffer, ifd, ifds);
  const w = tag(ifd, 256), h = tag(ifd, 257);
  const n = w * h;
  let bilevel = true, gray = true;
  for (let i = 0; i < n; i++) {
    const o = i * 4, a = rgba[o + 3];
    if (a < 255) {                                    // transparency: onto white paper
      for (let k = 0; k < 3; k++) rgba[o + k] = Math.round(rgba[o + k] * a / 255 + 255 - a);
      rgba[o + 3] = 255;
    }
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
    if (r !== g || g !== b) { gray = false; bilevel = false; } else if (r !== 0 && r !== 255) bilevel = false;
  }
  if (bilevel) {
    const rowB = Math.ceil(w / 8), out = new Uint8Array(rowB * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (rgba[(y * w + x) * 4]) out[y * rowB + (x >> 3)] |= 0x80 >> (x & 7);
    return { bytes: out, flate: true, dict: { Width: w, Height: h, BitsPerComponent: 1, ColorSpace: 'DeviceGray' } };
  }
  if (compress) {
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, n * 4), w, h), 0, 0);
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), dict: { Width: w, Height: h, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'DCTDecode' } };
  }
  const ch = gray ? 1 : 3, out = new Uint8Array(n * ch);
  for (let i = 0; i < n; i++) for (let k = 0; k < ch; k++) out[i * ch + k] = rgba[i * 4 + k];
  return { bytes: out, flate: true, dict: { Width: w, Height: h, BitsPerComponent: 8, ColorSpace: gray ? 'DeviceGray' : 'DeviceRGB' } };
}

function toPdfObj(doc, v) {
  if (typeof v === 'string') return PDFName.of(v);
  if (Array.isArray(v) || typeof v === 'number') return doc.context.obj(v);
  return doc.context.obj(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toPdfObj(doc, x)])));
}

// Orientation 1–8 as a placement matrix for the unit image square
// (u → right, v → up, the image's first row at v = 1) inside w × h.
function orientMatrix(o, w, h) {
  switch (o) {
    case 2: return [-w, 0, 0, h, w, 0];
    case 3: return [-w, 0, 0, -h, w, h];
    case 4: return [w, 0, 0, -h, 0, h];
    case 5: return [0, -h, -w, 0, w, h];
    case 6: return [0, -h, w, 0, 0, h];
    case 7: return [0, h, w, 0, 0, 0];
    case 8: return [0, h, -w, 0, w, 0];
    default: return [w, 0, 0, h, 0, 0];
  }
}

async function addPage(doc, buffer, ifd, ifds, options) {
  const { pageSize = 'auto', orientation = 'auto', compress = true, quality = 0.82 } = options;
  const img = passthroughCcitt(buffer, ifd) || passthroughJpeg(buffer, ifd) || await decoded(buffer, ifd, ifds, { compress, quality });
  const o = tag(ifd, 274) ?? 1;
  let [imgW, imgH] = physicalSize(ifd);
  if (o >= 5) [imgW, imgH] = [imgH, imgW];           // a quarter turn: the page is the other way round

  // js/worker.js handleJpg2Pdf, steps 7–8, with the physical size in place of pixels
  let pageW, pageH;
  if (pageSize === 'auto') [pageW, pageH] = [imgW, imgH];
  else if (pageSize === 'fit') [pageW, pageH] = PAGE_SIZES.a4;
  else [pageW, pageH] = PAGE_SIZES[pageSize] || PAGE_SIZES.a4;
  if ((orientation === 'landscape' && pageW < pageH) || (orientation === 'portrait' && pageW > pageH)
      || (orientation === 'auto' && imgW > imgH && pageW < pageH)) [pageW, pageH] = [pageH, pageW];
  let drawW = pageW, drawH = pageH, drawX = 0, drawY = 0;
  if (pageSize === 'fit' || pageSize === 'a4' || pageSize === 'letter') {
    const s = Math.min(pageW / imgW, pageH / imgH);
    drawW = imgW * s; drawH = imgH * s; drawX = (pageW - drawW) / 2; drawY = (pageH - drawH) / 2;
  }

  const page = doc.addPage([pageW, pageH]);
  const dict = toPdfObj(doc, { Type: 'XObject', Subtype: 'Image', ...img.dict });
  const stream = img.flate ? doc.context.flateStream(img.bytes, {}) : doc.context.stream(img.bytes, {});
  for (const [k, v] of dict.entries()) stream.dict.set(k, v);
  const name = page.node.newXObject('Im', doc.context.register(stream));
  const [a, b, c, d, e, f] = orientMatrix(o, drawW, drawH);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(a, b, c, d, e + drawX, f + drawY), drawObject(name), popGraphicsState());
}

async function toPdf(files, options) {
  const all = files.map(buffer => { try { return { buffer, ...pagesOf(buffer) }; } catch { return { buffer, ifds: [], pages: [] }; } });
  const total = all.reduce((s, f) => s + f.pages.length, 0);
  const skipped = [], doc = await PDFDocument.create();
  let done = 0, pageCount = 0;
  for (let i = 0; i < all.length; i++) {
    const { buffer, ifds, pages } = all[i];
    let added = 0;
    for (const ifd of pages) {
      try { await addPage(doc, buffer, ifd, ifds, options); added++; } catch { /* counted below */ }
      self.postMessage({ type: 'progress', done: ++done, total });
    }
    if (added < pages.length || !pages.length) skipped.push(i + 1);
    pageCount += added;
  }
  return { pdfs: [pageCount ? (await doc.save({ useObjectStreams: true })).buffer : null], pageCount, skipped };
}

// the parts of a mixed job, in order — copyPages keeps their image streams as they are
async function merge(pdfs) {
  const out = await PDFDocument.create();
  for (const bytes of pdfs) {
    const src = await PDFDocument.load(bytes);
    for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
  }
  return { pdfs: [(await out.save({ useObjectStreams: true })).buffer], pageCount: out.getPageCount() };
}

// a thumbnail: the first page decoded, as PNG
async function preview(buffer) {
  const { ifds, pages } = pagesOf(buffer);
  const ifd = pages[0];
  if (!ifd) return null;
  const w = tag(ifd, 256), h = tag(ifd, 257), rgba = await rgbaOf(buffer, ifd, ifds);
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'preview') { self.postMessage({ page: await preview(m.buffer) }); return; }
    const res = m.type === 'merge' ? await merge(m.pdfs) : await toPdf(m.files, m.options || {});
    self.postMessage({ type: 'done', ...res }, res.pdfs.filter(Boolean));
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err && err.message || err) });
  }
};
