// tests/textLayoutUtils.test.js — pure logic tests for js/textLayoutUtils.js,
// currently focused on joinHyphenatedLineEnd() (hyphen-orphan repair for
// pdf2md — see its own header comment for the full rationale). End-to-end
// coverage through the real pdf2md extraction pipeline lives in
// tests/pdf2md.test.js; this file is direct unit coverage of the decision
// function in isolation.
//
// Run: node tests/textLayoutUtils.test.js

import { strict as assert } from 'assert';
import { joinHyphenatedLineEnd, rtlItemsAreVisual, reorderVisualRtlLine, _visualRTLToLogical,
  lineStartMargins, startsIndentedParagraph, linePitch, startsSpacedParagraph } from '../js/textLayoutUtils.js';

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

test('a mixed line written as visual runs ("?", "PDF", one Hebrew run) is put in reading order', () => {
  // Chromium's output for "האם יש הגבלה על גודל קבצי PDF?" (ground-truth set): the
  // runs left to right, the Hebrew run itself already logical inside its item
  const items = [glyph('?', 0, 4), glyph('PDF', 4, 20), glyph('האם יש קבצי', 27, 60)];
  reorderVisualRtlLine(items);
  assert.equal(items.map(i => i.str).join(''), 'האם יש קבצי PDF?');
});

test('direction is judged in content-stream order (seq), not the y-sorted order lines arrive in', () => {
  // Wikipedia (he): runs drawn left to right on baselines 651.2/650.7 plus a raised
  // "[1]" — y-sorting put "[1]" first and hid the visual order (pdf2word regression)
  const run = (str, x, width, seq) => ({ str, x, width, seq, fontSize: 10 });
  const items = [run('1', 425, 5, 2), run('אשר', 294, 126, 0), run('הוא', 535, 17, 5),
    run('חופשי', 438, 28, 3), run('פורמט', 472, 57, 4)];
  reorderVisualRtlLine(items);
  // logical: "הוא פורמט חופשי 1 אשר" — the runs right to left, gaps become spaces
  assert.equal(items.map(i => i.str).join(''), 'הוא פורמט חופשי 1 אשר');
});

test('a stream already running right-to-left (logical) is left untouched', () => {
  const items = [glyph('שלום', 100, 30), glyph('עולם', 60, 30), glyph('זה', 20, 20)];
  const before = items.map(i => i.str);
  reorderVisualRtlLine(items);
  assert.deepEqual(items.map(i => i.str), before);
});

// ── First-line-indent paragraphs (book layout: no gap, first line indented).
const ln = (x, width, rtl = false, str = 'text') => ({ rtl, items: [{ str, x, width, fontSize: 11 }] });
// paragraph breaks a line set produces under startsIndentedParagraph
const breaks = lines => {
  const m = lineStartMargins(lines);
  return lines.slice(1).map((l, i) => startsIndentedParagraph(lines[i], l, m));
};

test('book layout (LTR): an indented line after a margin line starts a paragraph', () => {
  // [indent, margin, margin, indent, margin, margin]
  const lines = [ln(88, 400), ln(72, 416), ln(72, 300), ln(88, 400), ln(72, 416), ln(72, 200)];
  assert.deepEqual(breaks(lines), [false, false, true, false, false]);
});

test('book layout (RTL): the indent is on the right edge', () => {
  // right edges: 504 margin, 488 indented (16pt ≈ 1.5em at 11pt)
  const lines = [ln(88, 400, true), ln(88, 416, true), ln(200, 304, true), ln(88, 400, true), ln(88, 416, true)];
  assert.deepEqual(breaks(lines), [false, false, true, false]);
});

test('hanging indent (list item continuations) never breaks: the previous line is indented too', () => {
  const lines = [ln(72, 416), ln(72, 416), ln(72, 300), ln(90, 398), ln(90, 398), ln(90, 300)];
  assert.deepEqual(breaks(lines), [false, false, true, false, false]); // only where the shift starts
});

test('a centred display formula after a full-width line does not split the sentence', () => {
  // arXiv (2026-10-01): "...can be written as" runs to the right margin, no full stop,
  // then the formula line starts ~2 em in — not a paragraph start
  const lines = [ln(72, 416), ln(72, 416), ln(72, 416, false, 'can be written as'), ln(95, 300, false, 'd r / dt = -grad Phi'),
    ln(72, 416, false, 'where Phi is the potential')];
  assert.deepEqual(breaks(lines), [false, false, false, false]);
});

test('a full-width line ending a sentence still lets the next indented line start a paragraph', () => {
  const lines = [ln(72, 416), ln(72, 416), ln(72, 416, false, 'the end of a paragraph.'), ln(88, 400), ln(72, 416)];
  assert.deepEqual(breaks(lines), [false, false, true, false]);
});

test('centred lines have no dominant margin, so nothing counts as indented', () => {
  const lines = [ln(150, 200), ln(120, 260), ln(170, 160), ln(140, 220), ln(110, 280)];
  assert.deepEqual(breaks(lines), [false, false, false, false]);
});

test('a shift wider than 4 em (block quote, centring) is not a first-line indent', () => {
  const lines = [ln(72, 416), ln(72, 416), ln(72, 416), ln(140, 300), ln(72, 416)];
  assert.deepEqual(breaks(lines), [false, false, false, false]);
});

// ── Paragraph gap measured against the text's own line pitch.
const row = (y, str = 'text', width = 416, x = 72) => ({ y, rtl: false, items: [{ str, x, width, fontSize: 11 }] });
// line pitch 15.4 (1.4 em), paragraph gap 21.45 (1.95 em — under the fixed 2.0 em rule)
const spaced = [row(700), row(684.6), row(669.2, 'end of the paragraph.', 200), row(647.75), row(632.35), row(616.95)];

test('a 1.95 em gap on a 1.4 em pitch starts a paragraph the fixed 2 em rule missed', () => {
  const pitch = linePitch(spaced), m = lineStartMargins(spaced);
  assert.ok(Math.abs(pitch - 15.4) < 0.01, `pitch ${pitch}`);
  assert.deepEqual(spaced.slice(1).map((l, i) => startsSpacedParagraph(spaced[i], l, pitch, m)), [false, false, true, false, false]);
});

test('a taller gap before a display formula does not split the sentence', () => {
  const lines = [row(700), row(684.6), row(669.2, 'can be written as'), row(645, 'x = y + z', 120, 220), row(621, 'where x is'), row(605.6)];
  const pitch = linePitch(lines), m = lineStartMargins(lines);
  assert.deepEqual(lines.slice(1).map((l, i) => startsSpacedParagraph(lines[i], l, pitch, m)), [false, false, false, false, false]);
});

test('too few lines to know the pitch: the rule stays out', () => {
  assert.equal(linePitch([row(700), row(684.6), row(660)]), undefined);
});

const total = passed + failed;
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${total} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
