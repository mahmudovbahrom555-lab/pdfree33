// pdfSafetyReport (js/pdfSafetyReport.js): the scan as a person reads it, and
// links that show one site but lead to another. Built PDFs only.
import * as PDFLib from 'pdf-lib';
import { scanPdf } from '../js/pdfSafetyScan.js';
import { buildReport, linkMismatch, siteOf, textUnder } from '../js/pdfSafetyReport.js';

const { PDFDocument, PDFName, PDFString } = PDFLib;
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

console.log('\npdfSafetyReport:');

await test('nothing found says so — and says what a check like this can\'t see', async () => {
  const doc = await PDFDocument.create(); doc.addPage();
  const rep = buildReport(await scanPdf(await doc.save(), PDFLib));
  assert(rep.level === 'none' && rep.headline === 'Nothing that acts was found' && rep.groups.length === 0, JSON.stringify(rep));
  assert(/can't rule out/.test(rep.limits), rep.limits);
  assert(!/safe/i.test(rep.headline), 'never "safe"');
});

await test('a script on open comes first, grouped, with where and what it calls', async () => {
  const doc = await PDFDocument.create(); doc.addPage();
  doc.catalog.set(PDFName.of('OpenAction'), doc.context.register(doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.launchURL("x")') })));
  doc.getPages()[0].node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], A: { S: 'URI', URI: PDFString.of('https://bit.ly/x') } }))]));
  const rep = buildReport(await scanPdf(await doc.save(), PDFLib));
  assert(rep.level === 'high' && rep.groups[0].group === 'scripts', JSON.stringify(rep.groups.map(g => g.group)));
  const s = rep.groups[0].items[0];
  assert(s.where === 'when the document opens' && /app\.launchURL/.test(s.detail), JSON.stringify(s));
  const link = rep.groups.find(g => g.group === 'links').items[0];
  assert(link.title === 'bit.ly' && link.level === 'low' && /shortened/.test(link.why), JSON.stringify(link));
});

await test('the same address many times is one line with a count', async () => {
  const rep = buildReport({ findings: [], uris: [1, 2, 3].map(() => ({ uri: 'https://example.test/', host: 'example.test', flags: [], where: 'page 1, a link' })) });
  const items = rep.groups[0].items;
  assert(items.length === 1 && items[0].count === 3, JSON.stringify(items));
});

await test('signature and encryption notes', async () => {
  const rep = buildReport({ findings: [], uris: [], signed: true, encrypted: true });
  assert(rep.notes.length === 2 && rep.notes.some(n => /signature/.test(n)) && rep.notes.some(n => /encrypted/.test(n)), JSON.stringify(rep.notes));
});

await test('siteOf: the part a person recognises', async () => {
  assert(siteOf('login.secure.bank.com') === 'bank.com', siteOf('login.secure.bank.com'));
  assert(siteOf('www.bank.co.uk') === 'bank.co.uk', siteOf('www.bank.co.uk'));
});

await test('a link showing one site and leading to another is caught; the same site is not', async () => {
  const m = linkMismatch('https://www.mybank.com/login', 'https://mybank-secure.example.test/login');
  assert(m && m.shownSite === 'mybank.com' && m.targetSite === 'example.test', JSON.stringify(m));
  assert(linkMismatch('www.mybank.com', 'https://login.mybank.com/a') === null, 'subdomain of the shown site');
  assert(linkMismatch('Click here to log in', 'https://elsewhere.example.test/') === null, 'plain words are not an address');
  assert(linkMismatch('see section 4.2 of the report', 'https://example.test/') === null, 'a number is not a site');
  assert(linkMismatch('annual-report.pdf', 'https://files.example.test/annual-report.pdf') === null, 'a file name is not a site');
  assert(linkMismatch('README.md', 'https://github.example.test/x/README.md') === null, 'a file name is not a site');
  assert(linkMismatch('mybank.com', 'https://evil.example.test/') !== null, 'a bare site name with a common ending is');
  // seen on 1,098 links of 180 ordinary documents (all 18 flags were false):
  assert(linkMismatch('info@preedybuilders.co.uk', 'mailto:info@preedybuilders.co.uk') === null, 'an e-mail link to the address it shows');
  assert(linkMismatch('support@mybank.com', 'mailto:help@evil.example.com') !== null, 'an e-mail link to another domain');
  assert(linkMismatch('https://www.chafee.csac.ca.gov/', 'http:https://www.chafee.csac.ca.gov') === null, 'a broken address is no other site');
  assert(linkMismatch('https://www.lo material.html', 'https://www.lobsangrampa.org/research-material.html') === null, 'text cut by the link box');
  assert(linkMismatch('https://graphics.stanford.', 'https://graphics.stanford.edu/data/') === null, 'text cut by the link box');
});

await test('textUnder: the text whose middle lies in the link\'s rectangle', async () => {
  const items = [
    { str: 'Visit ', x: 50, y: 700, width: 30, height: 10 },
    { str: 'www.mybank.com', x: 82, y: 700, width: 80, height: 10 },
    { str: 'today', x: 170, y: 700, width: 25, height: 10 },
    { str: 'www.mybank.com', x: 82, y: 600, width: 80, height: 10 },   // the same words on another line
  ];
  assert(textUnder(items, [80, 698, 164, 712]) === 'www.mybank.com', textUnder(items, [80, 698, 164, 712]));
});

await test('a mismatch makes the link high, with what the page shows', async () => {
  const scan = { findings: [], uris: [{ uri: 'https://evil.example.test/a', host: 'evil.example.test', flags: [], where: 'page 1, a link' }] };
  const rep = buildReport(scan, { linkMismatches: [{ uri: 'https://evil.example.test/a', shown: 'www.mybank.com' }] });
  const link = rep.groups[0].items[0];
  assert(rep.level === 'high' && /shows one address but leads to another/.test(link.why) && /The page shows: www\.mybank\.com/.test(link.detail), JSON.stringify(link));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
