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
//  ✓ IntersectionObserver lazy-render — делаю (было "НЕ делаю" с
//    жёстким порогом 44 страницы → numbered-cards). Причина смены
//    решения: сам порог существовал только потому, что рендер был
//    eager (весь документ пачкой перед показом UI) — "200 = death".
//    С ленивым рендером (тот же паттерн, что в pdf2jpgUI.js —
//    IntersectionObserver + MAX_RENDERS=3 очередь) страница любого
//    размера получает настоящие миниатюры без блокировки потока.
//    numbered-cards остаются только как честный fallback при реальном
//    сбое pdf.js (CDN недоступен и т.п.), не по числу страниц.
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
import { loadPdfLib } from './lazyLibs.js';
import { wmRemoveHtml, bindWmRemove, resetWmRemove } from './watermarkRemoveUI.js';
import { t, tp } from './i18n.js';

// ── Constants ─────────────────────────────────────────────────

// Soft, non-blocking heads-up for very large documents — not a hard cap.
// Thumbnails render lazily as cards scroll into view, so memory/CPU
// pressure stays mild even well past this; it's just honest disclosure
// that a huge document may feel slower on older devices.
const _LARGE_DOC_WARN_THRESHOLD = 150;
const MAX_RENDERS = 3; // concurrent lazy thumb renders, mirrors pdf2jpgUI.js

// _applyRotation() below touches every selected card. Above this many,
// one _updateCard() per card (querySelector + outerHTML replace, each a
// separate reflow) becomes real main-thread jank on large documents —
// measured via real Playwright + CDP 4x throttle: "Select All" + rotate
// on a 600-page doc produced a 107ms single-frame gap (300 pages: ~40ms,
// under the same test's own noise floor). A single _refreshAllCards()
// call is one reflow instead of N and empirically faster past this size,
// so it takes over once a selection crosses this threshold. Below it,
// the existing content-only _updateCard() path stays — it's the better
// choice for a handful of individual toggles (avoids the drag-listener
// rebind + IntersectionObserver re-setup that a full rebuild carries).
const _BULK_UPDATE_THRESHOLD = 20;

// ── State ──────────────────────────────────────────────────────

let _pageCount       = 0;
let _initialRotations = [];  // [number] — per-page rotation already in PDF (0/90/180/270)
let _deltas           = [];  // [number] — user's rotation delta per page (0/90/180/270)
let _prevDeltas       = null; // snapshot for single-level undo
let _selected         = new Set(); // Set<index> — 0-indexed
let _thumbnailURLs    = [];  // [string | null] — objectURLs, null = not rendered yet
let _useThumbs        = false;
let _pdfJsDoc         = null;  // pdf.js document — pages rendered lazily on scroll
let _observer         = null;  // IntersectionObserver driving lazy thumb renders
let _renderQueue      = [];    // page indices queued for canvas rendering
let _activeRenders    = 0;     // concurrent renders in flight

// ── Public API ─────────────────────────────────────────────────

/**
 * Returns the rotation params for the worker.
 * Only includes pages where the user applied a delta — unmodified pages
 * are skipped so the worker doesn't write unnecessary /Rotate entries.
 */
export function getRotateParams() {
  const rotations = [];
  for (let i = 0; i < _pageCount; i++) {
    if (_deltas[i] === 0) continue;
    const final = ((_initialRotations[i] + _deltas[i]) % 360 + 360) % 360;
    rotations.push({ index: i, angle: final });
  }
  return { rotations };
}

export async function initRotateOptions(file) {
  const container = id('rotateOptions');
  if (!container) return;

  container.innerHTML = loadingRow(t('rot_loading'));
  container.style.display = 'block';

  try {
    // 1. Read page count + initial rotations via pdf-lib
    await loadPdfLib();
    const { PDFDocument } = window.PDFLib;
    const buf = await file.arrayBuffer();
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });

    _pageCount = doc.getPageCount();
    if (_pageCount === 0) { showToast(t('no_pages_pdf')); _hide(container); return; }

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

    // 2. Load the pdf.js document reference (fast — no page rendering yet).
    // Wrapped in its own try/catch so any failure (CDN unavailable, pdf.js
    // worker error, localhost CORS, etc.) gracefully falls back to
    // numbered-card mode instead of hiding the entire tool. The rotate
    // functionality works fine without thumbnails. Actual page thumbnails
    // render lazily as cards scroll into view — see _setupLazyThumbs().
    _useThumbs = true;
    try {
      await _initPdfJsDoc(buf);
    } catch (thumbErr) {
      _useThumbs = false;
      _pdfJsDoc  = null;
      console.warn('[rotateUI] pdf.js unavailable, using numbered cards:', thumbErr.message);
    }

    if (_pageCount > _LARGE_DOC_WARN_THRESHOLD) {
      showToast(t('warn_many_pages', { n: _pageCount }), 7000);
    }

    _render(file);

  } catch (err) {
    showToast(t('rot_err_load', { msg: err.message }), 5000);
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
  resetWmRemove();
}

