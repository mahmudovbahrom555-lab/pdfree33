// tests/compressPrep.test.js — js/compressPrepWorker.js's XMP pass, in Node.
//
// InDesign and Photoshop put XMP metadata on each placed image; Compress
// removed only the catalog's, so 12.2 of 29.5 MB stayed in a Maximum output
// (2026-11-04). The pass removes /Metadata from every object but the catalog
// (handleCompress removes that one) AND the streams — pdf-lib writes
// unreferenced objects, so dropping the keys alone saved nothing.
// Same extraction as tests/cleanScanWorker.integration.test.js: the worker's
// source without importScripts/self.onmessage, pdf-lib from node_modules.
//
// Run: node tests/compressPrep.test.js

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import * as PDFLib from 'pdf-lib';
import { deflateSync, inflateSync } from 'zlib';

const { PDFDocument, PDFName, PDFRawStream, PDFRef } = PDFLib;
globalThis.PDFLib = PDFLib;
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../js/compressPrepWorker.js'), 'utf8')
  .replace(/importScripts\([^)]+\);?/g, 'void 0;')
  .replace(/self\.onmessage\s*=[\s\S]*?^};/m, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const { _encodeRawImages, _mayHaveObjectXmp } = await new AsyncFunction(src + '\nreturn { _encodeRawImages, _mayHaveObjectXmp };')();

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); failed++; }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// A page with a JPEG-like image; XMP on the catalog, and optionally on the
// image and the page (each 200 KB of unfiltered XML, as InDesign writes it).
async function build({ objectXmp }) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 200]);
  const xmp = () => pdf.context.register(PDFRawStream.of(
    pdf.context.obj({ Type: 'Metadata', Subtype: 'XML' }), new TextEncoder().encode('<x:xmpmeta>' + 'h'.repeat(200000) + '</x:xmpmeta>')));
  pdf.catalog.set(PDFName.of('Metadata'), xmp());
  const imgDict = pdf.context.obj({ Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'FlateDecode' });
  if (objectXmp) imgDict.set(PDFName.of('Metadata'), xmp());
  const img = pdf.context.register(PDFRawStream.of(imgDict, pdf.context.flateStream(new Uint8Array([128])).contents));
  page.node.set(PDFName.of('Resources'), pdf.context.obj({ XObject: { Im0: img } }));
  if (objectXmp) page.node.set(PDFName.of('Metadata'), xmp());
  // InDesign: a placed image's XMP on the marked-content properties inside the page's resources
  if (objectXmp) page.node.Resources().set(PDFName.of('Properties'), pdf.context.obj({ MC0: pdf.context.obj({ Metadata: xmp() }) }));
  return (await pdf.save({ useObjectStreams: false })).buffer;
}

console.log('\n🗜️  compressPrepWorker — XMP on objects:');

await test('XMP on an image, a page and marked-content properties: keys and streams gone, the catalog\'s left, the file smaller', async () => {
  const input = await build({ objectXmp: true });
  const before = input.byteLength;
  const out = await _encodeRawImages(input.slice(0), true);
  assert(out.xmp === 3, `removed ${out.xmp}, expected 3 (image, page, marked-content properties)`);
  assert(out.result.byteLength < before - 550000, `${before} → ${out.result.byteLength}: the streams were not dropped`);
  const pdf = await PDFDocument.load(out.result);
  assert(pdf.catalog.has(PDFName.of('Metadata')), 'the catalog\'s XMP was removed (handleCompress\'s job, by preset)');
  const page = pdf.getPage(0);
  assert(!page.node.has(PDFName.of('Metadata')), 'the page still has /Metadata');
  const img = pdf.context.lookup(page.node.Resources().lookup(PDFName.of('XObject')).get(PDFName.of('Im0')));
  assert(!img.dict.has(PDFName.of('Metadata')), 'the image still has /Metadata');
  const mc0 = page.node.Resources().lookup(PDFName.of('Properties')).lookup(PDFName.of('MC0'));
  assert(!mc0.has(PDFName.of('Metadata')), 'the marked-content properties still have /Metadata');
});

await test('Light (stripXmp off): the input comes back as it is', async () => {
  const input = await build({ objectXmp: true });
  const out = await _encodeRawImages(input, false);
  assert(out.result === input && out.xmp === 0, 'the file was changed on Light');
});

