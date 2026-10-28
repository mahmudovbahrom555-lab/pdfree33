// tests/textLayoutUtils.test.js — pure logic tests for js/textLayoutUtils.js,
// currently focused on joinHyphenatedLineEnd() (hyphen-orphan repair for
// pdf2md — see its own header comment for the full rationale). End-to-end
// coverage through the real pdf2md extraction pipeline lives in
// tests/pdf2md.test.js; this file is direct unit coverage of the decision
// function in isolation.
//
// Run: node tests/textLayoutUtils.test.js

import { strict as assert } from 'assert';
import { joinSpacedItems, joinSplitNumbers, restoreDroppedSpaces, restoreGlyphOrder, joinHyphenatedLineEnd, rtlItemsAreVisual, reorderVisualRtlLine, _visualRTLToLogical,
  lineStartMargins, startsIndentedParagraph, linePitch, ocrLinePitch, startsSpacedParagraph,
  continuesWrappedHeading, startsAfterHardBreak, localLineEdges, lineRuns , textLayerLooksBroken, toUnifiedIdeographs, joinTouchingItems, dropCjkGapSpaces, isContentsEntry, dropOverprintedText, markLetterSpacing, spacedText } from '../js/textLayoutUtils.js';

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

test('presentation forms decide the order: logical words drawn left to right stay as they are', () => {
  // mPDF, a Persian customs page (corpus 1841524): every word logical, "کالا" on every line —
  // the لا rule voted it visual and every letter came out reversed ("تسا" for "است")
  const page = ['ﻗﻄﻌﺎ', 'ﺑﺎﺷﺪ', 'دﻟﺨﻮاه', 'ﺑﻪ', 'ﻛﻨﺪ', 'ﻛﺎﻻﯾی', 'ﻗﯿﻤﺖ', 'اﻇﻬﺎر'];
  assert.equal(rtlItemsAreVisual(rtl(page)), false);
  assert.equal(rtlItemsAreVisual(rtl(reversed(page))), true);   // a final form first: visual
});

test('a word with a presentation form at one end only still votes, or leaves the vote to its letters', () => {
  // mPDF with a broken font: Private Use glyphs at word ends ("اﻟﻬﺎد" with its ج missing); the
  // words led by ال outvote a few visual items — a version that let them abstain reversed the page
  const page = ['اﻟﻬﺎد', 'اﻹﺳﻼﻣﻲ', 'اﻟﺎﻟﺔ', 'اﻟﻠﻲ', 'اﻟﺎﻣﻞ', 'ﺔﺎاﻟ', 'ﺦﺗﺎر', 'ﺔﺎاﻟ', 'ﺦﺗﺎر'];
  assert.equal(rtlItemsAreVisual(rtl(page)), false);
  // and a word cut short at such a glyph ("اﻷﻣ\uE0B9…", an initial form last) is no vote
  assert.equal(rtlItemsAreVisual(rtl(['اﻷﻣ\uE0B9ﻦ اﻟﺎم', 'ﻟ\uE0C2ﺎﻣﻞ اﻟﻬﺎد', 'اﻷﻣ\uE0B9ﺔ'])), false);
});

test('a final lam-alef ends a word read as stored: ابتلا, مبتلا (Persian) are no visual vote', () => {
  // Microsoft Print to PDF, a Persian article (corpus 5103754): "ابتﻼ" on every line ended in لا
  const page = ['مبتﻼ', 'موارد ابتﻼ', 'بر اثر ابتﻼ به', 'نرخ ابتﻼ در', 'کامﻼ ً شن'];
  assert.equal(rtlItemsAreVisual(rtl(page)), false);
});

test('forms from a broken encoding, joined at random, are no vote', () => {
  // Illustrator, wrong glyph mapping (corpus 0519513): MuPDF reads the same garbage
  assert.equal(rtlItemsAreVisual(rtl(['رﻏﺤﺋ ﻇﻌربرتﻆﻐ', 'وﺻﻂــﻃ ﻄابﻐــﻀ', 'ﻄﻈاظر وﺖﺿاﻏات ﻎﺸ السﻌق'])), false);
});

test('short words ending in لا (کالا, بالا, إلا) are not ال reversed', () => {
  assert.equal(rtlItemsAreVisual(rtl(['کالا', 'بالا', 'کالا', 'است', 'إلا', 'حالا'])), false);
  assert.equal(rtlItemsAreVisual(rtl(reversed(['الكتاب', 'المدرسة', 'الطالب', 'الحديقة']))), true);
});

test('undecided pages (one glyph per item, no RTL, LTR items) keep pdf.js order', () => {
  assert.equal(rtlItemsAreVisual(rtl([...'ﻞﻤﺣ'])), false);
  assert.equal(rtlItemsAreVisual([{ str: 'שלום', dir: 'ltr' }, { str: 'Hello', dir: 'ltr' }]), false);
  assert.equal(rtlItemsAreVisual([]), false);
});

// ── joinSplitNumbers: a year drawn in three pieces in a right-to-left line
// (Adobe, corpus 3836300) read "1502" for 2015.
test('a number in pieces across RTL items is put back in its own order', () => {
  const at = (str, x, width) => ({ str, x, width, fontSize: 12, rtl: true });
  const line = [at('العامة لألمم املتحدة عام 15', 313.3, 111.8), at('0', 306.9, 6.4), at('2، ومن احملدد بلوغ', 200, 106.9)];
  joinSplitNumbers(line);
  assert.deepEqual(line.map(i => i.str), ['العامة لألمم املتحدة عام 2015', '', '، ومن احملدد بلوغ']);
});

test('a number piece with a space at its end — an ActualText digit over a mirrored bracket glyph — still joins, its space kept', () => {
  // corpus 5494457, a footnote: "1" drawn with a ")" glyph, its /ActualText "1",
  // the item " 1"; read "مايو 1202م" for "مايو 2021م"
  const line = [{ str: 'و', x: 342, width: 3.6, fontSize: 9, rtl: true }, { str: ' 1', x: 335.1, width: 4.4, fontSize: 9, rtl: false },
    { str: '202م', x: 317.6, width: 17.5, fontSize: 9, rtl: true }, { str: '(', x: 314.6, width: 3, fontSize: 9, rtl: false }];
  joinSplitNumbers(line);
  assert.deepEqual(line.map(i => i.str), ['و', ' ', '2021م', '(']);
});

test('a left-to-right item\'s last digit is at its right end: a contents line\'s section and page numbers stay apart', () => {
  // corpus 3836300, page 8: "…… خلفية تارخيية 1" (ltr, its "1" at x 390.7) and the page number "39" at 73.8
  const line = [{ str: '.......... خلفية تارخيية 1', x: 87.8, width: 308.5, fontSize: 11.2, rtl: false }, { str: '39', x: 73.8, width: 11.2, fontSize: 11.2, rtl: false }];
  joinSplitNumbers(line);
  assert.deepEqual(line.map(i => i.str), ['.......... خلفية تارخيية 1', '39']);
});