// ── Thumbnail rendering (lazy — mirrors pdf2jpgUI.js's _buildThumbs/
//    _enqueue/_drain pattern) ─────────────────────────────────────

// Loads the pdf.js document reference only — no page rendering yet.
// Pass raw bytes directly — no blob URL, no network fetch. disableWorker:true
// runs pdf.js in the main thread, which eliminates the Worker-context
// blob-URL access error on localhost and file:// origins.
async function _initPdfJsDoc(buf) {
  await loadPdfJs(); // shared with pdf2jpgUI — no double CDN hit if already loaded
  _pdfJsDoc = await window.pdfjsLib.getDocument({ isEvalSupported: false,
    data:          new Uint8Array(buf.slice(0)),
    disableWorker: true,
  }).promise;
}

// (Re)observes every card that doesn't have a rendered thumbnail yet.
// Must be re-run any time the grid's DOM nodes are replaced wholesale
// (_refreshAllCards) — IntersectionObserver stops watching a node once
// it's removed from the document, and outerHTML replacement always
// creates a new node.
function _setupLazyThumbs() {
  _observer?.disconnect();
  if (!_useThumbs || !_pdfJsDoc) return;

  _observer = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) {
        _observer.unobserve(e.target);
        _enqueueThumb(parseInt(e.target.dataset.idx, 10));
      }
    }
  }, { rootMargin: '300px' });

  id('rotGrid')?.querySelectorAll('[data-idx]').forEach(el => {
    const idx = parseInt(el.dataset.idx, 10);
    if (!_thumbnailURLs[idx]) _observer.observe(el);
  });
}

function _enqueueThumb(idx) {
  if (_thumbnailURLs[idx] || _renderQueue.includes(idx)) return;
  _renderQueue.push(idx);
  _drainThumbs();
}

function _drainThumbs() {
  while (_activeRenders < MAX_RENDERS && _renderQueue.length > 0) {
    const idx = _renderQueue.shift();
    if (_thumbnailURLs[idx]) continue;
    _activeRenders++;
    _renderThumb(idx).finally(() => { _activeRenders--; _drainThumbs(); });
  }
}

async function _renderThumb(idx) {
  if (!_pdfJsDoc || _thumbnailURLs[idx]) return;
  try {
    const page     = await _pdfJsDoc.getPage(idx + 1);
    const viewport = page.getViewport({ scale: 0.4 }); // small = fast

    const canvas  = document.createElement('canvas');
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    // toBlob + objectURL — not toDataURL.
    // toDataURL base64-encodes (+33% overhead), stays in JS heap.
    // objectURL is a pointer; Blob lives in browser's managed memory.
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.72));
    _thumbnailURLs[idx] = URL.createObjectURL(blob);
    page.cleanup?.();
    _updateCard(idx); // swap the placeholder for the rendered <img>
  } catch { /* leave placeholder — cosmetic only, rotation still works */ }
}

// ── Main render ────────────────────────────────────────────────

