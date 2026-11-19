// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  cmykD.js — mode D300 for Compress: print (DeviceCMYK) images re-encoded as
//  CMYK JPEG, downsampled to 300 dpi where they are finer, and kept only when
//  smaller. Loaded into js/compressPrepWorker.js (importScripts), so it works
//  on the pdf-lib document that pass already holds. js/worker.js is not
//  touched: its handleCompress skips CMYK images, so these bytes are what
//  ships.
//
//  Measured before it was written (owner-approved plan, 2026-11-06; the
//  research in the wip/ocr-bench-tools branch, scripts/compress-big/cmyk-proto):
//  17 print PDFs 417 → 319 MB (Maximum, q75) / 325 MB (Standard, q82),
//  page count, text layer, masks and colour spaces unchanged, colour closer
//  to the original than at 200 dpi, QR codes that read before still read.
//  It does not keep the finest raster detail of 600-ppi images (1-px lines
//  keep ~50 % of their ink) — 300 dpi can't hold it.
//
//  The chain, the same as the research prototype (chain.mjs) so the bytes
//  match it:
//    - pdf.js's JpegImage decodes the JPEG (CMYK and YCCK, the samples as a
//      PDF reader takes them, no inversion); a Flate image is read as it is;
//    - an area average (box filter) downsamples — no ringing, so no ink
//      appears where there was none;
//    - qpdf (the site's WASM, --optimize-images → libjpeg) encodes: 4
//      channels, Adobe marker, no colour transform;
//    - the guard: pure-K pixels (C = M = Y = 0, K > 0) must not gain C, M or
//      Y above 2/255 in more than 0.1 % of them, read back with the same
//      decoder; else the image stays as it was.
//  Out of scope, left as they are: any other colour space (ICC, Indexed,
//  DeviceN…), /Mask, an image mask, other than 8 bits, other filters,
//  progressive or non-Adobe CMYK JPEG, a /Decode other than [0 1…] or
//  [1 0…], the SMask images themselves, an image used anywhere this pass
//  doesn't read the size it is drawn at (patterns, annotation appearances…).
//
//  The same chain also re-encodes JPEG 2000 (JPX) RGB/grey images (class C34,
//  2026-11-10) — see _cmykdJpxCandidate — and downsamples RGB/grey figures
//  drawn smaller than the page (class C35, 2026-11-11) — _cmykdPlacedCandidate.
//  And it brings 1-bit scans down to 300 dpi, or to the resolution asked for
//  but never below 200, still 1 bit (class C36, 2026-11-20) — _cmykdBitonalCandidate.
//  And, on a size target's strongest steps, text scans become black and white
//  (class C37, 2026-11-20) — _scanReplace.
// ============================================================

// One function scope: this file shares the worker's global scope with
// pdf-lib.min.js and compressPrepWorker.js, and the build minifies it as a
// module (scripts/build.py) — its top-level names would become one-letter
// names that collide there ("Identifier 'e' has already been declared" took
// the whole pre-pass down). Only self.cmykD leaves this scope.
(() => {
const CMYKD_PURE_K_MAX_SHARE = 0.001;
const CMYKD_BATCH_BYTES = 48 * 1024 * 1024;   // uncompressed samples per qpdf run

// ── Where each image is drawn: the smallest effective dpi over its uses ──────

// Content-stream tokens, enough to follow q/Q, cm and Do. Strings, hex
// strings, dicts and inline image data are skipped, not interpreted.
function* _cmykdTokens(bytes) {
  const n = bytes.length;
  const ws = c => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
  const delim = c => ws(c) || c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
  let i = 0;
  while (i < n) {
    const c = bytes[i];
    if (ws(c)) { i++; continue; }
    if (c === 0x25) { while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++; continue; }   // comment
    if (c === 0x28) {                                                                            // (string)
      let depth = 0;
      for (; i < n; i++) {
        if (bytes[i] === 0x5c) { i++; continue; }
        if (bytes[i] === 0x28) depth++;
        else if (bytes[i] === 0x29 && --depth === 0) { i++; break; }
      }
      yield { t: 'str' }; continue;
    }
    if (c === 0x3c && bytes[i + 1] === 0x3c) { i += 2; yield { t: '<<' }; continue; }
    if (c === 0x3e && bytes[i + 1] === 0x3e) { i += 2; yield { t: '>>' }; continue; }
    if (c === 0x3c) { while (i < n && bytes[i] !== 0x3e) i++; i++; yield { t: 'str' }; continue; }   // <hex>
    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) { i++; yield { t: String.fromCharCode(c) }; continue; }
    const start = i;
    i++;
    while (i < n && !delim(bytes[i])) i++;
    const word = String.fromCharCode.apply(null, bytes.subarray(start, i));
    if (c === 0x2f) { yield { t: 'name', v: word.slice(1) }; continue; }
    const num = Number(word);
    if (word !== '' && !Number.isNaN(num) && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { yield { t: 'num', v: num }; continue; }
    if (word === 'ID') {                       // inline image data: skip to "EI" between whitespace
      i++;
      while (i < n - 2 && !(ws(bytes[i - 1]) && bytes[i] === 0x45 && bytes[i + 1] === 0x49 && (i + 2 >= n || ws(bytes[i + 2]) || delim(bytes[i + 2])))) i++;
      i += 2;
      continue;
    }
    yield { t: 'op', v: word };
  }
}

const _cmykdMul = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];

// → { minInch: Map<imageRefTag, { inchX, inchY }>, xobjectDicts: Set<PDFDict> }
// inchX/inchY: the largest size, in inches, each image axis is drawn at over
// all its uses on the pages (forms followed) — the lowest effective dpi.
function _cmykdPlacements(pdf) {
  const { PDFName, PDFDict, PDFArray, PDFRawStream, PDFRef, PDFNumber, decodePDFRawStream } = PDFLib;
  const ctx = pdf.context;
  const lookup = v => (v instanceof PDFRef ? ctx.lookup(v) : v);
  const minInch = new Map();      // image ref tag → { inchX, inchY }
  const xobjectDicts = new Set(); // every /XObject resource dict this pass read
  const formSeen = new Set();
  const streamBytes = s => {
    const parts = s instanceof PDFArray ? s.asArray().map(lookup) : [lookup(s)];
    const chunks = parts.filter(p => p instanceof PDFRawStream).map(p => decodePDFRawStream(p).decode());
    const out = new Uint8Array(chunks.reduce((a, c) => a + c.length + 1, 0));
    let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; out[o++] = 0x0a; }
    return out;
  };
  const walk = (bytes, resources, ctm0, depth) => {
    if (depth > 12) throw new Error('form nesting too deep');
    const xo = lookup(lookup(resources)?.get?.(PDFName.of('XObject')));
    if (xo instanceof PDFDict) xobjectDicts.add(xo);
    const stack = []; let ctm = ctm0; let ops = [];
    for (const tk of _cmykdTokens(bytes)) {
      if (tk.t !== 'op') { ops.push(tk); continue; }
      if (tk.v === 'q') stack.push(ctm);
      else if (tk.v === 'Q') ctm = stack.pop() || ctm0;
      else if (tk.v === 'cm') {
        const m = ops.slice(-6).map(o => o.v);
        if (m.length === 6 && m.every(Number.isFinite)) ctm = _cmykdMul(m, ctm);
      } else if (tk.v === 'Do') {
        const name = ops[ops.length - 1]?.t === 'name' ? ops[ops.length - 1].v : null;
        const ref = name && xo instanceof PDFDict ? xo.get(PDFName.of(name)) : null;
        const obj = lookup(ref);
        if (obj instanceof PDFRawStream) {
          const sub = obj.dict.get(PDFName.of('Subtype'))?.toString();
          if (sub === '/Image' && ref instanceof PDFRef) {
            const inchX = Math.hypot(ctm[0], ctm[1]) / 72, inchY = Math.hypot(ctm[2], ctm[3]) / 72;
            const tag = ref.tag, prev = minInch.get(tag);
            // the LARGEST drawing decides (the smallest dpi): keep the max inches per axis
            minInch.set(tag, { inchX: Math.max(prev?.inchX || 0, inchX), inchY: Math.max(prev?.inchY || 0, inchY) });
          } else if (sub === '/Form' && !formSeen.has(`${ref?.tag}|${ctm.join(',')}`)) {
            formSeen.add(`${ref?.tag}|${ctm.join(',')}`);   // the same form drawn the same way: once
            const fm = lookup(obj.dict.get(PDFName.of('Matrix')));
            const m = fm instanceof PDFArray && fm.size() === 6 ? fm.asArray().map(x => lookup(x)).map(x => (x instanceof PDFNumber ? x.asNumber() : NaN)) : [1, 0, 0, 1, 0, 0];
            if (!m.every(Number.isFinite)) throw new Error('form matrix');
            walk(decodePDFRawStream(obj).decode(), obj.dict.get(PDFName.of('Resources')) || resources, _cmykdMul(m, ctm), depth + 1);
          }
        }
      }
      ops = [];
    }
  };
  for (const page of pdf.getPages()) {
    const uu = lookup(page.node.get(PDFName.of('UserUnit')));
    const unit = uu instanceof PDFNumber ? uu.asNumber() : 1;
    const contents = page.node.Contents();
    if (!contents) continue;
    walk(streamBytes(contents), page.node.Resources(), [unit, 0, 0, unit, 0, 0], 0);
  }
  return { minInch, xobjectDicts };
}

