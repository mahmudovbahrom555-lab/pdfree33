// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  extractUI.js — Extract Pages options panel
//
//  Two-column layout: left options panel + right thumbnail grid.
//  Renders real PDF thumbnails via PDF.js.
//  Supports both single-file and separate-files modes.
// ============================================================

import { loadPdfJs }                        from './pdf2jpgUI.js';
import { parseRange, pagesToRangeString }   from './pageSelectorUtils.js';
import {
  wmRemoveHtml, bindWmRemove, resetWmRemove, getWmRemove,
} from './watermarkRemoveUI.js';

const THUMBS_PER_PAGE = 16;   // 4-column grid of 4 rows
const THUMB_SCALE     = 0.18;

let _pageCount     = 0;
let _selectedPages = new Set();
let _mode          = 'single';
let _reverse       = false;
let _thumbPage     = 0;       // 0-based current thumbnail page
let _pdfDoc        = null;
let _thumbsCache   = new Map(); // pageNum → canvas
let _container     = null;
let _renderGen     = 0;

// ── Public API ────────────────────────────────────────────────

export function getExtractParams() {
  const pages = [..._selectedPages].sort((a, b) => a - b);
  return {
    pages:            _reverse ? [...pages].reverse() : pages,
    mode:             _mode,
    removeWatermarks: getWmRemove(),
  };
}

export async function initExtractOptions(file, defaultMode = 'single') {
  _container = document.getElementById('splitOptions');
  if (!_container) return;

  _pageCount     = 0;
  _selectedPages = new Set();
  _mode          = defaultMode;
  _reverse       = false;
  _thumbPage     = 0;
  _thumbsCache   = new Map();
  _pdfDoc        = null;
  resetWmRemove();

  _container.style.display = '';
  _container.innerHTML = '<div class="split-loading">Loading pages…</div>';

  const myGen = ++_renderGen;

  try {
    await loadPdfJs();
    if (myGen !== _renderGen) return;

    const buf = await file.arrayBuffer();
    _pdfDoc = await window.pdfjsLib.getDocument({
      data: new Uint8Array(buf),
      verbosity: 0,
      disableJavaScript: true,
    }).promise;
    if (myGen !== _renderGen) return;

    _pageCount     = _pdfDoc.numPages;
    _selectedPages = new Set(Array.from({ length: _pageCount }, (_, i) => i + 1));

    _container.innerHTML = _panelHTML();
    _bindEvents();
    _updateRangeInput();
    _updateSelCount();
    await _renderThumbPage(myGen);
  } catch (err) {
    if (myGen !== _renderGen) return;
    _container.innerHTML = `<div class="split-loading">Failed to load PDF: ${err.message}</div>`;
  }
}

export function hideExtractOptions() {
  ++_renderGen;
  if (_pdfDoc) { _pdfDoc.destroy(); _pdfDoc = null; }
  _thumbsCache.clear();
  if (_container) {
    _container.style.display = 'none';
    _container.innerHTML = '';
    _container = null;
  }
  resetWmRemove();
}

// ── HTML ──────────────────────────────────────────────────────

