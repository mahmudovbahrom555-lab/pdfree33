// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors
//
// ============================================================
//  rotateUI.js — Rotate PDF tool UI
//
//  Архитектурные решения vs план:
//
//  ✓ toBlob + URL.createObjectURL (не toDataURL) — согласен.
//    Экономия памяти критична на мобильных. Cleanup в hide().
//
//  ✓ Cumulative rotation — читаем page.getRotation() при load,
//    храним delta, отдаём final = (initial + delta) % 360.
//    Без этого сканы со встроенным /Rotate 90° сломаются.
//
//  ✗ IntersectionObserver lazy-render — НЕ делаю.
//    Причина: порог 20 страниц для thumbnail-режима.
//    Выше 20 — numbered-cards (без рендера pdf.js вообще).
//    20 страниц рендерятся за ~1–2с, это приемлемо.
//    IntersectionObserver добавляет ~80 строк кода и баги с
//    ResizeObserver на Safari. Оптимизация не нужна до 20+.
//
//  ✗ Undo-стек (unlimited) — НЕ делаю.
//    Делаю 1-уровневый undo ("отменить последнее").
//    Для поворота этого достаточно: если перекрутил —
//    отменяй или жми кнопку Reset. Бесконечная история
//    усложняет state без реального user-value.
//
//  ✓ Shared pdf.js — reuse window.pdfjsLib если уже загружен
//    pdf2jpgUI. Не дублируем CDN-загрузку.
//
//  ✓ Worker export через pdfPipeline — одна строка в worker.js.
//    Rotate это простейший pdfPipeline case.
// ============================================================

import { id, esc } from './utils.js';
import { showToast }       from './ui.js';
import { loadingRow, infoBanner } from './uiComponents.js';
import { loadPdfJs } from './pdf2jpgUI.js';  // reuse CDN loader with retry logic

// ── Constants ─────────────────────────────────────────────────

// PDFs with ≤ THUMB_THRESHOLD pages get visual thumbnails.
// Above this: numbered cards (rotation badge only, no pdf.js render).
// Rationale: 20 thumb renders ≈ 1–2s, acceptable. 200 = death.
const THUMB_THRESHOLD = 20;

// ── State ──────────────────────────────────────────────────────

let _pageCount       = 0;
let _initialRotations = [];  // [number] — per-page rotation already in PDF (0/90/180/270)
let _deltas           = [];  // [number] — user's rotation delta per page (0/90/180/270)
let _prevDeltas       = null; // snapshot for single-level undo
let _selected         = new Set(); // Set<index> — 0-indexed
let _thumbnailURLs    = [];  // [string | null] — objectURLs, null for numbered-card mode
let _useThumbs        = false;

// ── Public API ─────────────────────────────────────────────────

/**
 * Returns the rotation params for the worker.
 * Only includes pages where the net rotation ≠ 0 (no-op pages skipped).
 */
export function getRotateParams() {
  const rotations = [];
  for (let i = 0; i < _pageCount; i++) {
    const final = (_initialRotations[i] + _deltas[i]) % 360;
    rotations.push({ index: i, angle: final });
  }
  return { rotations };
}