// Images referenced from anywhere but the /XObject dicts this pass read (a
// pattern's resources, an annotation's appearance, another image's /SMask…):
// the size they are drawn at there is unknown, so they are left alone.
function _cmykdUsedElsewhere(pdf, candidates, xobjectDicts) {
  const { PDFDict, PDFArray, PDFRawStream, PDFRef } = PDFLib;
  const out = new Set();
  const scan = (v, owner) => {
    if (v instanceof PDFRef) { if (candidates.has(v.tag) && !xobjectDicts.has(owner)) out.add(v.tag); return; }
    if (v instanceof PDFRawStream) { scan(v.dict, v.dict); return; }
    if (v instanceof PDFDict) { for (const [, x] of v.entries()) scan(x, v); return; }
    if (v instanceof PDFArray) for (const x of v.asArray()) scan(x, owner);
  };
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) scan(obj, obj instanceof PDFRawStream ? obj.dict : obj);
  // the trailer can't reference an image; the catalog and pages are objects above
  return out;
}

// ── Pixels ────────────────────────────────────────────────────────────────────

// Area-average downsample, row band by row band. The same arithmetic as the
// prototype's whole-image version (a Float32 horizontal pass, then a Float32
// vertical accumulation in the same order), so the samples are identical;
// only one horizontally reduced row is held at a time.
function _cmykdDownsample(src, w, h, nc, nw, nh) {
  const sx = w / nw, sy = h / nh;
  const out = new Uint8Array(nw * nh * nc);
  const row = new Float32Array(nw * nc), acc = new Float32Array(nw * nc);
  const spans = [];
  for (let x = 0; x < nw; x++) {
    const x0 = x * sx, x1 = x0 + sx, list = [];
    for (let xs = Math.floor(x0); xs < Math.min(w, Math.ceil(x1)); xs++) list.push([xs, (Math.min(x1, xs + 1) - Math.max(x0, xs)) / sx]);
    spans.push(list);
  }
  const hrow = (ys) => {
    row.fill(0);
    const base = ys * w * nc;
    for (let x = 0; x < nw; x++) {
      const di = x * nc;
      for (const [xs, wt] of spans[x]) { const si = base + xs * nc; for (let c = 0; c < nc; c++) row[di + c] += src[si + c] * wt; }
    }
  };
  for (let y = 0; y < nh; y++) {
    acc.fill(0);
    const y0 = y * sy, y1 = y0 + sy;
    for (let ys = Math.floor(y0); ys < Math.min(h, Math.ceil(y1)); ys++) {
      const wt = (Math.min(y1, ys + 1) - Math.max(y0, ys)) / sy;
      hrow(ys);
      for (let i = 0; i < nw * nc; i++) acc[i] += row[i] * wt;
    }
    for (let i = 0; i < nw * nc; i++) out[y * nw * nc + i] = Math.min(255, Math.max(0, Math.round(acc[i])));
  }
  return out;
}

function _cmykdPureKOk(src, back) {
  let pure = 0, bad = 0;
  for (let i = 0; i < src.length; i += 4) {
    if (src[i] === 0 && src[i + 1] === 0 && src[i + 2] === 0 && src[i + 3] > 0) {
      pure++;
      if (back[i] > 2 || back[i + 1] > 2 || back[i + 2] > 2) bad++;
    }
  }
  return pure < 50 || bad / pure <= CMYKD_PURE_K_MAX_SHARE;
}

// ── qpdf as the encoder ──────────────────────────────────────────────────────

let _cmykdQpdf = null;
async function _cmykdQpdfInstance(urls) {
  if (!_cmykdQpdf) {
    if (!self.Module) importScripts(urls.qpdfJs);   // defines the global factory `Module`
    _cmykdQpdf = await self.Module({ noInitialRun: true, locateFile: p => (p.endsWith('.wasm') ? urls.qpdfWasm : p), print: () => {}, printErr: () => {} });
  }
  return _cmykdQpdf;
}

