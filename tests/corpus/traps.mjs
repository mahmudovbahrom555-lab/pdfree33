// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/corpus/traps.mjs — synthetic "trap" PDFs, built at run time with
//  pdf-lib (no binaries committed). Each reproduces an image shape that
//  broke Compress in production on 2026-09-29/30; `expect` states what the
//  compress run must do to it:
//    'untouched'    — image stream + size/filter entries byte-identical
//    'lossless'     — Flate-encoded, decoded pixels identical to the source
//    'recompressed' — replaced by a JPEG (the savings must not be lost)
//  Shared by tests/e2e/compress.e2e.mjs (asserts `expect`) and
//  scripts/corpus-diff (old-vs-new runs over the whole corpus).
// ============================================================

import { PDFDocument, PDFName, PDFRawStream, StandardFonts,
         pushGraphicsState, concatTransformationMatrix, drawObject, popGraphicsState } from 'pdf-lib';
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 1200×1600 so Maximum's DPI downsampling applies on an A4 page.
export const W = 1200, H = 1600;

export const RAW_RGB  = Buffer.alloc(W * H * 3);
export const RAW_GRAY = Buffer.alloc(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 3;
  RAW_RGB[i] = x % 256; RAW_RGB[i + 1] = y % 256; RAW_RGB[i + 2] = 128;
  RAW_GRAY[y * W + x] = (x * 255 / W) | 0;
}

const ICC = fs.readFileSync(path.join(HERE, '..', '..', 'js', 'vendor', 'sRGB2014.icc'));
const CMYK_JPEG = fs.readFileSync(path.join(HERE, '..', 'fixtures', 'cmyk-gradient.jpg'));

// ICC by reference — the shape of a real 6.3 MB raw scan
export const iccRef = pdf => pdf.context.register(pdf.context.obj([PDFName.of('ICCBased'),
  pdf.context.register(pdf.context.stream(ICC, { N: 3 }))]));
// DeviceGray by reference — came out as striped garbage
export const grayRef = pdf => pdf.context.register(PDFName.of('DeviceGray'));

// One full-page image from an already-encoded stream + dict entries
// (entries may be a function of the document, for indirect objects).
export async function imagePdf(bytes, entries) {
  const pdf  = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const img  = pdf.context.register(pdf.context.stream(bytes, {
    Type: 'XObject', Subtype: 'Image', BitsPerComponent: 8, ...(typeof entries === 'function' ? entries(pdf) : entries),
  }));
  page.node.setXObject(PDFName.of('Im0'), img);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(595, 0, 0, 842, 0, 0), drawObject('Im0'), popGraphicsState());
  return pdf.save({ useObjectStreams: false });
}

