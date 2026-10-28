// pdfSafetyDisarm (js/pdfSafetyDisarm.js): what acts is taken out, what shows
// stays, and the scanner finds nothing acting in the result. Every file is
// built by the test — no real malicious document is stored or opened.
import * as PDFLib from 'pdf-lib';
import { disarmPdf } from '../js/pdfSafetyDisarm.js';
import { scanPdf, rawScan } from '../js/pdfSafetyScan.js';

const { PDFDocument, PDFName, PDFString, PDFHexString, PDFArray } = PDFLib;
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const enc = s => new TextEncoder().encode(s);
async function base(pages = 1) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([300, 300]).drawText(`page ${i + 1}`, { x: 20, y: 200 });
  return doc;
}
const js = (doc, code) => doc.context.obj({ S: 'JavaScript', JS: PDFString.of(code) });
const acting = r => r.findings.filter(f => f.risk === 'high' || f.risk === 'medium');
const clean = async (bytes, opts) => {
  const d = await disarmPdf(bytes, PDFLib, opts);
  assert(d.status === 'ok', d.status);
  return { d, r: await scanPdf(d.bytes, PDFLib), doc: await PDFDocument.load(d.bytes) };
};

console.log('\npdfSafetyDisarm:');

await test('an open-action script, a page action, a launch: all gone, the scan finds nothing acting', async () => {
  const doc = await base(2);
  doc.catalog.set(PDFName.of('OpenAction'), doc.context.register(js(doc, 'app.alert(1)')));
  doc.getPages()[1].node.set(PDFName.of('AA'), doc.context.obj({ O: { S: 'Launch', F: PDFString.of('cmd.exe') } }));
  const { d, r, doc: out } = await clean(await doc.save());
  assert(acting(r).length === 0, JSON.stringify(acting(r)));
  assert(d.removed.some(x => x.what === 'JavaScript action') && d.removed.some(x => x.what === 'Launch action'), JSON.stringify(d.removed));
  assert(out.getPageCount() === 2, 'pages kept');
});

await test('a script cut loose from everything is not left in the file', async () => {
  const doc = await base();
  doc.context.register(js(doc, 'this.exportDataObject({cName: "x"})'));   // nothing points to it
  const { d, r } = await clean(await doc.save({ useObjectStreams: false }));
  assert(d.orphans >= 1, `orphans ${d.orphans}`);
  assert(rawScan(d.bytes).counts.JavaScript === 0 && acting(r).length === 0, JSON.stringify(rawScan(d.bytes).counts));
});

await test('named destinations stay when the document scripts go', async () => {
  const doc = await base(2);
  const dests = doc.context.obj({ Names: [PDFString.of('chapter2'), doc.context.obj([doc.getPages()[1].ref, PDFName.of('Fit')])] });
  const scripts = doc.context.obj({ Names: [PDFString.of('init'), doc.context.register(js(doc, 'x=1'))] });
  doc.catalog.set(PDFName.of('Names'), doc.context.obj({ Dests: dests, JavaScript: scripts }));
  const { r, doc: out } = await clean(await doc.save());
  const names = out.catalog.lookup(PDFName.of('Names'));
  assert(names.get(PDFName.of('Dests')) && !names.get(PDFName.of('JavaScript')), 'Dests kept, JavaScript gone');
  assert(acting(r).length === 0, JSON.stringify(acting(r)));
});

await test('an attached file is taken out and named in the list', async () => {
  const doc = await base();
  await doc.attach(enc('MZ fake'), 'invoice.exe', { mimeType: 'application/octet-stream' });
  const { d, r } = await clean(await doc.save());
  assert(d.removed.some(x => x.what === 'attached file "invoice.exe"'), JSON.stringify(d.removed));
  assert(!r.findings.some(f => f.kind === 'file') && rawScan(d.bytes).counts.EmbeddedFile === 0, JSON.stringify(r.findings));
});

