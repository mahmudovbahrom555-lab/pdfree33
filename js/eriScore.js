// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  eriScore.js — Editing Readiness Index, structural mode (pure, no DOM UI)
//
//  JavaScript port of Atlas_DR's eri_core/evaluate.py `evaluate_structural()`.
//  This is the ONLY Atlas scoring mode that applies to an arbitrary user's
//  converted document (no corpus-specific ground truth is available for a
//  document PDFree has never seen before) — see eriChecks.js for exactly
//  which 3 of Atlas's 5 channels that means, and why.
//
//  This is the current production implementation for browser integration,
//  checked against Python's eri_core via corpus fixtures (see
//  tests/eriScore.test.js). If maintaining parallel Python and JavaScript
//  implementations becomes costly as Atlas grows, consolidating on one
//  shared core (e.g. via WebAssembly) is the direction to evaluate then —
//  a condition to watch for, not a scheduled rewrite.
//
//  Usage:
//    import { evaluateStructural } from './eriScore.js';
//    const result = await evaluateStructural(arrayBuffer);
//    result.eri          // 0-100
//    result.components    // { tables, paragraphs, flow }
//    result.findings       // { tables: [...], paragraphs: [...], flow: [...] }
// ============================================================

import { dissect } from './eriAnatomy.js';
import { checkTablesStruct, checkParagraphs, checkFlow } from './eriChecks.js';

// Same shape as eri_core/evaluate.py's CHECKS list — a plain array, not a
// plugin framework. Adding a future channel (lists, images, OCR) is a
// one-line append here, once a real, ground-truth-free check exists for it.
const CHECKS = [
  ['tables', checkTablesStruct],
  ['paragraphs', checkParagraphs],
  ['flow', checkFlow],
];

// Same as eri_core/profiles.py's GENERIC["weights"].
const DEFAULT_WEIGHTS = { tables: 0.20, paragraphs: 0.45, flow: 0.35 };

const STRUCTURAL_KEYS = ['tables', 'paragraphs', 'flow'];

function round(v, decimals) {
  const m = 10 ** decimals;
  return Math.round(v * m) / m;
}

function normalizeWeights(weights) {
  if (!weights) return { ...DEFAULT_WEIGHTS };
  const total = STRUCTURAL_KEYS.reduce((sum, k) => sum + (weights[k] || 0), 0);
  if (total <= 0) {
    throw new Error(`weights must have at least one positive value among ${STRUCTURAL_KEYS.join(', ')}`);
  }
  const w = {};
  for (const k of STRUCTURAL_KEYS) w[k] = (weights[k] || 0) / total;
  return w;
}

/**
 * evaluateStructural(arrayBuffer, weights?) -> {
 *   doc: 'structural', eri, components, findings, error
 * }
 *
 * `weights` may supply relative weights for a subset/superset of
 * tables/paragraphs/flow — normalized to sum to 1, so a caller can pass
 * e.g. { tables: 3, paragraphs: 1 } to mean "tables matter 3x more"
 * without also making the numbers sum to 1.0 themselves.
 */
export async function evaluateStructural(arrayBuffer, weights) {
  const w = normalizeWeights(weights);
  const a = await dissect(arrayBuffer);
  if (a.parseError) {
    return { doc: 'structural', eri: 0.0, components: {}, findings: {}, error: a.parseError };
  }

  const components = {};
  const findings = {};
  for (const [key, fn] of CHECKS) {
    const { score, findings: f } = fn(a);
    components[key] = round(score, 3);
    findings[key] = f;
  }

  const eri = 100 * STRUCTURAL_KEYS.reduce((sum, k) => sum + w[k] * components[k], 0);
  findings.flow.push("channels L (numbering) and O (order) aren't scored without a profile");

  return {
    doc: 'structural',
    eri: round(Math.max(0.0, eri), 1),
    components,
    findings,
    error: '',
  };
}