function _cmykdRun(q, args) {
  try { const r = q.callMain(args); return Number.isFinite(r) ? r : 0; }
  catch (e) { if (Number.isFinite(e?.status)) return e.status; if (Number.isFinite(e)) return e; throw e; }
}

// One temp PDF holding every image of the batch uncompressed (each in the
// device space of its channel count) (so DCT is
// always the smaller), each tagged /PDFreeID; qpdf --optimize-images encodes
// them; → Map<id, jpeg bytes> for those it wrote as DCT.
function _cmykdEncodeBatch(q, batch, quality) {
  const csName = nc => (nc === 4 ? '/DeviceCMYK' : nc === 3 ? '/DeviceRGB' : '/DeviceGray');
  const enc = s => new TextEncoder().encode(s);
  const parts = [], offs = []; let len = 0;
  const push = b => { parts.push(b); len += b.length; };
  const latin = s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
  push(latin('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n'));
  const first = 4, n = batch.length;
  const head = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Resources << /XObject << ${batch.map((_, i) => `/I${i} ${first + i} 0 R`).join(' ')} >> >> >>`,
  ];
  head.forEach((o, i) => { offs.push(len); push(enc(`${i + 1} 0 obj\n${o}\nendobj\n`)); });
  batch.forEach((b, i) => {
    offs.push(len);
    push(enc(`${first + i} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${b.w} /Height ${b.h} /ColorSpace ${csName(b.nc)} /BitsPerComponent 8 /PDFreeID ${i} /Length ${b.samples.length} >>\nstream\n`));
    push(b.samples); push(enc('\nendstream\nendobj\n'));
  });
  const xref = len, size = first + n;
  push(enc(`xref\n0 ${size}\n0000000000 65535 f \n${offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  const input = new Uint8Array(len); let o = 0; for (const p of parts) { input.set(p, o); o += p.length; }
  try { q.FS.unlink('/d-in.pdf'); } catch { /* not there */ }
  try { q.FS.unlink('/d-out.pdf'); } catch { /* not there */ }
  q.FS.writeFile('/d-in.pdf', input);
  const rc = _cmykdRun(q, ['--optimize-images', '--oi-min-width=0', '--oi-min-height=0', '--oi-min-area=0',
    `--jpeg-quality=${quality}`, '--object-streams=disable', '--decode-level=none', '/d-in.pdf', '/d-out.pdf']);
  try { q.FS.unlink('/d-in.pdf'); } catch { /* gone */ }
  const result = new Map();
  if (rc !== 0 && rc !== 3) return result;
  const out = q.FS.readFile('/d-out.pdf');
  try { q.FS.unlink('/d-out.pdf'); } catch { /* gone */ }
  const s = new TextDecoder('latin1').decode(out);
  const re = /\/PDFreeID (\d+)/g; let m;
  while ((m = re.exec(s))) {
    const dictStart = s.indexOf('<<', s.lastIndexOf(' obj', m.index));
    const streamAt = s.indexOf('stream', m.index);
    const dict = s.slice(dictStart, streamAt);
    if (!dict.includes('/DCTDecode')) continue;
    const L = /\/Length (\d+)(?! \d+ R)/.exec(dict);
    if (!L) continue;
    const start = streamAt + (s[streamAt + 6] === '\r' ? 8 : 7);
    const jpg = out.slice(start, start + Number(L[1]));
    if (jpg[0] === 0xff && jpg[1] === 0xd8) result.set(Number(m[1]), jpg);
  }
  return result;
}

// ── JPEG 2000 (JPX) images ───────────────────────────────────────────────────
// Neither js/worker.js nor the steps above read JPX, so these images left
// Compress as they came (class JPX, 2026-11-10; pre-registered criteria in
// the research branch, JPX-PREREG.md). In scope: 8 bits, DeviceRGB,
// DeviceGray or ICCBased with 1 or 3 components — the colour space stays as
// it is (a JPEG of the same channel count under the same profile); no
// /Decode but the identity one, no /SMaskInData, no mask. CMYK JPX stays out: on the documents
// measured its JPEG came out larger.
// Read SIZ from the raw codestream or its JP2 box before OpenJPEG allocates
// memory. The PDF dictionary alone is not a bound on decoder allocations.
function _cmykdJpxMatchesHeader(bytes, w, h, nc) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let start = 0, end = view.byteLength;
  if (end < 2) return false;
  if (view.getUint16(0) !== 0xff4f) {
    let found = false;
    for (let offset = 0; offset + 8 <= end;) {
      const length = view.getUint32(offset);
      const boxEnd = length === 0 ? end : offset + length;
      if (boxEnd < offset + 8 || boxEnd > end) return false;
      if (view.getUint32(offset + 4) === 0x6a703263) { // jp2c
        start = offset + 8;
        end = boxEnd;
        found = true;
        break;
      }
      offset = boxEnd;
    }
    if (!found) return false;
  }
  if (end - start < 42 + 3 * nc ||
      view.getUint32(start) !== 0xff4fff51 ||
      view.getUint16(start + 4) !== 38 + 3 * nc ||
      view.getUint16(start + 40) !== nc ||
      view.getUint32(start + 8) - view.getUint32(start + 16) !== w ||
      view.getUint32(start + 12) - view.getUint32(start + 20) !== h) return false;
  for (let i = 0; i < nc; i++) {
    if (view.getUint8(start + 42 + 3 * i) !== 7) return false; // unsigned 8-bit
  }
  return true;
}

// Channel count of an RGB or grey colour space (DeviceRGB, DeviceGray, ICCBased
// N=1|3), else 0 — the spaces a JPEG of the same channel count can stand under.
function _cmykdRgbChannels(d, lookup) {
  const { PDFName, PDFArray, PDFNumber } = PDFLib;
  const cs = lookup(d.get(PDFName.of('ColorSpace')));
  if (cs?.toString() === '/DeviceRGB') return 3;
  if (cs?.toString() === '/DeviceGray') return 1;
  if (cs instanceof PDFArray && cs.size() === 2 && lookup(cs.get(0))?.toString() === '/ICCBased') {
    const n = lookup(cs.get(1))?.dict?.get(PDFName.of('N'));
    const v = lookup(n) instanceof PDFNumber ? lookup(n).asNumber() : 0;
    if (v === 1 || v === 3) return v;
  }
  return 0;
}

// No /Decode, or the identity [0 1 …] (which means the same as none)
function _cmykdIdentityDecode(d, lookup, nc) {
  const { PDFName, PDFArray } = PDFLib;
  const dec = lookup(d.get(PDFName.of('Decode')));
  return dec === undefined || (dec instanceof PDFArray && dec.size() === 2 * nc && dec.asArray().every((x, i) => lookup(x)?.asNumber?.() === i % 2));
}

