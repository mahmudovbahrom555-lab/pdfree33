// pdfSafetyScan (js/pdfSafetyScan.js): what a PDF can do besides showing its
// pages, found without running anything. Every file here is built by the test
// itself — no real malicious document is stored or opened.
import * as PDFLib from 'pdf-lib';
import { rawScan, scanPdf, describeUri, fileRisk } from '../js/pdfSafetyScan.js';

const { PDFDocument, PDFName, PDFString, PDFHexString } = PDFLib;
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const enc = s => new TextEncoder().encode(s);

async function base(pages = 1) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([300, 300]).drawText('hello', { x: 20, y: 200 });
  return doc;
}
const jsAction = (doc, code) => doc.context.obj({ Type: 'Action', S: 'JavaScript', JS: PDFString.of(code) });
const types = r => r.findings.map(f => `${f.kind}:${f.type}`);

console.log('\npdfSafetyScan:');

await test('a plain document has nothing to report', async () => {
  const r = await scanPdf(await (await base()).save(), PDFLib);
  assert(r.findings.length === 0, `expected nothing, got ${JSON.stringify(types(r))}`);
  assert(r.level === 'none' && r.pages === 1 && !r.encrypted && !r.signed, JSON.stringify({ level: r.level, pages: r.pages }));
});

await test('a script run when the document opens: found, with what it calls', async () => {
  const doc = await base();
  doc.catalog.set(PDFName.of('OpenAction'), doc.context.register(jsAction(doc, 'app.launchURL("http://x.example/");')));
  const r = await scanPdf(await doc.save(), PDFLib);
  const f = r.findings.find(x => x.type === 'JavaScript');
  assert(f && f.where === 'when the document opens' && f.risk === 'high', JSON.stringify(r.findings));
  assert(f.calls.includes('app.launchURL'), `calls: ${f.calls}`);
  assert(r.level === 'high', r.level);
});

await test('found in a compressed object stream, where the bytes show nothing', async () => {
  const doc = await base();
  doc.catalog.set(PDFName.of('OpenAction'), doc.context.register(jsAction(doc, 'eval(unescape("%u4141"))')));
  const bytes = await doc.save({ useObjectStreams: true });
  assert(rawScan(bytes).counts.JavaScript === 0, 'the raw pass should not see inside the object stream');
  const r = await scanPdf(bytes, PDFLib);
  const f = r.findings.find(x => x.type === 'JavaScript');
  assert(f, `structural pass should find it: ${JSON.stringify(types(r))}`);
  assert(f.calls.includes('eval') && f.calls.includes('unescape'), `calls: ${f.calls}`);
});

await test('a page action, a launch and a chained /Next action are each found where they sit', async () => {
  const doc = await base(2);
  const launch = doc.context.obj({ S: 'Launch', F: PDFString.of('cmd.exe') });
  const first = doc.context.obj({ S: 'URI', URI: PDFString.of('https://example.org/'), Next: doc.context.register(launch) });
  doc.getPages()[1].node.set(PDFName.of('AA'), doc.context.obj({ O: doc.context.register(first) }));
  const r = await scanPdf(await doc.save({ useObjectStreams: false }), PDFLib);
  const l = r.findings.find(x => x.type === 'Launch');
  assert(l && l.target === 'cmd.exe' && l.where === 'page 2, on O', JSON.stringify(r.findings));
  assert(r.uris.some(u => u.host === 'example.org'), JSON.stringify(r.uris));
});

await test('links: address, host and what the address itself says', async () => {
  const doc = await base();
  const page = doc.getPages()[0];
  const link = (uri) => doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], A: { S: 'URI', URI: PDFString.of(uri) },
  }));
  page.node.set(PDFName.of('Annots'), doc.context.obj([
    link('https://bit.ly/abc'), link('http://192.168.0.1/login'), link('https://xn--pypal-4ve.com/'), link('javascript:alert(1)'),
  ]));
  const r = await scanPdf(await doc.save(), PDFLib);
  const flags = Object.fromEntries(r.uris.map(u => [u.uri, u.flags]));
  assert(flags['https://bit.ly/abc'].includes('shortener'), JSON.stringify(flags));
  assert(flags['http://192.168.0.1/login'].includes('ip-address') && flags['http://192.168.0.1/login'].includes('not-https'), JSON.stringify(flags));
  assert(flags['https://xn--pypal-4ve.com/'].includes('punycode'), JSON.stringify(flags));
  assert(flags['javascript:alert(1)'].includes('script-scheme'), JSON.stringify(flags));
  assert(r.uris.every(u => u.where === 'page 1, a link'), JSON.stringify(r.uris.map(u => u.where)));
});

await test('an attached file: its name, reported high', async () => {
  const doc = await base();
  await doc.attach(enc('MZ fake'), 'invoice.exe', { mimeType: 'application/octet-stream' });
  const r = await scanPdf(await doc.save(), PDFLib);
  const f = r.findings.find(x => x.kind === 'file');
  assert(f && f.target === 'invoice.exe' && f.risk === 'high', JSON.stringify(r.findings));
});