test('a leader of dots between a contents line\'s numbers is no part of a number', () => {
  const at = (str, x, width) => ({ str, x, width, fontSize: 12, rtl: true });
  const line = [at('1-2- تعریف کاال', 300, 100), at('................', 30, 270), at('9', 22, 8)];
  joinSplitNumbers(line);
  assert.deepEqual(line.map(i => i.str), ['1-2- تعریف کاال', '................', '9']);
});

test('two numbers side by side, a few points apart, stay two numbers', () => {
  const at = (str, x, width) => ({ str, x, width, fontSize: 12, rtl: true });
  const line = [at('حرر يف 9/6/', 300, 60), at('1422هـ', 270, 28)];   // 2pt apart
  joinSplitNumbers(line);
  assert.deepEqual(line.map(i => i.str), ['حرر يف 9/6/', '1422هـ']);
});

test('a colon next to a year stays outside the number: "2018:" not ":2018"', () => {
  const at = (str, x, width) => ({ str, x, width, fontSize: 12, rtl: true });
  const line = [at('2018', 399, 34), at(':', 393, 5), at('ندوة علمية', 200, 190)];
  joinSplitNumbers(line);
  assert.deepEqual(line.map(i => i.str), ['2018', ':', 'ندوة علمية']);
});

test('a decimal number in three pieces, comma between: whole and in order; left as is when already in order', () => {
  // corpus 3836300, page 11: "1" at 126, "," at 132.4, "25" at 136 — it reads 1,25
  const at = (str, x, width) => ({ str, x, width, fontSize: 12.8, rtl: true });
  const rtl = [at('تعوق', 153.4, 271.7), at(' ', 149.1, 0.3), at('25', 136, 13.1), at(',', 132.4, 3.65), at('1', 126, 6.4), at(' ', 121.6, 0.3), at('مليار', 56.7, 64.9)];
  joinSplitNumbers(rtl);
  assert.deepEqual(rtl.map(i => i.str).join('|'), 'تعوق| |||1,25| |مليار');
  const ltr = [at('مليار', 56.7, 64.9), at(' ', 121.6, 0.3), at('1', 126, 6.4), at(',', 132.4, 3.65), at('25', 136, 13.1)];
  joinSplitNumbers(ltr);           // already left to right in the line: kept
  assert.deepEqual(ltr.map(i => i.str).join('|'), 'مليار| |1|,|25');
});

test('a number at the start of an RTL line, in pieces in another order: "٠٠" | "8" | "2. هذا"', () => {
  const at = (str, x, width) => ({ str, x, width, fontSize: 12.8, rtl: true });
  const line = [at('٠٠', 406, 12.8), at('8', 418.8, 6.4), at('2. هذا باإلضافة', 300, 106)];
  joinSplitNumbers(line);
  assert.deepEqual(line.map(i => i.str), ['', '', '2٠٠8. هذا باإلضافة']);
  // as the line really came: two pieces already one item, a space before the "2"
  const real = [at('٠٠8', 406, 12.8), at(' 2. هذا باإلضافة', 56.7, 349.3)];
  joinSplitNumbers(real);
  assert.deepEqual(real.map(i => i.str), ['', ' 2٠٠8. هذا باإلضافة']);
});

test('numbers whole in their item, or items apart, are left alone', () => {
  const at = (str, x, width) => ({ str, x, width, fontSize: 12, rtl: true });
  const whole = [at('عام 2015', 300, 50), at('، ومن', 250, 40)];
  joinSplitNumbers(whole);
  assert.deepEqual(whole.map(i => i.str), ['عام 2015', '، ومن']);
  const apart = [at('صفحة 12', 300, 40), at('3 بنود', 200, 40)];     // 60pt apart: two numbers
  joinSplitNumbers(apart);
  assert.deepEqual(apart.map(i => i.str), ['صفحة 12', '3 بنود']);
});

// ── restoreGlyphOrder: a glyph naming several letters, read backwards with
// its line (class C11, Urdu Word files with Nastaleeq ligatures, 2262154).
test('a ligature glyph read backwards gets its letters back in order: "ےس" → "سے", "ونر رعمتف" → "نور معرفت"', () => {
  // visual order, as drawn: glyphs "فت" "معر" " " "ر" "نو"; then "سے" alone
  const runs = [['فت', 'معر', ' ', 'ر', 'نو'], ['سے']];
  const out = restoreGlyphOrder(rtl(['ونر رعمتف', ' ', 'ےس']), runs);
  assert.deepEqual(out.map(i => i.str), ['نور معرفت', ' ', 'سے']);
});

test('glyphs already in order, Latin ligatures and a digit run kept left to right are left alone', () => {
  assert.equal(restoreGlyphOrder(rtl(['سے']), [['سے']])[0].str, 'سے');
  const ltr = [{ str: 'office', dir: 'ltr' }];
  assert.equal(restoreGlyphOrder(ltr, [['o', 'ffi', 'ce']])[0].str, 'office');
  // "کی 2011" drawn visually: "2011" stays left to right inside the item, "کی" is fixed
  assert.equal(restoreGlyphOrder(rtl(['یک 2011']), [['2', '0', '1', '1', ' ', 'کی']])[0].str, 'کی 2011');
});

