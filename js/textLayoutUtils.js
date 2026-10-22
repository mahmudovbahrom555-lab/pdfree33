// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  textLayoutUtils.js — shared, zero-DOM text-layout helpers
//
//  Moved out of processor.js so js/pdf2mdCore.js can depend on them
//  without importing processor.js itself (which is browser-coupled —
//  Worker orchestration, DOM progress/cancel UI). processor.js still
//  imports and re-exports these for pdf2word/pdf2excel's own use and
//  for backward-compat with existing test imports.
// ============================================================

import { detectColumnRegions, regionIndexForX, lineSpansRegions } from './pdf2wordColumns.js';

// Shared list-line detector — pdf2md and pdf2word (_p2wBuildParagraphs) both
// use this exact pattern to keep list items from being swallowed into the
// surrounding paragraph. Bullet glyphs are unambiguous; numbered markers
// require a "N." / "N)" prefix NOT immediately followed by another digit —
// that's what excludes decimals like "3.14" and multi-level clause numbering
// ("2.5.1.", "5.11.": the digit right after the first "N." blocks the match)
// — exactly the safety margin pdf2word's native-numbering rendering below
// depends on: renumbering a legal clause's own reference number would be a
// real regression, but a flat "1. / 2. / 3." list is safe to renumber.
// Was `\s+` (required whitespace) instead of `(?!\d)` until a real PDF found
// via the Section 5.1 capability-map tool (scripts/pdf2word_capability_map.mjs)
// broke it: pdf.js commonly extracts a real "1." marker and its following
// item text as two separate text items with a purely positional (X-offset)
// gap, not an actual space character — so the concatenated line text is
// "1.Numbered item 1" with no whitespace at all, and numbered lists silently
// fell through to plain-paragraph text while bullets (BULLET_RE's `\s*`)
// worked fine. `(?!\d)` keeps both original safety properties (verified
// against every case in tests/pdf2wordLists.test.js) while fixing this.
// Letter/roman enumeration ("a.", "iv.") is deliberately excluded here —
// too easy to confuse with initials or headers on the marker shape alone,
// and detectTables()'s own "prefer false negatives" philosophy applies
// here too. LETTERED_RE below exists specifically for pdf2word's own,
// separately-gated use (indentation-checked at the call site, not usable
// standalone) — see that constant's own comment for why an indent
// requirement changes the risk calculus enough to reintroduce it there.
export const BULLET_RE   = /^[•◦▪‣●○]\s*/;
export const NUMBERED_RE = /^\d{1,3}[.)](?!\d)/;

// A single-letter marker ("a.", "b)", "A."), used ONLY by pdf2word
// (js/processor.js's _processLines) and ONLY when the line is also
// indented past the page's own baseline left margin — never standalone.
// Real, competitor-verified gap: a lettered sub-list under a numbered
// parent item ("1. Complete setup" / "  a. Verify email" / "  b. Choose a
// name") had its sub-items silently merged into ONE paragraph, since
// neither BULLET_RE nor NUMBERED_RE recognized them as list markers at
// all — iLovePDF and Smallpdf both split them into separate list items.
// The indentation requirement at the call site is what makes this safe to
// add despite the exclusion note above: a false positive like "A. Smith
// wrote the report." sits at the SAME x as ordinary body text (no real
// PDF indent, unlike a genuine sub-item), so it fails the indent gate and
// is correctly left as plain prose — verified directly against that exact
// fixture (tests/pdf2wordParagraphs.test.js).
export const LETTERED_RE = /^[a-zA-Z][.)](?!\w)/;

// Shared bold-font-name detector — both pdf2word's and pdf2md's _isFontBold
// resolve a font's real embedded PostScript/CFF name via page.commonObjs
// (content.styles' fontFamily alone reports a generic CSS fallback for these,
// see either _isFontBold's own comment) and test it against this pattern.
// "bold|heavy|black" alone misses a real, common case: LaTeX's default
// Computer Modern family (and XeLaTeX/LuaLaTeX's Latin Modern) names its bold
// weight "BX" (Bold Extended), never spelling out "bold" — e.g. "CMBX9",
// "CMBXTI10" (bold extended italic), "LMBX10". Found directly on a real
// arXiv two-column paper (tests/fixtures/columns' organic corpus, mirrored in
// Atlas_DR's md_corpus/002-two-column-paper): a section heading using CMBX9
// was silently scored as non-bold, which cascaded into it never qualifying
// for the bold-heading fallback either. No trailing \b after "bx" — real
// names append a point-size digit suffix directly ("CMBX9"), and \b can't
// match between two \w characters (letter, then digit).
export const BOLD_FONT_NAME_RE = /bold|heavy|black|\b(?:cm|lm)(?:ss)?bx/i;

// Shared guard for both pdf2word's and pdf2md's _isBoldHeadingLine — a bold,
// short, isolated line is usually a real section title, but a real financial
// table's bold subtotal/closing-balance row looks identical to that
// heuristic (bold, short-ish, followed by more content). Found directly on a
// real 28-row debit/credit ledger (Atlas_DR's md_corpus/003-multipage-ledger,
// the same document the table-detection fix above targets): "Subtotal thru
// 04/23 28,971.05 21,945.70" and "04/30 Closing Balance 38,744.05" both got
// wrongly promoted to Markdown/Word headings. A comma-grouped, 2-decimal
// currency-formatted number (e.g. "28,971.05") is a strong, precise signal
// that a line is tabular/financial data, not a real heading — real section
// titles essentially never contain a specifically-formatted amount like
// that. Requires the comma group (excludes bare "5.11", a real numbered
// heading/clause reference) so ordinary numbered headings stay unaffected.
export const MONEY_TOKEN_RE = /\d{1,3}(?:,\d{3})+\.\d{2}\b/;

// Decides, per page, whether pdf.js's dir:'rtl' item strings are in visual order and
// need _visualRTLToLogical. pdf.js 3.11 already runs its own bidi pass and returns
// LOGICAL order for real Hebrew/Arabic PDFs (Chromium, LibreOffice and pdf-lib
// output alike) — unconditionally reversing them turned every RTL word in
// pdf2md/pdf2word/pdf2excel output backwards (corpus gate, 2026-09-30: recall
// ~0.25 on the Wikipedia ar/he articles). Votes on letters that can only sit at
// one end of a word: Hebrew final forms (ך ם ן ף ץ) and Arabic ة/ى end a word,
// the article ال begins one. Seeing them at the opposite end means visual order.
// Standalone لا is excluded — after NFKC it is the reverse of ال and so votes both
// ways. Reverses only on clear evidence; undecided (e.g. pdf.js giving one glyph
// per item) keeps pdf.js's order, since a wrong reversal garbles every word.
const _HE_AR_WORD_FINAL_RE = /[\u05DA\u05DD\u05DF\u05E3\u05E5\u0629\u0649]/;
// A word in presentation forms says its own order: an initial form starts a
// word, a final form ends one. A word drawn starting with a final (or medial)
// form, or ending with an initial one, is in visual order. Where pdf.js gives
// them they decide alone: a Persian page in logical order, word after word
// drawn left to right (mPDF), was voted visual by "کالا" and "بالا" ending in
// لا — its every letter reversed, "تسا" for "است" (2026-10-17).
export function rtlItemsAreVisual(items) {
  const { logical, visual } = rtlOrderVotes(items);
  return visual >= 3 && visual > 2 * logical;
}
// rtlItemsAreVisual's votes: words read as stored (logical) and backwards (visual).
export function rtlOrderVotes(items) {
  let logical = 0, visual = 0;
  for (const item of items) {
    if (item.dir !== 'rtl' || !item.str) continue;
    for (const token of item.str.split(/\s+/)) {
      // whole words only: a word cut at a glyph with no Unicode (a broken
      // font's Private Use codes) ends in an initial form and looked backwards
      const word = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
      if (/^[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFC]{2,}$/.test(word)) {
        const order = _formsOrder(word);
        if (order) {
          if (order === 'visual') visual++; else logical++;
          continue;
        }
      }
      for (const w of token.normalize('NFKC').split(/[^\u0590-\u05FF\u0600-\u06FF]+/)) {
        if (w.length < 3) continue;
        if (_HE_AR_WORD_FINAL_RE.test(w[w.length - 1]) || w.startsWith('\u0627\u0644')) logical++;
        // ال reversed ends a word in لا — so do إلا, كلا, مثلا, بالا, کالا: short
        // words; an article and its noun make five letters or more
        if (_HE_AR_WORD_FINAL_RE.test(w[0]) || (w.length >= 5 && w.endsWith('\u0644\u0627'))) visual++;
      }
    }
  }
  return { logical, visual };
}
// Which way a word's presentation forms join: 'logical' when every two
// neighbouring forms join left to right as stored (an initial or medial form
// followed by a medial or final one, a final or isolated one by an initial or
// isolated one), 'visual' when only reversed, null when neither or both — a
// font with a broken encoding gives forms at random ("ﻇﻌربرتﻆﻐ").
const _JOINS_ON = { initial: true, medial: true, final: false, isolated: false };
const _JOINED = { initial: false, medial: true, final: true, isolated: false };
function _formsOrder(word) {
  let fwd = true, back = true, pairs = 0;
  for (let k = 1; k < word.length; k++) {
    const a = _PF_POSITION.get(word[k - 1]), b = _PF_POSITION.get(word[k]);
    if (!a || !b) continue;
    pairs++;
    if (_JOINS_ON[a] !== _JOINED[b]) fwd = false;
    if (_JOINS_ON[b] !== _JOINED[a]) back = false;
  }
  if (pairs) return fwd === back ? null : fwd ? 'logical' : 'visual';
  // no two forms side by side: Word writes nominal letters and only the
  // lam-alef ligature as a form ("ابتﻼ"); a final one ends the word as stored.
  // Lone forms of other letters are left out — a broken encoding's are random.
  const lastLamAlef = /[\uFEF6\uFEF8\uFEFA\uFEFC]$/.test(word), firstLamAlef = /^[\uFEF6\uFEF8\uFEFA\uFEFC]/.test(word);
  return lastLamAlef === firstLamAlef ? null : lastLamAlef ? 'logical' : 'visual';
}
// Each Arabic presentation form's position — isolated, final, initial or
// medial — from its place in its letter's run of forms (Unicode orders them
// so; a two-form letter has isolated and final only).
const _PF_POSITION = (() => {
  const m = new Map();
  const NAMES = ['isolated', 'final', 'initial', 'medial'];
  for (const [lo, hi] of [[0xFB50, 0xFBFF], [0xFE70, 0xFEFC]]) {
    let cp = lo;
    while (cp <= hi) {
      const base = String.fromCodePoint(cp).normalize('NFKC');
      if (base.length !== 1 || base.codePointAt(0) === cp || !/[\u0600-\u06FF]/.test(base)) { cp++; continue; }
      let n = 1;
      while (n < 4 && cp + n <= hi && String.fromCodePoint(cp + n).normalize('NFKC') === base) n++;
      if (n === 2 || n === 4) for (let k = 0; k < n; k++) m.set(String.fromCodePoint(cp + k), NAMES[k]);
      cp += n;
    }
  }
  // the lam-alef ligatures, two letters each: isolated and final
  for (let cp = 0xFEF5; cp <= 0xFEFC; cp += 2) { m.set(String.fromCodePoint(cp), 'isolated'); m.set(String.fromCodePoint(cp + 1), 'final'); }
  return m;
})();

