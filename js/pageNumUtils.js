// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  pageNumUtils.js — Pure page numeration formatters
//
//  Shared between pageNumUI.js (ES module) and the integration
//  tests (splitUI.logic.test.js copies them inline for speed).
//
//  NOT imported by worker.js — worker uses importScripts() and
//  can't consume ES modules. worker.js keeps its own copy of
//  _toRoman/_toAlpha. The integration tests verify both
//  implementations produce identical output, so drift is caught.
//
//  If you change the logic here, update worker.js too and run:
//    node tests/worker.integration.test.js
// ============================================================

/**
 * Format a 1-based page number in the requested style.
 * @param {number} n     — page number (1-indexed)
 * @param {'arabic'|'roman'|'alpha'} format
 * @returns {string}
 */
export function formatPageNumber(n, format) {
  if (format === 'roman') return toRoman(n);
  if (format === 'alpha') return toAlpha(n);
  return String(n);
}

/**
 * Convert integer to uppercase Roman numeral.
 * Handles 1–3999; returns String(n) for out-of-range values.
 */
export function toRoman(n) {
  if (n <= 0 || n > 3999) return String(n);
  const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms = ['M','CM','D','CD','C','XC','L','XL','X','IX','V','IV','I'];
  let result = '';
  for (let i = 0; i < vals.length; i++) {
    while (n >= vals[i]) { result += syms[i]; n -= vals[i]; }
  }
  return result;
}

/**
 * Convert integer to alphabetic label: 1→A, 26→Z, 27→AA, 52→AZ, 53→BA…
 */
export function toAlpha(n) {
  let result = '';
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}