test('a hamza pdf.js split off and carried to the word\'s start, and LRM marks the glyphs name, still pair: "ٔالاساس" → "الأساس"', () => {
  // Distiller 11 (1373210): "الأساس" drawn visually, its last glyph "الأ" (three letters)
  const out = restoreGlyphOrder(rtl(['ٔالاساس']), [['س', 'ا', 'س', 'الأ']]);
  assert.equal(out[0].str, 'الأساس');
  // one glyph of four words (ﷺ, 2262154): its words come out whole, spaces in place
  // ("محمد ﷺ" drawn left to right: the ﷺ glyph, a space, then د م ح م; pdf.js reverses it letter by letter)
  const salla = ['صلى الله عليه وسلم', ' ', 'د', 'م', 'ح', 'م'];
  assert.equal(restoreGlyphOrder(rtl([[...salla.join('')].reverse().join('')]), [salla])[0].str, 'محمد صلى الله عليه وسلم');
  // vowelled text already in reading order (5955337): a "لا" glyph is not taken for the article "ال"
  assert.equal(restoreGlyphOrder(rtl(['الصَّلاَة']), [['ة', 'َ', 'لا', 'َّ', 'ص', 'ال']])[0].str, 'الصَّلاَة');
  // a madda is the letter's, not a vowel mark: "لآ" read backwards becomes "الآيات" again (5955337)
  const ayat = ['ت', 'ا', 'ي', 'لآ', 'ا'];
  assert.equal(restoreGlyphOrder(rtl([[...ayat.join('')].reverse().join('')]), [ayat])[0].str, 'الآيات');
  // a contents line pdf.js calls left to right (dot leaders first, 5494457): its Arabic run is mended in place
  assert.equal(restoreGlyphOrder([{ str: '.....الضغوط األمريكية', dir: 'ltr' }],
    [['.', '.', '.', '.', '.', 'ة', 'ي', 'ك', 'ي', 'ر', 'م', 'لأ', 'ا', ' ', 'ط', 'و', 'غ', 'ض', 'ل', 'ا']])[0].str, '.....الضغوط الأمريكية');
  // an Arabic run bidi leaves in place (a logical-order line pdf.js calls left to right) keeps its glyphs as they are
  assert.equal(restoreGlyphOrder([{ str: 'https://bit.ly/x الإيراني', dir: 'ltr' }],
    [['h', 't', 't', 'p', 's', ':', '/', '/', 'b', 'i', 't', '.', 'l', 'y', '/', 'x', ' ', 'ا', 'لإ', 'ي', 'ر', 'ا', 'ن', 'ي']])[0].str, 'https://bit.ly/x الإيراني');
  // ﷺ as one character, which pdf.js expands and reverses (2262154): a ligature too
  assert.equal(restoreGlyphOrder(rtl(['محمد ملسو هيلع هللا ىلص']), [['\uFDFA', ' ', 'د', 'م', 'ح', 'م']])[0].str, 'محمد صلى الله عليه وسلم');
  // and the common Word case: "لأ" reversed by its code points, "أل" (7041235: "اإلسالمية")
  assert.equal(restoreGlyphOrder(rtl(['األلمانية']), [['ة', 'ي', 'ن', 'ا', 'م', 'ل', 'لأ', 'ا']])[0].str, 'الألمانية');
  // Word (0045417): the glyphs name LRMs pdf.js drops from the item — the next item still pairs
  const items = [{ str: 'IDN', dir: 'ltr' }, ...rtl(['ےس'])];
  assert.deepEqual(restoreGlyphOrder(items, [['\u200E', 'I', 'D', 'N', '\u200E'], ['سے']]).map(i => i.str), ['IDN', 'سے']);
});

test('a one-letter glyph decomposing to two ("ئ") is no ligature, and an item whose glyphs don\'t sit where the reading puts them is left alone', () => {
  // a Quran font's letter pairs (1902417): "ئېئى" in reading order, its glyphs one letter each — nothing to mend
  assert.equal(restoreGlyphOrder(rtl(['ئېئى', 'ےس']), [['ئ', 'ې', 'ئ', 'ى'], ['سے']])[0].str, 'ئېئى');
  // an item in reading order whose glyphs are read from its end only by coincidence: unchanged
  assert.equal(restoreGlyphOrder(rtl(['لاتب']), [['لا', 'ت', 'ب']])[0].str, 'لاتب');
});

test('a word space the stream draws and pdf.js dropped is put back: "اسٹیٹبینک" → "اسٹیٹ بینک" (Urdu Nastaleeq, Word)', () => {
  // drawn in visual order, glyph by glyph, a space between the two words; pdf.js drops it and reverses the rest
  const glyphs = ['ک', 'ن', 'ی', 'ب', ' ', 'ٹ', 'ی', 'ٹ', 'س', 'ا'];
  const item = [...glyphs.filter(g => g !== ' ').join('')].reverse().join('');
  assert.equal(restoreGlyphOrder(rtl([item]), [glyphs])[0].str, 'اسٹیٹ بینک');
});

test('spaces that would break a page\'s words into letters are not put back (1902417: "و ق ال" for "وقال")', () => {
  const glyphs = ['ل', ' ', 'ا', ' ', 'ق', ' ', 'و'];
  assert.equal(restoreGlyphOrder(rtl(['وقال']), [glyphs])[0].str, 'وقال');
});

test('items that do not pair with the glyphs stop it: the rest of the page left as pdf.js gave it', () => {
  // the second item's letters are not the next glyphs' (an ActualText-like change)
  const out = restoreGlyphOrder(rtl(['ےس', 'abc', 'یک']), [['سے'], ['x', 'y', 'z'], ['کی']]);
  assert.deepEqual(out.map(i => i.str), ['سے', 'abc', 'یک']);
  // no multi-letter Arabic glyph on the page: nothing to do
  const items = rtl(['من']);
  assert.equal(restoreGlyphOrder(items, [['ن', 'م']]), items);
});

// ── restoreDroppedSpaces: pdf.js drops a space glyph drawn overlapping its
// neighbours; the operator list keeps it (Persian InDesign, corpus 7629204).
test('a word space pdf.js dropped is put back from the glyphs, drawn in either order', () => {
  const items = rtl(['فصلسوم', 'نهادهایفناوریهمکار', 'گزارش']);
  const runs = ['موس لصف', 'راکمه یروانف یاهداهن', 'شرازگ'];      // visual order, spaces kept
  assert.deepEqual(restoreDroppedSpaces(items, runs).map(i => i.str), ['فصل سوم', 'نهادهای فناوری همکار', 'گزارش']);
});

test('two items drawn touching get the space the glyphs have between them, on the first word', () => {
  // "شرکت" at x 480.9 (w 25.2) and "نام" at 506.9 — 0.8pt apart, the run "تکرش مان"
  const at = (str, x, w) => ({ str, dir: 'rtl', width: w, transform: [13, 0, 0, 13, x, 457.7] });
  const out = restoreDroppedSpaces([at('شرکت', 480.9, 25.2), at('نام', 506.9, 12.2)], ['تکرش مان']);
  assert.deepEqual(out.map(i => i.str), ['شرکت', 'نام ']);
});

test('pieces of words at the ends of runs are no evidence: "من" is not split into "م ن"', () => {
  // InDesign breaks runs inside words (corpus 0525394): "عأ م", "م ار" hold pieces, not words
  assert.equal(restoreDroppedSpaces(rtl(['من']), ['ن م', 'م ار'])[0].str, 'من');
  assert.equal(restoreDroppedSpaces(rtl(['أعمال']), ['لا معأ'])[0].str, 'أعمال');
});