await test('a form keeps its fields; XFA and the fields\' scripts go', async () => {
  const doc = await base();
  const form = doc.getForm();
  const tf = form.createTextField('amount');
  tf.addToPage(doc.getPages()[0], { x: 20, y: 20, width: 100, height: 20 });
  tf.acroField.dict.set(PDFName.of('AA'), doc.context.obj({ K: js(doc, 'event.value = 1') }));
  doc.catalog.lookup(PDFName.of('AcroForm')).set(PDFName.of('XFA'), PDFHexString.fromText('<xdp/>'));
  // pdf-lib drops XFA itself when it refreshes field appearances on save
  const bytes = await doc.save({ updateFieldAppearances: false, useObjectStreams: false });
  assert(rawScan(bytes).counts.XFA === 1, 'the fixture holds XFA');
  const { d, r, doc: out } = await clean(bytes);
  assert(out.getForm().getFields().map(f => f.getName()).includes('amount'), 'field kept');
  assert(d.removed.some(x => x.what === 'XFA form') && acting(r).length === 0, JSON.stringify({ removed: d.removed, acting: acting(r) }));
});

await test('web links stay by default, go when asked; internal links always stay', async () => {
  const mk = async () => {
    const doc = await base(2);
    const p = doc.getPages()[0];
    p.node.set(PDFName.of('Annots'), doc.context.obj([
      doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], A: { S: 'URI', URI: PDFString.of('https://example.test/') } })),
      doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 20, 10, 30], Dest: [doc.getPages()[1].ref, PDFName.of('Fit')] })),
    ]));
    return doc.save();
  };
  const kept = await clean(await mk());
  assert(kept.r.uris.length === 1 && kept.doc.getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray).size() === 2, 'both links kept');
  const gone = await clean(await mk(), { keepLinks: false });
  assert(gone.r.uris.length === 0 && gone.doc.getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray).size() === 1, 'web link gone, internal link kept');
});

await test('a chain keeps its safe steps: GoTo → JavaScript → GoTo becomes GoTo → GoTo', async () => {
  const doc = await base(2);
  const last = doc.context.obj({ S: 'GoTo', D: [doc.getPages()[0].ref, PDFName.of('Fit')] });
  const mid = doc.context.obj({ S: 'JavaScript', JS: PDFString.of('x'), Next: doc.context.register(last) });
  doc.catalog.set(PDFName.of('OpenAction'), doc.context.register(doc.context.obj({ S: 'GoTo', D: [doc.getPages()[1].ref, PDFName.of('Fit')], Next: doc.context.register(mid) })));
  const { r, doc: out } = await clean(await doc.save());
  const oa = out.catalog.lookup(PDFName.of('OpenAction'));
  assert(oa.get(PDFName.of('S')).toString() === '/GoTo' && out.context.lookup(oa.get(PDFName.of('Next'))).get(PDFName.of('S')).toString() === '/GoTo', 'GoTo → GoTo');
  assert(acting(r).length === 0, JSON.stringify(acting(r)));
});

await test('a bookmark\'s script goes, the bookmark stays', async () => {
  const doc = await base();
  const outlines = doc.context.nextRef();
  const item = doc.context.register(doc.context.obj({ Title: PDFString.of('Start'), Parent: outlines, A: js(doc, 'app.launchURL("x")') }));
  doc.context.assign(outlines, doc.context.obj({ Type: 'Outlines', First: item, Last: item, Count: 1 }));
  doc.catalog.set(PDFName.of('Outlines'), outlines);
  const { d, doc: out } = await clean(await doc.save());
  const it = out.context.lookup(out.catalog.lookup(PDFName.of('Outlines')).get(PDFName.of('First')));
  assert(it.lookup(PDFName.of('Title')).decodeText() === 'Start' && !it.get(PDFName.of('A')), 'title kept, action gone');
  assert(d.removed.some(x => x.where === 'a bookmark'), JSON.stringify(d.removed));
});

await test('a file whose page tree can\'t be read is reported, not thrown', async () => {
  const doc = await base();
  doc.catalog.set(PDFName.of('Pages'), PDFString.of('broken'));
  const d = await disarmPdf(await doc.save({ useObjectStreams: false }), PDFLib);
  assert(d.status === 'unreadable' && !d.bytes && typeof d.error === 'string', JSON.stringify(d));
});

await test('an encrypted file is not rewritten', async () => {
  const doc = await base();
  doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 2 }));
  const d = await disarmPdf(await doc.save(), PDFLib);
  assert(d.status === 'encrypted' && !d.bytes, JSON.stringify(d));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