const _cmykdIsMask = (d, lookup) => d.has(PDFLib.PDFName.of('Mask')) || lookup(d.get(PDFLib.PDFName.of('ImageMask')))?.toString() === 'true';

function _cmykdJpxCandidate(d, lookup, isSMask, skip) {
  const { PDFName } = PDFLib;
  if (isSMask) { skip('JPX: is an SMask'); return null; }
  const nc = _cmykdRgbChannels(d, lookup);
  if (!nc) { skip('JPX: colour space'); return null; }
  if (lookup(d.get(PDFName.of('BitsPerComponent')))?.toString() !== '8') { skip('JPX: bpc'); return null; }
  const smid = lookup(d.get(PDFName.of('SMaskInData')));
  if (!_cmykdIdentityDecode(d, lookup, nc) || (smid && smid.toString() !== '0')) { skip('JPX: /Decode or /SMaskInData'); return null; }
  if (_cmykdIsMask(d, lookup)) { skip('JPX: mask'); return null; }
  return { kind: 'jpx', nc, invert: false };
}

// ── RGB/grey figures drawn smaller than the page (class C35, 2026-11-11) ─────
// worker.js's _recompressImages estimates an image's dpi from the PAGE size
// (and only for images of 600 px or more), so a 1024-px figure drawn 2 in wide
// counts as ~120 dpi, not 509 — and stays: on Maximum (96 dpi) the figures of
// scientific papers kept 290–510 dpi, the leader was 3–4× smaller on such
// papers. Here, an 8-bit RGB/grey DCT or Flate image (no predictor, no /Decode
// but the identity, not a mask) drawn above 1.1 × the mode's target is
// downsampled by where it is actually drawn; everything else stays with
// worker.js as before. Pre-registered criteria: PLACED-PREREG.md (research branch).
function _cmykdPlacedCandidate(d, lookup, f, nc) {
  const { PDFName } = PDFLib;
  if (f.length !== 1 || (f[0] !== '/DCTDecode' && f[0] !== '/FlateDecode')) return null;
  if (lookup(d.get(PDFName.of('BitsPerComponent')))?.toString() !== '8') return null;
  if (!_cmykdIdentityDecode(d, lookup, nc) || _cmykdIsMask(d, lookup)) return null;
  if (f[0] === '/FlateDecode' && lookup(lookup(d.get(PDFName.of('DecodeParms')))?.get?.(PDFName.of('Predictor')))?.asNumber?.() > 1) return null;
  return { kind: f[0] === '/DCTDecode' ? 'rgb-dct' : 'rgb-raw', nc, invert: false };
}

// The main encoder sizes images against the median page. Only delegate scans
// whose drawn dimensions agree with that reference. Smaller placed figures
// still need the placement-aware encoder.
function _cmykdMedianPage(pdf) {
  const pages = pdf.getPages().map(page => {
    const { width, height } = page.getSize();
    return { width, height, rotation: page.getRotation().angle };
  }).sort((a, b) => a.width * a.height - b.width * b.height);
  const median = pages[Math.floor(pages.length / 2)];
  return median?.rotation === 0 && median.width > 0 && median.height > 0 ? median : null;
}

// Check the JPEG frame without decoding pixels. Leave EXIF orientation,
// embedded profiles and other application markers on the existing path.
function _cmykdPlainRgbJpeg(bytes, width, height) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let matches = false;
  for (let offset = 2; offset + 4 <= bytes.length;) {
    if (bytes[offset] !== 0xff) return false;
    const marker = bytes[offset + 1];
    const length = bytes[offset + 2] * 256 + bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) return false;
    if (marker === 0xda) return matches;
    if (marker >= 0xe1 && marker <= 0xef) return false;
    if (marker === 0xc0) {
      matches = length === 17 && bytes[offset + 4] === 8
        && bytes[offset + 5] * 256 + bytes[offset + 6] === height
        && bytes[offset + 7] * 256 + bytes[offset + 8] === width
        && bytes[offset + 9] === 3;
    }
    offset += length + 2;
  }
  return false;
}

// ── 1-bit scans (class C36, 2026-11-20) ─────────────────────────────────────
// worker.js skips every 1-bit image, so a scanner's black-and-white pages
// (CCITT G4) went through Compress untouched whatever was asked: a 4-page A3
// newspaper scan, 1.97 MB, came back "Already optimized" with a 500 KB target.
// Here a 1-bit DeviceGray image or image mask — CCITT G4, Flate without
// predictor, or no filter — drawn above 1.1 × the target comes down to it,
// still 1 bit: the area average of its samples, then cut half-way. The target
// (processor.js _cmykDOptions) is 300 dpi, or the resolution asked for (a size
// target's step, a chosen dpi) but never below 200: the newspaper's small
// kanji still read at 200 dpi and broke apart at 150 — and 200 dpi black and
// white is what India's PAN portal asks of a scan. That newspaper at 200 dpi:
// 1.91 → 0.92 MB. Written as Flate, not G4: as small on the scans measured.
// The G4 decoder is UTIF.js's (vendored for TIFF→PDF) — pixel for pixel what
// MuPDF decodes on 4 real scans. A G4 stream it can't read throws: left as it was.
function _cmykdBitonalCandidate(d, lookup, f) {
  const { PDFName, PDFArray, PDFDict, PDFNumber } = PDFLib;
  const num = v => (lookup(v) instanceof PDFNumber ? lookup(v).asNumber() : undefined);
  const mask = lookup(d.get(PDFName.of('ImageMask')))?.toString() === 'true';
  const bpc = num(d.get(PDFName.of('BitsPerComponent')));
  if (mask ? bpc !== undefined && bpc !== 1 : bpc !== 1 || lookup(d.get(PDFName.of('ColorSpace')))?.toString() !== '/DeviceGray') return null;
  if (d.has(PDFName.of('Mask')) || d.has(PDFName.of('SMask'))) return null;
  const dec = lookup(d.get(PDFName.of('Decode')));
  if (dec !== undefined && !(dec instanceof PDFArray && dec.size() === 2)) return null;
  const dp = lookup(d.get(PDFName.of('DecodeParms')));
  const parm = k => (dp instanceof PDFDict ? dp.get(PDFName.of(k)) : undefined);
  if (f.length === 0) return { kind: 'bitonal', nc: 1, codec: 'raw' };
  if (f.length !== 1) return null;
  if (f[0] === '/FlateDecode') return num(parm('Predictor')) > 1 ? null : { kind: 'bitonal', nc: 1, codec: 'flate' };
  if (f[0] !== '/CCITTFaxDecode' || !(num(parm('K')) < 0)) return null;   // G4 only
  const w = num(d.get(PDFName.of('Width'))), h = num(d.get(PDFName.of('Height')));
  if ((num(parm('Columns')) ?? 1728) !== w || (num(parm('Rows')) ?? h) !== h) return null;
  if (lookup(parm('EncodedByteAlign'))?.toString() === 'true') return null;
  return { kind: 'bitonal', nc: 1, codec: 'ccitt', blackIs1: lookup(parm('BlackIs1'))?.toString() === 'true' };
}

