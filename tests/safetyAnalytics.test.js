// js/safetyAnalytics.js: what the PDF safety check may send to analytics.
// The main test feeds it a report full of one file's own details — its name,
// its links and their sites, a QR code's text, an attachment's name, script
// code, page text — and checks that none of it comes out.
import { safetyReportProps, safetyResultProps, safetyErrorType, pagesBand, countBand } from '../js/safetyAnalytics.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// A file's details, each a string that must never reach analytics.
const SECRETS = ['Q3-salary-review.pdf', 'https://mybank-login.example.test/verify', 'mybank-login.example.test',
  'www.mybank.com', 'invoice.exe', 'app.launchURL("https://evil.example.test/")', 'evil.example.test',
  'WIFI:S:office;T:WPA;P:hunter2;;', 'Dear Mr Smith, your account 4417 1234', 'cmd.exe', 'form field "iban"'];

const report = {
  level: 'high',
  headline: `This PDF can do more than show pages — ${SECRETS[0]}`,
  groups: [
    { group: 'scripts', title: 'A script', items: [{ level: 'high', title: 'A script', where: SECRETS[10], detail: `It calls: ${SECRETS[5]}` }] },
    { group: 'files', title: 'Attached files', items: [{ level: 'high', title: SECRETS[4], detail: `File: ${SECRETS[4]}` }] },
    { group: 'links', title: 'Links', items: [{ level: 'high', title: SECRETS[2], detail: `${SECRETS[1]} — The page shows: ${SECRETS[3]}` }] },
    { group: `programs ${SECRETS[9]}`, title: 'odd', items: [] },   // a group key that isn't one of ours
  ],
  notes: [SECRETS[8]],
};
const scan = { pages: 3, encrypted: false, signed: true, error: null, uris: [{ uri: SECRETS[1], host: SECRETS[2] }], files: [{ name: SECRETS[4] }] };
const extra = { qr: [{ data: SECRETS[7], host: 'office' }], mismatches: [{ uri: SECRETS[1], shown: SECRETS[3] }] };

console.log('\nsafetyAnalytics:');

test('none of a file\'s own details comes out — name, links, sites, QR text, attachment, script, text', () => {
  const out = JSON.stringify([safetyReportProps(report, scan, extra), safetyResultProps('clean', 4), safetyErrorType(SECRETS[0])]);
  const leaked = SECRETS.filter(s => out.includes(s) || out.toLowerCase().includes(s.toLowerCase().slice(0, 12)));
  assert(!leaked.length, `leaked: ${leaked.join(' | ')}\n${out}`);
});

test('only categories from the fixed lists, each value one of its list', () => {
  const p = safetyReportProps(report, scan, extra);
  assert(JSON.stringify(Object.keys(p).sort()) === JSON.stringify(['encrypted', 'kinds', 'level', 'link_mismatch', 'pages', 'qr', 'readable', 'signed', 'tool']), Object.keys(p).join(','));
  assert(p.level === 'high' && p.kinds === 'files+links+other+scripts' && p.qr === 'yes' && p.link_mismatch === 'yes', JSON.stringify(p));
  assert(p.signed === 'yes' && p.encrypted === 'no' && p.readable === 'yes' && p.pages === '2-10', JSON.stringify(p));
});

test('an unknown level, mode or error becomes "other", never the value given', () => {
  assert(safetyReportProps({ level: 'evil.example.test' }, {}).level === 'other', 'level');
  assert(safetyResultProps(SECRETS[0], 1).mode === 'other', 'mode');
  assert(safetyErrorType(SECRETS[1]) === 'other' && safetyErrorType('encrypted') === 'encrypted', 'error');
});

test('counts are bands, not exact numbers', () => {
  assert(pagesBand(1) === '1' && pagesBand(7) === '2-10' && pagesBand(212) === '>200' && pagesBand(NaN) === 'unknown', 'pages');
  assert(countBand(0) === '0' && countBand(3) === '2-5' && countBand(57) === '>20', 'counts');
});

test('a missing report or scan still gives a safe event', () => {
  const p = safetyReportProps(undefined, undefined);
  assert(p.level === 'other' && p.kinds === 'none' && p.pages === 'unknown', JSON.stringify(p));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