export async function textPdf() {
  const pdf  = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  page.drawText('Plain text document with no images.', { x: 50, y: 780, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
  return pdf.save({ useObjectStreams: false, updateMetadata: false });
}

// ASCII85 (PDF /ASCII85Decode) encoder, "~>" terminated.
export function ascii85(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 4) {
    const n = Math.min(4, bytes.length - i);
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + (k < n ? bytes[i + k] : 0);
    if (n === 4 && v === 0) { out += 'z'; continue; }
    const c = [];
    for (let k = 0; k < 5; k++) { c.unshift(String.fromCharCode(33 + (v % 85))); v = Math.floor(v / 85); }
    out += c.slice(0, n + 1).join('');
  }
  return out + '~>';
}

export function firstImage(doc) {
  return [...doc.context.enumerateIndirectObjects()].map(([, o]) => o)
    .find(o => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype'))?.toString() === '/Image');
}

// A low-quality JPEG from the real browser encoder — a q=0.72 re-encode can't
// beat it by 10%, which forces handleCompress onto its revert path.
async function lowQualityJpeg(browser) {
  const page = await browser.newPage();
  try {
    return Buffer.from(await page.evaluate(async ({ w, h }) => {
      const c = new OffscreenCanvas(w, h); const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, w, 0); grad.addColorStop(0, '#000'); grad.addColorStop(1, '#fff');
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
      const b = await c.convertToBlob({ type: 'image/jpeg', quality: 0.15 });
      return [...new Uint8Array(await b.arrayBuffer())];
    }, { w: W, h: H }));
  } finally {
    await page.close();
  }
}

/**
 * Every trap as { name, why, expect, bytes, source? } — `source` is the raw
 * pixel buffer a 'lossless' trap must decode back to. Needs a Playwright
 * browser for the one browser-encoded JPEG.
 */
export async function trapCases(browser) {
  const deflate = b => zlib.deflateSync(b);
  const grayGradient = Buffer.alloc(W * H);
  for (let i = 0; i < grayGradient.length; i++) grayGradient[i] = ((i % W) * 255 / W) | 0;
  // PNG "None" row-filter byte before every row — what /Predictor 15 means
  const rgbRows = [];
  for (let y = 0; y < 1000; y++) {
    const r = Buffer.alloc(1 + 800 * 3);
    for (let x = 0; x < 800; x++) { r[1 + x * 3] = (x * 7 + y * 3) & 255; r[2 + x * 3] = y & 255; r[3 + x * 3] = x & 255; }
    rgbRows.push(r);
  }
  // Seeded noise: Flate can't shrink it, so the old JPEG-replacement path
  // actually ran (a regular pattern compressed too well to ever reach the
  // corruption, and the test passed against the buggy build).
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const indices = Buffer.alloc(800 * 1000);
  for (let i = 0; i < indices.length; i++) indices[i] = (rnd() * 4) | 0;
  const gray16 = Buffer.alloc(800 * 1000 * 2);
  for (let i = 0; i < 800 * 1000; i++) gray16.writeUInt16BE(Math.min(65535, (((i % 800) / 800) * 60000 + rnd() * 5000) | 0), i * 2);
  // Photo-like (gradient + mild noise): Flate can't shrink it much, a JPEG can
  const photo = Buffer.alloc(800 * 1000 * 3);
  for (let i = 0; i < photo.length; i++) photo[i] = Math.min(255, ((i % 2400) / 2400 * 200 + rnd() * 40) | 0);

  return [
    { name: 'raw-icc-by-ref', expect: 'lossless', source: RAW_RGB,
      why: 'raw (no /Filter) image, ICC by reference — compressPrepWorker Flate-encodes it',
      bytes: await imagePdf(RAW_RGB, pdf => ({ Width: W, Height: H, ColorSpace: iccRef(pdf) })) },
    { name: 'raw-gray-by-ref', expect: 'untouched',
      why: 'raw DeviceGray by reference — first pre-pass version turned it into stripes',
      bytes: await imagePdf(RAW_GRAY, pdf => ({ Width: W, Height: H, ColorSpace: grayRef(pdf) })) },
    { name: 'gray-flate-revert', expect: 'untouched',
      why: 'revert path kept the downsampled Width/Height (since 2026-05-24)',
      bytes: await imagePdf(deflate(grayGradient), { Width: W, Height: H, ColorSpace: 'DeviceGray', Filter: 'FlateDecode' }) },
    { name: 'low-quality-jpeg-revert', expect: 'untouched',
      why: 'same revert bug on the JPEG branch',
      bytes: await imagePdf(await lowQualityJpeg(browser), { Width: W, Height: H, ColorSpace: 'DeviceRGB', Filter: 'DCTDecode' }) },
    { name: 'indexed-by-ref', expect: 'untouched',
      why: 'by-reference Indexed colour space decoded as RGB — came out solid black',
      bytes: await imagePdf(deflate(indices), pdf => ({ Width: 800, Height: 1000, Filter: 'FlateDecode',
        ColorSpace: pdf.context.register(pdf.context.obj([PDFName.of('Indexed'), PDFName.of('DeviceRGB'), 3,
          pdf.context.register(pdf.context.stream(Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]), {}))])) })) },
    { name: 'png-predictor-flate', expect: 'untouched',
      why: 'pdf-lib ignores /Predictor — row-filter bytes read as pixels (sheared)',
      bytes: await imagePdf(deflate(Buffer.concat(rgbRows)), { Width: 800, Height: 1000, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode',
        DecodeParms: { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: 800 } }) },
    { name: 'gray16-flate', expect: 'untouched',
      why: '16-bit samples read as 8-bit',
      bytes: await imagePdf(deflate(gray16), { Width: 800, Height: 1000, ColorSpace: 'DeviceGray', Filter: 'FlateDecode', BitsPerComponent: 16 }) },
    { name: 'cmyk-jpeg-by-ref', expect: 'untouched',
      why: 'CMYK JPEG re-encoded as RGB but kept its CMYK label',
      bytes: await imagePdf(CMYK_JPEG, pdf => ({ Width: 800, Height: 1000, Filter: 'DCTDecode', Decode: [1, 0, 1, 0, 1, 0, 1, 0],
        ColorSpace: pdf.context.register(PDFName.of('DeviceCMYK')) })) },
    { name: 'ascii85-flate-chain', expect: 'untouched',
      why: 'revert rewrote [/ASCII85Decode /FlateDecode] to a bare /FlateDecode — charts vanished',
      bytes: await imagePdf(Buffer.from(ascii85(deflate(grayGradient))),
        { Width: W, Height: H, ColorSpace: 'DeviceGray', Filter: [PDFName.of('ASCII85Decode'), PDFName.of('FlateDecode')] }) },
    { name: 'icc-n3-by-ref-photo', expect: 'recompressed',
      why: 'plain RGB behind an ICC reference — must keep being recompressed (a real PDF lost 2.15→0.47 MB when it wasn\'t)',
      bytes: await imagePdf(deflate(photo), pdf => ({ Width: 800, Height: 1000, Filter: 'FlateDecode', ColorSpace: iccRef(pdf) })) },
  ];
}
