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

import { detectColumnRegions, regionIndexForX } from './pdf2wordColumns.js';

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
// Letter/roman enumeration ("a.", "iv.") is deliberately excluded — too
// easy to confuse with initials or headers, and detectTables()'s own
// "prefer false negatives" philosophy applies here too.
export const BULLET_RE   = /^[•◦▪‣●○]\s*/;
export const NUMBERED_RE = /^\d{1,3}[.)](?!\d)/;

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

// Converts a pdf.js RTL item string from visual (left-to-right screen) order to Unicode
// logical order that Word's BiDi engine expects.  Character-level reverse() corrupts
// embedded LTR words (e.g. "(Arabic)" → "(cibarA)"); this splits by run direction,
// reverses only RTL runs, applies bidi mirroring to brackets in LTR runs, then reverses
// the run order so the overall reading order is restored.
export function _visualRTLToLogical(s) {
  const BIDI_MIRROR = {'(':')',')':'(','[':']',']':'[','{':'}','}':'{','<':'>','>':'<'};
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
      : seg.chars.map(c => BIDI_MIRROR[c] ?? c).join(''))
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

// CJK: Hiragana/Katakana, CJK Unified Ideographs, Hangul syllables, CJK Extension A/B.
export function _isCjk(str) {
  return /[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF\u3400-\u4DBF\uF900-\uFAFF]/.test(str);
}
