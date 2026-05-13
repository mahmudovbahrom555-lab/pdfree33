// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  pageSelectorUtils.js — Pure utilities for page selection UI
//
//  Extracted from splitUI.js and pdf2jpgUI.js where these four
//  functions were byte-for-byte identical.
//
//  renderCheckboxes / renderRangeInput return HTML strings so
//  the caller controls where and when to insert them — no hidden
//  DOM side-effects.
// ============================================================

import { esc } from './utils.js';

/**
 * Parse a comma/range string into a sorted array of 1-indexed page numbers.
 * "1-3, 5, 7-9" → [1,2,3,5,7,8,9]
 * @param {string} str
 * @param {number} maxPage
 * @returns {number[]}
 */
export function parseRange(str, maxPage) {
  const pages = new Set();
  str.split(',').forEach(part => {
    part = part.trim();
    if (!part) return;
    const dash = part.indexOf('-');
    if (dash > 0) {
      const from = parseInt(part.slice(0, dash));
      const to   = parseInt(part.slice(dash + 1));
      if (!isNaN(from) && !isNaN(to)) {
        for (let p = Math.max(1, from); p <= Math.min(maxPage, to); p++) pages.add(p);
      }
    } else {
      const p = parseInt(part);
      if (!isNaN(p) && p >= 1 && p <= maxPage) pages.add(p);
    }
  });
  return [...pages].sort((a, b) => a - b);
}

/**
 * Serialize a sorted page array back to a compact range string.
 * [1,2,3,5,7,8,9] → "1-3, 5, 7-9"
 * @param {number[]} pages
 * @returns {string}
 */
export function pagesToRangeString(pages) {
  if (!pages.length) return '';
  const sorted = [...pages].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0], end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) { end = sorted[i]; }
    else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = end = sorted[i];
    }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(', ');
}

/**
 * Render a grid of checkboxes — one per page.
 * Used when pageCount ≤ 30.
 * @param {number}   pageCount
 * @param {number[]} selectedPages  — 1-indexed selected page numbers
 * @returns {string} HTML string
 */
export function renderCheckboxes(pageCount, selectedPages) {
  const cols = Math.min(5, Math.ceil(pageCount / 4));
  let html = `<div class="split-checkboxes" style="grid-template-columns: repeat(${esc(cols)}, 1fr)">`;
  for (let i = 1; i <= pageCount; i++) {
    const checked = selectedPages.includes(i) ? 'checked' : '';
    // esc(i) — i is always an integer here, but we escape defensively:
    // if the call site ever passes non-integer selectedPages values the
    // HTML won't silently break or inject markup.
    html += `<label class="split-cb ${checked ? 'checked' : ''}">
      <input type="checkbox" value="${esc(i)}" ${checked}><span>${esc(i)}</span>
    </label>`;
  }
  return html + '</div>';
}

/**
 * Render a text-input + apply button for range entry.
 * Used when pageCount > 30.
 * @param {number[]} selectedPages
 * @param {string}   inputId        id for the <input>
 * @param {string}   applyBtnId     id for the Apply button
 * @returns {string} HTML string
 */
export function renderRangeInput(selectedPages, inputId = 'splitRangeInput', applyBtnId = 'splitRangeApply') {
  const rangeStr = pagesToRangeString(selectedPages);
  return `
    <div class="split-range">
      <input type="text"
        id="${esc(inputId)}"
        class="split-range__input"
        value="${esc(rangeStr)}"
        placeholder="e.g. 1-5, 8, 10-12"
        aria-label="Page range">
      <button type="button" class="split-range__apply" id="${esc(applyBtnId)}">Apply</button>
    </div>
    <div class="split-range__hint">Comma-separated pages or ranges, e.g. 1-3, 5, 7-10</div>
  `;
}