// Puts one RTL line's items (in pdf.js content-stream order) into logical order, IN
// PLACE — only when the stream itself runs left-to-right across the line's text.
// Chromium-printed Arabic/Farsi arrives one presentation-form glyph per item, drawn
// left to right (visual); keeping that order spelled every word backwards and, with
// no space items in the stream, glued the words together (corpus gate 2026-09-30).
// Chromium also writes a mixed line as runs in visual order — "?", "PDF", then one
// Hebrew run for "...האם יש הגבלה ... קבצי PDF?" — so the direction is judged across
// every item with letters or digits, not the RTL ones only (with a single RTL run
// there is nothing to compare; ground-truth set 2026-10-01). Such a line is
// re-sorted right-to-left, embedded LTR runs ("PDF", "1993") are flipped back to
// left-to-right, and an X-gap wider than 20% of the font size becomes a space —
// the same threshold the LTR line-join paths use. A stream that already runs
// right-to-left (logical: Word/LibreOffice output) is left alone.
const _BIDI_MIRROR = {'(':')',')':'(','[':']',']':'[','{':'}','}':'{','<':'>','>':'<'};
// Arabic-Indic / Persian digits (U+0660-0669, U+06F0-06F9) are left out: they run
// left-to-right inside RTL text, so "۱۳۹۹" drawn digit by digit must stay in order.
const _RTL_CHAR_RE = /[\u0590-\u05FF\u0600-\u065F\u066A-\u06EF\u06FA-\u06FF\u0750-\u077F\uFB1D-\uFB4F\uFB50-\uFDFF\uFE70-\uFEFF]/;
const _STRONG_CHAR_RE = /[\p{L}\p{N}]/u;
const _ARABIC_MARKS_RE = /^[\u064B-\u065F\u0670]+$/;
// Isolated/final presentation forms of the dual-joining Arabic-script letters (the
// 4-form groups; offsets 0 and 1), derived from Unicode's own NFKC mapping. Such a
// glyph followed, with no gap, by another letter means the join was broken on
// purpose — a Persian half-space (ZWNJ: "نرم‌افزار", "می‌توان"). pdf.js drops the
// U+200C itself, so it is restored from the glyph forms.
const _JOIN_BROKEN_FORMS = (() => {
  const set = new Set();
  for (const [lo, hi] of [[0xFB50, 0xFBFF], [0xFE80, 0xFEFC]]) {
    for (let cp = lo; cp <= hi - 3; cp++) {
      const base = String.fromCodePoint(cp).normalize('NFKC');
      if (base.length !== 1 || base.codePointAt(0) === cp) continue;
      const prevBase = String.fromCodePoint(cp - 1).normalize('NFKC');
      if (prevBase === base) continue; // not the first form of its group
      let n = 1;
      while (n < 4 && String.fromCodePoint(cp + n).normalize('NFKC') === base) n++;
      if (n === 4 && String.fromCodePoint(cp + 4).normalize('NFKC') !== base) { set.add(cp); set.add(cp + 1); }
    }
  }
  return set;
})();
export function reorderVisualRtlLine(items) {
  // Lines are grouped after a sort by y, so a raised footnote mark ("[1]") or a
  // run on a slightly different baseline arrives out of stream order — restore it
  // from `seq` (the item's pdf.js index) before judging direction. A logical line
  // left as is then also keeps its true stream order.
  // A step to an item more than 2 em away is no step within the text: two columns'
  // lines merged on one baseline put the other column's run between them (ground
  // truth ar-cols2 2026-10-02: the jump across the gutter outvoted the one real
  // left-to-right step, so "مئة صفحة كلما احتجت." stayed "كلما احتجت.مئة صفحة").
  items.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const spaceWidth = _lineSpaceWidth(items);
  // kept on the items: a table cell is joined from them later (joinSpacedItems)
  if (spaceWidth) for (const item of items) item.spaceWidth = spaceWidth;
  let ltrSteps = 0, rtlSteps = 0, prev = null;
  for (const item of items) {
    if (!_STRONG_CHAR_RE.test(item.str)) continue;
    const gap = prev && Math.max(item.x - (prev.x + (prev.width || 0)), prev.x - (item.x + (item.width || 0)));
    if (prev && gap <= 2 * (item.fontSize || 10)) {
      if (item.x > prev.x) ltrSteps++;
      else if (item.x < prev.x) rtlSteps++;
    }
    prev = item;
  }
  // a logical line still gets its word gaps: a PDF drawing each letter alone
  // (macOS Quartz) has no space items, and a list on such a page came out
  // "الأردن–مركزالحیاة–راصد" (corpus 6199289, 2026-10-19)
  // — spaces only: a final form meeting the next letter is no half-space sign
  // there, the word boundary just lost its space ("تربیت‌و", 3201970)
  if (ltrSteps <= rtlSteps) { _spaceGaps(items, false, spaceWidth); return; }

  // Arabic harakat (fatha, damma, shadda, tanween...) arrive as their own zero-width
  // items. Sorted on their own they landed on the neighbouring word ("مئةً صفحة" for
  // "مستندًا من مئة صفحة"), and their x opened false gaps ("سُ طّح"). In a visual
  // stream each mark is drawn just before the glyph it sits on (the cluster is laid
  // out reversed), so it joins the next glyph in stream order — space items skipped —
  // if that glyph is within 0.5 em: ground truth 2026-10-02 29/29, Wikipedia ar 15/15.
  // x alone can't decide: the font's mark offset puts "يُ"'s damma inside the غ before
  // it. The glyph's own left edge is the last letter of its item, so the mark is
  // appended there. With no glyph that close the mark's own letter is missing from
  // the text layer (a glyph with no Unicode mapping — every such case measured, 6/6);
  // the mark is dropped rather than put on the wrong letter, where its x also split
  // the word ("سُ طّح" for "يُسطّح").
  const joined = new Set();
  items.forEach((mark, i) => {
    if (!_ARABIC_MARKS_RE.test(mark.str)) return;
    joined.add(mark);
    const base = items.slice(i + 1).find(item => item.str.trim() && !_ARABIC_MARKS_RE.test(item.str));
    if (base && Math.abs(base.x - mark.x) <= 0.5 * (mark.fontSize || 10)) base.str = (base.str + mark.str).normalize('NFC');
  });

  // Right edge first: pdf.js splits a lam-alef ligature glyph into items that share
  // one left x (e.g. "ال" width 9 and "إ" width 0), and only the right edge puts
  // them in reading order. Whitespace items narrower than a word gap (that split
  // leaves near-zero-width ones) are dropped — real gaps are recovered below.
  const right = item => item.x + (item.width || 0);
  const ordered = items
    .filter(item => !joined.has(item) && (item.str.trim() || item.width > item.fontSize * 0.2))
    .sort((a, b) => (right(b) - right(a)) || (b.x - a.x));
  // Left-to-right runs, as in the Unicode bidi algorithm: Latin words ('L') absorb
  // neutrals between them; numbers ('N') only a lone separator ("1,234", "۱۳۹۹/۱")
  // — numbers act as RTL toward neutrals, so "[6][7]" and "۱۳۹۹ (pdf" break apart.
  const ltrKind = item => (_RTL_CHAR_RE.test(item.str) ? null
    : /\p{L}/u.test(item.str) ? 'L' : /\p{N}/u.test(item.str) ? 'N' : null);
  const joinsRun = (item, kind) => (kind === 'L'
    ? !_STRONG_CHAR_RE.test(item.str)
    : /^[.,:/\u066B\u066C]$/.test(item.str));
  const inLtrRun = new Set();
  for (let i = 0; i < ordered.length; i++) {
    const kind = ltrKind(ordered[i]);
    if (!kind) continue;
    let end = i;
    for (let j = i + 1; j < ordered.length; j++) {
      if (ltrKind(ordered[j]) === kind) end = j;
      else if (!joinsRun(ordered[j], kind)) break;
    }
    const run = ordered.slice(i, end + 1);
    run.forEach(item => inLtrRun.add(item));
    ordered.splice(i, run.length, ...run.reverse());
    i = end;
  }
  // A bracket in right-to-left flow is drawn as its mirror glyph and extracted as
  // that glyph's character; once the line reads right-to-left, mirror it back —
  // once: a line already reordered is reordered again run by run for its table
  // cells (lineRuns, pdf2word), and a second mirroring turned "(pdf)" back.
  for (const item of ordered) {
    if (!inLtrRun.has(item) && !item.mirrored && !_STRONG_CHAR_RE.test(item.str)) {
      item.str = item.str.replace(/[()[\]{}<>]/g, c => _BIDI_MIRROR[c]);
      item.mirrored = true;
    }
  }
  _spaceGaps(ordered, true, spaceWidth);
  items.splice(0, items.length, ...ordered);
}

// The width of the line's own space glyph — its narrowest whitespace item
// (justification stretches the others), not counting the near-zero ones a
// lam-alef split leaves — or 0 when it draws none.
// A word gap: over 0.15 em (right-to-left lines, and table cells of any
// script — 72 non-Arabic corpus documents came out unchanged). 0.2 em, the old rule, cut
// right through real spaces — a Persian table at 6.4 pt has its words 0.19 em
// apart ("عنوانرشته", 7351637: 346 glued words → 28), a book at 13 pt 0.193 em
// (7389718) — while glyphs of one word sit 0–0.05 em apart.
const GAP_EM = 0.15;
function _lineSpaceWidth(items) {
  const w = items.filter(i => i.str && !i.str.trim() && i.width >= 0.1 * (i.fontSize || 10)).map(i => i.width);
  return w.length ? Math.min(...w) : 0;
}

