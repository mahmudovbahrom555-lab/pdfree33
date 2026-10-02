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
export function rtlItemsAreVisual(items) {
  let logical = 0, visual = 0;
  for (const item of items) {
    if (item.dir !== 'rtl' || !item.str) continue;
    for (const w of item.str.normalize('NFKC').split(/[^\u0590-\u05FF\u0600-\u06FF]+/)) {
      if (w.length < 3) continue;
      if (_HE_AR_WORD_FINAL_RE.test(w[w.length - 1]) || w.startsWith('\u0627\u0644')) logical++;
      if (_HE_AR_WORD_FINAL_RE.test(w[0]) || w.endsWith('\u0644\u0627')) visual++;
    }
  }
  return visual >= 3 && visual > 2 * logical;
}

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
  items.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  let ltrSteps = 0, rtlSteps = 0, prev = null;
  for (const item of items) {
    if (!_STRONG_CHAR_RE.test(item.str)) continue;
    if (prev) {
      if (item.x > prev.x) ltrSteps++;
      else if (item.x < prev.x) rtlSteps++;
    }
    prev = item;
  }
  if (ltrSteps <= rtlSteps) return;

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
  // that glyph's character; once the line reads right-to-left, mirror it back.
  for (const item of ordered) {
    if (!inLtrRun.has(item) && !_STRONG_CHAR_RE.test(item.str)) {
      item.str = item.str.replace(/[()[\]{}<>]/g, c => _BIDI_MIRROR[c]);
    }
  }
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1], b = ordered[i];
    if (a.str.endsWith(' ') || b.str.startsWith(' ')) continue;
    const gap = Math.max(b.x - (a.x + (a.width || 0)), a.x - (b.x + (b.width || 0)));
    if (gap > b.fontSize * 0.2) b.str = ' ' + b.str;
    else if (_JOIN_BROKEN_FORMS.has(a.str.codePointAt(a.str.length - 1)) && _RTL_CHAR_RE.test(b.str[0])) {
      b.str = '\u200C' + b.str;
    }
  }
  items.splice(0, items.length, ...ordered);
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
export function _splitCrossColumnLines(lines, pageW) {
  const columnRegions = detectColumnRegions(lines, pageW);
  if (!columnRegions) return;
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
    const splitLines = [...byRegion.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, regionItems]) => ({ y: ln.y, rtl: ln.rtl, items: regionItems }));
    lines.splice(li, 1, ...splitLines);
  }
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
export function startsSpacedParagraph(prevLn, ln, pitch, margins) {
  if (pitch === undefined) return false;
  return prevLn.y - ln.y > pitch * 1.25 && lineEndsParagraph(prevLn, margins);
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
  if (Math.abs(_lineEm(prevLn) - em) > 0.5) return false;
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
