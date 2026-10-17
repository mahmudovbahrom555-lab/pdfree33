// tests/pdfActualText.test.js — marked-content /ActualText: read from the
// content stream (js/pdfActualText.js) and applied to pdf.js text items
// (textLayoutUtils.applyActualText). Chrome and LibreOffice put the real
// Arabic letters there; pdf.js drops it (2026-10-17).
//
// Run: node tests/pdfActualText.test.js

import { strict as assert } from 'assert';
import * as PDFLib from 'pdf-lib';
import { actualTextSpans } from '../js/pdfActualText.js';
import { applyActualText } from '../js/textLayoutUtils.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const { PDFDocument, PDFName } = PDFLib;
const utf16 = s => '<FEFF' + [...s].map(c => c.charCodeAt(0).toString(16).padStart(4, '0')).join('').toUpperCase() + '>';

// a one-page document whose page content is `ops`; `props`: /Properties
// resources by name; `form`: a Form XObject /F1 with that content
async function docWith(ops, { props = {}, form = null } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const ctx = doc.context;
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(ops)));
  const res = ctx.obj({});
  if (Object.keys(props).length) {
    res.set(PDFName.of('Properties'), ctx.obj(Object.fromEntries(Object.entries(props).map(([k, v]) =>
      [k, ctx.obj({ ActualText: PDFLib.PDFHexString.fromText(v) })]))));
  }
  if (form) {
    const f = ctx.flateStream(form, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 200] });
    res.set(PDFName.of('XObject'), ctx.obj({ F1: ctx.register(f) }));
  }
  page.node.set(PDFName.of('Resources'), res);
  return PDFDocument.load(await doc.save());
}

await test('BDC with an inline /ActualText (UTF-16), BMC and plain BDC, in order', async () => {
  const d = await docWith(`/Span <</ActualText ${utf16('ي')}>> BDC BT (x) Tj ET EMC /Artifact BMC EMC /P <</MCID 0>> BDC EMC`);
  assert.deepEqual(actualTextSpans(PDFLib, d, 0), ['ي', null, null]);
});

await test('BDC naming a /Properties resource', async () => {
  const d = await docWith('/Span /MC0 BDC EMC', { props: { MC0: 'لإ' } });
  assert.deepEqual(actualTextSpans(PDFLib, d, 0), ['لإ']);
});

await test('operators inside strings and inline images are not operators', async () => {
  const d = await docWith(
    'BT (a \\) BDC \\( (nested) BMC) Tj <4244 43> Tj ET BI /W 2 /H 1 /BPC 8 /CS /G ID \x00BDC\xff EI /Span <</ActualText (ok)>> BDC EMC');
  assert.deepEqual(actualTextSpans(PDFLib, d, 0), ['ok']);
});

await test('a Form XObject\'s marked content, where it is drawn', async () => {
  const d = await docWith(`/A BMC EMC /F1 Do /Span <</ActualText (z)>> BDC EMC`, { form: `/Span <</ActualText ${utf16('م')}>> BDC EMC` });
  assert.deepEqual(actualTextSpans(PDFLib, d, 0), [null, 'م', 'z']);
});

// pdf.js items: the shape getTextContent({ includeMarkedContent: true }) returns
const it = (str, x, w, y = 700) => ({ str, transform: [12, 0, 0, 12, x, y], width: w, dir: 'rtl' });
const B = { type: 'beginMarkedContentProps', tag: 'Span' }, E = { type: 'endMarkedContent' };

await test('Chrome\'s initial yeh: Persian form (ToUnicode) → Arabic form, same position', async () => {
  // "يقدم": the glyph's ToUnicode says U+FBFE, its ActualText ي
  const out = applyActualText([B, it('ﯾ', 82, 3), E], ['ي']);
  assert.equal(out.length, 1);
  assert.equal(out[0].str, 'ﻳ');                 // ARABIC LETTER YEH INITIAL FORM
  assert.equal(out[0].str.normalize('NFKC'), 'ي');
  assert.equal(out[0].transform[4], 82);
});

