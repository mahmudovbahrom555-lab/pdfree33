// SPDX-License-Identifier: AGPL-3.0-only
// tests/signedPdf.test.js — js/signedPdf.js on real signed PDFs (C28, 2026-11-05).
// Fixtures: tests/fixtures/signed/ (make.py: pyHanko, a throw-away certificate; pdfsig calls the
// three signed ones valid). Run: node tests/signedPdf.test.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectSignature } from '../js/signedPdf.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
const blob = f => new Blob([fs.readFileSync(path.join(DIR, f))]);
const eq = (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

await test('one approval signature', async () => eq(await detectSignature(blob('signed/signed-one.pdf')), { count: 1, certified: false }));
await test('two signatures, the second an incremental update', async () => eq(await detectSignature(blob('signed/signed-two.pdf')), { count: 2, certified: false }));
await test('a certification signature (DocMDP)', async () => eq(await detectSignature(blob('signed/signed-certified.pdf')), { count: 1, certified: true }));
await test('an empty signature field is not a signature', async () => eq(await detectSignature(blob('signed/field-empty.pdf')), null));
await test('a picture of a signature is not a digital signature', async () => eq(await detectSignature(blob('signed/image-signature.pdf')), null));
await test('an ordinary PDF', async () => eq(await detectSignature(blob('normal-3page.pdf')), null));
await test('a /ByteRange split across the 4 MB read boundary is still found', async () => {
  const signed = fs.readFileSync(path.join(DIR, 'signed/signed-one.pdf'));
  const at = signed.indexOf('/ByteRange');
  // pad the front so /ByteRange straddles the first chunk's end; shift the ranges by the padding
  const pad = (4 << 20) - at - 5;
  const text = signed.toString('latin1').replace(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/, (m, a, b, c, d) =>
    `/ByteRange [${a} ${+b + pad} ${+c + pad} ${d}]`.padEnd(m.length, ' '));
  const padded = Buffer.concat([Buffer.alloc(pad, 0x20), Buffer.from(text, 'latin1')]);
  eq(await detectSignature(new Blob([padded])), { count: 1, certified: false });
});
await test('a zero-filled /Contents placeholder (prepared, never signed) is not counted', async () => {
  const s = fs.readFileSync(path.join(DIR, 'signed/signed-one.pdf')).toString('latin1');
  const m = /\/ByteRange\s*\[\s*0\s+(\d+)\s+(\d+)/.exec(s);
  const b = +m[1], c = +m[2];
  const zeroed = s.slice(0, b) + '<' + '0'.repeat(c - b - 2) + '>' + s.slice(c);
  eq(await detectSignature(new Blob([Buffer.from(zeroed, 'latin1')])), null);
});

// Adobe's usage-rights signature (/Perms /UR3, "Rights-Enabled PDF Document") lets Reader fill a
// form; no person signed anything. Counting it put the dialog on every IRS form (the corpus gate
// caught it on f1040 and fw9, deploy 637462a9, 2026-11-05).
const CORPUS = path.join(DIR, '..', 'corpus', 'real');
for (const f of ['irs-f1040-form.pdf', 'irs-fw9-form.pdf']) {
  await test(`a usage-rights signature (/UR3) is not a signature: ${f}`, async () =>
    eq(await detectSignature(new Blob([fs.readFileSync(path.join(CORPUS, f))])), null));
}
await test('a usage-rights signature found only through /Perms /UR3 (no inline TransformMethod)', async () => {
  // fw9 keeps /Perms in a compressed object; written out here in place (same length, offsets kept)
  const s = fs.readFileSync(path.join(CORPUS, 'irs-fw9-form.pdf')).toString('latin1');
  const prefs = '/ViewerPreferences<</DisplayDocTitle 1059 0 R>>/Perms 1076 0 R';
  if (!s.includes(prefs) || !s.includes('1075 0 obj')) throw new Error('fixture changed');
  const hidden = s.replace(prefs, '/Perms<</UR3 1075 0 R>>'.padEnd(prefs.length, ' '))
    .replace(/\/TransformMethod\s*\/UR3/, m => '/TransformMethod/XX3'.padEnd(m.length, ' '));
  eq(await detectSignature(new Blob([Buffer.from(hidden, 'latin1')])), null);
});

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