await test('only the catalog has XMP: no parse, the input comes back as it is', async () => {
  const input = await build({ objectXmp: false });
  assert(!_mayHaveObjectXmp(new Uint8Array(input)), 'the scan saw object XMP where there is none');
  const out = await _encodeRawImages(input, true);
  assert(out.result === input && out.xmp === 0, 'the file was changed');
});

await test('the scan sees XMP on objects', async () => {
  assert(_mayHaveObjectXmp(new Uint8Array(await build({ objectXmp: true }))), 'missed');
});

// ── Flate L for CMYK images (criteria v0.2, owner 2026-11-05) ─────────────
// A CMYK Flate image deflated again — the same decoded samples, fewer bytes —
// on Standard/Maximum, never on Light or a signed file (T12).
console.log('\n🗜️  compressPrepWorker — CMYK Flate images, lossless:');

const W = 300, H = 200;
function cmykSamples() {                     // smooth photo-like CMYK, deterministic
  const a = new Uint8Array(W * H * 4);
  let r = 7;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    r = (r * 1103515245 + 12345) & 0x7fffffff;
    const i = (y * W + x) * 4, n = r % 7;
    a[i] = 128 + 100 * Math.sin(x / 40) + n; a[i + 1] = 100 + 80 * Math.cos(y / 30) + n;
    a[i + 2] = 90 + 60 * Math.sin((x + y) / 50) + n; a[i + 3] = 20 + n;
  }
  return a;
}
const pngUp = (a, rowLen) => {               // PNG "Up" predictor rows, as a writer stores them
  const out = new Uint8Array((rowLen + 1) * H);
  for (let y = 0; y < H; y++) {
    out[y * (rowLen + 1)] = 2;
    for (let x = 0; x < rowLen; x++) out[y * (rowLen + 1) + 1 + x] = (a[y * rowLen + x] - (y ? a[(y - 1) * rowLen + x] : 0)) & 255;
  }
  return out;
};

// one CMYK image (stored at zlib level 1, as some writers do), used twice on a page
async function cmykPdf({ data = deflateSync(cmykSamples(), { level: 1 }), extra = {}, cs = 'DeviceCMYK' } = {}) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  const dict = pdf.context.obj({ Type: 'XObject', Subtype: 'Image', Width: W, Height: H, ColorSpace: cs, BitsPerComponent: 8, Filter: 'FlateDecode', Decode: [1, 0, 1, 0, 1, 0, 1, 0], ...extra });
  const img = pdf.context.register(PDFRawStream.of(dict, data));
  page.node.set(PDFName.of('Resources'), pdf.context.obj({ XObject: { Im0: img, Im1: img } }));
  return (await pdf.save({ useObjectStreams: false })).buffer;
}
const imageOf = async buf => {
  const pdf = await PDFDocument.load(buf);
  const xo = pdf.getPage(0).node.Resources().lookup(PDFName.of('XObject'));
  return { pdf, ref0: xo.get(PDFName.of('Im0')), ref1: xo.get(PDFName.of('Im1')), img: pdf.context.lookup(xo.get(PDFName.of('Im0'))) };
};

await test('a CMYK Flate image: fewer bytes, the same samples, the dictionary as it was, still one shared object', async () => {
  const input = await cmykPdf();
  const before = (await imageOf(input)).img;
  const out = await _encodeRawImages(input.slice(0), true, true);
  assert(out.cmyk === 1, `repacked ${out.cmyk}, expected 1`);
  const { img, ref0, ref1 } = await imageOf(out.result);
  assert(img.contents.length < before.contents.length, `${before.contents.length} → ${img.contents.length} bytes`);
  assert(Buffer.compare(inflateSync(img.contents), inflateSync(before.contents)) === 0, 'decoded samples differ');
  for (const k of ['ColorSpace', 'BitsPerComponent', 'Decode', 'Filter', 'Width', 'Height'])
    assert(String(img.dict.get(PDFName.of(k))) === String(before.dict.get(PDFName.of(k))), `/${k} changed`);
  assert(ref0 instanceof PDFRef && ref0 === ref1, 'the two uses no longer share one object');
});