function _render(file) {
  const container = id('rotateOptions');
  if (!container) return;

  const anyChanged = _deltas.some(d => d !== 0);

  container.innerHTML = `
    <div class="compress-info">
      <span class="compress-info__name" title="${esc(file.name)}">${esc(_truncName(file.name))}</span>
      <span class="compress-info__dot">·</span>
      <span class="compress-info__meta">${tp(_pageCount, 'split_info_page', 'split_info_pages', { n: _pageCount })}</span>
    </div>

    <!-- Controls -->
    <div class="rot-controls">
      <div class="rot-btns" role="toolbar" aria-label="${t('rot_toolbar_aria')}">
        <button type="button" class="rot-btn" id="rotLeft"  title="${t('rot_ccw_title')}">↺ 90°</button>
        <button type="button" class="rot-btn" id="rot180"   title="${t('rot_180_title')}">↔ 180°</button>
        <button type="button" class="rot-btn" id="rotRight" title="${t('rot_cw_title')}">↻ 90°</button>
      </div>

      <div class="rot-quick" role="toolbar" aria-label="${t('rot_quick_aria')}">
        <span class="rot-quick__label">${t('rot_select_label')}</span>
        <button type="button" class="split-action-btn" id="rotSelAll">${t('select_all_short')}</button>
        <button type="button" class="split-action-btn" id="rotSelOdd">${t('rot_odd')}</button>
        <button type="button" class="split-action-btn" id="rotSelEven">${t('rot_even')}</button>
        <button type="button" class="split-action-btn" id="rotSelNone">${t('deselect_all_short')}</button>
      </div>

      <div class="rot-history">
        <button type="button" class="split-action-btn" id="rotUndo"
                ${_prevDeltas ? '' : 'disabled'}>${t('rot_undo')}</button>
        <button type="button" class="split-action-btn" id="rotReset"
                ${anyChanged ? '' : 'disabled'}>${t('rot_reset')}</button>
      </div>
    </div>

    <!-- Selection hint -->
    <div class="rot-hint" id="rotHint" aria-live="polite">
      ${_hintText()}
    </div>

    <!-- Page grid -->
    <div class="rot-grid ${_useThumbs ? 'rot-grid--thumbs' : 'rot-grid--numbers'}"
         id="rotGrid" role="list" aria-label="${t('rot_grid_aria')}">
      ${_renderGrid()}
    </div>

    ${wmRemoveHtml()}

    ${infoBanner(t('rot_banner'), 'info')}
  `;

  _bindEvents(container);
  _setupLazyThumbs();
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
    ? `<span class="rot-badge" aria-label="${t('rot_badge_aria', { delta })}">${delta > 0 ? '+' : ''}${delta}°</span>`
    : '';

  const ariaLabel = t('rot_page_aria', { n: i + 1 })
    + (selected ? t('rot_selected_suffix') : '')
    + (changed  ? t('rot_rotated_suffix', { delta }) : '');

  if (_useThumbs) {
    const url = _thumbnailURLs[i];
    // Not rendered yet — blank placeholder box (IntersectionObserver
    // triggers the actual render once this card scrolls into view).
    const thumbInner = url
      ? `<img src="${esc(url)}" alt="${t('rot_page_alt', { n: i + 1 })}"
               style="transform:rotate(${visual}deg)" loading="lazy">`
      : '';
    return `
      <div class="rot-card${selClass}${chgClass}" data-idx="${i}"
           role="listitem button" tabindex="0"
           aria-label="${esc(ariaLabel)}">
        <div class="rot-thumb">
          ${thumbInner}
          ${badgeHTML}
        </div>
        <span class="rot-card__num">${i + 1}</span>
      </div>`;
  } else {
    return `
      <div class="rot-card rot-card--num${selClass}${chgClass}" data-idx="${i}"
           role="listitem button" tabindex="0"
           aria-label="${esc(ariaLabel)}">
        <div class="rot-numbox">
          <span class="rot-numbox__n" style="transform:rotate(${visual}deg)">${i + 1}</span>
          ${badgeHTML}
        </div>
        <span class="rot-card__num">${i + 1}</span>
      </div>`;
  }
}

// ── Events ─────────────────────────────────────────────────────

function _bindEvents(_container) {
  bindWmRemove();

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
    showToast(t('rot_select_first'));
    return;
  }

  // Save snapshot for undo (shallow copy of deltas is fine — all numbers)
  _prevDeltas = [..._deltas];

  for (const idx of _selected) {
    _deltas[idx] = ((_deltas[idx] + angle) % 360 + 360) % 360;
  }

  // Real bug found via analytics (2 of 8 sessions with a rotate quick-retry
  // did 6 each — a "stuck in a loop" concentration, not independent users):
  // selection used to survive past applying a rotation, so selecting one
  // MORE page afterward silently re-rotated every already-rotated page too,
  // a second time. Clearing here matches the universal select-act-reset
  // convention (Gmail archive, Google Photos delete, …) and also removes
  // the ambiguous "still selected AND already changed" combined card style
  // (.rot-card--changed.rot-card--selected) as a side effect.
  const rotated = [..._selected];
  _selected.clear();

  // See _BULK_UPDATE_THRESHOLD above — one full-grid rebuild beats N
  // individual card updates once the selection is large.
  if (rotated.length > _BULK_UPDATE_THRESHOLD) {
    _refreshAllCards();
  } else {
    for (const idx of rotated) _updateCard(idx);
  }

  _updateHistoryButtons();
  _updateMergeBtn();
  _updateHint();
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
  // After outerHTML replacement re-bind is automatic — event delegation on grid.
  // outerHTML always creates a fresh node, so a still-pending thumbnail's
  // IntersectionObserver registration on the old node is gone — reattach it.
  if (_useThumbs && !_thumbnailURLs[idx] && _observer) {
    const freshCard = grid.querySelector(`[data-idx="${idx}"]`);
    if (freshCard) _observer.observe(freshCard);
  }
}

function _refreshAllCards() {
  const grid = id('rotGrid');
  if (grid) grid.innerHTML = _renderGrid();
  _setupLazyThumbs(); // whole grid replaced — every pending card needs re-observing
}

function _hintText() {
  return _selected.size === 0
    ? t('rot_hint_click')
    : tp(_selected.size, 'rot_hint_selected_one', 'rot_hint_selected_many', { n: _selected.size });
}

function _updateHint() {
  const el = id('rotHint');
  if (!el) return;
  el.textContent = _hintText();
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
    btn.textContent = tp(changed, 'rot_btn_one', 'rot_btn_many', { n: changed });
  } else {
    btn.disabled    = true;
    btn.textContent = t('rot_btn_disabled');
  }
}

// ── Cleanup ────────────────────────────────────────────────────

function _cleanup() {
  _observer?.disconnect();
  _observer      = null;
  _renderQueue   = [];
  _activeRenders = 0;
  _pdfJsDoc      = null;

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
