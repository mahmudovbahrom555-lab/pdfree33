// ============================================================
//  tests/repairWorker.integration.test.js — js/repairWorker.js's
//  repairPdf(), the "Try to repair" offered from the damaged-file error.
//  Same harness as tests/resizeWorker.integration.test.js: the worker's
//  source run as a function (no postMessage in Node).
//
//  The damaged files are built here, one per failure our tools report:
//  a catalog whose /Pages isn't the page tree, a content stream cut short,
//  one that is garbage from its first byte. "Repaired" means
//  the thing that failed now works — pdf-lib's embedPage(), what Resize
//  and Pages per Sheet call — not just that bytes came back.
//  Run: node tests/repairWorker.integration.test.js
// ============================================================

const PDFLib = await import('pdf-lib');
const { PDFDocument, PDFName, PDFRawStream } = PDFLib;
const zlib = await import('zlib');
const { readFileSync } = await import('fs');
const { join, dirname } = await import('path');
const { fileURLToPath } = await import('url');
const __dir = dirname(fileURLToPath(import.meta.url));

global.self = { postMessage: () => {}, PDFLib };
new Function(readFileSync(join(__dir, '../js/pageTreeCounts.js'), 'utf8'))();
const src = readFileSync(join(__dir, '../js/repairWorker.js'), 'utf8')
  .replace(/importScripts\([^)]+\);?/g, '')
  .replace(/self\.onmessage\s*=[\s\S]*?^};/m, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const { repairPdf } = await new AsyncFunction(src + '\nreturn { repairPdf };')();

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); failed++; }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

const LINES = Array.from({ length: 40 }, (_, i) => `BT /F1 12 Tf 72 ${780 - i * 18} Td (Line ${i + 1}) Tj ET`).join('\n');

// A one-page PDF whose content stream is `compressed` (FlateDecode).
async function withContents(compressed) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const dict = doc.context.obj({ Filter: 'FlateDecode', Length: compressed.length });
  page.node.set(PDFName.of('Contents'), doc.context.register(PDFRawStream.of(dict, compressed)));
  return doc.save({ useObjectStreams: false });
}

// What a tool does with the file: embed its pages, draw them, save — the
// contents are decoded at save, which is where "Bad encoding" is thrown.
async function embedsCleanly(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  for (const e of await out.embedPages(doc.getPages())) out.addPage().drawPage(e);
  await out.save();
  return doc;
}
const contentsText = doc => {
  const s = doc.context.lookup(doc.getPage(0).node.get(PDFName.of('Contents')));
  return Buffer.from(s.contents).toString('latin1');
};

console.log('\n🩹 repairWorker repairPdf:');

await test('a content stream cut short (a download that didn\'t finish): the text before the cut is kept, embedPage works', async () => {
  // a page's worth of text: a short stream cut short still inflates in pdf-lib
  const long = Array.from({ length: 400 }, (_, i) => `BT /F1 12 Tf 72 ${780 - (i % 40) * 18} Td (Line ${i + 1} of a long page) Tj ET`).join('\n');
  const good = zlib.deflateSync(Buffer.from(long));
  const damaged = await withContents(good.subarray(0, Math.floor(good.length * 0.8)));
  let threw = false;
  try { await embedsCleanly(damaged); } catch { threw = true; }
  assert(threw, 'the damaged file should fail embedPage before repair (else this test proves nothing)');

  const { result, fixes } = await repairPdf(damaged.buffer.slice(0));
  assert(result && fixes.streams === 1, `fixes ${JSON.stringify(fixes)}`);
  const text = contentsText(await embedsCleanly(result));
  assert(text.includes('(Line 1 ') && text.includes('(Line 250 '), 'the lines before the cut recovered');
  assert(!text.includes('(Line 400 '), 'nothing invented past the cut');
});

await test('damage pdf-lib already reads past is left alone (text a strict check would throw away)', async () => {
  const good = zlib.deflateSync(Buffer.from(LINES));
  const bad = Buffer.from(good);
  bad[bad.length - 2] ^= 0xff;   // the checksum: pdf-lib inflates the data and ignores it
  const { result, fixes } = await repairPdf((await withContents(bad)).buffer.slice(0));
  assert(result === null && fixes.streams === 0, JSON.stringify(fixes));
});

await test('a content stream that is garbage from its first byte (RESIZE-7F84): emptied, the page survives', async () => {
  const damaged = await withContents(Buffer.from('WU' + 'x'.repeat(60)));
  const { result, fixes } = await repairPdf(damaged.buffer.slice(0));
  assert(result && fixes.streams === 1, `fixes ${JSON.stringify(fixes)}`);
  const doc = await embedsCleanly(result);
  assert(doc.getPageCount() === 1, 'page kept');
});

await test('the catalog\'s /Pages pointing at the wrong object: the real page tree is found again', async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([300 + i, 400]).drawText(`page ${i + 1}`);
  const info = doc.context.register(doc.context.obj({ Producer: 'broken writer' }));
  doc.catalog.set(PDFName.of('Pages'), info);
  const damaged = await doc.save({ useObjectStreams: false });
  let threw = false;
  try { (await PDFDocument.load(damaged)).getPageCount(); } catch { threw = true; }
  assert(threw, 'getPageCount should fail before repair');

  const { result, fixes } = await repairPdf(damaged.buffer.slice(0));
  assert(result && fixes.pageTree, `fixes ${JSON.stringify(fixes)}`);
  const fixed = await embedsCleanly(result);
  assert(fixed.getPages().map(p => p.getWidth()).join() === '300,301,302', 'all three pages, in order');
});

await test('/Count entries that don\'t add up (SPLIT-37EA): recounted, every page removable, order kept', async () => {
  const { PDFNumber, PDFPageTree } = PDFLib;
  const doc = await PDFDocument.create();
  for (let i = 0; i < 6; i++) doc.addPage([200 + i, 200]);
  const ctx = doc.context, rootRef = doc.catalog.get(PDFName.of('Pages')), root = ctx.lookup(rootRef);
  const kids = root.Kids().asArray();
  const node = refs => {
    const n = PDFPageTree.withContext(ctx), r = ctx.register(n);
    n.set(PDFName.of('Parent'), rootRef);
    for (const k of refs) { n.Kids().push(k); ctx.lookup(k).set(PDFName.of('Parent'), r); }
    n.set(PDFName.of('Count'), PDFNumber.of(refs.length));
    return [r, n];
  };
  const [ra, a] = node(kids.slice(0, 3)), [rb] = node(kids.slice(3));
  root.set(PDFName.of('Kids'), ctx.obj([ra, rb]));
  a.set(PDFName.of('Count'), PDFNumber.of(5));
  const { result, fixes } = await repairPdf((await doc.save({ useObjectStreams: false })).buffer);
  assert(result && fixes.pageCounts === 1, `expected one node recounted, got ${JSON.stringify(fixes)}`);
  const fixed = await PDFDocument.load(result);
  assert(fixed.getPages().map(p => p.getWidth()).join() === '200,201,202,203,204,205', 'page order changed');
  fixed.removePage(4);
  assert(fixed.getPageCount() === 5, 'removePage after the repair');
});

await test('a healthy file: nothing to fix → null, the original is kept', async () => {
  const doc = await PDFDocument.create();
  doc.addPage().drawText('fine');
  const { result, fixes } = await repairPdf((await doc.save()).buffer);
  assert(result === null && !fixes.pageTree && fixes.streams === 0, JSON.stringify(fixes));
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`repairWorker integration tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