// A bitonal candidate's samples, one byte each: 0 or 255 for the sample bit
// (what /Decode and an image mask read), rows unpadded; null if the decoded
// length isn't what /Width and /Height say.
function _cmykdBitonalSamples(c, w, h, urls) {
  const bpl = Math.ceil(w / 8);
  let bits;
  if (c.codec === 'ccitt') {
    if (!self.UTIF) importScripts(urls.utif);   // sets self.UTIF
    bits = new Uint8Array(bpl * h);
    self.UTIF.decode._decompress({ width: w, height: h }, [], c.obj.contents, 0, c.obj.contents.length, 4, bits, 0, 1);
    // UTIF writes 1 for black; a PDF sample is 0 for black unless /BlackIs1
    if (!c.blackIs1) for (let i = 0; i < bits.length; i++) bits[i] = ~bits[i];
  } else {
    bits = c.codec === 'raw' ? c.obj.contents : PDFLib.decodePDFRawStream(c.obj).decode();
    if (bits.length < bpl * h) return null;
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + x] = (bits[y * bpl + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
  }
  return out;
}

// Area-averaged samples → 1 bit again, cut half-way; rows padded to a byte
function _cmykdPackBits(samples, w, h) {
  const bpl = Math.ceil(w / 8), out = new Uint8Array(bpl * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (samples[y * w + x] >= 128) out[y * bpl + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return out;
}

// ── Text scans to black and white, for a size target (class C37, 2026-11-20) ─
// Below 150 dpi a colour JPEG of a text page stops reading: OCR recall held
// at 150 and fell at 120/96/72 (72 dpi: 2 of 16 pages read, small print 0 of
// 8; on phone photos 0 of 20) — and the target ladder's last steps were just
// that. The same page in black and white (Sauvola, the formula Clean Scan
// uses) read on 52 of 52 pages at 300 dpi and 51 of 52 at 200, at 80–130 KB
// and 45–75 KB a page: no larger than the 72-dpi JPEG
// (scripts/bench/scan_floor.py, 2026-11-20). So on those steps a page-sized
// RGB/grey scan with no picture on it becomes 1 bit at the step's
// `scan.dpi`, never below 200. A picture anywhere on it (a ~1 cm block mostly
// mid-tone or dark: a photo, a figure, a dark page) keeps it as it was —
// worker.js's JPEG steps then. Ink in colour (a stamp, a signature: ≤ 2 % of
// the page) keeps its colour: up to two colours of it in a 2-bit /Indexed
// image beside white and black; more colour than that and the page stays.
const _SCAN_MIN_INCH = 5;           // drawn at least 5 × 5 in: a page, not a figure
const _SCAN_COLOUR_SPREAD = 60;     // max − min channel above this: coloured ink
const _SCAN_COLOUR_MARKS = 0.0005;  // share of coloured pixels from which marks keep their colour
const _SCAN_COLOUR_PAGE = 0.02;     // above this the page is a colour page: left alone

// Separable running max / box mean over radius r, edges clamped — grey, w × h
function _scanFilter(src, w, h, r, max) {
  const pass = (a, len, stride, lines, lineStride) => {
    const out = new Float32Array(a.length);
    for (let l = 0; l < lines; l++) {
      const base = l * lineStride;
      for (let i = 0; i < len; i++) {
        let v = 0;
        for (let j = i - r; j <= i + r; j++) {
          const x = a[base + Math.min(len - 1, Math.max(0, j)) * stride];
          v = max ? Math.max(v, x) : v + x;
        }
        out[base + i * stride] = max ? v : v / (2 * r + 1);
      }
    }
    return out;
  };
  return pass(pass(src, w, 1, h, w), h, w, w, 1);
}

// Any picture on the page? On a ~100 dpi grey copy: the paper (a wide max,
// smoothed) divides the page, so shadow and paper tint don't count; then ~1 cm
// blocks, a picture if over half mid-tone or over 60 % dark.
function _scanHasPicture(grey, w, h) {
  const bg = _scanFilter(_scanFilter(grey, w, h, 4, true), w, h, 15, false);
  const B = Math.max(8, Math.round(w / 21));
  const bw = Math.floor(w / B), bh = Math.floor(h / B);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let mid = 0, dark = 0;
      for (let y = by * B; y < (by + 1) * B; y++) {
        for (let x = bx * B; x < (bx + 1) * B; x++) {
          const n = Math.min(255, grey[y * w + x] / Math.max(1, bg[y * w + x]) * 255);
          if (n <= 60) dark++; else if (n < 230) mid++;
        }
      }
      if (mid > B * B * 0.5 || dark > B * B * 0.6) return true;
    }
  }
  return false;
}

// Sauvola (k 0.5, R 128 — Clean Scan's) with the local mean and deviation
// taken from a copy 4× smaller, windows of 2 % of its short edge: the same
// threshold to within the window, at a 16th of the memory. → 1 = ink
function _scanInk(grey, w, h) {
  const sw = Math.max(1, Math.floor(w / 4)), sh = Math.max(1, Math.floor(h / 4));
  const small = _cmykdDownsample(grey, w, h, 1, sw, sh);
  const sq = new Float32Array(sw * sh);
  for (let i = 0; i < sq.length; i++) sq[i] = small[i] * small[i];
  const r = Math.max(2, Math.round(Math.min(sw, sh) * 0.02));
  const mean = _scanFilter(small, sw, sh, r, false), meanSq = _scanFilter(sq, sw, sh, r, false);
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const ty = Math.min(sh - 1, Math.floor(y * sh / h));
    for (let x = 0; x < w; x++) {
      const t = ty * sw + Math.min(sw - 1, Math.floor(x * sw / w));
      const sd = Math.sqrt(Math.max(0, meanSq[t] - mean[t] * mean[t]));
      if (grey[y * w + x] <= mean[t] * (1 + 0.5 * (sd / 128 - 1))) ink[y * w + x] = 1;
    }
  }
  return ink;
}