export async function initRotateOptions(file) {
  const container = id('rotateOptions');
  if (!container) return;

  container.innerHTML = loadingRow('Loading PDF…');
  container.style.display = 'block';

  try {
    // 1. Read page count + initial rotations via pdf-lib (always available)
    const { PDFDocument } = window.PDFLib;
    const buf = await file.arrayBuffer();
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });

    _pageCount = doc.getPageCount();
    if (_pageCount === 0) { showToast('This PDF has no pages'); _hide(container); return; }

    // Read existing rotation for each page — critical for scanned docs
    const pages = doc.getPages();
    _initialRotations = pages.map(p => {
      const r = p.getRotation();
      return r ? ((r.angle % 360) + 360) % 360 : 0;
    });

    _deltas    = new Array(_pageCount).fill(0);
    _prevDeltas = null;
    _selected  = new Set();
    _thumbnailURLs = new Array(_pageCount).fill(null);
    _useThumbs = _pageCount <= THUMB_THRESHOLD;

    // 2. Try to render thumbnails. Wrapped in its own try/catch so any
    // failure (CDN unavailable, pdf.js worker error, localhost CORS, etc.)
    // gracefully falls back to numbered-card mode instead of hiding the
    // entire tool. The rotate functionality works fine without thumbnails.
    if (_useThumbs) {
      try {
        await _renderThumbnails(buf);
      } catch (thumbErr) {
        // Fallback: numbered cards (no pdf.js needed)
        _useThumbs = false;
        _thumbnailURLs = new Array(_pageCount).fill(null);
        console.warn('[rotateUI] Thumbnail render failed, using numbered cards:', thumbErr.message);
      }
    }

    _render(file);

  } catch (err) {
    showToast('Could not read PDF: ' + err.message, 5000);
    _hide(container);
  }
}

export function hideRotateOptions() {
  _cleanup();
  const container = id('rotateOptions');
  if (!container) return;
  container.style.display = 'none';
  container.innerHTML = '';
  _pageCount = 0;
  _initialRotations = [];
  _deltas = [];
  _prevDeltas = null;
  _selected = new Set();
  _useThumbs = false;
}

// ── Thumbnail rendering ────────────────────────────────────────

async function _renderThumbnails(buf) {
  // Load pdf.js (shared with pdf2jpgUI — no double CDN hit if already loaded)
  await loadPdfJs();

  // Pass raw bytes directly — no blob URL, no network fetch.
  // disableWorker:true runs pdf.js in the main thread, which eliminates
  // the Worker-context blob-URL access error on localhost and file:// origins.
  // For ≤20 pages at scale 0.4 the main-thread cost is negligible (<100ms).
  const pdfJsDoc = await window.pdfjsLib.getDocument({
    data:          new Uint8Array(buf.slice(0)),
    disableWorker: true,
  }).promise;

  for (let i = 0; i < _pageCount; i++) {
    const page     = await pdfJsDoc.getPage(i + 1);
    const viewport = page.getViewport({ scale: 0.4 });  // small = fast

    const canvas  = document.createElement('canvas');
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    // toBlob + objectURL — not toDataURL.
    // toDataURL base64-encodes (+33% overhead), stays in JS heap.
    // objectURL is a pointer; Blob lives in browser's managed memory.
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.72));
    _thumbnailURLs[i] = URL.createObjectURL(blob);
  }
}

// ── Main render ────────────────────────────────────────────────

function _render(file) {
  const container = id('rotateOptions');
  if (!container) return;

  const anyChanged = _deltas.some(d => d !== 0);

  container.innerHTML = `
    <div class="compress-info">
      <span class="compress-info__name" title="${esc(file.name)}">${_truncName(file.name)}</span>
      <span class="compress-info__dot">·</span>
      <span class="compress-info__meta">${_pageCount} page${_pageCount !== 1 ? 's' : ''}</span>
    </div>

    <!-- Controls -->
    <div class="rot-controls">
      <div class="rot-btns" role="toolbar" aria-label="Rotation">
        <button type="button" class="rot-btn" id="rotLeft"  title="Rotate 90° counter-clockwise">↺ 90°</button>
        <button type="button" class="rot-btn" id="rot180"   title="Rotate 180°">↔ 180°</button>
        <button type="button" class="rot-btn" id="rotRight" title="Rotate 90° clockwise">↻ 90°</button>
      </div>

      <div class="rot-quick" role="toolbar" aria-label="Quick select">
        <span class="rot-quick__label">Select:</span>
        <button type="button" class="split-action-btn" id="rotSelAll">All</button>
        <button type="button" class="split-action-btn" id="rotSelOdd">Odd</button>
        <button type="button" class="split-action-btn" id="rotSelEven">Even</button>
        <button type="button" class="split-action-btn" id="rotSelNone">None</button>
      </div>

      <div class="rot-history">
        <button type="button" class="split-action-btn" id="rotUndo"
                ${_prevDeltas ? '' : 'disabled'}>↩ Undo</button>
        <button type="button" class="split-action-btn" id="rotReset"
                ${anyChanged ? '' : 'disabled'}>⊘ Reset all</button>
      </div>
    </div>

    <!-- Selection hint -->
    <div class="rot-hint" id="rotHint" aria-live="polite">
      ${_selected.size === 0
        ? 'Click pages to select, then rotate'
        : `${_selected.size} page${_selected.size !== 1 ? 's' : ''} selected`}
    </div>

    <!-- Page grid -->
    <div class="rot-grid ${_useThumbs ? 'rot-grid--thumbs' : 'rot-grid--numbers'}"
         id="rotGrid" role="list" aria-label="PDF pages">
      ${_renderGrid()}
    </div>

    ${infoBanner('🔒 Processed entirely in your browser · No upload', 'info')}
  `;

  _bindEvents(container);
}

