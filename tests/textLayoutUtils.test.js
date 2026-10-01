// tests/textLayoutUtils.test.js — pure logic tests for js/textLayoutUtils.js,
// currently focused on joinHyphenatedLineEnd() (hyphen-orphan repair for
// pdf2md — see its own header comment for the full rationale). End-to-end
// coverage through the real pdf2md extraction pipeline lives in
// tests/pdf2md.test.js; this file is direct unit coverage of the decision
// function in isolation.
//
// Run: node tests/textLayoutUtils.test.js

import { strict as assert } from 'assert';
import { joinHyphenatedLineEnd, rtlItemsAreVisual, reorderVisualRtlLine, _visualRTLToLogical } from '../js/textLayoutUtils.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

test('a soft line-wrap break is joined with the hyphen dropped', () => {
  const r = joinHyphenatedLineEnd('This word is informa-', 'tion continues here.');
  assert.ok(r, 'expected a join result, got null');
  assert.equal(r.hyphenKept, false);
  assert.equal(r.text, 'This word is information continues here.');
});

test('a known hard-hyphenated compound keeps its hyphen', () => {
  const r = joinHyphenatedLineEnd('a well-', 'known approach');
  assert.ok(r);
  assert.equal(r.hyphenKept, true);
  assert.equal(r.text, 'a well-known approach');
});

test('an ALL-CAPS stem (acronym) keeps its hyphen even when not in the dictionary', () => {
  const r = joinHyphenatedLineEnd('The system is NASA-', 'approved for launch.');
  assert.ok(r);
  assert.equal(r.hyphenKept, true);
  assert.equal(r.text, 'The system is NASA-approved for launch.');
});

test('a mixed-case stem NOT in the dictionary drops the hyphen (default: soft break)', () => {
  const r = joinHyphenatedLineEnd('a quasi-', 'experimental design');
  assert.ok(r);
  assert.equal(r.hyphenKept, false);
  assert.equal(r.text, 'a quasiexperimental design');
});

test('no hyphen at the end of the previous text -> null (not a candidate at all)', () => {
  assert.equal(joinHyphenatedLineEnd('This sentence ends normally.', 'Next sentence.'), null);
});

test('a hyphen followed by a CAPITALIZED next line -> null (new sentence/proper noun, not a broken word)', () => {
  assert.equal(joinHyphenatedLineEnd('Results were inconclusive-', 'Further study is needed.'), null);
});

test('a hyphen followed by a non-letter (digit, punctuation) -> null', () => {
  assert.equal(joinHyphenatedLineEnd('See figure-', '3 for details.'), null);
  assert.equal(joinHyphenatedLineEnd('End of clause-', '"quoted continuation"'), null);
});

test('a single-character stem -> null (too short to be a real word fragment)', () => {
  assert.equal(joinHyphenatedLineEnd('x-', 'ray imaging'), null);
});

test('URL/email-shaped text is never de-hyphenated even if it matches the stem/continuation shape', () => {
  assert.equal(joinHyphenatedLineEnd('Visit our website at example-', 'site.com for more.'), null);
  assert.equal(joinHyphenatedLineEnd('Contact john.doe-', 'test@example.com directly.'), null);
});

test('leading/trailing text around the matched word is preserved verbatim', () => {
  const r = joinHyphenatedLineEnd('  Prefix text informa-', 'tion, and a trailing clause.');
  assert.ok(r);
  assert.equal(r.text, '  Prefix text information, and a trailing clause.');
});

test('empty strings never throw and return null', () => {
  assert.equal(joinHyphenatedLineEnd('', ''), null);
  assert.equal(joinHyphenatedLineEnd('word-', ''), null);
  assert.equal(joinHyphenatedLineEnd('', 'word'), null);
});

test('a Cyrillic soft break is joined the same way as Latin', () => {
  const r = joinHyphenatedLineEnd('Это была насто-', 'ящая проблема.');
  assert.ok(r);
  assert.equal(r.hyphenKept, false);
  assert.equal(r.text, 'Это была настоящая проблема.');
});

// ── rtlItemsAreVisual: pdf.js 3.11 already returns LOGICAL order for RTL text
// (corpus gate 2026-09-30: unconditional reversal left pdf2md recall at ~0.25
// on the Wikipedia ar/he articles). Reversal must only happen on clear evidence.
const rtl = strs => strs.map(str => ({ str, dir: 'rtl' }));
const reversed = strs => strs.map(s => [...s].reverse().join(''));
const HE = ['שלום עולם, זהו מסמך בעברית', 'הספרים נמצאים בחדר הגדול', 'אנחנו לומדים בבית הספר כל יום'];
const AR = ['اللغة العربية هي لغة رسمية', 'في المدرسة الكبيرة مكتبة جميلة', 'الطالب يقرأ الكتاب في الحديقة'];

test('logical-order Hebrew (what pdf.js returns) is not reversed', () => {
  assert.equal(rtlItemsAreVisual(rtl(HE)), false);
});

