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

const { PDFDocument, PDFName, PDFRawStream } = PDFLib;
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

console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