await test('a name hidden with #xx escapes is decoded and reported', async () => {
  const doc = await base();
  doc.catalog.set(PDFName.of('OpenAction'), doc.context.register(jsAction(doc, 'x=1')));
  let text = new TextDecoder('latin1').decode(await doc.save({ useObjectStreams: false }));
  text = text.replace('/JavaScript', '/Jav#61Script');
  const bytes = Uint8Array.from(text, c => c.charCodeAt(0));
  const raw = rawScan(bytes);
  assert(raw.counts.JavaScript === 1 && raw.escapedNames.includes('JavaScript'), JSON.stringify(raw));
  const r = await scanPdf(bytes, PDFLib);
  assert(types(r).includes('hidden-names:name escapes'), JSON.stringify(types(r)));
  // the parser decodes the name too: the script is still found as a script
  assert(r.findings.some(f => f.type === 'JavaScript'), JSON.stringify(types(r)));
});

await test('a font name\'s "#20" is no hiding', async () => {
  const raw = rawScan(enc('%PDF-1.7\n1 0 obj << /BaseFont /Times#20New#20Roman >> endobj\n%%EOF'));
  assert(raw.escapedCount === 0, JSON.stringify(raw));
});

await test('XFA and a form field\'s own script are found', async () => {
  const doc = await base();
  const field = doc.context.register(doc.context.obj({
    FT: 'Tx', T: PDFString.of('amount'), AA: { K: jsAction(doc, 'event.value = 1') },
  }));
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [field], XFA: PDFHexString.fromText('<xdp/>') }));
  const r = await scanPdf(await doc.save(), PDFLib);
  assert(types(r).includes('xfa:XFA'), JSON.stringify(types(r)));
  assert(r.findings.some(f => f.type === 'JavaScript' && f.where === 'form field "amount", on K'), JSON.stringify(r.findings));
});

await test('bytes inside a stream are data: a "/Jav#61Script" there is not a name', async () => {
  const raw = rawScan(enc('%PDF-1.7\n1 0 obj << /Length 20 >>\nstream\n\x00/Jav#61Script\x01\nendstream\nendobj\n%%EOF'));
  assert(raw.escapedCount === 0 && raw.counts.JavaScript === 0, JSON.stringify(raw));
});

await test('an escaped name that is not one that acts is no hiding', async () => {
  const raw = rawScan(enc('%PDF-1.7\n1 0 obj << /Some#4Bey 1 >> endobj\n%%EOF'));
  assert(raw.escapedCount === 0, JSON.stringify(raw));
});

await test('an attachment\'s risk follows what it is', async () => {
  assert(fileRisk('Press Quality.joboptions') === 'medium', 'settings file');
  assert(fileRisk('invoice.pdf.exe') === 'high' && fileRisk('report.docm') === 'high' && fileRisk('a.zip') === 'high', 'runnable');
  assert(fileRisk('') === 'high', 'a nameless attachment is not known to be harmless');
});

await test('Acrobat\'s field formatting script is said to be formatting, medium', async () => {
  const doc = await base();
  const field = doc.context.register(doc.context.obj({
    FT: 'Tx', T: PDFString.of('total'), AA: { F: jsAction(doc, "AFNumber_Format(2, 0, 0, 0, '$', true);") },
  }));
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [field] }));
  const r = await scanPdf(await doc.save(), PDFLib);
  const f = r.findings.find(x => x.type === 'JavaScript');
  assert(f && f.formatting === true && f.risk === 'medium', JSON.stringify(r.findings));
});

await test('a launch naming its file in a file specification shows the file name', async () => {
  const doc = await base();
  const spec = doc.context.obj({ Type: 'Filespec', F: PDFString.of('other.pdf'), UF: PDFHexString.fromText('other.pdf') });
  doc.catalog.set(PDFName.of('OpenAction'), doc.context.register(doc.context.obj({ S: 'Launch', F: spec })));
  const r = await scanPdf(await doc.save(), PDFLib);
  const f = r.findings.find(x => x.type === 'Launch');
  assert(f && f.target === 'other.pdf', JSON.stringify(r.findings));
});

await test('a link written as a hex string is read like any other', async () => {
  const doc = await base();
  doc.getPages()[0].node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], A: { S: 'URI', URI: PDFHexString.fromText('https://phishing.example.test/login') },
  }))]));
  const r = await scanPdf(await doc.save(), PDFLib);
  assert(r.uris.some(u => u.uri === 'https://phishing.example.test/login' && u.host === 'phishing.example.test'), JSON.stringify(r.uris));
});

await test('describeUri: an ordinary https link carries no flags', async () => {
  assert(describeUri('https://www.example.com/a?b=c').flags.length === 0, 'expected no flags');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