function _panelHTML() {
  const totalThumbPages = Math.ceil(_pageCount / THUMBS_PER_PAGE);
  const showPager       = totalThumbPages > 1;

  return `
    <div class="ext-layout">
      <div class="ext-panel">
        <div class="ext-section">
          <div class="ext-section__title">
            <span class="ext-step">1</span>Output format
          </div>
          <div class="ext-modes">
            <label class="ext-mode ${_mode === 'single' ? 'ext-mode--active' : ''}">
              <input type="radio" name="extMode" value="single" ${_mode === 'single' ? 'checked' : ''}>
              <strong>Single file</strong>
              <small>All selected pages in one PDF</small>
            </label>
            <label class="ext-mode ${_mode === 'separate' ? 'ext-mode--active' : ''}">
              <input type="radio" name="extMode" value="separate" ${_mode === 'separate' ? 'checked' : ''}>
              <strong>Separate files</strong>
              <small>One PDF per selected page</small>
            </label>
          </div>
        </div>

        <div class="ext-section">
          <div class="ext-section__title">
            <span class="ext-step">2</span>Select pages
          </div>
          <div class="ext-range-row">
            <input type="text" id="extRangeInput" class="ext-range-input"
                   placeholder="e.g. 1-3, 5, 7">
            <button type="button" id="extRangeApply" class="ext-apply-btn">Apply</button>
          </div>
          <div class="ext-quick-btns">
            <button type="button" class="ext-quick-btn" data-preset="all">All</button>
            <button type="button" class="ext-quick-btn" data-preset="odd">Odd</button>
            <button type="button" class="ext-quick-btn" data-preset="even">Even</button>
            <button type="button" class="ext-quick-btn" data-preset="first">1st half</button>
            <button type="button" class="ext-quick-btn" data-preset="last">2nd half</button>
          </div>
        </div>

        <div class="ext-section">
          <div class="ext-section__title">
            <span class="ext-step">3</span>Options
          </div>
          <label class="compress-preserve">
            <input type="checkbox" id="extReverse">
            <span class="compress-preserve__box" aria-hidden="true"></span>
            <div class="compress-preserve__text">
              <strong>Reverse page order</strong>
              <small>Output pages in reverse sequence</small>
            </div>
          </label>
          ${wmRemoveHtml()}
        </div>
      </div>

      <div class="ext-thumbs-col">
        <div class="ext-thumbs-grid" id="extThumbsGrid">
          <div class="split-loading">Rendering thumbnails…</div>
        </div>
        ${showPager ? `
        <div class="ext-pager">
          <button type="button" id="extPrevThumb" class="ext-pager-btn" disabled>‹</button>
          <span id="extPagerLabel" class="ext-pager-label">1 / ${totalThumbPages}</span>
          <button type="button" id="extNextThumb" class="ext-pager-btn">›</button>
        </div>` : ''}
        <div class="ext-sel-bar">
          <span id="extSelCount" class="ext-sel-count"></span>
          <button type="button" id="extClearSel" class="ext-clear-btn">Clear</button>
        </div>
      </div>
    </div>
  `;
}

// ── Events ────────────────────────────────────────────────────

function _bindEvents() {
  _container.querySelectorAll('input[name="extMode"]').forEach(r => {
    r.addEventListener('change', e => {
      _mode = e.target.value;
      _container.querySelectorAll('.ext-mode').forEach(el => {
        el.classList.toggle('ext-mode--active', el.querySelector('input').value === _mode);
      });
    });
  });

  document.getElementById('extRangeApply')?.addEventListener('click', _applyRange);
  document.getElementById('extRangeInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') _applyRange();
  });

  _container.querySelectorAll('.ext-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => _applyPreset(btn.dataset.preset));
  });

  document.getElementById('extReverse')?.addEventListener('change', e => {
    _reverse = e.target.checked;
  });

  bindWmRemove();

  document.getElementById('extClearSel')?.addEventListener('click', () => {
    _selectedPages.clear();
    _refreshThumbSelections();
    _updateSelCount();
    _updateRangeInput();
  });

  document.getElementById('extPrevThumb')?.addEventListener('click', async () => {
    if (_thumbPage > 0) { _thumbPage--; await _gotoThumbPage(); }
  });
  document.getElementById('extNextThumb')?.addEventListener('click', async () => {
    const max = Math.ceil(_pageCount / THUMBS_PER_PAGE) - 1;
    if (_thumbPage < max) { _thumbPage++; await _gotoThumbPage(); }
  });
}

// ── Thumbnails ────────────────────────────────────────────────

async function _renderThumbPage(gen) {
  const grid = document.getElementById('extThumbsGrid');
  if (!grid || !_pdfDoc) return;

  const start = _thumbPage * THUMBS_PER_PAGE + 1;
  const end   = Math.min(start + THUMBS_PER_PAGE - 1, _pageCount);

  grid.innerHTML = '';
  for (let p = start; p <= end; p++) {
    const card    = document.createElement('div');
    card.className = 'ext-thumb-card' + (_selectedPages.has(p) ? ' ext-thumb-card--sel' : '');
    card.dataset.page = p;

    const placeholder = document.createElement('div');
    placeholder.className = 'ext-thumb-placeholder';
    placeholder.textContent = p;
    card.appendChild(placeholder);

    const label = document.createElement('span');
    label.className = 'ext-thumb-label';
    label.textContent = p;
    card.appendChild(label);

    card.addEventListener('click', () => _togglePage(p));
    grid.appendChild(card);

    _renderThumb(p, card, gen);
  }
}

