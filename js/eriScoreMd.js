// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  eriScoreMd.js — Atlas ERI structural check, adapted for pdf2md's
//  Markdown output (pure, no DOM UI).
//
//  eriScore.js/eriAnatomy.js/eriChecks.js were built for pdf2word's DOCX
//  output — checkTablesStruct/checkFlow (js/eriChecks.js) turn out to be
//  format-agnostic: they only read an abstract Anatomy shape
//  ({ paras: [{text, inTextbox, inTable, brCount}], tables: [{rows, cols,
//  inTextbox, chars, regular}], ... }), never raw DOCX XML — so this file
//  reuses those two checks completely unchanged, feeding them a NEW
//  dissect-equivalent (dissectMarkdown, below) built from pdf2md's own
//  `blocks` array (js/pdf2mdCore.js's _p2mdExtractText output) instead of
//  eriAnatomy.js's word/document.xml parser.
//
//  Deliberately NOT ported: checkParagraphs (the "text trapped in a text
//  box/frame" channel). Markdown has no equivalent failure mode — there is
//  no way for pdf2md to produce a paragraph that LOOKS like body text but
//  is actually un-editable, the way a DOCX text box or w:framePr paragraph
//  can. Including it would mean a channel that trivially always scores
//  100%, which reads as a real "we checked this" signal without one
//  actually existing — dishonest by omission. Same reasoning, GFM tables
//  have no merged-cell concept, so `regular` is always true and Tbl's own
//  "irregular row widths" finding can never fire either — that channel is
//  kept anyway because its OTHER check (single-row strip-tables looking
//  like misdetected layout) is real and portable.
//
//  Weights renormalized from Atlas's DEFAULT_WEIGHTS (tables:0.20,
//  paragraphs:0.45, flow:0.35) with paragraphs dropped: 0.20/(0.20+0.35) ≈
//  0.36, 0.35/(0.20+0.35) ≈ 0.64. Not independently recalibrated against a
//  real Markdown corpus (no ground truth exists for that, same constraint
//  eriScore.js's own header notes for the DOCX case) — an honest,
//  proportionally-derived default, not a measured one.
//
//  Verdict thresholds (READY/MINOR/NOTABLE/HEAVY) are reused as-is from
//  pdf2wordUI.js's _atlasVerdict — same caveat: calibrated on DOCX corpus
//  data, not independently re-derived for Markdown.
// ============================================================

import { checkTablesStruct, checkFlow } from './eriChecks.js';

const DEFAULT_WEIGHTS = { tables: 0.36, flow: 0.64 };
const KEYS = ['tables', 'flow'];

function round(v, decimals) {
  const m = 10 ** decimals;
  return Math.round(v * m) / m;
}

function normalizeWeights(weights) {
  if (!weights) return { ...DEFAULT_WEIGHTS };
  const total = KEYS.reduce((sum, k) => sum + (weights[k] || 0), 0);
  if (total <= 0) throw new Error(`weights must have at least one positive value among ${KEYS.join(', ')}`);
  const w = {};
  for (const k of KEYS) w[k] = (weights[k] || 0) / total;
  return w;
}

/**
 * Converts pdf2md's `blocks` (from _p2mdExtractText) into the same
 * abstract Anatomy shape eriChecks.js's checkTablesStruct/checkFlow
 * expect. `list`/`image`/`formula-latex` blocks are intentionally
 * excluded from `paras` — list items are short (never penalized by
 * checkFlow's own "short lines aren't judged" rule anyway) and
 * images/formulas have no prose flow to evaluate; including them would
 * only ever dilute the signal, never sharpen it.
 */
export function dissectMarkdown(blocks) {
  const paras  = [];
  const tables = [];

  for (const b of blocks) {
    if (b.type === 'table') {
      const rows = b.rows.length;
      const cols = rows ? Math.max(...b.rows.map(r => r.length)) : 0;
      const chars = b.rows.flat().reduce((s, c) => s + (c || '').length, 0);
      // inTextbox: always false (no such concept in GFM tables).
      // regular: always true (GFM tables have no merged-cell syntax at all,
      // so a "table with irregular row widths" cannot exist by construction).
      tables.push({ rows, cols, inTextbox: false, chars, regular: true });
    } else if (b.type === 'para') {
      const text = b.runs.map(r => r.text).join('');
      paras.push({ text, inTextbox: false, inTable: false, hasNumPr: false, brCount: 0 });
    } else if (b.type === 'heading') {
      paras.push({ text: b.text, inTextbox: false, inTable: false, hasNumPr: false, brCount: 0 });
    }
  }

  return { paras, tables };
}

/**
 * evaluateMarkdownStructural(blocks, weights?) -> {
 *   doc: 'structural-md', eri, components, findings, error
 * }
 * Same return shape as eriScore.js's evaluateStructural() (minus the
 * `paragraphs` key in components/findings) so pdf2wordUI.js's existing
 * renderAtlasCheck() can consume either without modification.
 */
export function evaluateMarkdownStructural(blocks, weights) {
  const w = normalizeWeights(weights);
  const a = dissectMarkdown(blocks);

  const components = {};
  const findings    = {};

  const t = checkTablesStruct(a);
  components.tables = round(t.score, 3);
  findings.tables    = t.findings;

  const f = checkFlow(a);
  components.flow = round(f.score, 3);
  findings.flow    = f.findings;

  const eri = 100 * KEYS.reduce((sum, k) => sum + w[k] * components[k], 0);

  return {
    doc: 'structural-md',
    eri: round(Math.max(0.0, eri), 1),
    components,
    findings,
    error: '',
  };
}