// The scan (samples nc 1|3, w × h, at the output size) as black and white:
// → { bpc, palette (RGB bytes) | null, bits } or a reason it stays
function _scanToBitonal(samples, nc, w, h) {
  const grey = new Uint8Array(w * h);
  let colour = 0;
  for (let i = 0; i < w * h; i++) {
    if (nc === 1) { grey[i] = samples[i]; continue; }
    const r = samples[3 * i], g = samples[3 * i + 1], b = samples[3 * i + 2];
    grey[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    if (Math.max(r, g, b) - Math.min(r, g, b) > _SCAN_COLOUR_SPREAD && grey[i] < 200) colour++;
  }
  if (colour > w * h * _SCAN_COLOUR_PAGE) return { stays: 'scan: a colour page' };
  const f = Math.max(1, Math.round(w / 850));   // ~100 dpi for an A4/Letter page
  const sw = Math.max(1, Math.floor(w / f)), sh = Math.max(1, Math.floor(h / f));
  if (_scanHasPicture(_cmykdDownsample(grey, w, h, 1, sw, sh), sw, sh)) return { stays: 'scan: has a picture' };
  const ink = _scanInk(grey, w, h);
  if (colour < w * h * _SCAN_COLOUR_MARKS) {   // DeviceGray, 1 = white
    const bpl = Math.ceil(w / 8), bits = new Uint8Array(bpl * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!ink[y * w + x]) bits[y * bpl + (x >> 3)] |= 0x80 >> (x & 7);
    return { bpc: 1, palette: null, bits };
  }
  // the coloured ink in two colours (k-means from its darkest and lightest)
  const isMark = i => Math.max(samples[3 * i], samples[3 * i + 1], samples[3 * i + 2]) - Math.min(samples[3 * i], samples[3 * i + 1], samples[3 * i + 2]) > _SCAN_COLOUR_SPREAD && grey[i] < 200;
  const marks = [];
  for (let i = 0; i < w * h; i++) if (isMark(i)) marks.push(i);
  const step = Math.max(1, Math.floor(marks.length / 20000));
  let lo = marks[0], hi = marks[0];
  for (const i of marks) { if (grey[i] < grey[lo]) lo = i; if (grey[i] > grey[hi]) hi = i; }
  let c = [[0, 1, 2].map(k => samples[3 * lo + k]), [0, 1, 2].map(k => samples[3 * hi + k])];
  const nearest = i => {
    const d = c.map(cc => (samples[3 * i] - cc[0]) ** 2 + (samples[3 * i + 1] - cc[1]) ** 2 + (samples[3 * i + 2] - cc[2]) ** 2);
    return d[0] <= d[1] ? 0 : 1;
  };
  for (let it = 0; it < 8; it++) {
    const sum = [[0, 0, 0, 0], [0, 0, 0, 0]];
    for (let m = 0; m < marks.length; m += step) {
      const i = marks[m], k = nearest(i);
      for (let ch = 0; ch < 3; ch++) sum[k][ch] += samples[3 * i + ch];
      sum[k][3]++;
    }
    c = c.map((cc, k) => (sum[k][3] ? sum[k].slice(0, 3).map(v => Math.round(v / sum[k][3])) : cc));
  }
  const bpl = Math.ceil(w / 4), bits = new Uint8Array(bpl * h);   // 0 white, 1 black, 2–3 the marks
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, v = isMark(i) ? 2 + nearest(i) : ink[i] ? 1 : 0;
      bits[y * bpl + (x >> 2)] |= v << (6 - 2 * (x & 3));
    }
  }
  return { bpc: 2, palette: Uint8Array.from([255, 255, 255, 0, 0, 0, ...c[0], ...c[1]]), bits };
}

// One page-sized RGB/grey scan (a placed-figure candidate) to black and white
// at `dpi` → true when replaced, else the reason it stays
function _scanReplace(c, w, h, eff, dpi, JpegImage, ctx) {
  const { PDFName, PDFNumber, PDFRawStream, PDFHexString } = PDFLib;
  if (eff < 180) return 'scan: under 200 dpi';   // 1 bit below 200 dpi breaks small print
  let samples;
  if (c.kind === 'rgb-dct') {
    const j = new JpegImage();
    j.parse(c.obj.contents);
    if (j.numComponents !== c.nc || j.width !== w || j.height !== h) return 'scan: JPEG does not match its dictionary';
    samples = j.getData({ width: w, height: h, forceRGB: false, isSourcePDF: true });
  } else {
    samples = PDFLib.decodePDFRawStream(c.obj).decode();
    if (samples.length !== w * h * c.nc) return 'scan: raw length';
  }
  let nw = w, nh = h;
  if (eff > dpi * 1.1) {
    nw = Math.max(1, Math.round(w * dpi / eff)); nh = Math.max(1, Math.round(h * dpi / eff));
    samples = _cmykdDownsample(samples, w, h, c.nc, nw, nh);
  }
  const bw = _scanToBitonal(samples, c.nc, nw, nh);
  if (bw.stays) return bw.stays;
  const flat = ctx.flateStream(bw.bits).contents;
  if (flat.length >= c.obj.contents.length) return 'scan: not smaller';
  const dict = c.obj.dict;
  dict.set(PDFName.of('ColorSpace'), bw.palette
    ? ctx.obj([PDFName.of('Indexed'), PDFName.of('DeviceRGB'), 3, PDFHexString.of([...bw.palette].map(v => v.toString(16).padStart(2, '0')).join(''))])
    : PDFName.of('DeviceGray'));
  dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(bw.bpc));
  dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
  for (const key of ['DecodeParms', 'Decode', 'SMaskInData']) dict.delete(PDFName.of(key));
  dict.set(PDFName.of('Width'), PDFNumber.of(nw));
  dict.set(PDFName.of('Height'), PDFNumber.of(nh));
  ctx.assign(c.ref, PDFRawStream.of(dict, flat));
  return true;
}

// ── The pass ─────────────────────────────────────────────────────────────────