// Between two neighbours in reading order: a space where a gap over GAP_EM
// separates them and neither has one — or over 0.8 of the line's own space
// glyph, if that is narrower: a Persian book set its 13 pt words 2.5 pt apart
// with a 2.6 pt space, and "در ايران" came out "درايران" (7389718: 909 glued
// words). And (`zwnj`, a visual line) a ZWNJ
// where a letter's isolated or final form meets the next letter with no gap (a
// Persian half-space).
function _spaceGaps(ordered, zwnj = true, spaceWidth = 0) {
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1], b = ordered[i];
    if (a.str.endsWith(' ') || b.str.startsWith(' ')) continue;
    const gap = Math.max(b.x - (a.x + (a.width || 0)), a.x - (b.x + (b.width || 0)));
    const wide = spaceWidth ? Math.min(b.fontSize * GAP_EM, 0.8 * spaceWidth) : b.fontSize * GAP_EM;
    if (gap > wide) b.str = ' ' + b.str;
    else if (zwnj && _JOIN_BROKEN_FORMS.has(a.str.codePointAt(a.str.length - 1)) && _RTL_CHAR_RE.test(b.str[0])) {
      b.str = '\u200C' + b.str;
    }
  }
}

// One line's items as runs: neighbours less than 0.6 em apart — a word, or the
// words of one table cell — become one item carrying the run's text; a wider gap
// (between cells) or a table rule between them (`cuts`: the rules' x positions)
// starts a new run. Each run is put in reading order on its own: Chromium writes
// a table row's cells in logical order but each cell's runs in visual order, so
// one vote over the whole row read "ورق طباعة A4" as "A4 ورق طباعة". Table code
// assigns items to cells and joins a cell's items with spaces, which turned
// Chromium-printed Persian, one glyph per item, into "ل ک ع م ج" for "جمع کل"
// (table ground truth 2026-10-02). A gap over 0.2 em becomes a space unless
// either side already has one (reorderVisualRtlLine adds them on visual text).
const _CUT_SLACK = 2; // pt — a rule drawn against a cell's text still separates
const _right = item => item.x + (item.width || 0);

// Items of one line, in reading order, as text: a space only where the gap
// between two of them is over GAP_EM — or 0.8 of the line's space glyph, if
// narrower (C9) — and neither side already has one.
export function joinSpacedItems(items) {
  let str = items[0]?.str ?? '';
  for (let k = 1; k < items.length; k++) {
    const a = items[k - 1], b = items[k];
    const gap = Math.max(b.x - _right(a), a.x - _right(b));
    const em = Math.max(a.fontSize || 0, b.fontSize || 0) || 10;
    // the line's own space glyph, as for running text (_spaceGaps)
    const space = a.spaceWidth || b.spaceWidth;
    const wide = space ? Math.min(GAP_EM * em, 0.8 * space) : GAP_EM * em;
    str += (gap > wide && !a.str.endsWith(' ') && !b.str.startsWith(' ') ? ' ' : '') + b.str;
  }
  return str;
}

export function lineRuns(items, cuts = []) {
  const segments = [];
  let segRight = -Infinity;
  for (const item of [...items].sort((a, b) => a.x - b.x)) {
    const em = item.fontSize || 10;
    const ruled = cuts.some(c => c > segRight - _CUT_SLACK && c < item.x + _CUT_SLACK);
    if (!segments.length || item.x - segRight >= 0.6 * em || ruled) segments.push([]);
    segments[segments.length - 1].push(item);
    segRight = Math.max(segments[segments.length - 1].length > 1 ? segRight : -Infinity, _right(item));
  }
  return segments.map(seg => {
    if (seg.some(item => _RTL_CHAR_RE.test(item.str))) reorderVisualRtlLine(seg);
    const str = joinSpacedItems(seg);
    const x = Math.min(...seg.map(item => item.x));
    return {
      ...seg[0], str, x, width: Math.max(...seg.map(_right)) - x,
      fontSize: Math.max(...seg.map(item => item.fontSize || 0)) || seg[0].fontSize,
      bold: seg.every(item => item.bold),
    };
  });
}

// A left-to-right line's items, with pieces that touch (a gap under 0.05 em,
// no table rule between them) joined into one: pdf.js breaks a run of CJK text
// at every glyph it reads as a radical ("项" + "⽬", "⿊" + "⾊" + "打印机墨" +
// "⽔"), and in PDF→Excel each piece counted as a cell — a Chinese invoice's
// header came out one column off (81% of its cells in place) and text rows got
// spaces mid-word ("所有 ⾦ 额均以") (2026-10-09). A real gap, even a narrow one,
// stays: those are words or cells. Only where both sides are Chinese or
// Japanese characters: a Latin item's width can take in the space after it,
// and "cell" touching "b2" was read as "cellb2" (Quick Edit e2e).
const _HAN_KANA_EDGE_RE = /[\u3040-\u30FF\u3400-\u9FFF\uF900-\uFAFF]/;
export function joinTouchingItems(items, cuts = []) {
  const out = [];
  for (const item of [...items].sort((a, b) => a.x - b.x)) {
    const prev = out[out.length - 1];
    const em = Math.max(prev?.fontSize || 0, item.fontSize || 0) || 10;
    const gap = prev && item.x - _right(prev);
    const ruled = prev && cuts.some(c => c > _right(prev) - _CUT_SLACK && c < item.x + _CUT_SLACK);
    if (prev && Math.abs(gap) <= 0.05 * em && !ruled
        && _HAN_KANA_EDGE_RE.test(prev.str.slice(-1)) && _HAN_KANA_EDGE_RE.test(item.str.charAt(0))) {
      prev.str += item.str;
      prev.width = _right(item) - prev.x;
      prev.bold = prev.bold && item.bold;
    } else {
      out.push({ ...item });
    }
  }
  return out;
}

// Spaces pdf.js puts between Chinese or Japanese characters inside one item:
// a justified line is drawn with wider character spacing, and pdf.js reads each
// widened gap as a space — "用 户 管 理 ： 身 份 证" in a Chinese white paper
// (presentations corpus, 2026-10-15; MuPDF reads the line without any). Neither
// language puts spaces between its characters; a space next to Latin letters,
// digits or Hangul (Korean is written with spaces) stays.
const _CJK_SPACED_RE = /([\u3000-\u303F\u3040-\u30FF\u3400-\u9FFF\uF900-\uFAFF\uFF01-\uFF60]) +(?=[\u3000-\u303F\u3040-\u30FF\u3400-\u9FFF\uF900-\uFAFF\uFF01-\uFF60])/g;
export function dropCjkGapSpaces(str) {
  return str.replace(_CJK_SPACED_RE, '$1');
}

// CJK radicals → the ideographs they stand for. A CJK font draws 目 and the
// Kangxi radical ⽬ with one glyph, and pdf.js gives that glyph the radical's
// code point: 1082 of the ~10 300 characters of a Chrome-printed Chinese
// Wikipedia page (一 人 大 文 日 用 自 …) came out as radicals — they look the
// same, but searching or copying "文件" finds nothing (2026-10-09; MuPDF reads
// the same file without a single one). Kangxi radicals (U+2F00–2FD5) have a
// compatibility mapping (NFKC); the simplified forms in CJK Radicals
// Supplement (⻔ ⻚ ⻓ …) don't, and are mapped here by their Unicode names
// (C-SIMPLIFIED GATE → 门, LEAF → 页, LONG → 长, LONG ONE → 長 in Japanese, …).
const _RADICAL_SUPPLEMENT = {
  '⺟': '母', '⺠': '民', '⻁': '虎', '⻄': '西', '⻅': '见', '⻆': '角', '⻉': '贝', '⻋': '车',
  '⻑': '長', '⻓': '长', '⻔': '门', '⻘': '青', '⻚': '页', '⻛': '风', '⻜': '飞', '⻝': '食', '⻢': '马',
  '⻣': '骨', '⻤': '鬼', '⻥': '鱼', '⻦': '鸟', '⻨': '麦', '⻩': '黄', '⻬': '齐', '⻮': '齿',
  '⻰': '龙', '⻳': '龟',
};
const _CJK_RADICAL_RE = /[⺀-⻳⼀-⿕]/g;
export function toUnifiedIdeographs(str) {
  return str.replace(_CJK_RADICAL_RE, c => _RADICAL_SUPPLEMENT[c] ?? c.normalize('NFKC'));
}

// Arabic presentation forms (U+FB50–FDFF, U+FE70–FEFE: the shaped isolated/initial/
// medial/final glyph codes many fonts map their glyphs to) → the plain letters they
// stand for. They display fine, but Word, search, spell-check and screen readers
// treat "ﺻﻴﻐﺔ" and "صيغة" as different text — 58% of the letters in pdf2word's
// Persian output were such codes (ground truth, 2026-10-01). Run after
// reorderVisualRtlLine, which reads the forms to restore half-spaces (ZWNJ).
// U+FEFF (zero-width no-break space / BOM) is left alone.
const _PRESENTATION_FORM_RE = /[\uFB50-\uFDFF\uFE70-\uFEFE]/g;
export function toArabicBaseLetters(str) {
  return str.replace(_PRESENTATION_FORM_RE, c => c.normalize('NFKC'));
}

// Converts a pdf.js RTL item string from visual (left-to-right screen) order to Unicode
// logical order that Word's BiDi engine expects.  Character-level reverse() corrupts
// embedded LTR words (e.g. "(Arabic)" → "(cibarA)"); this splits by run direction,
// reverses only RTL runs, applies bidi mirroring to brackets in LTR runs, then reverses
// the run order so the overall reading order is restored.
export function _visualRTLToLogical(s) {
  // Arabic-Indic digits (U+0660–0669) and Extended Arabic-Indic (U+06F0–06F9) have
  // BiDi class AN — they run left-to-right even within RTL text, so exclude them
  // from the RTL set to prevent reversal (e.g. "١٢٣" must not become "٣٢١").
  const isRTL = cp =>
    !((cp >= 0x0660 && cp <= 0x0669) || (cp >= 0x06F0 && cp <= 0x06F9)) &&
    ((cp >= 0x0590 && cp <= 0x05FF) || (cp >= 0x0600 && cp <= 0x06FF) ||
     (cp >= 0x0750 && cp <= 0x077F) || (cp >= 0xFB1D && cp <= 0xFB4F) ||
     (cp >= 0xFB50 && cp <= 0xFDFF) || (cp >= 0xFE70 && cp <= 0xFEFF));
  const segs = [];
  for (const ch of [...s]) {
    const rtl = isRTL(ch.codePointAt(0));
    if (!segs.length || segs[segs.length - 1].rtl !== rtl) segs.push({ rtl, chars: [ch] });
    else segs[segs.length - 1].chars.push(ch);
  }
  // Move trailing spaces from an LTR run into the following RTL run so the space
  // ends up between the Arabic text and the embedded LTR word after run-order reversal.
  for (let i = 0; i < segs.length - 1; i++) {
    if (!segs[i].rtl && segs[i + 1].rtl) {
      while (segs[i].chars.length && segs[i].chars[segs[i].chars.length - 1] === ' ')
        segs[i + 1].chars.unshift(segs[i].chars.pop());
    }
  }
  return segs.reverse()
    .map(seg => seg.rtl
      ? seg.chars.reverse().join('')
      : seg.chars.map(c => _BIDI_MIRROR[c] ?? c).join(''))
    .join('');
}