await test('a PNG predictor (/DecodeParms) is kept and the stored rows stay identical', async () => {
  const rows = pngUp(cmykSamples(), W * 4);
  const input = await cmykPdf({ data: deflateSync(rows, { level: 1 }), extra: { DecodeParms: { Predictor: 15, Colors: 4, Columns: W, BitsPerComponent: 8 } } });
  const out = await _encodeRawImages(input.slice(0), true, true);
  assert(out.cmyk === 1, `repacked ${out.cmyk}`);
  const { img } = await imageOf(out.result);
  assert(String(img.dict.get(PDFName.of('DecodeParms'))).includes('/Predictor 15'), 'DecodeParms lost');
  assert(Buffer.compare(inflateSync(img.contents), Buffer.from(rows)) === 0, 'stored rows differ');
});

await test('Light, or a signed file (cmykFlate off): the input comes back as it is', async () => {
  const input = await cmykPdf();
  const out = await _encodeRawImages(input, true, false);
  assert(out.result === input && out.cmyk === 0, 'the file was changed');
});

await test('a damaged stream (cut short) is left byte for byte', async () => {
  const good = deflateSync(cmykSamples(), { level: 1 });
  const input = await cmykPdf({ data: good.subarray(0, Math.floor(good.length * 0.6)) });
  const out = await _encodeRawImages(input, true, true);
  assert(out.cmyk === 0, 'a cut stream was repacked — its missing rows would be baked in as "the image"');
});

await test('a whole stream one row short of /Width × /Height is left as it is', async () => {
  // inflates without an error, so only the length check stands between it and a repack
  const input = await cmykPdf({ data: deflateSync(cmykSamples().subarray(0, W * (H - 1) * 4), { level: 1 }) });
  const out = await _encodeRawImages(input, true, true);
  assert(out.cmyk === 0, 'repacked a stream whose length doesn\'t match the image');
});

await test('not CMYK, or CMYK with a soft mask: not touched', async () => {
  for (const [label, opts] of [
    ['DeviceRGB', { cs: 'DeviceRGB', data: deflateSync(cmykSamples().subarray(0, W * H * 3), { level: 1 }) }],
    ['SMask', { extra: { SMask: PDFName.of('None') } }],
  ]) {
    const input = await cmykPdf(opts);
    const out = await _encodeRawImages(input, true, true);
    assert(out.cmyk === 0, `${label} repacked`);
  }
});

await test('two images, same samples, different /Decode: never left with the same bytes', async () => {
  // handleCompress merges images by their stream bytes alone (worker.js _deduplicateImages):
  // re-deflating both to identical bytes would hand one the other's /Decode — an inverted picture
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  const mk = (level, decode) => pdf.context.register(PDFRawStream.of(pdf.context.obj({ Type: 'XObject', Subtype: 'Image', Width: W, Height: H, ColorSpace: 'DeviceCMYK', BitsPerComponent: 8, Filter: 'FlateDecode', Decode: decode }), deflateSync(cmykSamples(), { level })));
  const a = mk(1, [0, 1, 0, 1, 0, 1, 0, 1]), b = mk(2, [1, 0, 1, 0, 1, 0, 1, 0]);
  page.node.set(PDFName.of('Resources'), pdf.context.obj({ XObject: { Im0: a, Im1: b } }));
  const out = await _encodeRawImages((await pdf.save({ useObjectStreams: false })).buffer, true, true);
  const doc = await PDFDocument.load(out.result);
  const xo = doc.getPage(0).node.Resources().lookup(PDFName.of('XObject'));
  const ca = doc.context.lookup(xo.get(PDFName.of('Im0'))).contents, cb = doc.context.lookup(xo.get(PDFName.of('Im1'))).contents;
  assert(Buffer.compare(Buffer.from(ca), Buffer.from(cb)) !== 0, 'the two streams now have identical bytes');
  assert(out.cmyk === 1, `repacked ${out.cmyk}: one may go, the second would collide`);
});

await test('already as small as the encoder makes it: not touched', async () => {
  const input = await cmykPdf({ data: deflateSync(cmykSamples(), { level: 9 }) });
  const out = await _encodeRawImages(input, true, true);
  assert(out.cmyk === 0, 'repacked to no gain');
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