// opts: { target (dpi), quality, maxMegapixels,               — CMYK (D300)
//         rgb: { target (dpi) | null, quality, maxMegapixels } | null,  — JPX and placed RGB/grey figures
//         bitonal: { target (dpi), maxMegapixels } | null,     — 1-bit scans (C36)
//         scan: { dpi, maxMegapixels } | null,                 — text scans to black and white (C37)
//         urls: { decoders, qpdfJs, qpdfWasm, utif }, onProgress }
// → { replaced, jpx, placed, bitonal, scans, deferred, before, after, skipped: {reason: count} }   (jpx, placed, bitonal, scans: how many of `replaced`)
async function cmykD(pdf, opts) {
  const { PDFName, PDFRawStream, PDFArray, PDFNumber, PDFRef, decodePDFRawStream } = PDFLib;
  const ctx = pdf.context;
  const lookup = v => (v instanceof PDFRef ? ctx.lookup(v) : v);
  const skipped = {};
  const skip = r => { skipped[r] = (skipped[r] || 0) + 1; };
  const filters = d => { const f = lookup(d.get(PDFName.of('Filter'))); return f instanceof PDFArray ? f.asArray().map(x => lookup(x)?.toString()) : f ? [f.toString()] : []; };

  // candidates: 8-bit DeviceCMYK, one DCT or Flate filter, no /Mask, not an image mask, not an SMask
  const smasks = new Set();
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) { const sm = obj.dict.get(PDFName.of('SMask')); if (sm instanceof PDFRef) smasks.add(sm.tag); }
  }
  const cands = new Map();   // tag → { ref, obj, kind, invert }
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (d.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    if (opts.bitonal && !smasks.has(ref.tag)) { const b = _cmykdBitonalCandidate(d, lookup, filters(d)); if (b) { cands.set(ref.tag, { ref, obj, ...b }); continue; } }
    if (opts.rgb && filters(d).join() === '/JPXDecode') { const j = _cmykdJpxCandidate(d, lookup, smasks.has(ref.tag), skip); if (j) cands.set(ref.tag, { ref, obj, ...j }); continue; }
    const rgbNc = opts.rgb?.target ? _cmykdRgbChannels(d, lookup) : 0;
    if (rgbNc) { const p = !smasks.has(ref.tag) && _cmykdPlacedCandidate(d, lookup, filters(d), rgbNc); if (p) cands.set(ref.tag, { ref, obj, ...p }); continue; }
    if (lookup(d.get(PDFName.of('ColorSpace')))?.toString() !== '/DeviceCMYK') continue;
    if (smasks.has(ref.tag)) { skip('is an SMask'); continue; }
    if (lookup(d.get(PDFName.of('BitsPerComponent')))?.toString() !== '8') { skip('bpc'); continue; }
    if (d.has(PDFName.of('Mask')) || lookup(d.get(PDFName.of('ImageMask')))?.toString() === 'true') { skip('mask'); continue; }
    const f = filters(d);
    if (f.length !== 1 || (f[0] !== '/DCTDecode' && f[0] !== '/FlateDecode')) { skip('filter'); continue; }
    const dec = lookup(d.get(PDFName.of('Decode')));
    let invert = false;
    if (dec instanceof PDFArray) {
      const v = dec.asArray().map(x => lookup(x)).map(x => (x instanceof PDFNumber ? x.asNumber() : NaN)).join(',');
      if (v === '1,0,1,0,1,0,1,0') invert = true; else if (v !== '0,1,0,1,0,1,0,1') { skip('/Decode'); continue; }
    }
    if (f[0] === '/FlateDecode') {
      const dp = lookup(d.get(PDFName.of('DecodeParms')));
      const pred = dp?.get?.(PDFName.of('Predictor'));
      if (pred && lookup(pred)?.asNumber?.() > 1) { skip('flate predictor'); continue; }
    }
    cands.set(ref.tag, { ref, obj, kind: f[0] === '/DCTDecode' ? 'dct' : 'raw', nc: 4, invert });
  }
  if (!cands.size) return { replaced: 0, jpx: 0, placed: 0, bitonal: 0, scans: 0, before: 0, after: 0, skipped };

  const { minInch, xobjectDicts } = _cmykdPlacements(pdf);
  let medianPage = null;
  if (opts.rgb?.preferNativeScans) {
    try { medianPage = _cmykdMedianPage(pdf); } catch { /* malformed page box */ }
  }
  const elsewhere = _cmykdUsedElsewhere(pdf, new Set(cands.keys()), xobjectDicts);
  const { JpegImage, JpxImage } = await import(opts.urls.decoders);
  const decode = (bytes) => {
    const j = new JpegImage({ decodeTransform: null, colorTransform: -1 });
    j.parse(bytes);
    if (j.numComponents !== 4) return null;
    if (!j.adobe) return null;   // non-Adobe 4-channel JPEG: readers disagree
    return { data: j.getData({ width: j.width, height: j.height, forceRGB: false, isSourcePDF: true }), w: j.width, h: j.height };
  };
  const progressive = b => { for (let i = 2; i + 4 <= b.length && b[i] === 0xff;) { const m = b[i + 1]; if (m === 0xc2) return true; if (m === 0xda) return false; i += 2 + ((b[i + 2] << 8) | b[i + 3]); } return false; };

  let replaced = 0, jpx = 0, placed = 0, bitonal = 0, scans = 0, deferred = 0, before = 0, after = 0;
  let pending = [], pendingBytes = 0;
  async function flush() {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    let jpegs;
    try {
      const q = await _cmykdQpdfInstance(opts.urls);
      jpegs = _cmykdEncodeBatch(q, batch, batch[0].quality);
    }
    catch {
      _cmykdQpdf = null;
      for (const b of batch) skip('encoder failed');
      return;
    }
    batch.forEach((b, k) => {
      const jpg = jpegs.get(k);
      if (!jpg) { skip('not encoded'); return; }
      const rgb = b.c.kind === 'jpx' || b.c.kind.startsWith('rgb');
      if (jpg.length >= b.old) { skip(b.c.kind === 'jpx' ? 'JPX: not smaller' : rgb ? 'placed: not smaller' : 'not smaller'); return; }
      if (rgb) {
        // read back: the size qpdf wrote must be the size the dictionary will say
        let ok = false;
        try { const j = new JpegImage(); j.parse(jpg); ok = j.width === b.w && j.height === b.h && j.numComponents === b.nc; } catch { ok = false; }
        if (!ok) { skip('JPEG read-back'); return; }
      } else {
        let back;
        try { back = decode(jpg); } catch { back = null; }
        if (!back || back.w !== b.w || back.h !== b.h || !_cmykdPureKOk(b.samples, back.data)) { skip('pure-K guard'); return; }
      }
      const dict = b.c.obj.dict;
      dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
      dict.delete(PDFName.of('DecodeParms'));
      dict.delete(PDFName.of('Decode'));   // the new samples are what a reader shows
      dict.set(PDFName.of('Width'), PDFNumber.of(b.w));
      dict.set(PDFName.of('Height'), PDFNumber.of(b.h));
      dict.delete(PDFName.of('SMaskInData'));   // a JPX-only key (always absent or 0 here)
      ctx.assign(b.c.ref, PDFRawStream.of(dict, jpg));
      replaced++; before += b.old; after += jpg.length;
      if (b.c.kind === 'jpx') jpx++; else if (rgb) placed++;
    });
  }

  let done = 0;
  for (const [tag, c] of cands) {
    opts.onProgress?.(++done, cands.size);
    if (elsewhere.has(tag)) { skip('used outside page content'); continue; }
    const place = minInch.get(tag);
    if (!place || !(place.inchX > 0) || !(place.inchY > 0)) { skip('not placed'); continue; }
    const d = c.obj.dict;
    const w = lookup(d.get(PDFName.of('Width')))?.asNumber?.(), h = lookup(d.get(PDFName.of('Height')))?.asNumber?.();
    if (!(w > 0 && h > 0)) { skip('size'); continue; }
    if (opts.scan && c.kind.startsWith('rgb') && place.inchX >= _SCAN_MIN_INCH && place.inchY >= _SCAN_MIN_INCH
        && w * h <= opts.scan.maxMegapixels * 1e6) {
      const old = c.obj.contents.length;
      let r;
      try { r = _scanReplace(c, w, h, Math.min(w / place.inchX, h / place.inchY), opts.scan.dpi, JpegImage, ctx); }
      catch { r = 'scan: decode error'; }
      if (r === true) { replaced++; scans++; before += old; after += ctx.lookup(c.ref).contents.length; continue; }
      skip(r);   // then as any other figure
    }
    const own = c.kind === 'bitonal' ? opts.bitonal : c.kind === 'jpx' || c.kind.startsWith('rgb') ? opts.rgb : opts;
    if (w * h > own.maxMegapixels * 1e6) { skip('too large for this device'); continue; }
    const eff = Math.min(w / place.inchX, h / place.inchY);   // the smaller axis dpi: the conservative one
    const { target, quality } = own;
    // A soft mask may differ in size from its image (readers scale it), except one
    // with /Matte: its samples are pre-multiplied against the image's own pixels,
    // so the two must keep the same size — such an image is not downsampled.
    const sm = lookup(d.get(PDFName.of('SMask')));
    const matte = sm instanceof PDFRawStream && sm.dict.has(PDFName.of('Matte'));
    const shrink = target && eff > target * 1.1 && !matte;
    // placed figures: only those this pass downsamples — the rest stay with worker.js, decoded never
    if (c.kind.startsWith('rgb') && !shrink) { skip('placed: at or below the target'); continue; }
    if (c.kind === 'bitonal' && !shrink) { skip('1-bit: at or below the target'); continue; }
    if (medianPage && c.kind === 'rgb-dct' && w * h <= 12_000_000 && Math.max(w, h) >= 600
        && c.nc === 3 && !(d.get(PDFName.of('ColorSpace')) instanceof PDFArray)
        && d.get(PDFName.of('Filter')) === PDFName.of('DCTDecode')
        && !['Decode', 'DecodeParms', 'SMask', 'SMaskInData'].some(key => d.has(PDFName.of(key)))
        && Math.abs(place.inchX * 72 / medianPage.width - 1) <= 0.01
        && Math.abs(place.inchY * 72 / medianPage.height - 1) <= 0.01
        && Math.abs((w / place.inchX) / (h / place.inchY) - 1) <= 0.01) {
      const estimatedDpi = Math.round((w / medianPage.width + h / medianPage.height) * 36);
      if (estimatedDpi > target * 1.1 && _cmykdPlainRgbJpeg(c.obj.contents, w, h)) {
        // The main encoder can resize and encode this scan in one pass.
        deferred++;
        continue;
      }
    }
    let samples;
    try {
      if (c.kind === 'bitonal') {
        samples = _cmykdBitonalSamples(c, w, h, opts.urls);
        if (!samples) { skip('1-bit: shorter than its size'); continue; }
      } else if (c.kind === 'jpx') {
        if (!_cmykdJpxMatchesHeader(c.obj.contents, w, h, c.nc)) {
          skip('JPX: codestream does not match PDF image');
          continue;
        }
        samples = JpxImage.decode(c.obj.contents, { numComponents: c.nc, isIndexedColormap: false, smaskInData: false });
        if (samples?.length !== w * h * c.nc) { skip('JPX: not decodable at its size'); continue; }
      } else if (c.kind === 'rgb-dct') {
        const j = new JpegImage();
        j.parse(c.obj.contents);
        if (j.numComponents !== c.nc || j.width !== w || j.height !== h) { skip('placed: JPEG does not match its dictionary'); continue; }
        samples = j.getData({ width: w, height: h, forceRGB: false, isSourcePDF: true });
      } else if (c.kind === 'dct') {
        if (progressive(c.obj.contents)) { skip('progressive JPEG'); continue; }
        const r = decode(c.obj.contents);
        if (!r || r.w !== w || r.h !== h) { skip('JPEG not decodable as Adobe CMYK at its size'); continue; }
        samples = r.data;
      } else {
        samples = decodePDFRawStream(c.obj).decode();
        if (samples.length !== w * h * c.nc) { skip('raw length'); continue; }
      }
    } catch { skip('decode error'); continue; }
    if (c.invert) for (let i = 0; i < samples.length; i++) samples[i] = 255 - samples[i];
    let nw = w, nh = h;
    if (shrink) {
      const s = target / eff;
      nw = Math.max(1, Math.round(w * s)); nh = Math.max(1, Math.round(h * s));
      samples = _cmykdDownsample(samples, w, h, c.nc, nw, nh);
    }
    if (c.kind === 'bitonal') {   // still 1 bit, as Flate: not for the JPEG batch
      const flat = ctx.flateStream(_cmykdPackBits(samples, nw, nh)).contents;
      if (flat.length >= c.obj.contents.length) { skip('1-bit: not smaller'); continue; }
      const dict = c.obj.dict;
      dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
      dict.delete(PDFName.of('DecodeParms'));
      dict.set(PDFName.of('Width'), PDFNumber.of(nw));
      dict.set(PDFName.of('Height'), PDFNumber.of(nh));
      ctx.assign(c.ref, PDFRawStream.of(dict, flat));
      replaced++; bitonal++; before += c.obj.contents.length; after += flat.length;
      continue;
    }
    if (pending.length && (pending[0].quality !== quality ||
        pendingBytes + samples.length > CMYKD_BATCH_BYTES)) await flush();
    pending.push({ c, nc: c.nc, quality, w: nw, h: nh, samples, old: c.obj.contents.length });
    pendingBytes += samples.length;
    if (pendingBytes >= CMYKD_BATCH_BYTES) await flush();
  }
  await flush();
  return { replaced, jpx, placed, bitonal, scans, deferred, before, after, skipped };
}

// Published on the worker's global, as pdfEncrypt.js does (an unexported function
// would also be dropped by the module minify).
if (typeof self !== 'undefined') self.cmykD = cmykD;
})();