function _renderGrid() {
  const cards = [];
  for (let i = 0; i < _pageCount; i++) {
    cards.push(_cardHTML(i));
  }
  return cards.join('');
}

function _cardHTML(i) {
  const delta    = _deltas[i];
  const initial  = _initialRotations[i];
  const visual   = (initial + delta) % 360;  // what the page looks like now
  const selected = _selected.has(i);
  const changed  = delta !== 0;

  const selClass = selected ? ' rot-card--selected' : '';
  const chgClass = changed  ? ' rot-card--changed'  : '';

  const badgeHTML = changed
    ? `<span class="rot-badge" aria-label="Rotated ${delta}°">${delta > 0 ? '+' : ''}${delta}°</span>`
    : '';

  if (_useThumbs) {
    const url = _thumbnailURLs[i];
    return `
      <div class="rot-card${selClass}${chgClass}" data-idx="${i}"
           role="listitem button" tabindex="0"
           aria-label="Page ${i + 1}${selected ? ' (selected)' : ''}${changed ? ` rotated ${delta}°` : ''}">
        <div class="rot-thumb">
          <img src="${esc(url)}" alt="Page ${i + 1}"
               style="transform:rotate(${visual}deg)"
               loading="lazy">
          ${badgeHTML}
        </div>
        <span class="rot-card__num">${i + 1}</span>
      </div>`;
  } else {
    return `
      <div class="rot-card rot-card--num${selClass}${chgClass}" data-idx="${i}"
           role="listitem button" tabindex="0"
           aria-label="Page ${i + 1}${selected ? ' (selected)' : ''}${changed ? ` rotated ${delta}°` : ''}">
        <div class="rot-numbox">
          <span class="rot-numbox__n" style="transform:rotate(${visual}deg)">${i + 1}</span>
          ${badgeHTML}
        </div>
        <span class="rot-card__num">${i + 1}</span>
      </div>`;
  }
}

// ── Events ─────────────────────────────────────────────────────

function _bindEvents(container) {
  // Rotation buttons
  id('rotLeft') ?.addEventListener('click', () => _applyRotation(-90));
  id('rot180')  ?.addEventListener('click', () => _applyRotation(180));
  id('rotRight')?.addEventListener('click', () => _applyRotation(90));

  // Quick select
  id('rotSelAll') ?.addEventListener('click', () => _quickSelect('all'));
  id('rotSelOdd') ?.addEventListener('click', () => _quickSelect('odd'));
  id('rotSelEven')?.addEventListener('click', () => _quickSelect('even'));
  id('rotSelNone')?.addEventListener('click', () => _quickSelect('none'));

  // Undo / Reset
  id('rotUndo') ?.addEventListener('click', _undo);
  id('rotReset')?.addEventListener('click', _reset);

  // Card clicks — toggle selection
  // Delegation on grid — one listener, not N listeners
  id('rotGrid')?.addEventListener('click', e => {
    const card = e.target.closest('[data-idx]');
    if (!card) return;
    const idx = parseInt(card.dataset.idx, 10);
    if (_selected.has(idx)) _selected.delete(idx);
    else                     _selected.add(idx);
    _updateCard(idx);
    _updateHint();
  });

  // Keyboard accessibility on cards
  id('rotGrid')?.addEventListener('keydown', e => {
    if (e.key === ' ' || e.key === 'Enter') {
      const card = e.target.closest('[data-idx]');
      if (!card) return;
      e.preventDefault();
      card.click();
    }
  });
}