// Re-splits, IN PLACE, any line whose items span multiple detected column
// regions (js/pdf2wordColumns.js) into separate per-region lines (same Y,
// items partitioned by region) — a no-op when detectColumnRegions() finds
// no confident multi-column layout (the common case).
//
// Has to run here, on the freshly Y-grouped `lines` _p2wBuildPageData just
// built, not later in _p2wBuildParagraphs: the Y-proximity line-grouping
// above has no concept of columns, and for a genuine 2-column page both
// columns commonly share near-identical Y per row (same font/line-height
// page-wide) — confirmed empirically against 5 real 2-column academic
// papers, 70-85% of "lines" turned out to hold items from BOTH columns
// merged into one object. Left unfixed, _p2wBuildParagraphs's column-aware
// dispatch would have nothing meaningful left to split — a merged line
// routes whole to just one column, corrupting both (the other column's
// words vanish from their own column and get spliced into this one
// mid-sentence). Extracted as its own function, rather than left inline,
// specifically so it's unit-testable without a real pdf.js
// PDFDocumentProxy — it only needs the `lines` shape _p2wBuildPageData
// already produces at this point, not the parser itself.
//
// Returns the regions it split by (null: one column). The page's later passes
// use these same regions instead of detecting again on the split lines, where
// a line no longer shows the columns standing side by side in it.
export function _splitCrossColumnLines(lines, pageW) {
  const columnRegions = detectColumnRegions(lines, pageW);
  if (!columnRegions) return null;
  for (let li = lines.length - 1; li >= 0; li--) {
    const ln = lines[li];
    if (lineSpansRegions(ln, columnRegions)) continue; // a full-width line, not two columns' lines
    const byRegion = new Map();
    for (const item of ln.items) {
      const idx = regionIndexForX(item.x, columnRegions);
      if (!byRegion.has(idx)) byRegion.set(idx, []);
      byRegion.get(idx).push(item);
    }
    if (byRegion.size <= 1) continue; // this line only ever touched one region
    // Each piece takes its own baseline (topmost item, as a line is formed): the
    // columns' baselines can sit a few points apart, and the merged line's y came
    // from whichever column's item was higher — the other column then measured its
    // paragraph gaps from a foreign baseline (Arabic 2-col ground truth 2026-10-02:
    // 15 + 21.8 pt read as 19.5 + 18, the paragraph break lost).
    const splitLines = [...byRegion.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, regionItems]) => ({ y: Math.max(...regionItems.map(i => i.y)), rtl: ln.rtl, items: regionItems }));
    lines.splice(li, 1, ...splitLines);
  }
  return columnRegions;
}

// First-line-indent paragraphs (book/report style: no space between paragraphs,
// each one's first line indented). The vertical-gap rule never sees these breaks
// — ground truth 2026-10-01: paragraph-break recall 43% in that layout in every
// language, where pdf2docx gets 77%. A line's START is its left edge, or its
// right edge for RTL; the margin is the most common start among a line set (one
// page, or one column after a split), trusted only when it is clearly dominant.
const _EDGE_TOLERANCE = 2;  // pt — same edge despite rounding/kerning
// A line's start edge (left; right for RTL) and end edge (right; left for RTL).
const _lineStart = ln => (ln.rtl
  ? Math.max(...ln.items.map(i => i.x + (i.width || 0)))
  : Math.min(...ln.items.map(i => i.x)));
const _lineEnd = ln => (ln.rtl
  ? Math.min(...ln.items.map(i => i.x))
  : Math.max(...ln.items.map(i => i.x + (i.width || 0))));
const _lineEm = ln => Math.max(...ln.items.map(i => i.fontSize || 0)) || 10;
// Most common value, trusted only when clearly dominant (≥3 lines and ≥40%):
// centred or ragged text has no margin to measure from.
function _dominant(values) {
  let best, bestCount = 0;
  for (const x of values) {
    const count = values.filter(y => Math.abs(y - x) <= _EDGE_TOLERANCE).length;
    if (count > bestCount) { best = x; bestCount = count; }
  }
  return bestCount >= 3 && bestCount >= 0.4 * values.length ? best : undefined;
}
export function lineStartMargins(lines) {
  const margins = {};
  for (const rtl of [false, true]) {
    const set = lines.filter(ln => !!ln.rtl === rtl && ln.items.length);
    // far: the farthest end edge — the column's extent even when ragged text
    // (left-aligned, no justification) has no common end margin
    const ends = set.map(_lineEnd);
    margins[rtl ? 'rtl' : 'ltr'] = {
      start: _dominant(set.map(_lineStart)),
      end: _dominant(ends),
      far: ends.length ? (rtl ? Math.min(...ends) : Math.max(...ends)) : undefined,
    };
  }
  return margins;
}
// Indented by 0.8–4 em from its direction's start margin — wider shifts are
// centring or block quotes, not a first-line indent.
export function lineIsIndented(ln, margins) {
  const m = margins[ln.rtl ? 'rtl' : 'ltr'];
  if (m?.start === undefined || !ln.items.length) return false;
  const indent = ln.rtl ? m.start - _lineStart(ln) : _lineStart(ln) - m.start;
  const em = _lineEm(ln);
  return indent >= 0.8 * em && indent <= 4 * em;
}
// The line before a paragraph start ends like a paragraph: short of the end
// margin by more than 1 em, or on sentence-final punctuation. A full-width line
// running into a display formula ("…can be written as" | centred equation) does
// neither — without this the formula split its sentence (arXiv corpus 2026-10-01).
const _SENTENCE_END_RE = /[.!?。！？؟…]["'”’»)\]]*$/;
// "Short" counts only for a line that starts like body text — at the start margin
// or at a paragraph indent: a centred display formula is short too, and the
// sentence goes on after it ("where …").
export function lineEndsParagraph(ln, margins) {
  if (_SENTENCE_END_RE.test(ln.items.map(i => i.str).join('').trimEnd())) return true;
  const m = margins[ln.rtl ? 'rtl' : 'ltr'];
  if (m?.end === undefined || m.start === undefined) return false;
  const atStart = Math.abs(_lineStart(ln) - m.start) <= _EDGE_TOLERANCE || lineIsIndented(ln, margins);
  const short = ln.rtl ? _lineEnd(ln) - m.end : m.end - _lineEnd(ln);
  return atStart && short > _lineEm(ln);
}
// A paragraph starts at an indented line that follows a line at the margin which
// ends like a paragraph. The previous line must not be indented itself: under a
// hanging indent (list item continuations) or a block quote every line is
// shifted, and none of them start a paragraph.
export function startsIndentedParagraph(prevLn, ln, margins) {
  return lineIsIndented(ln, margins) && !lineIsIndented(prevLn, margins) && lineEndsParagraph(prevLn, margins);
}

// Paragraph gap relative to the text's own line pitch. The fixed "gap > 2.0×
// font size" rule misses paragraphs whose spacing sits near 2 em: a two-column
// page at line-height 1.4 with 0.6 em between paragraphs has gaps of 1.95–2.05 em
// against a 1.4 em pitch (ground truth 2026-10-01). Layout analysis measures gaps
// against the page's own median line spacing (Docstrum, O'Gorman 1993; pdfminer's
// relative line margin; the median-baseline-distance rule used for Arabic
// paragraph units) — here a gap over 1.25× the median pitch of a line set (page
// or column) starts a paragraph when the previous line ends like one (same guard
// as the indent rule: a display formula's taller gap must not split its sentence).
export function linePitch(lines) {
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y;
    const em = _lineEm(lines[i - 1]);
    if (gap >= 0.8 * em && gap <= 3 * em) gaps.push(gap);
  }
  if (gaps.length < 3) return undefined;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}
// The line pitch of OCR'd lines, whose paragraph breaks go by gaps alone (font
// size is a guess there — see _p2wBuildParagraphs). The lower quartile of the
// gaps, not the median: in a FAQ of 2–3-line paragraphs half the gaps are
// paragraph gaps, and a line Tesseract missed doubles one more — the median
// landed on a paragraph gap (Persian scan: 22.1pt for lines 16.5pt apart,
// paragraphs 24.8pt; 1 of 7 breaks found). Same gap range as linePitch: below
// 0.8 em are lines of two columns interleaved half a line apart.
export function ocrLinePitch(lines) {
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y;
    const em = _lineEm(lines[i - 1]);
    if (gap >= 0.8 * em && gap <= 3 * em) gaps.push(gap);
  }
  if (gaps.length < 3) return undefined;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 4)];
}
export function startsSpacedParagraph(prevLn, ln, pitch, margins) {
  if (pitch === undefined) return false;
  return prevLn.y - ln.y > pitch * 1.25 && lineEndsParagraph(prevLn, margins);
}

// A line of a table of contents: a dot leader (four dots or more, or "……")
// with a page number at either end of the line. Long and without closing
// punctuation, such a line read as a wrapped paragraph line, and a contents
// page came out as one paragraph — 12 of the 15 documents with one in the
// Arabic corpus, from Word, Distiller, Adobe PDF Library and pdfFactory
// (class C5, 2026-10-18). It is a paragraph of its own.
const _LEADER_RE = /(?:\.\s?){4,}|…{2,}|(?:·\s?){4,}/;
const _EDGE_NUMBER_RE = /(?:^|[\s.…·])[0-9\u0660-\u0669\u06F0-\u06F9]{1,4}\s*$|^\s*[0-9\u0660-\u0669\u06F0-\u06F9]{1,4}(?=[\s.…·])/;
export function isContentsEntry(ln) {
  const text = ln?.items?.map(i => i.str).join('') ?? '';
  return _LEADER_RE.test(text) && _EDGE_NUMBER_RE.test(text.trim());
}