test('logical-order Arabic (what pdf.js returns) is not reversed', () => {
  assert.equal(rtlItemsAreVisual(rtl(AR)), false);
});

test('visual-order Hebrew and Arabic are detected and restored by _visualRTLToLogical', () => {
  assert.equal(rtlItemsAreVisual(rtl(reversed(HE))), true);
  assert.equal(rtlItemsAreVisual(rtl(reversed(AR))), true);
  assert.equal(_visualRTLToLogical(reversed(HE)[1]), HE[1]);
});

test('standalone لا does not count as visual evidence (it is ال reversed after NFKC)', () => {
  assert.equal(rtlItemsAreVisual(rtl(['لا', 'بالا', 'لا لا لا'])), false);
});

test('undecided pages (one glyph per item, no RTL, LTR items) keep pdf.js order', () => {
  assert.equal(rtlItemsAreVisual(rtl([...'ﻞﻤﺣ'])), false);
  assert.equal(rtlItemsAreVisual([{ str: 'שלום', dir: 'ltr' }, { str: 'Hello', dir: 'ltr' }]), false);
  assert.equal(rtlItemsAreVisual([]), false);
});

// ── reorderVisualRtlLine: Chromium-printed Arabic/Farsi arrives one presentation-
// form glyph per item, drawn left to right. Shapes below mirror the real items
// pdf.js 3.11 returns for tests/corpus/real/wikipedia-{ar,fa}-pdf.pdf.
const glyph = (str, x, width = 5) => ({ str, x, width, fontSize: 10 });
const lineText = items => items.map(i => i.str).join('').normalize('NFKC');

test('a visual glyph stream is reordered right-to-left, with spaces from X-gaps', () => {
  // "صيغة PDF" drawn left to right: P D F, gap, then ﺔ ﻐ ﻴ ﺻ
  const items = [glyph('PDF', 0, 15), glyph('ﺔ', 25), glyph('ﻐ', 30), glyph('ﻴ', 35), glyph('ﺻ', 40)];
  reorderVisualRtlLine(items);
  assert.equal(lineText(items), 'صيغة PDF');
});

test('numbers keep left-to-right digit order; brackets in RTL flow are mirrored back', () => {
  // logical "سال ۱۳۹۹ (pdf)" — both brackets resolve RTL and are drawn mirrored
  const items = [glyph('(', 0), glyph('pdf', 5, 15), glyph(')', 20), glyph('۱', 30), glyph('۳', 35),
    glyph('۹', 40), glyph('۹', 45), glyph('ل', 55), glyph('ا', 60), glyph('س', 65)];
  reorderVisualRtlLine(items);
  assert.equal(lineText(items), 'سال ۱۳۹۹ (pdf)');
});

test('citation brackets between numbers do not join the numbers into one run', () => {
  // logical "متن [6][7]": every bracket resolves RTL and is drawn mirrored, so the
  // glyphs left to right read [ 7 ] [ 6 ] and then the word
  const items = [glyph('[', 0, 3), glyph('7', 3, 5), glyph(']', 8, 3), glyph('[', 11, 3), glyph('6', 14, 5), glyph(']', 19, 3),
    glyph('ﻦ', 30), glyph('ﺘ', 35), glyph('ﻣ', 40)];
  reorderVisualRtlLine(items);
  assert.equal(lineText(items), 'متن [6][7]');
});

test('a broken join with no gap restores the Persian half-space (ZWNJ) pdf.js drops', () => {
  // "نرم‌افزار": isolated ﻡ followed directly by ﺍ — only a ZWNJ breaks that join.
  // Glyphs left to right: ﺭ ﺍ ﺰ ﻓ ﺍ ﻡ ﺮ ﻧ
  const items = [glyph('ﺭ', 0), glyph('ﺍ', 5), glyph('ﺰ', 10), glyph('ﻓ', 15),
    glyph('ﺍ', 20), glyph('ﻡ', 25), glyph('ﺮ', 30), glyph('ﻧ', 35)];
  reorderVisualRtlLine(items);
  assert.equal(lineText(items), 'نرم‌افزار');
});

test('a lam-alef ligature split into same-x items is ordered by right edge', () => {
  // pdf.js: "ال" (alef + lam, width 9) and zero-width "إ" share x — reads "الإ…"
  const items = [glyph('ﺎ', 0), glyph('ﻨ', 10), glyph('ﻧ', 20), glyph('إ', 29, 0), glyph('ال', 29, 9)];
  reorderVisualRtlLine(items);
  assert.ok(lineText(items).startsWith('الإ'), lineText(items));
});

test('a stream already running right-to-left (logical) is left untouched', () => {
  const items = [glyph('שלום', 100, 30), glyph('עולם', 60, 30), glyph('זה', 20, 20)];
  const before = items.map(i => i.str);
  reorderVisualRtlLine(items);
  assert.deepEqual(items.map(i => i.str), before);
});

const total = passed + failed;
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${total} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