async function _renderThumb(pageNum, card, gen) {
  if (_thumbsCache.has(pageNum)) {
    const src    = _thumbsCache.get(pageNum);
    const canvas = document.createElement('canvas');
    canvas.width  = src.width;
    canvas.height = src.height;
    canvas.getContext('2d').drawImage(src, 0, 0);
    _insertCanvas(card, canvas);
    return;
  }
  try {
    const page   = await _pdfDoc.getPage(pageNum);
    if (gen !== _renderGen) return;
    const vp     = page.getViewport({ scale: THUMB_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width  = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    if (gen !== _renderGen) return;
    _thumbsCache.set(pageNum, canvas);
    _insertCanvas(card, canvas);
  } catch (_) { /* render errors are non-fatal */ }
}

function _insertCanvas(card, canvas) {
  const placeholder = card.querySelector('.ext-thumb-placeholder');
  if (placeholder) placeholder.remove();
  card.insertBefore(canvas, card.querySelector('.ext-thumb-label'));
}

async function _gotoThumbPage() {
  const gen = _renderGen;
  await _renderThumbPage(gen);
  _updatePager();
}

function _updatePager() {
  const total = Math.ceil(_pageCount / THUMBS_PER_PAGE);
  const label = document.getElementById('extPagerLabel');
  if (label) label.textContent = `${_thumbPage + 1} / ${total}`;
  const prev = document.getElementById('extPrevThumb');
  const next = document.getElementById('extNextThumb');
  if (prev) prev.disabled = _thumbPage === 0;
  if (next) next.disabled = _thumbPage >= total - 1;
}

// ── Selection ─────────────────────────────────────────────────

function _togglePage(p) {
  if (_selectedPages.has(p)) { _selectedPages.delete(p); }
  else                        { _selectedPages.add(p);    }
  _container?.querySelector(`.ext-thumb-card[data-page="${p}"]`)
    ?.classList.toggle('ext-thumb-card--sel', _selectedPages.has(p));
  _updateSelCount();
  _updateRangeInput();
}

function _refreshThumbSelections() {
  _container?.querySelectorAll('.ext-thumb-card').forEach(card => {
    card.classList.toggle('ext-thumb-card--sel',
      _selectedPages.has(parseInt(card.dataset.page)));
  });
}

function _updateSelCount() {
  const el = document.getElementById('extSelCount');
  const n  = _selectedPages.size;
  if (el) el.textContent = `Selected: ${n} page${n === 1 ? '' : 's'}`;
}

function _updateRangeInput() {
  const inp = document.getElementById('extRangeInput');
  if (inp) inp.value = pagesToRangeString([..._selectedPages].sort((a, b) => a - b));
}

// ── Presets & range ───────────────────────────────────────────

function _applyRange() {
  const inp = document.getElementById('extRangeInput');
  if (!inp) return;
  _selectedPages = new Set(parseRange(inp.value, _pageCount));
  _refreshThumbSelections();
  _updateSelCount();
}

function _applyPreset(preset) {
  const all = Array.from({ length: _pageCount }, (_, i) => i + 1);
  let pages;
  if (preset === 'all')   pages = all;
  else if (preset === 'odd')   pages = all.filter(p => p % 2 === 1);
  else if (preset === 'even')  pages = all.filter(p => p % 2 === 0);
  else if (preset === 'first') pages = all.slice(0, Math.ceil(_pageCount / 2));
  else if (preset === 'last')  pages = all.slice(Math.ceil(_pageCount / 2));
  else return;
  _selectedPages = new Set(pages);
  _refreshThumbSelections();
  _updateSelCount();
  _updateRangeInput();
}