// A heading too long for its column wraps, and every wrapped line used to become
// a heading of its own ("What's the difference between" / "Clean and Enhance
// mode?" — ground truth 2026-10-01: 0/2 headings found on two-column pages in
// en/ru/ja/zh). The next heading-sized line continues the previous one when it
// has the same size and weight, sits one line below (≤1.9 em — Arabic faces such
// as Amiri set a 15 pt heading 26 pt apart, 1.73 em), and the previous
// line really wrapped: it fills ≥60% of the body text width, the next line's
// first word wouldn't have fitted after it, and it doesn't end on sentence
// punctuation. A short line above ("Chapter 1" / "Introduction") stays a
// heading of its own.
const _HEADING_END_RE = /[.!?:;。！？؟：]["'”’»)\]]*$/;
export function continuesWrappedHeading(prevLn, ln, margins) {
  if (!prevLn || !ln || !prevLn.items.length || !ln.items.length) return false;
  const em = _lineEm(ln);
  // An OCR'd line's size is a guess from its box (±30 %): a Persian heading's
  // two lines came out 12.5 and 9.5 pt, and each became a heading of its own.
  const ocr = [...prevLn.items, ...ln.items].some(i => i.ocr);
  const tolerance = ocr ? 0.3 * Math.max(_lineEm(prevLn), em) : 0.5;
  if (Math.abs(_lineEm(prevLn) - em) > tolerance) return false;
  const bold = l => l.items.every(i => i.bold);
  if (bold(prevLn) !== bold(ln)) return false;
  const gap = prevLn.y - ln.y;
  if (gap <= 0 || gap > 1.9 * em) return false;
  if (_HEADING_END_RE.test(prevLn.items.map(i => i.str).join('').trimEnd())) return false;
  const m = margins[prevLn.rtl ? 'rtl' : 'ltr'];
  if (m?.start === undefined || m.far === undefined) return false;
  const bodyWidth = Math.abs(m.far - m.start);
  // it really wrapped: the room left before the column's farthest edge is less
  // than the next line's first word (+1 em) — that word didn't fit. Stacked bold
  // labels (a Wikipedia infobox: "Filename extension" / "Internet media type")
  // leave far more room than that and stay apart. Word width is estimated from
  // the next line's average character width; CJK wraps per character.
  const reach = prevLn.rtl ? _lineEnd(prevLn) - m.far : m.far - _lineEnd(prevLn);
  const text = ln.items.map(i => i.str).join('').trim();
  const firstWord = _isCjk(text) ? text.slice(0, 1) : text.split(/\s+/)[0];
  const charWidth = Math.abs(_lineEnd(ln) - _lineStart(ln)) / Math.max(text.length, 1);
  // ≥10 em: a column of running text — the narrowest two-column ground-truth
  // column is 15 em; a Wikipedia infobox label cell (72 pt, ~7 em) is a table
  // cell whose stacked labels all "fill" it ("Filename" / "extension" /
  // "Internet" chained into one heading before this)
  return bodyWidth >= 10 * em && Math.abs(_lineEnd(prevLn) - _lineStart(prevLn)) >= 0.6 * bodyWidth
    && reach <= firstWord.length * charWidth + em;
}

// CJK: Hiragana/Katakana, CJK Unified Ideographs, Hangul syllables, CJK Extension A/B.
// Is a page's text layer garbage rather than text? A font without a usable
// ToUnicode map makes extraction return glyph codes: control characters
// (glyph 1, 3 …) and letters from scripts that have nothing to do with each
// other side by side — an Arabic page came back as Malayalam, Kannada, Hebrew
// and Arabic fragments in one "word", an English one as ":KDW" for "What".
// Measured on the prose ground truth with ToUnicode stripped vs every page of
// the corpus (2026-10-08): control characters 8.6–18 % of the text broken
// (good pages ≤ 0.9 %), script changes between adjacent letters 9.7–46 %
// broken (good ≤ 2.3 %, Japanese with Latin words). Broken when either is
// clearly over the good range. Han, kana and bopomofo count as one script
// (Japanese mixes them by nature), and Latin next to them is no change either
// (_latinBesideCjk). Pages under 200 characters aren't judged.
const _SCRIPT_RES = ['Latin', 'Arabic', 'Hebrew', 'Cyrillic', 'Greek', 'Han', 'Hiragana', 'Katakana', 'Bopomofo',
  'Hangul', 'Devanagari', 'Thai', 'Malayalam', 'Kannada', 'Tamil', 'Telugu', 'Bengali', 'Gujarati', 'Gurmukhi',
  'Oriya', 'Armenian', 'Georgian', 'Ethiopic', 'Sinhala', 'Myanmar', 'Khmer', 'Lao', 'Tibetan', 'Syriac', 'Thaana',
  'Mongolian', 'Cherokee', 'Canadian_Aboriginal', 'Runic', 'Ogham', 'Yi', 'Tifinagh', 'Vai', 'Javanese', 'Balinese',
  'Sundanese', 'Coptic', 'Glagolitic', 'Samaritan', 'Mandaic', 'Bamum', 'Lisu']
  .map(s => [['Han', 'Hiragana', 'Katakana', 'Bopomofo'].includes(s) ? 'CJK' : s, new RegExp(`\\p{Script=${s}}`, 'u')]);
// eslint-disable-next-line no-control-regex -- intentional: counting control chars
const _CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/;
const _scriptOf = ch => { for (const [s, re] of _SCRIPT_RES) if (re.test(ch)) return s; return null; };
// Latin beside Chinese or Japanese is how both are written ("Ａブロック",
// "Ｂ面", "PDF文件"): a Japanese slide's 10 of them in 600 characters made a
// good text layer "broken", and OCR read it in its place with less of it
// (presentations corpus, 2026-10-16) — PDF→Word did the same.
const _latinBesideCjk = (a, b) => (a === 'Latin' && b === 'CJK') || (a === 'CJK' && b === 'Latin');
export function textLayerLooksBroken(text) {
  let chars = 0, control = 0, pairs = 0, switches = 0, prev = null;
  for (const ch of text) {
    if (/\s/.test(ch)) { prev = null; continue; }
    chars++;
    if (_CONTROL_RE.test(ch)) control++;
    const script = /\p{L}/u.test(ch) ? _scriptOf(ch) : null;
    if (script && prev) { pairs++; if (script !== prev && !_latinBesideCjk(script, prev)) switches++; }
    prev = script;
  }
  if (chars < 200) return false;
  return control / chars >= 0.05 || (pairs > 0 && switches / pairs >= 0.06);
}

export function _isCjk(str) {
  return /[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF\u3400-\u4DBF\uF900-\uFAFF]/.test(str);
}

// \u2500\u2500 Hyphen-orphan repair \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// A justified/narrow-column PDF (common in academic papers, the same corpus
// column-detection above was calibrated against) routinely breaks a word
// across a line with a soft, appearance-only hyphen: "informa-" / "tion".
// Left unfixed, pdf2md's line-join (a plain space between lines) turns this
// into "informa- tion" in the output Markdown \u2014 exactly the kind of
// structural noise that corrupts token/embedding quality for a downstream
// RAG consumer worse than the whitespace noise older cleanup passes
// targeted (see the Atlas structural-check discussion this shipped
// alongside: real, measured paragraph fragmentation already showed up as a
// checkFlow finding on real documents).
//
// Deliberately text-only (no PDF geometry/right-margin check): a real
// hard-hyphenated compound ("well-known") landing at a line break is
// genuinely ambiguous from text alone, and false positives here are the
// prevention target \u2014 see the two guards below (ALL-CAPS stem, exception
// dictionary) for how that ambiguity is resolved. "Prefer false negatives"
// \u2014 the same philosophy this file's other detectors already follow \u2014
// applies in reverse here: defaulting to STRIP-when-ambiguous is correct
// specifically because soft breaks are the overwhelming real-world case
// (this is the one hypothesis of this kind confirmed safe to apply
// unconditionally, unlike inferring column order or table-vs-prose from
// text patterns alone \u2014 both of those are already solved upstream via real
// geometry, see pdf2wordColumns.js/pdf2wordTables.js).
//
// Common English hard-hyphenated compounds that must NOT be de-hyphenated
// even when they happen to break at their own hyphen \u2014 a small, curated
// list (not exhaustive; a compound missing from this list still gets
// joined, just without its hyphen, a minor quality ding, not a regression
// from today's "leave it broken" default).
const HYPHEN_COMPOUND_EXCEPTIONS = new Set([
  'e-mail', 'x-ray', 't-shirt', 'a-list', 'u-turn',
  'state-of-the-art', 'well-known', 'well-being', 'well-defined', 'well-established',
  'self-driving', 'self-aware', 'self-esteem', 'self-employed', 'self-service',
  'co-founder', 'co-author', 'co-worker', 'co-operate', 'co-exist',
  'non-profit', 'non-existent', 'non-negotiable', 'non-linear', 'non-native',
  'up-to-date', 'long-term', 'short-term', 'high-quality', 'low-cost',
  'real-time', 'full-time', 'part-time', 'one-time', 'follow-up', 'check-in',
  'check-out', 'built-in', 'hands-on', 'in-depth', 'pre-existing', 'post-war',
  'editor-in-chief', 'mother-in-law', 'father-in-law', 'over-the-counter',
]);

// URL/email/identifier-shaped text must never be de-hyphenated \u2014 a hyphen
// there is virtually always semantic (a real path/slug segment), and
// splicing it out would corrupt the token, not just misjudge a compound
// word. Checked against the FULL prevText/nextText, not just the narrow
// stem+continuation match: a domain suffix like ".com" routinely falls
// outside `continuation` (the match stops at the first non-letter), so a
// break like "example-" / "site.com" would otherwise slip through with
// ".com" sitting unchecked in the leftover tail. Deliberately errs toward
// over-blocking (a real hyphen elsewhere in the same run, unrelated to a
// URL mentioned nearby, also gets skipped) \u2014 "prefer false negatives",
// same policy this file's other detectors already follow; the cost is one
// unjoined word, not a corrupted URL/email token.
const _LOOKS_LIKE_CODE_OR_URL_RE = /https?:|www\.|@|_|\.[a-z]{2,4}\b/i;

/**
 * joinHyphenatedLineEnd(prevText, nextText) -> { text, hyphenKept } | null
 *
 * Pure text decision, no PDF geometry or run/formatting concerns \u2014 the
 * caller (js/pdf2mdCore.js's _flushPara) owns deciding WHETHER to even ask
 * (skipping RTL lines, formula-tagged runs) and how to splice the result
 * back into its own run array. Returns null when `prevText`/`nextText`
 * don't look like a genuine line-wrap hyphen break at all (the overwhelming
 * common case \u2014 this function is a no-op for ordinary text).
 */
export function joinHyphenatedLineEnd(prevText, nextText) {
  const stemMatch = /(\p{L}{2,})-$/u.exec(prevText);
  if (!stemMatch) return null;
  const contMatch = /^\p{Ll}[\p{L}]*/u.exec(nextText);
  if (!contMatch) return null; // continuation must start lowercase \u2014 a capitalized
                                // word starting the next line is a new sentence/proper
                                // noun, not a broken word's continuation.

  const stem         = stemMatch[1];
  const continuation = contMatch[0];
  const withHyphen   = `${stem}-${continuation}`;
  const withoutHyphen = `${stem}${continuation}`;
  const restOfNext   = nextText.slice(continuation.length);
  const restOfPrev   = prevText.slice(0, prevText.length - stemMatch[0].length);

  if (_LOOKS_LIKE_CODE_OR_URL_RE.test(prevText) || _LOOKS_LIKE_CODE_OR_URL_RE.test(nextText)) return null;

  // An ALL-CAPS stem (an acronym/initialism \u2014 "NASA-approved") is a real,
  // semantic hyphen almost by definition: a genuine soft line-break happens
  // mid-word, and mid-word fragments of ordinary prose are essentially
  // never all-caps on their own.
  const stemIsAllCaps = stem === stem.toUpperCase() && stem !== stem.toLowerCase();
  const keepHyphen = stemIsAllCaps || HYPHEN_COMPOUND_EXCEPTIONS.has(withHyphen.toLowerCase());

  return {
    text: restOfPrev + (keepHyphen ? withHyphen : withoutHyphen) + restOfNext,
    hyphenKept: keepHyphen,
  };
}

// pdf.js text items (getTextContent with includeMarkedContent) with each
// marked-content span that carries /ActualText read as that text, and the
// marker items dropped. `spans`: one entry per BDC/BMC on the page, in
// content order — its /ActualText or null (js/pdfActualText.js). The text
// items inside such a span become one item: the span's text, over the span's
// extent, where its first item was. Spans that cover no text, or text on more
// than one line, keep their items. When `spans` doesn't match pdf.js's
// markers one for one, the items are returned as they are — the pairing is
// by order alone. Chrome's and LibreOffice's Arabic carries its real letters
// there (see pdfActualText.js).
export function applyActualText(items, spans) {
  const isBegin = i => i.type === 'beginMarkedContent' || i.type === 'beginMarkedContentProps';
  const text = items.filter(i => 'str' in i);
  if (!spans || items.filter(isBegin).length !== spans.length) return text;
  const out = [];
  const stack = [];       // per open span: { actual, items } or null
  let k = 0;
  let owner = null;       // the outermost open span with ActualText
  let checked = 0, unfit = 0;
  const close = frame => {
    // word spaces drawn inside the span stay items of their own: their x is
    // what puts a space between two words
    const core = frame.items.filter(i => i.str.trim());
    const isSpace = i => !i.str.trim();
    const lead = [], trail = [];
    for (const i of frame.items) { if (!isSpace(i)) break; lead.push(i); }
    for (const i of [...frame.items].reverse()) { if (!isSpace(i) || lead.includes(i)) break; trail.unshift(i); }
    const middle = frame.items.slice(lead.length, frame.items.length - trail.length);
    const actual = frame.actual.trim();
    const drawn = core.map(i => i.str.trim()).join('');
    // vowel marks and unmapped glyphs (a superscript alef) may sit well above
    // the line: only the letters' glyphs count
    const letters = core.filter(i => /\p{L}/u.test(i.str));
    const glyphs = letters.length ? letters : core;
    const sameLine = glyphs.every(i => Math.abs(i.transform[5] - glyphs[0].transform[5]) <= 0.5 * (Math.abs(glyphs[0].transform[3]) || 1));
    out.push(...lead);
    const fits = !drawn || _actualFitsDrawn(drawn, actual);
    if (drawn && actual) { checked++; if (!fits) unfit++; }
    if (!core.length || !actual || !sameLine || drawn.normalize('NFKC') === actual.normalize('NFKC') || !fits) {
      out.push(...middle);           // nothing to gain, or nothing safe to do
    } else if (core.length === 1 && middle.length === 1 && [...drawn].length === 1 && [...actual].length === 1 && _sameFormOf(drawn, actual)) {
      // one shaped glyph, one letter: the letter's own form in the same
      // position (initial, medial…) — later steps read the join from it
      out.push({ ...core[0], str: core[0].str.replace(drawn, _sameFormOf(drawn, actual)) });
    } else {
      const x0 = Math.min(...core.map(i => i.transform[4]));
      const x1 = Math.max(...core.map(i => i.transform[4] + (i.width || 0)));
      // the letter's own glyph, not a vowel mark's: a font may draw the mark
      // raised, and the text took the mark's baseline into the line above
      const first = glyphs.reduce((a, i) => ((i.width || 0) > (a.width || 0) ? i : a));
      const merged = { ...first, str: actual, width: x1 - x0, transform: [...first.transform.slice(0, 4), x0, first.transform[5]],
        dir: /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(actual) ? 'rtl' : first.dir, hasEOL: core.at(-1).hasEOL };
      // the span's text where its first glyph was, its spaces where they were
      out.push(...middle.filter(i => isSpace(i) || i === first).map(i => (i === first ? merged : i)));
    }
    out.push(...trail);
  };
  for (const it of items) {
    if (isBegin(it)) {
      const actual = spans[k++];
      const frame = actual != null && !owner ? { actual, items: [] } : null;
      if (frame) owner = frame;
      stack.push(frame);
    } else if (it.type === 'endMarkedContent') {
      const frame = stack.pop();
      if (frame && frame === owner) { close(frame); owner = null; }
    } else if ('str' in it) {
      (owner ? owner.items : out).push(it);
    }
  }
  if (owner) out.push(...owner.items);   // an unclosed span: as it was
  // a page whose ActualText misses its glyphs this often is off as a whole —
  // Adobe's was shifted by one character, its brackets too: none of it is used
  return unfit > checked / 3 ? text : out;
}

// Whether `actual` can be the text of glyphs read as `drawn`: the digits the
// glyphs show are in it, in order (either way). A file's ActualText corrects
// letters its glyphs map wrongly — Chrome's yeh (ی → ي), InDesign's kashida
// drawn as lam ("لني" → "ني"), Adobe's ض mapped as ف, a ligature mapped
// backwards ("حت" → "تح"): on every such case the corpus held, MuPDF and
// poppler read the ActualText's letter too. Where it was wrong, it was
// shifted, and the digits showed it: "(3" over the footnote number "34", and
// PDF→Word wrote "(3)" (corpus 3836300, 2026-10-17). Digits in any script are
// the same digit (Chrome: ١ glyph, ۱ text).
const _digitOf = c => {
  const cp = c.codePointAt(0);
  return cp >= 0x0660 && cp <= 0x0669 ? String(cp - 0x0660) : cp >= 0x06F0 && cp <= 0x06F9 ? String(cp - 0x06F0) : c;
};
function _actualFitsDrawn(drawn, actual) {
  const digits = t => [...t.normalize('NFKC')].map(_digitOf).filter(c => c >= '0' && c <= '9');
  const d = digits(drawn), a = digits(actual);
  const within = seq => { let k = 0; for (const c of a) if (c === seq[k]) k++; return k === seq.length; };
  return within(d) || within([...d].reverse());
}

// Arabic presentation forms by letter and position: [letter] → forms in their
// Unicode order (isolated, final[, initial, medial]), from NFKC itself.
const _FORMS_OF = (() => {
  const m = new Map();
  for (const [lo, hi] of [[0xFB50, 0xFBFF], [0xFE70, 0xFEFC]]) {
    for (let cp = lo; cp <= hi; cp++) {
      const base = String.fromCodePoint(cp).normalize('NFKC');
      if (base.length !== 1 || base.codePointAt(0) === cp) continue;
      if (!m.has(base)) m.set(base, []);
      m.get(base).push(String.fromCodePoint(cp));
    }
  }
  return m;
})();
// `form` (a presentation form) of one letter as the same position's form of
// `letter`, or null when either has no such form: "ﯾ" (Persian yeh, initial)
// and "ي" → "ﻳ".
function _sameFormOf(form, letter) {
  const own = _FORMS_OF.get(form.normalize('NFKC'));
  const target = _FORMS_OF.get(letter);
  if (!own || !target || own.length !== target.length) return null;
  return target[own.indexOf(form)] ?? null;
}

// The word spaces pdf.js drops from Arabic-script text, put back from the
// page's own glyphs. pdf.js remembers a space glyph and forgets it when the
// next glyph is drawn overlapping it — Persian InDesign and Word fonts draw
// their narrow spaces so — and joined "فصل سوم" into "فصلسوم" (the space is
// in the content stream: MuPDF and poppler keep it). `runs`: the text of each
// text-showing operator, its space glyphs as " " (from the operator list,
// where pdf.js keeps them), in drawing order — visual for some producers, so
// read both ways — and, for a run given as its glyphs, in glyph order (a
// glyph naming several letters keeps them: see restoreGlyphOrder). A word of
// the items is split only where the glyphs show those letters with spaces
// between and never as one word.
export function restoreDroppedSpaces(items, runs) {
  if (!runs?.length) return items;
  const ARABIC = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
  const split = new Map();      // joined words → the words with their spaces
  const whole = new Set();      // words the glyphs show whole
  const pairs = new Set();      // two words the glyphs show side by side, a space between
  // InDesign breaks its runs inside words, so a run's first or last "word" can
  // be a piece ("م", "ع", "ال"): a word to split into must be one — two letters
  // or more and not the bare article, or the conjunction و
  const isWord = w => w === '\u0648' || (w.length >= 2 && w !== '\u0627\u0644');
  for (const run of runs) {
    const glyphs = Array.isArray(run) ? run : [...run];
    const joined = glyphs.join('');
    if (!ARABIC.test(joined)) continue;
    for (const text of new Set([joined, [...joined].reverse().join(''), [...glyphs].reverse().join('')])) {
      const words = text.split(/\s+/).filter(Boolean);
      for (const w of words) whole.add(w);
      for (let i = 0; i < words.length; i++) {
        if (i + 1 < words.length && isWord(words[i]) && isWord(words[i + 1])) pairs.add(words[i] + '\u0001' + words[i + 1]);
        for (let n = 2; n <= 4 && i + n <= words.length; n++) {
          const part = words.slice(i, i + n);
          if (!part.every(isWord)) break;
          if (!split.has(part.join(''))) split.set(part.join(''), part.join(' '));
        }
      }
    }
  }
  if (!split.size) return items;
  // inside an item: "فصلسوم" → "فصل سوم"
  const out = items.map(item => {
    if (!item.str || !ARABIC.test(item.str)) return item;
    const str = item.str.replace(/\S+/g, w => (!whole.has(w) && split.has(w) ? split.get(w) : w));
    return str === item.str ? item : { ...item, str };
  });
  // between two items drawn touching, on one line: "نام" | "شرکت" → "نام " — the
  // first word, in reading order, takes the space, whatever order the line is
  // put together in
  const text = out.filter(i => i.str?.trim() && ARABIC.test(i.str) && i.transform);
  for (const a of text) {
    if (/\s$/.test(a.str)) continue;
    const wa = a.str.trim().split(/\s+/).pop();
    const fs = Math.abs(a.transform[3]) || 10;
    for (const b of text) {
      if (b === a || /^\s/.test(b.str) || Math.abs(b.transform[5] - a.transform[5]) > 0.3 * fs) continue;
      const gap = Math.max(a.transform[4] - (b.transform[4] + (b.width || 0)), b.transform[4] - (a.transform[4] + (a.width || 0)));
      if (gap > 0.5 * fs || gap < -0.5 * fs) continue;
      const wb = b.str.trim().split(/\s+/)[0];
      if (pairs.has(wa + '\u0001' + wb) && !whole.has(wa + wb)) { a.str += ' '; break; }
    }
  }
  return out;
}

// A number drawn in pieces across a right-to-left line's items, put back in
// its own order. Adobe drew "…عام 2015، ومن" as "…عام 15" | "٠" | "2، ومن…" and
// "2008. هذا" as "٠٠" | "8" | "2. هذا…": kept in the line's reading order, the
// digits came out "1502" and "008 2" (corpus 3836300, on production before
// 2026-10: 6 of its years). A number reads left to right, whatever the line.
// The pieces: items of digits only, and the digits a right-to-left item
// starts with (at its right end) or ends with (at its left end); pieces whose
// edges touch make one number, left to right. It goes where the text puts it —
// in place of the digits an item ends with ("…عام 2015"), else of those an
// item starts with ("2008. هذا") — and the other pieces leave their items
// (an item that was a piece only is left empty).
// `items`: one RTL line, { str, x, width, fontSize, rtl }, in reading order. In place.
// Known debt (owner, 2026-10-18): numbers in right-to-left lines go through a
// chain of local rules — this one, rtlItemsAreVisual's order vote, the
// ActualText digit check, reorderVisualRtlLine — each found on corpus cases,
// five regressions fixed on the way (TOC page numbers, dot leaders, ":2018",
// dropped phrases, adjacent numbers). They interact and no single model of a
// line's bidi runs stands behind them; a new rule here can break another's
// case. What sees such a break: numbersMissing and numberCauses of
// scripts/quality/arabic.py on the cloud corpus — run it with any change here.
// Measured and rolled back: an ActualText check that also refuses digits the
// glyphs don't show ("35" drawn, "345" ActualText) lost 96 more numbers and
// added 99 dot errors on two Adobe PDF Library 15 documents, fixing none
// (289 docs, 2026-10-18) — likely through the page-level fallback, which drops
// a page's letter fixes with its digits; not verified.
const _DIGIT = '0-9\u0660-\u0669\u06F0-\u06F9';
const _TRAILING_DIGITS = new RegExp(`[${_DIGIT}][${_DIGIT}.,/:\u066B\u066C]*$`);
const _LEADING_DIGITS = new RegExp(`^[${_DIGIT}](?:[${_DIGIT}.,/:\u066B\u066C]*[${_DIGIT}])?`);
const _ONLY_DIGITS = new RegExp(`^[${_DIGIT}.,/:\u066B\u066C]+$`);   // separators alone too: "1" | "," | "25"
export function joinSplitNumbers(items) {
  const pieces = [];
  for (const it of items) {
    const right = it.x + (it.width || 0);
    // digits, or one separator between them ("1" | "," | "25") — not a leader
    // of dots ("……….", a contents line's), which held page numbers together
    // — spaces at its ends allowed and kept (" 1": an /ActualText digit over a
    // mirrored bracket glyph, corpus 5494457, read "1202م" for "2021م")
    const bare = it.str.trim();
    if (bare && _ONLY_DIGITS.test(bare) && (/\d|[\u0660-\u0669\u06F0-\u06F9]/.test(bare) || bare.length === 1)) {
      pieces.push({ it, kind: 'all', text: bare, lead: it.str.match(/^\s*/)[0], trail: it.str.match(/\s*$/)[0], xL: it.x, xR: right });
      continue;
    }
    // a text item's first and last characters sit at its right and left ends
    // only when it runs right to left: in a left-to-right item ("…… خلفية
    // تارخيية 1", a contents line) its last character is at its right end
    if (!it.rtl) continue;
    // spaces at an item's ends stay where they are ("٠٠8" | " 2. هذا")
    const lead = it.str.match(/^\s*/)[0], trail = it.str.match(/\s*$/)[0];
    const core = it.str.slice(lead.length, it.str.length - trail.length);
    const head = core.match(_LEADING_DIGITS)?.[0];
    const tail = core.match(_TRAILING_DIGITS)?.[0];
    if (head) pieces.push({ it, kind: 'head', text: head, lead, trail, xL: null, xR: right });
    if (tail && !(head && head.length === core.length)) pieces.push({ it, kind: 'tail', text: tail, lead, trail, xL: it.x, xR: null });
  }
  if (pieces.length < 2) return;
  // pieces of one number meet exactly — 0.0–0.05 pt apart on every split
  // number found; two numbers side by side ("9/6/1422", a contents line's
  // page numbers, "90/0 ± 32") stand a few points apart and stay apart
  const em = () => 0.5;
  const rightOf = p => pieces.find(q => q !== p && q.it !== p.it && p.xR != null && q.xL != null && Math.abs(q.xL - p.xR) < em(p));
  const hasLeft = q => pieces.some(p => p !== q && p.it !== q.it && p.xR != null && q.xL != null && Math.abs(q.xL - p.xR) < em(p));
  for (const start of pieces.filter(p => !hasLeft(p))) {
    const chain = [start];
    for (let next = rightOf(start); next && !chain.includes(next) && chain.length < 12; next = rightOf(next)) chain.push(next);
    // a separator belongs between digits, not at a number's end: "2018:" is
    // the year and its colon, not ":2018"
    const isSep = p => !/\d|[\u0660-\u0669\u06F0-\u06F9]/.test(p.text);
    while (chain.length && isSep(chain[0])) chain.shift();
    while (chain.length && isSep(chain[chain.length - 1])) chain.pop();
    if (chain.length < 2) continue;
    // only a number read backwards: its left piece after its right one in the
    // line — one already in its own order ("١" | "," | "٢٥" read "١,٢٥") stays
    const at = chain.map(p => items.indexOf(p.it));
    if (!at.some((k, n) => n > 0 && k < at[n - 1])) continue;
    const number = chain.map(p => p.text).join('');
    const home = chain.find(p => p.kind === 'tail') ?? chain.find(p => p.kind === 'head') ?? chain[0];
    // the digits replaced at their own end of the item, its spaces kept
    const put = (p, digits) => {
      const s = p.it.str;
      p.it.str = p.kind === 'head' ? p.lead + digits + s.slice(p.lead.length + p.text.length)
        : s.slice(0, s.length - p.trail.length - p.text.length) + digits + p.trail;
    };
    for (const p of chain) {
      if (p === home) continue;
      if (p.kind === 'all') p.it.str = p.lead + p.trail;    // emptied (its spaces kept), not removed: the page's item list still holds it
      else put(p, '');
    }
    if (home.kind === 'all') home.it.str = home.lead + number + home.trail;
    else put(home, number);
  }
}

// The order pdf.js gives one item's characters in: [index into `chars`, …],
// with `.level`, each character's bidi level (odd: read right to left)
// — the Unicode bidi algorithm as pdf.js runs it, cut to what one text item
// needs: strong letters, digits (after Arabic they read as Arabic numbers,
// kept left to right; one separator between two digits is the number's),
// neutrals (Arabic punctuation among them) taking their neighbours'
// direction or the item's, and the runs reversed level by level.
function _bidiOrder(chars, rtl) {
  const cls = c => {
    const u = c.codePointAt(0);
    if ((u >= 0x30 && u <= 0x39) || (u >= 0x660 && u <= 0x669) || (u >= 0x6F0 && u <= 0x6F9)) return 'D';
    if (/[.,:/+\-\u066B\u066C]/.test(c)) return 'S';                    // separators
    if (/[\u060C\u061B\u061F\u066A\u06D4]/.test(c)) return 'N';            // Arabic punctuation
    if ((u >= 0x590 && u <= 0x8FF) || (u >= 0xFB1D && u <= 0xFDFF) || (u >= 0xFE70 && u <= 0xFEFF)) return 'R';
    return /\p{L}/u.test(c) ? 'L' : 'N';
  };
  const base = rtl ? 'R' : 'L';
  // one separator between two digits is part of the number ("13:00", "2.7")
  const t = chars.map(cls).map((c, i, a) => (c === 'S' ? (a[i - 1] === 'D' && a[i + 1] === 'D' ? 'D' : 'N') : c));
  // digits: Arabic numbers after an Arabic letter, else European (left to
  // right in a left-to-right item); for neutrals both count as right to left
  let strong = base;
  const dir = t.map(c => {
    if (c === 'R' || c === 'L') { strong = c; return c; }
    if (c === 'D') return rtl || strong === 'R' ? 'AN' : 'L';
    return 'N';
  });
  const side = d => (d === 'AN' ? 'R' : d);
  for (let i = 0; i < dir.length; i++) {
    if (dir[i] !== 'N') continue;
    let j = i;
    while (j < dir.length && dir[j] === 'N') j++;
    const before = i ? side(dir[i - 1]) : base, after = j < dir.length ? side(dir[j]) : base;
    for (let m = i; m < j; m++) dir[m] = before === after ? before : base;
    i = j - 1;
  }
  const level = dir.map(d => (rtl ? (d === 'R' ? 1 : 2) : (d === 'R' ? 1 : d === 'AN' ? 2 : 0)));
  const order = chars.map((_, i) => i);
  order.level = level;
  for (let lv = Math.max(0, ...level); lv >= 1; lv--) {
    for (let i = 0; i < order.length; i++) {
      if (level[order[i]] < lv) continue;
      let j = i;
      while (j < order.length && level[order[j]] >= lv) j++;
      order.splice(i, j - i, ...order.slice(i, j).reverse());
      i = j - 1;
    }
  }
  return order;
}

// The letters of a glyph that names several (a Nastaleeq ligature: "سے",
// "کی", "نو"; lam-alef "لأ"; ﷺ), put back in their order. pdf.js reads a
// line drawn in visual order through the bidi algorithm letter by letter, a
// glyph's letters with it: "ےس" for "سے", "اإلسالمية" for "الإسلامية"
// (class C11). `runs`: each text-showing operator's glyphs, in drawing
// order, a space glyph as " " (pdf2readCore's _glyphRuns). The items and the
// glyphs are paired one to one: an item takes the glyphs whose letters it
// holds, compared decomposed (NFKD) with whitespace, format characters and
// vowel marks aside (pdf.js adds and drops spaces, drops the LRM or the
// Arabic sign a glyph can name, and places the marks — separate glyphs —
// where bidi leaves them). An item is mended only where pdf.js's own string
// is reproduced exactly: its glyphs' letters put through the bidi
// algorithm give the item (its letters as pdf.js normalizes them, as the
// font names them, or decomposed — pdf.js can split "أ" before the
// reversal carries the hamza off: "ٔالاساس" for "الأساس"); the same
// glyphs, each one's letters turned around first, give it mended — in a
// right-to-left item and in a left-to-right one alike (a contents line,
// dot leaders first: bidi reverses its Arabic run only). Anything else — a
// coincidence, a mark out
// of place, an order this doesn't model — is left as pdf.js gave it. The
// first item that does not pair stops it: the rest of the page is left
// too. Then, for the items this left as they were, the first rule (#56): a
// right-to-left item holds its glyphs from its end, and a glyph found
// reversed at its own place is turned — it catches lines whose bidi this
// doesn't model exactly (numbers in brackets, "(6951-0561م)"), and can't
// turn back a glyph already read in order. Only for items pdf.js gives in
// reading order (a page rtlItemsAreVisual finds backwards is reversed back
// whole, its glyphs with it).
export function restoreGlyphOrder(items, runs) {
  return _restoreGlyphOrderInPlace(_restoreGlyphOrderExact(items, runs), runs);
}

// The page with the spaces the stream draws put back, unless that leaves it
// in pieces: a page whose Arabic words turn into single letters had spaces
// that were no word spaces (1902417, Word 2013: "و ق ال ش ي خ" for "وقال
// شيخ") — it keeps pdf.js's spacing.
function _restoreGlyphOrderExact(items, runs) {
  const spaced = _restoreGlyphOrderPass(items, runs, true);
  const plain = _restoreGlyphOrderPass(items, runs, false);
  const single = list => {
    const words = list.flatMap(i => (typeof i.str === 'string' ? i.str : '').split(/\s+/)).filter(w => /[\u0600-\u06FF]/.test(w));
    return words.length ? words.filter(w => w.replace(/[\u064B-\u0652\u0670\u0640]/g, '').length === 1).length / words.length : 0;
  };
  return single(spaced) > Math.max(0.25, single(plain) + 0.1) ? plain : spaced;
}

function _restoreGlyphOrderPass(items, runs, putSpaces) {
  const IGNORED = /[\s\p{Cf}\u064B-\u0652\u0656-\u065F\u0670]/u;
  const key = s => [...s.normalize('NFKD')].filter(c => !IGNORED.test(c)).join('');
  // each glyph with whether the stream draws a space glyph after it
  const glyphs = [];
  for (const raw of (runs ?? []).flat()) {
    const g = key(raw);
    if (g) glyphs.push({ raw, g, spaceAfter: false });
    else if (/\s/.test(raw) && glyphs.length) glyphs[glyphs.length - 1].spaceAfter = true;
  }
  // several letters: as the glyph names them, or as a compatibility ligature
  // expands (ﷺ, ﳎ) — not a letter with its own mark ("ئ" is one letter)
  const letters = s => [...s].filter(c => !IGNORED.test(c)).length;
  const multi = ({ raw }) => letters(raw) > 1 || letters(raw.normalize('NFKD')) > letters(raw.normalize('NFD'));
  const ARABIC = /[\u0600-\u06FF]/;
  // a font that names its word space "۽" (U+06FD) draws its " " inside
  // words (2262154: "ا و ذ" for "اور") — no space is put back on its page
  const sindhiAnd = glyphs.filter(x => x.raw === '\u06FD').length;
  if (!putSpaces || (sindhiAnd >= 5 && sindhiAnd > glyphs.filter(x => x.spaceAfter).length)) for (const x of glyphs) x.spaceAfter = false;
  if (!glyphs.some(x => (multi(x) || x.spaceAfter) && ARABIC.test(x.g))) return items;
  // the item's characters as bidi orders them, each with its glyph; each
  // multi-letter glyph's letters turned around first when `turned`
  // — only a glyph bidi reads right to left (odd level): one it leaves in
  // place was never turned around
  const ordered = (mine, form, rtl, turned) => {
    let seq = [];
    mine.forEach((x, gi) => { for (const c of [...form(x.raw)].filter(c => !IGNORED.test(c))) seq.push({ c, gi }); });
    if (turned) {
      const level = _bidiOrder(seq.map(e => e.c), rtl).level;
      const odd = new Set(seq.filter((e, i) => level[i] % 2 && multi(mine[e.gi])).map(e => e.gi));
      seq = mine.flatMap((x, gi) => {
        const cs = seq.filter(e => e.gi === gi);
        return odd.has(gi) ? cs.reverse() : cs;
      });
    }
    const order = _bidiOrder(seq.map(e => e.c), rtl);
    // decomposed, one entry a key character, with its glyph
    return order.flatMap(i => [...seq[i].c.normalize('NFKD')].filter(c => !IGNORED.test(c)).map(c => ({ c, gi: seq[i].gi })));
  };
  let at = 0;
  const out = [];
  for (let n = 0; n < items.length; n++) {
    const item = items[n];
    const k = typeof item.str === 'string' ? key(item.str) : '';
    if (!k) { out.push(item); continue; }
    const mine = [];
    let len = 0;
    while (len < k.length && at < glyphs.length) { mine.push(glyphs[at]); len += glyphs[at++].g.length; }
    const sorted = s => [...s].sort().join('');
    if (len !== k.length || sorted(mine.map(x => x.g).join('')) !== sorted(k)) return [...out, ...items.slice(n)];
    if (!ARABIC.test(k) || (!mine.some(multi) && !mine.slice(0, -1).some(x => x.spaceAfter))) { out.push(item); continue; }
    const rtl = item.dir === 'rtl';
    const form = [s => s.normalize('NFKC'), s => s, s => s.normalize('NFKD')].find(f => ordered(mine, f, rtl, false).map(e => e.c).join('') === k);
    const mended = form && ordered(mine, form, rtl, true);
    if (!mended) { out.push(item); continue; }
    // word spaces the stream draws between two of the item's glyphs that
    // pdf.js dropped (a space glyph the next glyph is drawn over)
    const gaps = [];
    for (let i = 0; i + 1 < mended.length; i++) {
      const a = mended[i].gi, b = mended[i + 1].gi;
      // only between glyphs the stream draws one after the other: across a
      // bidi run's edge the two are far apart there, and a space somewhere
      // between them says nothing about this place
      if (Math.abs(a - b) === 1 && mine[Math.min(a, b)].spaceAfter) gaps.push(i);
    }
    // each key character to its place among the item's decomposed characters
    // (the ignored ones staying); a glyph of several words (ﷺ) takes its
    // whole span, spaces and all, last span first so the others stay put
    const chars = [...item.str.normalize('NFKD')], where = [];
    chars.forEach((c, i) => { if (!IGNORED.test(c)) where.push(i); });
    const spans = [];
    mended.forEach((e, i) => { if (!/\s/.test(mine[e.gi].raw.normalize('NFKD'))) chars[where[i]] = e.c; });
    mine.forEach((x, gi) => {
      if (!multi(x) || !/\s/.test(x.raw.normalize('NFKD'))) return;
      const pos = mended.map((e, i) => (e.gi === gi ? i : -1)).filter(i => i >= 0);
      spans.push([pos[0], pos[pos.length - 1], x.raw]);
    });
    const missing = gaps.filter(i => !chars.slice(where[i] + 1, where[i + 1]).some(c => /\s/.test(c)));
    if (mended.map(e => e.c).join('') === k) {
      if (!missing.length) { out.push(item); continue; }
      // only spaces to put back: into pdf.js's own string, its characters as
      // they are (presentation forms kept — restoreDroppedSpaces matches the
      // glyphs by them), each after the character that ends key position i
      const orig = [...item.str], ends = new Map();
      let at = 0;
      orig.forEach((c, ci) => {
        const n = [...c.normalize('NFKD')].filter(x => !IGNORED.test(x)).length;
        if (n) { at += n; ends.set(at - 1, ci); }
      });
      for (const i of missing.sort((p, q) => q - p)) if (ends.has(i)) orig.splice(ends.get(i) + 1, 0, ' ');
      out.push({ ...item, str: orig.join('') });
      continue;
    }
    // all edits from the end back, so each one's offsets still hold
    const edits = [...missing.map(i => [where[i] + 1, 0, [' ']]), ...spans.map(([a, b, raw]) => [where[a], where[b] - where[a] + 1, [...raw.normalize('NFKD')]])];
    for (const [at, del, put] of edits.sort((p, q) => q[0] - p[0])) chars.splice(at, del, ...put);
    out.push({ ...item, str: chars.join('').normalize('NFC') });
  }
  return out;
}

// restoreGlyphOrder's first rule: each glyph at the place a right-to-left
// item reversed whole puts it (from the item's end), compared after NFKC.
function _restoreGlyphOrderInPlace(items, runs) {
  const key = s => s.normalize('NFKC').replace(/\s+/g, '');
  const glyphs = (runs ?? []).flat().map(key).filter(Boolean);
  if (!glyphs.some(g => g.length > 1 && /[\u0600-\u06FF]/.test(g))) return items;
  let at = 0;
  const out = [];
  for (let n = 0; n < items.length; n++) {
    const item = items[n];
    const k = typeof item.str === 'string' ? key(item.str) : '';
    if (!k) { out.push(item); continue; }
    const mine = [];
    let len = 0;
    while (len < k.length && at < glyphs.length) { mine.push(glyphs[at]); len += glyphs[at++].length; }
    const sorted = s => [...s].sort().join('');
    if (len !== k.length || sorted(mine.join('')) !== sorted(k)) return [...out, ...items.slice(n)];
    const fix = [];      // [offset in k, letters] for each glyph read backwards
    let pos = item.dir === 'rtl' ? k.length : 0;
    for (const g of mine) {
      const from = item.dir === 'rtl' ? pos - g.length : pos;
      const rev = [...g].reverse().join('');
      if (g.length > 1 && rev !== g && k.slice(from, from + g.length) === rev) fix.push([from, g]);
      pos = item.dir === 'rtl' ? from : pos + g.length;
    }
    if (!fix.length || item.str !== item.str.normalize('NFKC')) { out.push(item); continue; }
    // offsets in k are offsets among the item's non-space characters
    const chars = [...item.str], where = [];
    chars.forEach((c, i) => { if (!/\s/.test(c)) where.push(i); });
    for (const [from, g] of fix) [...g].forEach((c, j) => { chars[where[from + j]] = c; });
    out.push({ ...item, str: chars.join('') });
  }
  return out;
}