await test('a word space drawn inside the span stays an item of its own, where it was', async () => {
  const out = applyActualText([B, it(' ً', 108, 0), it(' ', 97, 9), it('ﻼ', 104, 8), E], ['لًا']);
  assert.deepEqual(out.map(i => i.str), [' ', 'لًا']);
  assert.equal(out[0].transform[4], 97);
  assert.equal(out[1].transform[4], 104);   // the letter's glyph, not the mark's
});

await test('a span that adds nothing keeps its items (a lam-alef ligature)', async () => {
  const items = [B, it('ﻺ', 86, 8), E];
  assert.equal(applyActualText(items, ['لإ'])[0].str, 'ﻺ');
});

await test('LibreOffice: a letter with its vowel mark from a glyph with no Unicode', async () => {
  const out = applyActualText([B, it('ِم\u0001', 424, 0), E, it('x', 1, 5)], ['مِ']);
  assert.deepEqual(out.map(i => i.str), ['مِ', 'x']);
});

await test('an outer ActualText covers inner spans; text outside spans passes', async () => {
  const out = applyActualText([it('a', 1, 1), B, B, it('b', 5, 1), E, it('c', 7, 1), E], ['b-c', 'inner']);
  assert.deepEqual(out.map(i => i.str), ['a', 'b-c']);
});

await test('markers and spans that don\'t pair one for one: items unchanged, markers dropped', async () => {
  const out = applyActualText([B, it('ﯾ', 82, 3), E, B, E], ['ي']);
  assert.deepEqual(out.map(i => i.str), ['ﯾ']);
});

await test('a raised vowel mark or unmapped glyph: the letter\'s baseline', async () => {
  // DecoType Naskh: "مَٰ" — fatha and a glyph with no Unicode (superscript alef) drawn 6pt up
  const out = applyActualText([B, it('\u0000\u064E', 494.5, 7, 706), it('\u0645', 496.7, 2.5), E], ['مَٰ']);
  assert.deepEqual(out.map(i => [i.str, i.transform[5]]), [['مَٰ', 700]]);
});

await test('a file\'s ActualText that doesn\'t fit its glyphs is not taken: footnote "34", ActualText "(3"', async () => {
  // Adobe PDF Library, corpus 3836300: PDF→Word wrote "(3)" for (34)
  // a page where it misses this often is off as a whole — its brackets were shifted too
  const out = applyActualText([B, it(')', 332.2, 3), E, B, it('34', 335.2, 7.5), E], ['(', '(3']);
  assert.deepEqual(out.map(i => i.str), [')', '34']);
  // and one that only adds what the glyphs lost still is: a lam-kaf ligature read as its kaf
  assert.equal(applyActualText([B, it('ك', 10, 6), E], ['كل'])[0].str, 'كل');
});

await test('ActualText with no letters (a kashida InDesign draws as lam), or another script\'s digits, is taken', async () => {
  assert.equal(applyActualText([B, it('لللل', 10, 12), E], ['ــــ'])[0].str, 'ــــ');
  assert.equal(applyActualText([B, it('\u0661', 10, 4), E], ['\u06F1'])[0].str, '\u06F1');   // Chrome: ١ glyph, ۱ text
  assert.equal(applyActualText([B, it('لني', 10, 9), E], ['ني'])[0].str, 'ني');                  // a kashida drawn as lam
  assert.equal(applyActualText([B, it('حت', 10, 9), E], ['تح'])[0].str, 'تح');                    // a ligature mapped backwards
  assert.equal(applyActualText([B, it('ه', 10, 5), E], ['ہ'])[0].str, 'ہ');                       // Urdu heh goal
  assert.equal(applyActualText([B, it('\uFED1', 10, 6), E], ['\uFEBD'])[0].str, '\uFEBD');   // Adobe: ض mapped as ف
});

await test('a span over two lines keeps its items', async () => {
  const out = applyActualText([B, it('a', 1, 1, 700), it('b', 1, 1, 680), E], ['ab']);
  assert.deepEqual(out.map(i => i.str), ['a', 'b']);
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