test('a word the glyphs also show whole is left whole; no runs, no change', () => {
  const items = rtl(['کتابخانه']);
  assert.equal(restoreDroppedSpaces(items, ['کتاب خانه', 'کتابخانه'])[0].str, 'کتابخانه');
  assert.equal(restoreDroppedSpaces(items, null), items);
  assert.equal(restoreDroppedSpaces(rtl(['abcdef']), ['abc def'])[0].str, 'abcdef');   // Arabic script only
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

test('a line reordered again (run by run, for table cells) keeps its brackets', () => {
  const items = [glyph('(', 0), glyph('pdf', 5, 15), glyph(')', 20), glyph('۱', 30), glyph('۳', 35),
    glyph('۹', 40), glyph('۹', 45), glyph('ل', 55), glyph('ا', 60), glyph('س', 65)];
  items.forEach((it, seq) => { it.seq = seq; });
  reorderVisualRtlLine(items);
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

test('a zero-width haraka at a letter\'s left edge stays on that letter, not the next word', () => {
  // ground truth ar-web: "...أو مستندًا من مئة صفحة" — Chromium splits the run at the
  // tanween, drawn 0.3pt left of its د; sorted alone it landed in "مئةً صفحة"
  const run = (str, x, width) => ({ str, x, width, fontSize: 11 });
  const items = [run('ا من مئة صفحة', 62, 56.1), run('ً', 117.7, 0), run('د', 118, 5.2),
    run('ا من صفحة واحدة أو مستن', 123.2, 97)];
  reorderVisualRtlLine(items);
  assert.equal(items.map(i => i.str).join(''), 'ا من صفحة واحدة أو مستندًا من مئة صفحة');
});

test('a haraka moved into a single wide glyph joins that glyph (Wikipedia ar "أيضًا")', () => {
  // glyphs left to right: ﺎ ﻀ ﻳ ﺃ, the tanween drawn 3.7pt inside ﻀ
  const items = [glyph('ﺎ', 303, 5), glyph('ً', 312, 0), glyph('ﻀ', 308.3, 9.4), glyph('ﻳ', 317.7, 4), glyph('ﺃ', 321.7, 4)];
  reorderVisualRtlLine(items);
  assert.equal(lineText(items), 'أيضًا');
});

test('a haraka offset into the previous glyph still joins the glyph drawn after it ("ويُغمّق")', () => {
  // ground truth ar-tight: the damma of يُ is drawn at 378.5, inside غ (376.9–380.9);
  // in the stream it comes right before its ي, as the shadda comes before its م
  const run = (str, x, width) => ({ str, x, width, fontSize: 11 });
  const items = [run('ق النص', 84.2, 287.6), run('ّ', 371.6, 0), run(' ', 371.8, 0), run('م', 371.8, 5.1),
    run('غ', 376.9, 4), run('ُ', 378.5, 0), run(' ', 380.9, 0), run('ي', 380.9, 2.1), run(' ', 383, 1.8),
    run('نقي و', 384.3, 92.4)];
  reorderVisualRtlLine(items);
  assert.equal(items.map(i => i.str).join(''), 'نقي ويُغمّق النص');
});

test('a haraka whose own letter is missing from the text layer is dropped, not moved', () => {
  // ground truth ar-tight "التنظيف يُسطّح": the initial ي has no Unicode mapping (pdf.js
  // "\0", filtered out before), so its damma is followed by the previous word, 8.6pt away
  const run = (str, x, width) => ({ str, x, width, fontSize: 11 });
  const items = [run('ح', 470.7, 6), run('ّ', 477.1, 0), run('ط', 476.7, 6.1), run('س', 482.8, 5.4),
    run('ُ', 485.2, 0), run('التنظيف', 493.8, 29.5)];
  reorderVisualRtlLine(items);
  assert.equal(items.map(i => i.str).join(''), 'التنظيف سطّح');
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

test('a jump across a column gutter does not vote on the line\'s direction', () => {
  // ground truth ar-cols2: the right column's run (earlier in the stream) merged
  // with the left column's two visual runs on one baseline
  const run = (str, x, width, seq) => ({ str, x, width, seq, fontSize: 11 });
  const items = [run('كلما احتجت.', 199.3, 49.5, 90), run('مئة صفحة', 249.3, 36.2, 91), run('الأختام', 354, 185, 21)];
  reorderVisualRtlLine(items);
  // (their 0.7pt space item is dropped like the lam-alef split's; every converter
  // tested glues these two words)
  const text = items.map(i => i.str).join('');
  assert.ok(/^الأختام مئة صفحة ?كلما احتجت\.$/.test(text), text);
});

// ── lineRuns: table code joins a cell's items with spaces, so an RTL line goes
// to it as runs (table ground truth 2026-10-02).
test('glyph-per-item Persian becomes one run per cell, in reading order', () => {
  // "جمع کل" drawn left to right one glyph per item: ل ک | ع م ج
  const items = [glyph('ل', 0), glyph('ک', 5), glyph('ع', 13), glyph('م', 18), glyph('ج', 23)]
    .map((it, seq) => ({ ...it, seq }));
  const runs = lineRuns(items);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].str.normalize('NFKC'), 'جمع کل');
});

test('each cell of a row is read on its own: cells in logical order, a cell\'s runs visual', () => {
  // Chromium: the row's cells right to left, "ورق طباعة A4" inside its cell left to right
  const run = (str, x, width, seq) => ({ str, x, width, seq, fontSize: 10 });
  const items = [run('A4', 200, 10, 1), run('ورق طباعة', 213, 40, 2), run('12', 150, 10, 3), run('18.50', 100, 20, 4)];
  assert.deepEqual(lineRuns(items).map(r => r.str), ['18.50', '12', 'ورق طباعة A4']);
});

test('a table rule between two close items keeps them in separate runs', () => {
  const run = (str, x, width) => ({ str, x, width, fontSize: 10 });
  assert.equal(lineRuns([run('أ', 100, 5), run('ب', 109, 5)], [107]).length, 2);
  assert.equal(lineRuns([run('أ', 100, 5), run('ب', 109, 5)]).length, 1);
});

test('a stream already running right-to-left (logical) keeps its order — its word gaps get their spaces', () => {
  const items = [glyph('שלום', 100, 30), glyph('עולם', 60, 30), glyph('זה', 20, 20)];
  reorderVisualRtlLine(items);
  assert.deepEqual(items.map(i => i.str), ['שלום', ' עולם', ' זה']);
});

test('a logical line drawn letter by letter (macOS Quartz) gets its word spaces back', () => {
  // corpus 6199289: "• تونس – منظمة" as one item per letter, words 3.3 pt apart
  const g = (str, x, width) => ({ str, x, width, fontSize: 14 });
  const items = [g('ت', 484.3, 2.9), g('و', 479.1, 5.2), g('ن', 476.2, 2.9), g('س', 466.3, 9.9), g('–', 456.3, 6.7),
    g('م', 448.2, 4.7), g('ن', 445.3, 2.9), g('ظ', 438.3, 7), g('م', 433.6, 4.7), g('ة', 429.1, 4.5)];
  reorderVisualRtlLine(items);
  assert.equal(items.map(i => i.str).join(''), 'تونس – منظمة');
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

// OCR'd FAQ page (Persian scan, 2026-10-09): 2-line paragraphs, lines 16.5pt
// apart, paragraphs 24.8pt, one line Tesseract missed (a 33pt gap). Half the
// gaps are paragraph gaps — the median is one; the lower quartile is the lines.
test('OCR line pitch: the lines\' spacing even when half the gaps are paragraph gaps', () => {
  const ys = [700, 683.5, 658.7, 642.2, 617.4, 600.9, 576.1, 543.1, 526.6, 501.8, 485.3];
  const lines = ys.map(y => row(y));
  assert.ok(linePitch(lines) > 20, `median ${linePitch(lines)}`);
  const pitch = ocrLinePitch(lines);
  assert.ok(Math.abs(pitch - 16.5) < 0.01, `pitch ${pitch}`);
  // breaks at 1.3× of it: exactly the paragraph gaps (and the missed line)
  assert.deepEqual(ys.slice(1).map((y, i) => ys[i] - y > pitch * 1.3), [false, true, false, true, false, true, true, false, true, false]);
});

test('OCR line pitch: two columns interleaved half a line apart are not the pitch', () => {
  const ys = [700, 692, 684.5, 677, 669, 661.5, 654, 646];  // two columns, 15.5pt each, offset 8pt
  const lines = ys.map(y => row(y));
  assert.equal(ocrLinePitch(lines), undefined);
});

// ── Wrapped headings: a heading too long for its column is still one heading.
const hl = (y, str, x, width, bold = true, fontSize = 15) => ({ y, rtl: false, items: [{ str, x, width, fontSize, bold }] });
const body = Array.from({ length: 6 }, (_, i) => hl(600 - i * 15, 'body text', 56, 228, false, 11)); // column 56–284

test('a heading wrapped at the column edge continues on the next line', () => {
  const m = lineStartMargins(body);
  const first = hl(700, "What's the difference between", 56, 226), second = hl(679, 'Clean and Enhance mode?', 56, 190);
  assert.equal(continuesWrappedHeading(first, second, m), true);
});

test('an OCR heading wrapped at the edge continues though its lines measured 12.5 and 9.5 pt', () => {
  const m = lineStartMargins(body);
  const ocr = ln => ({ ...ln, items: ln.items.map(i => ({ ...i, ocr: true })) });
  const first = ocr(hl(700, "What's the difference between", 56, 226, true, 12.5)), second = ocr(hl(682, 'Clean and Enhance mode?', 56, 190, true, 9.5));
  assert.equal(continuesWrappedHeading(first, second, m), true);
  // from a text layer, the same sizes are two different headings
  assert.equal(continuesWrappedHeading(hl(700, "What's the difference between", 56, 226, true, 12.5), hl(682, 'Clean and Enhance mode?', 56, 190, true, 9.5), m), false);
});

test('"Chapter 1" above "Introduction" stays two headings (the first line never reached the edge)', () => {
  const m = lineStartMargins(body);
  assert.equal(continuesWrappedHeading(hl(700, 'Chapter 1', 56, 70), hl(679, 'Introduction', 56, 95), m), false);
});

test('stacked labels in a narrow cell (~7 em) are not one wrapped heading', () => {
  const cell = Array.from({ length: 6 }, (_, i) => hl(600 - i * 15, 'value', 326, 72, false, 10.6));
  const m = lineStartMargins(cell);
  assert.equal(continuesWrappedHeading(hl(700, 'extension', 326, 70, true, 10.6), hl(686, 'Internet', 326, 40, true, 10.6), m), false);
});

test('a heading line ending on sentence punctuation, or a different size, does not continue', () => {
  const m = lineStartMargins(body);
  assert.equal(continuesWrappedHeading(hl(700, 'A complete heading line of its own.', 56, 226), hl(679, 'Another', 56, 80), m), false);
  assert.equal(continuesWrappedHeading(hl(700, "What's the difference between", 56, 226), hl(679, 'smaller', 56, 80, true, 12), m), false);
});


// textLayerLooksBroken — real extraction from the prose ground truth with its
// fonts' ToUnicode maps stripped (2026-10-08), next to the same pages intact.
console.log('\ntextLayerLooksBroken:');
test('real text in any script is not broken (Arabic, Japanese with Latin words, short pages)', () => {
  assert.equal(textLayerLooksBroken('التنظيف يُسطّح الخلفية إلى أبيض نقي ويُغمّق النص لأقصى تباين — الأنسب للصفحات النصية. '.repeat(5)), false);
  assert.equal(textLayerLooksBroken('PDFree を使えば、ファイルをアップロードせずにブラウザ内で PDF を変換できます。'.repeat(8)), false);
  assert.equal(textLayerLooksBroken('Привет, мир! Это обычный текст на русском языке, без мусора. '.repeat(6)), false);
  assert.equal(textLayerLooksBroken('/അ೪ۻٍ\u0001'), false); // under 200 characters: not judged
});
test('glyph codes instead of text are broken (control characters, scripts mixed inside words)', () => {
  assert.equal(textLayerLooksBroken(':KDW\u0003V\u0003WKH\u0003GLffHUHQFH\u0003EHWZHHQ\u0003&OHDQ\u0003DQG\u0003'.repeat(6)), true);
  assert.equal(textLayerLooksBroken('/അ೪ۻٍ\u05ebڤ7X\u0001؉מ܊ר\u05ebڤ7\u0001\u0b58কۛX\u0001അ೪ּ\u0001Rۑءڤ7'.repeat(8)), true);
  assert.equal(textLayerLooksBroken('ʢʱʳʩʱɐʱوجˑɐمجحɐتیʱˑدحمɐاه\u200cلѫافɐˎاغʱʩɐͤʩربɐایʤ'.repeat(6)), true);  // Persian, no control chars
});

// pdf.js reads a CJK glyph shared with a radical as the radical: Chrome-printed
// Chinese came out with 一 人 文 as ⼀ ⼈ ⽂ (1082 on one Wikipedia page) —
// same look, but search and copy fail (2026-10-09).
test('Kangxi radicals and simplified radical forms become the ideographs', () => {
  assert.equal(toUnifiedIdeographs('项⽬ ⾦额 ⿊⾊打印机'), '项目 金额 黑色打印机');
  assert.equal(toUnifiedIdeographs('⼈⺠币 ⻚码 ⻔ 特⻑'), '人民币 页码 门 特長');
});
test('everything else is left as it is', () => {
  assert.equal(toUnifiedIdeographs('PDF ﬁle — مرحبا 文件 ①'), 'PDF ﬁle — مرحبا 文件 ①');
});

// pdf.js breaks Chinese runs at glyphs it reads as radicals; the touching
// pieces are one word. A Latin item's width can include the space after it.
const piece = (str, x, width) => ({ str, x, width, fontSize: 11 });
test('touching Chinese pieces join into one item', () => {
  // radicals are already ideographs here (toUnifiedIdeographs, at item creation)
  const out = joinTouchingItems([piece('水', 132.2, 10.99), piece('黑色', 66.2, 21.98), piece('打印机墨', 88.2, 43.98)]);
  assert.deepEqual(out.map(i => i.str), ['黑色打印机墨水']);
});
test('touching Latin pieces, a real gap, and a table rule between stay apart', () => {
  assert.equal(joinTouchingItems([piece('cell', 10, 20), piece('b2', 30, 10)]).length, 2);
  assert.equal(joinTouchingItems([piece('数量', 10, 22), piece('单价', 40, 22)]).length, 2);
  assert.equal(joinTouchingItems([piece('项', 10, 11), piece('目', 21, 11)], [21]).length, 2);
});

test('dropCjkGapSpaces: a justified Chinese line loses the spaces pdf.js read into it', () => {
  // a white paper's justified line (presentations corpus, 2026-10-15)
  assert.equal(dropCjkGapSpaces('用 户 管 理 ： 身 份 证 由 个 人 拥 有 ， 而 不 是'), '用户管理：身份证由个人拥有，而不是');
  assert.equal(dropCjkGapSpaces('様式１業 務 委 託'), '様式１業務委託');
  // next to Latin, digits or Hangul a space stays
  assert.equal(dropCjkGapSpaces('在 2000 年 提出 Augmented Social'), '在 2000 年提出 Augmented Social');
  assert.equal(dropCjkGapSpaces('한국어 문장 입니다'), '한국어 문장 입니다');
});

test('textLayerLooksBroken: Japanese with Latin letters beside kana and kanji is not broken', () => {
  // a Japanese tournament sheet (presentations corpus): Ａブロック, Ｂ面 … read as script changes
  const line = 'グランド案内 Ａブロック Ｂブロック Ｃブロック Ｄブロック 主管 東北信ブロック Ａ面 Ｂ面 チーム名 順位 リーグ戦 ';
  assert.equal(textLayerLooksBroken(line.repeat(6)), false);
  // a broken layer still is: unrelated scripts side by side
  assert.equal(textLayerLooksBroken('മലയാളംಕನ್ನಡעבריתعربي '.repeat(20)), true);
});

test('a table of contents line — a dot leader and a page number at an end — is a paragraph of its own', () => {
  const ln = str => ({ items: [{ str }] });
  for (const t of ['1.1 الغرض من المدونة ................ 6', 'رضورت وہ وت فرآن یک واحض اہشدت یھب نس ےیجیل۔ ................47',
    'Introduction .......................... 3', '12 ............. الملخص التنفيذي', 'الفصل الأول · · · · · · ١٧'])
    assert.equal(isContentsEntry(ln(t)), true, t);
  for (const t of ['وقال… ثم سكت', 'الاسم: ................................', 'In 2024 the total was 12... more or less',
    'مجلة جامعة النجاح المجلد 35(7) 2021 ـــــــــــــــــ 1080'])
    assert.equal(isContentsEntry(ln(t)), false, t);
});

test('words set closer than a fifth of an em but a space glyph apart get their space (7389718: "درايران")', () => {
  // the line's own space is 2.6 pt; "در" and "ايران" stand 2.5 pt apart at 13 pt
  const it = (str, x, width, seq) => ({ str, x, width, fontSize: 12.96, seq, y: 546 });
  const items = [it('جنبش', 167.6, 24.3, 1), it(' ', 164.9, 2.6, 2), it('در', 127, 9.6, 3), it('ايران', 106, 18.5, 4)];
  reorderVisualRtlLine(items);
  if (!items.some(i => i.str === ' ايران')) throw new Error(JSON.stringify(items.map(i => i.str)));
});

test('glyphs closer than 0.15 em stay one word', () => {
  const it = (str, x, width, seq) => ({ str, x, width, fontSize: 12.96, seq, y: 546 });
  const items = [it('در', 127, 9.6, 1), it('ايران', 106.6, 18.5, 2)];   // 1.9 pt = 0.147 em apart
  reorderVisualRtlLine(items);
  if (items.some(i => i.str.startsWith(' '))) throw new Error(JSON.stringify(items.map(i => i.str)));
});

test('a small Persian table\'s words 0.19 em apart get their space (7351637: "عنوانرشته")', () => {
  const it = (str, x, width) => ({ str, x, width, fontSize: 6.399 });
  if (joinSpacedItems([it('عنوان', 373.05, 12.36), it('رشته', 361.72, 10.12)]) !== 'عنوان رشته') throw new Error('glued');
});

// Text drawn again over itself — a printer driver's fake bold, fill then stroke
// (class C14, Chinese corpus 2026-10-24): "壬壬壬壬", "北原北原北原北原".
const it = (str, x, y, size = 12, w = str.length * size) => ({ str, transform: [size, 0, 0, size, x, y], width: w, height: size, dir: 'ltr', fontName: 'f' });
const text = items => items.map(i => i.str).join('|');
test('overprint: four copies of a glyph a quarter point apart are read once', () => {
  const r = dropOverprintedText([it('壬', 169.92, 744.72, 9.6), it('壬', 169.68, 744.48, 9.6), it('壬', 169.92, 744.48, 9.6), it('壬', 169.68, 744.72, 9.6)]);
  assert.equal(text(r), '壬');
});
test('overprint: a line drawn twice (fill, then stroke) is read once', () => {
  const r = dropOverprintedText([it('技術於校園安全建置', 289.98, 43.73, 8), it('技術於校園安全建置', 289.69, 43.44, 8), it('之經驗分享', 361.98, 43.73, 8)]);
  assert.equal(text(r), '技術於校園安全建置|之經驗分享');
});
test('overprint: copies cut into different pieces — "備註" once, not "備備註註"', () => {
  const r = dropOverprintedText([it('備', 60.36, 559.52, 11), it('備註', 60.12, 559.28, 11), it('註', 71.4, 559.5, 11)]);
  assert.equal(r.map(i => i.str).join(''), '備註');
});
test('overprint: a longer copy keeps only what the first did not draw', () => {
  const r = dropOverprintedText([it('紀律聆訊機制', 131.9, 500, 30), it('紀律聆訊機制研討會', 131.6, 500, 30)]);
  assert.equal(r.map(i => i.str).join(''), '紀律聆訊機制研討會');
  const tail = r[r.length - 1];
  assert.ok(Math.abs(tail.transform[4] - (131.6 + 6 * 30)) < 0.01 && Math.abs(tail.width - 90) < 0.01, 'the piece left sits where its glyphs are');
});
test('overprint, not: the same character twice in a row stays twice ("謝謝")', () => {
  assert.equal(text(dropOverprintedText([it('謝謝', 10, 700)])), '謝謝');
  assert.equal(text(dropOverprintedText([it('謝', 10, 700), it('謝', 22, 700)])), '謝|謝');
});
test('overprint, not: the same text in two table cells stays in both', () => {
  assert.equal(text(dropOverprintedText([it('合計', 100, 400), it('合計', 300, 400), it('合計', 100, 385)])), '合計|合計|合計');
});
test('overprint, not: a vertical column of the same character keeps every one', () => {
  assert.equal(text(dropOverprintedText([it('第', 50, 700), it('第', 50, 688), it('第', 50, 676)])), '第|第|第');
});
test('overprint, not: different glyphs set tight or kerned into each other stay', () => {
  assert.equal(text(dropOverprintedText([it('A', 10, 700, 12, 8), it('V', 16, 700, 12, 8), it('中', 30, 700), it('文', 30.5, 700)])), 'A|V|中|文');
});
test('overprint, not: a copy in another size or direction is another text (a shadow, a stamp)', () => {
  const rotated = { ...it('印', 10, 700), transform: [0, 12, -12, 0, 10, 700] };
  assert.equal(text(dropOverprintedText([it('印', 10, 700, 12), it('印', 10, 700, 16), rotated])), '印|印|印');
});
test('overprint: right-to-left text drawn twice is read once, whole; overlapping different Arabic stays', () => {
  const ar = (str, x) => ({ ...it(str, x, 600, 12, 40), dir: 'rtl' });
  assert.equal(text(dropOverprintedText([ar('مجلس الأمن', 100), ar('مجلس الأمن', 100.2), ar('الأمم', 120)])), 'مجلس الأمن|الأمم');
});
test('overprint: full-width marks are on the CJK pitch too — "（星期三）" once', () => {
  const r = dropOverprintedText([it('（星期三', 300, 450, 12), it('（', 300.2, 450, 12), it('星期三）', 312.2, 450, 12)]);
  assert.equal(r.map(i => i.str).join(''), '（星期三）');
});
test('overprint, not: a shadow drawn 10 % larger stays whole — no pieces left ("南亞 花板")', () => {
  const r = dropOverprintedText([it('南亞防火天花板', 158.81, 155.52, 25.66, 179.63), it('南亞防火天花板', 165.43, 156.53, 23.33, 163.3)]);
  assert.equal(text(r), '南亞防火天花板|南亞防火天花板');
});
test('overprint: empty and space items and items without a transform pass through', () => {
  const r = dropOverprintedText([{ str: '', hasEOL: true }, it(' ', 10, 10), it(' ', 10, 10), { str: 'x' }]);
  assert.equal(r.length, 4);
});

// Letter-spaced Chinese and Japanese (P2a, 2026-10-24): gaps in em as the
// corpus documents draw them, a space item in each gap over 0.15 em as pdf.js gives.
const spacedLine = (glyphs, gaps, size = 10) => {
  const items = []; let x = 0;
  [...glyphs].forEach((g, k) => {
    if (k) {
      const gap = gaps[k - 1] * size;
      if (gaps[k - 1] > 0.15) items.push({ str: ' ', x, width: gap, fontSize: size });
      x += gap;
    }
    items.push({ str: g, x, width: size, fontSize: size });
    x += size;
  });
  markLetterSpacing(items);
  return items.map(spacedText).join('');
};
test('letter spacing: an evenly spread Chinese line loses its spaces (0738745)', () => {
  assert.equal(spacedLine('董事名單與其角色', [0.14, 0.14, 0.15, 0.14, 0.14, 0.14, 0.14]), '董事名單與其角色');
  assert.equal(spacedLine('每週上課時間', [1, 1, 1, 1, 1]), '每週上課時間');
});
test('letter spacing: a Japanese name keeps its family–given space, a whole em wider (7909868)', () => {
  assert.equal(spacedLine('青山桃子', [0.54, 1.54, 0.53]), '青山 桃子');
  assert.equal(spacedLine('西久保直心', [0.30, 0.30, 1.30, 0.30]), '西久保 直心');
  assert.equal(spacedLine('田嶋優里奈', [0.15, 1.15, 0.16, 0.15]), '田嶋 優里奈');
});
test('letter spacing: two spread headers on a line join each, not each other (5547861, 2706899)', () => {
  assert.equal(spacedLine('氏名所属', [1.00, 4.38, 1.00]), '氏名 所属');
  assert.equal(spacedLine('氏名所属', [0.66, 5.84, 0.66]), '氏名 所属');
});
test('letter spacing: cells 3 em apart stay apart; one lone spaced pair stays; Korean stays', () => {
  assert.equal(spacedLine('日一二三四', [3.12, 3.5, 2.9, 3.2]), '日 一 二 三 四');
  assert.equal(spacedLine('男女', [1.0]), '男 女');
  assert.equal(spacedLine('문서관리', [0.5, 0.5, 0.5]), '문 서 관 리');
});
test('letter spacing: glyphs that touch are plain text — a typed space between them stays', () => {
  assert.equal(spacedLine('東京都新宿区西新宿', [0, 0, 0.25, 0, 0, 0, 0, 0]), '東京都 新宿区西新宿');
});
test('letter spacing: names as words keep their family–given space, however alike the gaps (1309849, 0048931)', () => {
  const it = (str, x) => ({ str, x, width: str.length * 10, fontSize: 10 });
  const items = [it('井手口', 0), it(' ', 30), it('峻', 35), it(' ', 45), it('堀口', 80), it(' ', 100), it('蒼太', 105)];
  markLetterSpacing(items);
  assert.equal(items.map(spacedText).join(''), '井手口 峻 堀口 蒼太');
});
test('letter spacing: full-width digits and dashes are no glyphs of spread text (a score "３ － １")', () => {
  assert.equal(spacedLine('３－１', [0.5, 0.5]), '３ － １');
});
test('letter spacing: the space pdf.js puts on the next glyph\'s item (" 名") is spacing too', () => {
  const it = (str, x, width) => ({ str, x, width, fontSize: 10 });
  // 氏 名 1 em apart, 所 属 too, 4.4 em between: the space carried by " 名" and " 属"
  const items = [it('氏', 0, 10), it(' 名', 10, 20), it(' ', 20, 44), it('所', 64, 10), it(' 属', 74, 20)];
  markLetterSpacing(items);
  assert.equal(items.map(spacedText).join(''), '氏名 所属');
});
test('letter spacing only marks: the line keeps every item, where it was, with its text (tables read those gaps — P2a run 1)', () => {
  const it = (str, x, width) => ({ str, x, width, fontSize: 10 });
  const items = [it('氏', 0, 10), it(' ', 10, 10), it('名', 20, 10), it(' ', 30, 44), it('所', 74, 10), it(' ', 84, 10), it('属', 94, 10)];
  const before = JSON.stringify(items.map(i => [i.str, i.x, i.width]));
  markLetterSpacing(items);
  assert.equal(JSON.stringify(items.map(i => [i.str, i.x, i.width])), before);
  assert.equal(items.map(spacedText).join(''), '氏名 所属');
});
test('letter spacing: uneven gaps are words, not spacing', () => {
  assert.equal(spacedLine('東京大阪名古屋', [0.0, 0.9, 0.0, 1.6, 0.0, 0.0]), '東京 大阪 名古屋');
});

// ── Lines broken by hand: short lines stacked without a gap are paragraphs of their own.
const bl = (y, str, x, width, fontSize = 11) => ({ y, rtl: false, items: [{ str, x, width, fontSize }] });
const column = Array.from({ length: 6 }, (_, i) => bl(600 - i * 13, 'body text that fills the whole width of the page column here', 56, 484)); // 56–540, A4 with margins

test('a short line the next word would have fitted after starts a new paragraph (form fields, a list without markers)', () => {
  const m = lineStartMargins(column);
  assert.equal(startsAfterHardBreak(bl(700, 'Last Name: ____________', 56, 120), bl(687, 'First Name: ____________', 56, 124), m), true);
  assert.equal(startsAfterHardBreak(bl(700, 'eBird checklists (approved and vetted)', 56, 170), bl(687, 'Personal observations (vetted)', 56, 140), m), true);
});

test('a wrapped line that reached the column edge does not (the next word did not fit)', () => {
  const m = lineStartMargins(column);
  assert.equal(startsAfterHardBreak(bl(700, 'running text that goes all the way to the edge of the column and then', 56, 478), bl(687, 'wraps onto the next line', 56, 120), m), false);
});

test('a line short by less than the next word and 2 em stays in the paragraph (ragged right)', () => {
  const m = lineStartMargins(column);
  // 50 pt of room, next word "considerations" ~14 × 5 pt = 70 pt: it could not fit
  assert.equal(startsAfterHardBreak(bl(700, 'ragged right text ends a bit early here because the next word', 56, 434), bl(687, 'considerations follow on this line', 56, 170), m), false);
});

test('a centred line and a narrow cell (< 10 em) are left alone', () => {
  const m = lineStartMargins(column);
  assert.equal(startsAfterHardBreak(bl(700, 'Centred Title', 140, 60), bl(687, 'Subtitle', 150, 40), m), false);
  const cell = Array.from({ length: 6 }, (_, i) => bl(600 - i * 13, 'cell', 326, 72, 10.6));
  assert.equal(startsAfterHardBreak(bl(700, 'one', 326, 20, 10.6), bl(687, 'two', 326, 20, 10.6), lineStartMargins(cell)), false);
});

test('justified lines are judged against their common end margin, not one wider line', () => {
  // every line ends at 540 but one runs on to 580 (a URL): a line ending at 540 is full
  const lines = [...column.map(l => ({ ...l, items: [{ ...l.items[0], width: 484 }] })), bl(500, 'a long line with a url that runs past', 56, 524)];
  const m = lineStartMargins(lines);
  assert.equal(startsAfterHardBreak(bl(700, 'justified line that ends exactly at the margin', 56, 484), bl(687, 'next', 56, 20), m), false);
});

test('a line set apart at the top right (a document number) is not the body column edge', () => {
  // as pdf.js reads it: "联合国" at the margin and the number at the top right are one line
  const page = [{ y: 745, rtl: false, items: [{ str: '联合国', x: 123, width: 59, fontSize: 13.7 }, { str: 'S/2012/2/Rev.2', x: 485, width: 70, fontSize: 20 }] },
    ...[0, 1, 2].map(i => bl(530 - i * 16, '根据1998年10月30日安全理事会主席的说明第4(b)段并', 123, 366, 10.5)),
    bl(480, '和副主席如下：', 123, 79, 10.5), bl(460, '主席：', 123, 37, 10.5)];
  const m = lineStartMargins(page);
  // a wrapped line ending at the body's edge (489) stays with the next
  assert.equal(startsAfterHardBreak(bl(530, '根据1998年10月30日安全理事会主席的说明第4(b)段并', 123, 366, 10.5), bl(514, '经安理会成员协商后', 123, 95, 10.5), m), false);
  // "主席：" then the name: two paragraphs
  assert.equal(startsAfterHardBreak(bl(460, '主席：', 123, 37, 10.5), bl(444, '彼得·维蒂希(德国)', 144, 100, 10.5), m), true);
});

test('a narrow justified column beside a picture: lines at its own edge are not short', () => {
  // the page's body runs to 540, this column to 300 (a picture to its right)
  const narrow = [0, 1, 2, 3, 4].map(i => bl(400 - i * 16, '宇宙及國際會議於一九九七年三月', 56, 244, 12));
  const page = [...column, ...narrow];
  const m = lineStartMargins(page);
  const edges = localLineEdges(narrow, m);
  assert.equal(startsAfterHardBreak(narrow[1], narrow[2], m, edges.get(narrow[1])), false);
  // without the local edge, the page edge made it look short
  assert.equal(startsAfterHardBreak(narrow[1], narrow[2], m), true);
});

test('a stack of short lines of different lengths has no edge of its own: the page edge stands', () => {
  const stack = [bl(700, 'Last Name: ______', 56, 100), bl(687, 'First Name: __________', 56, 130), bl(674, 'Middle: ___', 56, 70)];
  const m = lineStartMargins([...column, ...stack]);
  const edges = localLineEdges(stack, m);
  assert.equal(edges.get(stack[0]), undefined);
  assert.equal(startsAfterHardBreak(stack[0], stack[1], m, edges.get(stack[0])), true);
});

test('Chinese: an options line that stops early, then the next question, is two paragraphs', () => {
  const cjk = Array.from({ length: 6 }, (_, i) => bl(600 - i * 16, '第三十題為題組圖一所示為表一表二表三之資料庫關聯圖說明', 56, 300, 12)); // 25 chars × 12
  const m = lineStartMargins(cjk);
  assert.equal(startsAfterHardBreak(bl(700, '①關聯式資料庫 ②階層式資料庫', 56, 168, 12), bl(684, '第33題至第38題為題組', 56, 156, 12), m), true);
  // a CJK line wrapped one character short of the edge (kinsoku) stays
  assert.equal(startsAfterHardBreak(bl(700, '第三十題為題組圖一所示為表一表二表三之資料庫關聯', 56, 288, 12), bl(684, '圖說明', 56, 36, 12), m), false);
});

const total = passed + failed;

console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${total} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
