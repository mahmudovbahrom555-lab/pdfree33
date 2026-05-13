// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  extractUI.js — Extract Pages options panel
//
//  Zero new logic — wraps splitUI.js and forces mode='single'.
//  The mode selector is hidden via CSS. Worker reuses handleSplit.
//
//  🎯 Сверх ТЗ:
//  1. "Smart extract" preset buttons: First half / Second half /
//     Odd pages / Even pages — один клик вместо ввода диапазона.
//  2. Re-export order toggle: выбранные страницы могут быть
//     переупорядочены (reverse) — полезно для печати буклетов.
// ============================================================

import { id }         from './utils.js';
import { showToast }  from './ui.js';
import {
  initSplitOptions,
  hideSplitOptions,
  getSelectedPages,
} from './splitUI.js';

// State for extras
let _reverse = false;
let _currentFile = null;

/**
 * Returns pages in the order they'll be extracted.
 * If reverse is on, the array is flipped.
 */
export function getExtractParams() {
  const pages = getSelectedPages();
  return {
    pages: _reverse ? [...pages].reverse() : pages,
    mode: 'single',  // always single PDF output
  };
}

// ── Public API ─────────────────────────────────────────────────

export async function initExtractOptions(file) {
  _currentFile = file;
  _reverse = false;

  // Reuse splitUI — it reads page count, renders checkboxes/range
  await initSplitOptions(file);

  // Inject our extra controls after splitUI has rendered
  _injectExtras();
}

export function hideExtractOptions() {
  hideSplitOptions();
  _currentFile = null;
  _reverse = false;
  // Remove our injected extras (they live inside splitOptions)
  id('extractExtras')?.remove();
}

// ── Injected extras ────────────────────────────────────────────

function _injectExtras() {
  const container = id('splitOptions');
  if (!container || container.style.display === 'none') return;

  // Remove any previous extras
  id('extractExtras')?.remove();

  const div = document.createElement('div');
  div.id        = 'extractExtras';
  div.className = 'extract-extras';
  div.innerHTML = `
    <div class="j2p-label">Quick select</div>
    <div class="extract-presets">
      <button type="button" class="extract-preset-btn" data-preset="odd">Odd pages</button>
      <button type="button" class="extract-preset-btn" data-preset="even">Even pages</button>
      <button type="button" class="extract-preset-btn" data-preset="first-half">First half</button>
      <button type="button" class="extract-preset-btn" data-preset="second-half">Second half</button>
    </div>
    <label class="compress-preserve" style="margin-top:8px">
      <input type="checkbox" id="extractReverse" ${_reverse ? 'checked' : ''}>
      <span class="compress-preserve__box" aria-hidden="true"></span>
      <div class="compress-preserve__text">
        <strong>Reverse page order</strong>
        <small>Useful for printing booklets (last page first)</small>
      </div>
    </label>
  `;

  // Insert before the action button area (after split-pages div)
  const splitPages = container.querySelector('.split-pages');
  if (splitPages) {
    splitPages.insertAdjacentElement('afterend', div);
  } else {
    container.appendChild(div);
  }

  _bindExtrasEvents(div);
}

function _bindExtrasEvents(div) {
  div.querySelectorAll('.extract-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => _applyPreset(btn.dataset.preset));
  });

  id('extractReverse')?.addEventListener('change', e => {
    _reverse = e.target.checked;
  });
}

function _applyPreset(preset) {
  if (!_currentFile) return;
  // We can read pageCount from the rendered split-info text
  const infoEl = document.querySelector('.split-info__pages');
  if (!infoEl) return;
  const match = infoEl.textContent.match(/(\d+)/);
  if (!match) return;
  const total = parseInt(match[1]);

  let pages = [];
  if (preset === 'odd')         pages = Array.from({length: total}, (_,i) => i+1).filter(p => p%2===1);
  if (preset === 'even')        pages = Array.from({length: total}, (_,i) => i+1).filter(p => p%2===0);
  if (preset === 'first-half')  pages = Array.from({length: Math.ceil(total/2)}, (_,i) => i+1);
  if (preset === 'second-half') pages = Array.from({length: Math.floor(total/2)}, (_,i) => Math.ceil(total/2)+i+1);

  if (pages.length === 0) { showToast('No pages match this preset'); return; }

  // Sync into splitUI's checkbox state by simulating user interaction
  // We manipulate the DOM checkboxes directly — splitUI listens for change events
  const checkboxes = document.querySelectorAll('#splitOptions input[type="checkbox"]');
  checkboxes.forEach(cb => {
    const page = parseInt(cb.value);
    const shouldCheck = pages.includes(page);
    if (cb.checked !== shouldCheck) {
      cb.checked = shouldCheck;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  // For range input (>30 pages): update the range string
  const rangeInput = id('splitRangeInput');
  if (rangeInput) {
    rangeInput.value = _pagesToRangeString(pages);
    id('splitRangeApply')?.click();
  }
}

function _pagesToRangeString(pages) {
  if (!pages.length) return '';
  const sorted = [...pages].sort((a,b) => a-b);
  const ranges = [];
  let start = sorted[0], end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end+1) { end = sorted[i]; }
    else { ranges.push(start===end ? `${start}` : `${start}-${end}`); start=end=sorted[i]; }
  }
  ranges.push(start===end ? `${start}` : `${start}-${end}`);
  return ranges.join(', ');
}
