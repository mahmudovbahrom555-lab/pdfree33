// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  eriChecks.js — structural editability checks (pure, no DOM UI)
//
//  JavaScript port of the 3 checks Atlas_DR's eri_core/evaluate.py
//  `evaluate_structural()` actually uses from eri_core/checks.py —
//  check_tables_struct, check_paragraphs, check_flow. The other two
//  Python checks (check_tables, check_lists, check_order) need
//  corpus-specific ground truth (expected table dimensions, clause
//  markers, reading-order milestones) that an arbitrary user PDF on
//  PDFree doesn't have, so they aren't ported — see ROADMAP.md /
//  eriScore.js for the scope reasoning.
//
//  Also NOT ported for the same "needs ground truth" reason: the
//  no_merge_pairs (paragraph-merge) sub-check in Python's
//  check_paragraphs, and the dehyphen/header_leak sub-checks in
//  check_flow — all are no-ops in Python's own structural mode too
//  (GENERIC profile has none of these fields set), so omitting them
//  here changes nothing relative to the Python behavior this ports.
//
//  Checked for parity against Python in tests/eriScore.test.js. Synced
//  through Atlas_DR v0.2.2's check_tables_struct: the "irregular row
//  widths" (merged-cell) penalty, gated on anatomy.js's Tbl.regular.
// ============================================================

// Same terminal-punctuation set as eri_core/checks.py's TERMINAL.
const TERMINAL = '.!?:;»")]…%';

// Same RTL Unicode ranges as eri_core/checks.py's _RTL_RANGES — including
// the Hebrew/Arabic *presentation-form* blocks (FB1D-FB4F, FB50-FDFF,
// FE70-FEFF), not just the plain Arabic/Hebrew blocks. A reshaping library
// (e.g. arabic_reshaper, used to build the 014-rtl-notice corpus fixture)
// rewrites each letter to a contextual glyph in those presentation-form
// blocks, not the plain block — missing them was a real bug caught this
// session when the Python fix's first attempt didn't include them.
const RTL_RANGES = [
  [0x0590, 0x05FF], [0x0600, 0x06FF], [0x0750, 0x077F],
  [0xFB1D, 0xFB4F], [0xFB50, 0xFDFF], [0xFE70, 0xFEFF],
];

function isAlpha(ch) {
  return /\p{L}/u.test(ch);
}

function isRtlText(t) {
  const letters = [...t].filter(isAlpha);
  if (letters.length === 0) return false;
  const rtl = letters.filter((c) => {
    const code = c.codePointAt(0);
    return RTL_RANGES.some(([lo, hi]) => code >= lo && code <= hi);
  }).length;
  return rtl / letters.length > 0.5;
}

/** T (structural mode). A table drawn with text boxes is a picture, not a table. */
export function checkTablesStruct(a) {
  const findings = [];
  const real = a.tables.filter((t) => !t.inTextbox && t.chars > 30);
  const ghosts = a.tables.filter((t) => t.inTextbox && t.chars > 30);
  let score = 1.0;
  if (ghosts.length) {
    const share = ghosts.length / Math.max(1, ghosts.length + real.length);
    score *= 1 - 0.6 * share;
    findings.push(`${ghosts.length} table(s) trapped inside text boxes`);
  }
  const layoutish = real.filter((t) => t.rows === 1 && t.cols >= 2);
  if (layoutish.length >= 3) {
    const mult = Math.max(0.65, 0.96 ** layoutish.length);
    score *= mult;
    findings.push(`${layoutish.length} single-row strip-tables — looks like layout-by-grid (×${mult.toFixed(2)})`);
  }
  const irregular = real.filter((t) => !t.regular);
  if (irregular.length) {
    const mult = Math.max(0.7, 1 - 0.1 * irregular.length);
    score *= mult;
    findings.push(`${irregular.length} table(s) with irregular row widths (merged cells) — inserting a plain row would need surgery, not a keystroke (×${mult.toFixed(2)})`);
  }
  return { score, findings };
}

/**
 * P (structural mode). A text box is solitary confinement for text:
 * visible, not editable. A real table cell is NOT a prison.
 */
export function checkParagraphs(a) {
  const editable = a.bodyChars + a.tblChars;
  const total = editable + a.textboxChars;
  if (total === 0) return { score: 0.0, findings: ['no extractable text in the document'] };
  const share = editable / total;
  const findings = [];
  if (a.textboxChars) {
    const pct = Math.round((1 - share) * 100);
    findings.push(`${a.textboxChars} char(s) (${pct}% of text) trapped in text boxes`);
  }
  return { score: share, findings };
}

/**
 * F (structural mode). A paragraph chopped up by hard breaks is
 * mincemeat — you can't turn it back into a patty without manual work.
 */
export function checkFlow(a) {
  let body = a.paras.filter((p) => !p.inTable && p.text.trim());
  const findings = [];
  let penalties = 0.0;
  if (body.length === 0) {
    body = a.paras.filter((p) => p.inTable && !p.inTextbox && p.text.trim());
    if (body.length) {
      findings.push('no ordinary paragraphs — flow scored from table cells (table-native document)');
    } else {
      return { score: 0.0, findings: ['no text paragraphs to analyze'] };
    }
  }

  const brs = body.reduce((sum, p) => sum + p.brCount, 0);
  if (brs) {
    const pen = Math.min(0.4, (brs / Math.max(body.length, 1)) * 0.5);
    penalties += pen;
    findings.push(`${brs} hard <w:br/> break(s) inside paragraphs`);
  }

  let frag = 0;
  for (const p of body) {
    const t = p.text.trim();
    if (t.length < 50) continue; // short lines (headings, captions) aren't judged
    const last = t[t.length - 1];
    const edge = isRtlText(t) ? [t[0], last] : [last];
    if (edge.some((c) => TERMINAL.includes(c) || /\d/.test(c))) continue;
    frag += t.endsWith('-') ? 2 : 1;
  }
  if (frag) {
    const ratio = frag / body.length;
    const pen = Math.min(0.5, Math.max(0.0, ratio - 0.08) * 1.4);
    penalties += pen;
    if (pen) {
      const pct = Math.round(ratio * 100);
      findings.push(`${frag} paragraph(s) cut off without terminal punctuation (${pct}% of the corpus — layout lines, not paragraphs)`);
    }
  }

  return { score: Math.max(0.0, 1.0 - penalties), findings };
}
