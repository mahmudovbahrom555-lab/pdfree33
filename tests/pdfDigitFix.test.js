// tests/pdfDigitFix.test.js — digits whose ToUnicode names them wrongly
// (class C4, tests/corpus/ERROR_CLASSES.md): found per font, confirmed by the
// glyph's outline (js/digitGlyphs.js), applied to pdf.js text items
// (js/pdfDigitFix.js). Fixtures: tests/fixtures/pdf2word/make-c4-digits.py.
//
// Run: node tests/pdfDigitFix.test.js

import { strict as assert } from 'assert';
import fs from 'fs';
import * as PDFLib from 'pdf-lib';
import { parseToUnicode, pageDigits, applyDigitFix } from '../js/pdfDigitFix.js';
import { digitTemplates } from '../js/digitTemplates.js';
import { digitScore } from '../js/digitGlyphs.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
const fixture = f => PDFLib.PDFDocument.load(fs.readFileSync(new URL(`./fixtures/pdf2word/${f}`, import.meta.url)));
const digitsOf = async f => pageDigits(PDFLib, await fixture(f), 0, new Map(), async () => digitTemplates());

console.log('\nToUnicode CMaps:');
await test('bfchar, bfrange counting up and bfrange with an array', () => {
  const m = parseToUnicode('beginbfchar\n<0001> <0033>\nendbfchar\nbeginbfrange\n<0003> <0005> <0030>\n<0010> <0011> [<0661> <0662>]\nendbfrange');
  assert.equal(m.get(1), '3');
  assert.deepEqual([m.get(3), m.get(4), m.get(5)], ['0', '1', '2']);
  assert.deepEqual([m.get(0x10), m.get(0x11)], ['١', '٢']);
});

console.log('\nThe glyph decides:');
await test('the references score a digit above its neighbour (the templates decode)', () => {
  const t = digitTemplates();
  const two = t.find(x => x.value === 2);
  assert.ok(digitScore(two.img, two.relH, 2, t) > digitScore(two.img, two.relH, 3, t));
});

await test('a drawn "2011, 4096" its ToUnicode names "3122, 5107" is corrected', async () => {
  const fixes = await digitsOf('c4-wrong-digits.pdf');
  assert.ok(fixes, 'nothing found');
  const items = [{ str: 'Invoice 3122, total 5107', fontName: 'f1' }];
  applyDigitFix(items, () => [...fixes.keys()][0], fixes);
  assert.equal(items[0].str, 'Invoice 2011, total 4096');
});

await test('a font whose own cmap is the wrong one changes nothing (its outlines refuse it)', async () => {
  assert.equal(await digitsOf('c4-font-cmap-wrong.pdf'), null);
});

console.log('\nPairing with pdf.js items:');
const fixesFor = list => new Map([['F', list.map(([said, right]) => ({ said, right }))]]);
await test('an item whose digits are not what ToUnicode says keeps its text (pdf.js read it its own way)', () => {
  // the corpus case: ToUnicode in drawing order "8102", pdf.js gave the right "2018"
  const items = [{ str: '2018', fontName: 'f' }];
  applyDigitFix(items, () => 'F', fixesFor([['8', '2'], ['1', '0'], ['0', '1'], ['2', '8']]));
  assert.equal(items[0].str, '2018');
});
await test('a font whose digit count differs from the drawing keeps its text', () => {
  const items = [{ str: '31', fontName: 'f' }];
  applyDigitFix(items, () => 'F', fixesFor([['3', '2'], ['1', '0'], ['2', '1']]));
  assert.equal(items[0].str, '31');
});
await test('items are walked in order, other fonts untouched', () => {
  const items = [{ str: 'a 31', fontName: 'f' }, { str: '31', fontName: 'g' }, { str: '2', fontName: 'f' }];
  applyDigitFix(items, n => (n === 'f' ? 'F' : 'G'), fixesFor([['3', '2'], ['1', '0'], ['2', '1']]));
  assert.deepEqual(items.map(i => i.str), ['a 20', '31', '1']);
});

console.log(`\n${'─'.repeat(50)}\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
process.exit(failed ? 1 : 0);