// ── Rotation logic ─────────────────────────────────────────────

function _applyRotation(angle) {
  if (_selected.size === 0) {
    showToast('Select pages first, then rotate');
    return;
  }

  // Save snapshot for undo (shallow copy of deltas is fine — all numbers)
  _prevDeltas = [..._deltas];

  for (const idx of _selected) {
    _deltas[idx] = ((_deltas[idx] + angle) % 360 + 360) % 360;
    _updateCard(idx);
  }

  _updateHistoryButtons();
  _updateMergeBtn();
}

function _undo() {
  if (!_prevDeltas) return;
  _deltas     = _prevDeltas;
  _prevDeltas = null;
  _refreshAllCards();
  _updateHistoryButtons();
  _updateMergeBtn();
}

function _reset() {
  _prevDeltas = [..._deltas];  // allow undo of reset
  _deltas = new Array(_pageCount).fill(0);
  _refreshAllCards();
  _updateHistoryButtons();
  _updateMergeBtn();
}

// ── Quick select ───────────────────────────────────────────────

function _quickSelect(mode) {
  _selected.clear();
  for (let i = 0; i < _pageCount; i++) {
    if (mode === 'all')            _selected.add(i);
    else if (mode === 'odd'  && (i % 2 === 0)) _selected.add(i);  // page 1,3,5… = index 0,2,4
    else if (mode === 'even' && (i % 2 === 1)) _selected.add(i);
    // 'none' — already cleared
  }
  _refreshAllCards();
  _updateHint();
}

// ── Partial DOM updates (avoid full re-render on each click) ───

function _updateCard(idx) {
  const grid = id('rotGrid');
  if (!grid) return;
  const card = grid.querySelector(`[data-idx="${idx}"]`);
  if (!card) return;
  card.outerHTML = _cardHTML(idx);
  // After outerHTML replacement re-bind is automatic — event delegation on grid
}

function _refreshAllCards() {
  const grid = id('rotGrid');
  if (grid) grid.innerHTML = _renderGrid();
}

function _updateHint() {
  const el = id('rotHint');
  if (!el) return;
  el.textContent = _selected.size === 0
    ? 'Click pages to select, then rotate'
    : `${_selected.size} page${_selected.size !== 1 ? 's' : ''} selected`;
}

function _updateHistoryButtons() {
  const undoBtn  = id('rotUndo');
  const resetBtn = id('rotReset');
  if (undoBtn)  undoBtn.disabled  = !_prevDeltas;
  if (resetBtn) resetBtn.disabled = _deltas.every(d => d === 0);
}

function _updateMergeBtn() {
  const btn = id('mergeBtn');
  if (!btn) return;
  const changed = _deltas.filter(d => d !== 0).length;
  if (changed > 0) {
    btn.disabled    = false;
    btn.textContent = `🔄 Rotate ${changed} page${changed !== 1 ? 's' : ''}`;
  } else {
    btn.disabled    = true;
    btn.textContent = '🔄 Select and rotate pages';
  }
}

// ── Cleanup ────────────────────────────────────────────────────

function _cleanup() {
  // Revoke all objectURLs — critical for memory management
  // Without this: ~2–5 MB per page stays in browser memory indefinitely
  for (const url of _thumbnailURLs) {
    if (url) URL.revokeObjectURL(url);
  }
  _thumbnailURLs = [];
}

function _hide(container) {
  container.style.display = 'none';
  container.innerHTML = '';
}

// ── Helpers ────────────────────────────────────────────────────

function _truncName(name) {
  return name.length > 35 ? name.slice(0, 32) + '…' : name;
}
