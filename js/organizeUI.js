// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  organizeUI.js — Organize PDF tool UI (reorder / delete / rotate)
//
//  Single PDF in, single PDF out — combines three things that already
//  exist separately elsewhere: rotate's per-page rotation UI, jpg2pdf's
//  drag-reorder grid, and a new per-page delete affordance. Reuses
//  rotateUI.js's lazy thumbnail engine (IntersectionObserver + bounded
//  concurrency) and dragReorder.js's grid mode verbatim.
//
//  State shape — two families of parallel arrays:
//    POSITION-indexed (current grid order; spliced in lockstep by
//    dragReorder.js, so array IDENTITY must stay stable — see undo/reset):
//      _originalIndex[pos] → source-doc page index
//      _deltas[pos]        → user's rotation delta, travels with the page
//      _deletedFlags[pos]  → 0|1, travels with the page
//    ORIGINAL-index-indexed (fixed size = pageCount, never reordered,
//    since the underlying PDF page content doesn't move):
//      _initialRotations[origIdx] → rotation already baked into the PDF
//      _thumbnailURLs[origIdx]    → objectURL cache, persists across drags
//
//  Card DOM updates come in two flavors, deliberately kept separate:
//    _updateCard(pos)     — content-only (thumb/badge/classes), the DOM
//                            node itself is untouched, so dragReorder's
//                            per-item listeners on that node survive.
//                            Used for rotate/delete/restore/thumb-load —
//                            frequent, must never trigger a re-bind.
//    _refreshAllCards()   — full grid content replace + full drag re-bind
//                            (_bindDrag()). Used only when page ORDER
//                            actually changes (drag-reorder itself, undo,
//                            reset) — DOM node identity changes, so old
//                            per-item listeners are gone regardless.
//  Calling _bindDrag() after a plain _updateCard() would double-bind
//  drag listeners on every untouched card (bindDragReorder() has no
//  "skip already-bound" guard) — this is why the split matters.
// ============================================================

import { id, esc } from './utils.js';
import { showToast } from './ui.js';
import { loadingRow, infoBanner } from './uiComponents.js';
import { loadPdfJs } from './pdf2jpgUI.js';
import { loadPdfLib } from './lazyLibs.js';
import { bindDragReorder } from './dragReorder.js';
import { isFilesLocked } from './files.js';
import { t, tp } from './i18n.js';

// ── Constants ─────────────────────────────────────────────────
const _LARGE_DOC_WARN_THRESHOLD = 150; // soft warning only, matches rotateUI.js
const MAX_RENDERS = 3;                 // concurrent lazy thumb renders

// Same threshold + same rationale as rotateUI.js's _BULK_UPDATE_THRESHOLD:
// _applyRotation()/_deleteSelected() below call _updateCard() once per
// touched card (querySelector + innerHTML write, each a separate reflow).
// Measured via real Playwright + CDP 4x throttle: "Select All" + rotate on
// a 600-page doc produced a 160ms single-frame gap (300 pages: ~80ms).
// Past this many touched cards, a single _refreshAllCards() call (one
// reflow) is faster than N individual ones.
const _BULK_UPDATE_THRESHOLD = 20;

// A pixel counts as "ink" once it deviates from pure white by more than
// this much (sum of the three RGB deltas) — tolerant of light scanner
// grain/JPEG noise on a genuinely blank page, still catches real text.
const _INK_PIXEL_THRESHOLD = 30;
// A page is flagged "looks blank" once its ink-pixel ratio falls below
// this — deliberately generous (catches a lone page number/stamp too):
// this only pre-selects candidates for the user to review, never deletes
// anything on its own, so a false positive costs one click to deselect.
const _BLANK_INK_RATIO = 0.006;

// ── State ──────────────────────────────────────────────────────
let _pageCount        = 0;
let _originalIndex    = []; // position → source page index
let _deltas            = []; // position → rotation delta
let _deletedFlags       = []; // position → 0|1
let _initialRotations = []; // origIdx → rotation baked into source PDF
let _thumbnailURLs    = []; // origIdx → objectURL | null
let _blankFlags       = []; // origIdx → true|false|undefined (undefined = not yet rendered)
let _selected          = new Set(); // Set<position>
let _prevSnapshot      = null; // {originalIndex, deltas, deletedFlags} — single-level undo
let _useThumbs         = false;
let _pdfJsDoc          = null;
let _observer          = null;
let _renderQueue       = [];
let _activeRenders     = 0;

// ── Public API ─────────────────────────────────────────────────

export function getOrganizeParams() {
  const pageOrder = [];
  for (let pos = 0; pos < _originalIndex.length; pos++) {
    if (_deletedFlags[pos]) continue;
    const idx = _originalIndex[pos];
    pageOrder.push({
      originalIndex: idx,
      rotation: ((_initialRotations[idx] + _deltas[pos]) % 360 + 360) % 360,
    });
  }
  return { pageOrder };
}

export async function initOrganizeOptions(file) {
  const container = id('organizeOptions');
  if (!container) return;

  container.innerHTML = loadingRow(t('org_loading'));
  container.style.display = 'block';

  try {
    await loadPdfLib();
    const { PDFDocument } = window.PDFLib;
    const buf = await file.arrayBuffer();
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });

    _pageCount = doc.getPageCount();
    if (_pageCount === 0) { showToast(t('no_pages_pdf')); _hide(container); return; }

    const pages = doc.getPages();
    _initialRotations = pages.map(p => {
      const r = p.getRotation();
      return r ? ((r.angle % 360) + 360) % 360 : 0;
    });

    _originalIndex = Array.from({ length: _pageCount }, (_, i) => i);
    _deltas        = new Array(_pageCount).fill(0);
    _deletedFlags  = new Array(_pageCount).fill(0);
    _thumbnailURLs = new Array(_pageCount).fill(null);
    _blankFlags    = new Array(_pageCount).fill(undefined);
    _selected      = new Set();
    _prevSnapshot  = null;

    // Same fallback story as rotateUI.js: a real pdf.js failure (CDN down,
    // worker error) degrades to numbered cards; page COUNT never forces it.
    _useThumbs = true;
    try {
      await _initPdfJsDoc(buf);
    } catch (thumbErr) {
      _useThumbs = false;
      _pdfJsDoc  = null;
      console.warn('[organizeUI] pdf.js unavailable, using numbered cards:', thumbErr.message);
    }

    if (_pageCount > _LARGE_DOC_WARN_THRESHOLD) {
      showToast(t('warn_many_pages', { n: _pageCount }), 7000);
    }

    _render(file);

  } catch (err) {
    showToast(t('org_err_load', { msg: err.message }), 5000);
    _hide(container);
  }
}

export function hideOrganizeOptions() {
  _cleanup();
  const container = id('organizeOptions');
  if (!container) return;
  container.style.display = 'none';
  container.innerHTML = '';
  _pageCount = 0;
  _originalIndex = [];
  _deltas = [];
  _deletedFlags = [];
  _initialRotations = [];
  _selected = new Set();
  _prevSnapshot = null;
  _useThumbs = false;
}

// ── Thumbnail rendering (lazy — lifted from rotateUI.js, keyed by
//    ORIGINAL page index instead of position so a cached thumbnail
//    survives a drag-reorder without re-decoding) ──────────────

async function _initPdfJsDoc(buf) {
  await loadPdfJs();
  _pdfJsDoc = await window.pdfjsLib.getDocument({
    data:          new Uint8Array(buf.slice(0)),
    disableWorker: true,
  }).promise;
}

function _setupLazyThumbs() {
  _observer?.disconnect();
  if (!_useThumbs || !_pdfJsDoc) return;

  _observer = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) {
        _observer.unobserve(e.target);
        _enqueueThumb(parseInt(e.target.dataset.orig, 10));
      }
    }
  }, { rootMargin: '300px' });

  id('orgGrid')?.querySelectorAll('[data-orig]').forEach(el => {
    const origIdx = parseInt(el.dataset.orig, 10);
    if (!_thumbnailURLs[origIdx]) _observer.observe(el);
  });
}

function _enqueueThumb(origIdx) {
  if (_thumbnailURLs[origIdx] || _renderQueue.includes(origIdx)) return;
  _renderQueue.push(origIdx);
  _drainThumbs();
}

function _drainThumbs() {
  while (_activeRenders < MAX_RENDERS && _renderQueue.length > 0) {
    const origIdx = _renderQueue.shift();
    if (_thumbnailURLs[origIdx]) continue;
    _activeRenders++;
    _renderThumb(origIdx).finally(() => { _activeRenders--; _drainThumbs(); });
  }
}

async function _renderThumb(origIdx) {
  if (!_pdfJsDoc || _thumbnailURLs[origIdx]) return;
  try {
    const page     = await _pdfJsDoc.getPage(origIdx + 1);
    const viewport = page.getViewport({ scale: 0.4 });

    const canvas = document.createElement('canvas');
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Piggybacks on the render this thumbnail needed anyway — no extra
    // page.render() call. See _INK_PIXEL_THRESHOLD/_BLANK_INK_RATIO above.
    _blankFlags[origIdx] = _looksBlank(ctx, canvas.width, canvas.height);

    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.72));
    _thumbnailURLs[origIdx] = URL.createObjectURL(blob);
    page.cleanup?.();

    const pos = _originalIndex.indexOf(origIdx);
    if (pos !== -1) _updateCard(pos); // content-only — safe, doesn't touch drag listeners
  } catch { /* leave placeholder — cosmetic only */ }
}

function _looksBlank(ctx, w, h) {
  if (w === 0 || h === 0) return false;
  const { data } = ctx.getImageData(0, 0, w, h);
  let inkPixels = 0;
  const totalPixels = w * h;
  for (let i = 0; i < data.length; i += 4) {
    const deviation = (255 - data[i]) + (255 - data[i + 1]) + (255 - data[i + 2]);
    if (deviation > _INK_PIXEL_THRESHOLD) inkPixels++;
  }
  return (inkPixels / totalPixels) < _BLANK_INK_RATIO;
}

// ── Main render ────────────────────────────────────────────────

function _render(file) {
  const container = id('organizeOptions');
  if (!container) return;

  container.innerHTML = `
    <div class="compress-info">
      <span class="compress-info__name" title="${esc(file.name)}">${esc(_truncName(file.name))}</span>
      <span class="compress-info__dot">·</span>
      <span class="compress-info__meta">${tp(_pageCount, 'split_info_page', 'split_info_pages', { n: _pageCount })}</span>
    </div>

    <div class="rot-controls">
      <div class="rot-btns" role="toolbar" aria-label="${t('org_toolbar_aria')}">
        <button type="button" class="rot-btn" id="orgLeft"  title="${t('org_ccw_title')}">↺ 90°</button>
        <button type="button" class="rot-btn" id="org180"   title="${t('org_180_title')}">↔ 180°</button>
        <button type="button" class="rot-btn" id="orgRight" title="${t('org_cw_title')}">↻ 90°</button>
      </div>

      <div class="rot-quick" role="toolbar" aria-label="${t('org_quick_aria')}">
        <span class="rot-quick__label">${t('org_select_label')}</span>
        <button type="button" class="split-action-btn" id="orgSelAll">${t('select_all_short')}</button>
        <button type="button" class="split-action-btn" id="orgSelOdd">${t('rot_odd')}</button>
        <button type="button" class="split-action-btn" id="orgSelEven">${t('rot_even')}</button>
        ${_useThumbs ? `<button type="button" class="split-action-btn" id="orgSelBlank">${t('org_sel_blank')}</button>` : ''}
        <button type="button" class="split-action-btn" id="orgSelNone">${t('deselect_all_short')}</button>
        <button type="button" class="split-action-btn org-delete-sel-btn" id="orgDeleteSel">${t('org_delete_selected')}</button>
      </div>

      <div class="rot-history">
        <button type="button" class="split-action-btn" id="orgUndo"
                ${_prevSnapshot ? '' : 'disabled'}>${t('rot_undo')}</button>
        <button type="button" class="split-action-btn" id="orgReset"
                ${_anyChanged() ? '' : 'disabled'}>${t('rot_reset')}</button>
      </div>
    </div>

    <div class="rot-hint" id="orgHint" aria-live="polite">
      ${_hintText()}
    </div>

    <div class="rot-grid org-grid ${_useThumbs ? 'rot-grid--thumbs' : 'rot-grid--numbers'}"
         id="orgGrid" role="list" aria-label="${t('org_grid_aria')}">
      ${_renderGrid()}
    </div>

    ${infoBanner(t('org_banner'), 'info')}
  `;

  _bindEvents();
  _bindDrag();
  _setupLazyThumbs();
  _updateSubmitBtn();
}

function _renderGrid() {
  const cards = [];
  for (let pos = 0; pos < _originalIndex.length; pos++) {
    cards.push(_cardHTML(pos));
  }
  return cards.join('');
}

function _thumbInnerHTML(pos) {
  const origIdx = _originalIndex[pos];
  const delta   = _deltas[pos];
  const deleted = !!_deletedFlags[pos];
  const visual  = ((_initialRotations[origIdx] + delta) % 360 + 360) % 360;
  const changed = delta !== 0;
  const blank   = !!_blankFlags[origIdx];

  const badgeHTML = (!deleted && changed)
    ? `<span class="rot-badge" aria-label="${t('rot_badge_aria', { delta })}">${delta > 0 ? '+' : ''}${delta}°</span>`
    : '';
  const blankBadgeHTML = (!deleted && blank)
    ? `<span class="org-blank-badge" aria-label="${t('org_blank_badge_aria')}">${t('org_blank_badge')}</span>`
    : '';
  const actionBtnHTML = deleted
    ? `<button type="button" class="org-card__action org-card__action--restore" data-act="restore" aria-label="${esc(t('org_restore_btn'))}">↺</button>`
    : `<button type="button" class="org-card__action org-card__action--delete" data-act="delete" aria-label="${esc(t('org_delete_btn'))}">×</button>`;

  if (_useThumbs) {
    const url = _thumbnailURLs[origIdx];
    const img = url
      ? `<img src="${esc(url)}" alt="${t('org_page_alt', { n: pos + 1 })}" style="transform:rotate(${visual}deg)" loading="lazy">`
      : '';
    return `${img}${badgeHTML}${blankBadgeHTML}${actionBtnHTML}`;
  }
  return `<span class="rot-numbox__n" style="transform:rotate(${visual}deg)">${pos + 1}</span>${badgeHTML}${blankBadgeHTML}${actionBtnHTML}`;
}

function _ariaLabelFor(pos) {
  const origIdx  = _originalIndex[pos];
  const deleted  = !!_deletedFlags[pos];
  const selected = _selected.has(pos);
  const delta    = _deltas[pos];
  const changed  = delta !== 0;
  const blank    = !!_blankFlags[origIdx];
  return t('org_page_aria', { n: pos + 1 })
    + (deleted  ? t('org_deleted_suffix')   : '')
    + (selected ? t('rot_selected_suffix')  : '')
    + (changed  ? t('rot_rotated_suffix', { delta }) : '')
    + (!deleted && blank ? t('org_blank_suffix') : '');
}

function _cardHTML(pos) {
  const origIdx  = _originalIndex[pos];
  const selected = _selected.has(pos);
  const changed  = _deltas[pos] !== 0;
  const deleted  = !!_deletedFlags[pos];

  const selClass  = selected ? ' rot-card--selected' : '';
  const chgClass  = changed  ? ' rot-card--changed'  : '';
  const delClass  = deleted  ? ' org-card--deleted'  : '';
  const cardClass = _useThumbs ? 'rot-card' : 'rot-card rot-card--num';
  const wrapClass = _useThumbs ? 'rot-thumb' : 'rot-numbox';

  return `
    <div class="${cardClass} org-card${selClass}${chgClass}${delClass}" data-i="${pos}" data-idx="${pos}" data-orig="${origIdx}"
         role="listitem button" tabindex="0" aria-label="${esc(_ariaLabelFor(pos))}">
      <div class="${wrapClass}">
        ${_thumbInnerHTML(pos)}
      </div>
      <span class="rot-card__num">${pos + 1}</span>
    </div>`;
}

// ── Events ─────────────────────────────────────────────────────

function _bindEvents() {
  id('orgLeft') ?.addEventListener('click', () => _applyRotation(-90));
  id('org180')  ?.addEventListener('click', () => _applyRotation(180));
  id('orgRight')?.addEventListener('click', () => _applyRotation(90));

  id('orgSelAll') ?.addEventListener('click', () => _quickSelect('all'));
  id('orgSelOdd') ?.addEventListener('click', () => _quickSelect('odd'));
  id('orgSelEven')?.addEventListener('click', () => _quickSelect('even'));
  id('orgSelBlank')?.addEventListener('click', () => _quickSelect('blank'));
  id('orgSelNone')?.addEventListener('click', () => _quickSelect('none'));
  id('orgDeleteSel')?.addEventListener('click', _deleteSelected);

  id('orgUndo') ?.addEventListener('click', _undo);
  id('orgReset')?.addEventListener('click', _reset);

  const grid = id('orgGrid');

  // Delegated — survives grid.innerHTML replacement (container itself
  // persists across _updateCard/_refreshAllCards), so bound exactly once.
  grid?.addEventListener('click', e => {
    const actBtn = e.target.closest('[data-act]');
    const card   = e.target.closest('[data-i]');
    if (!card) return;
    const pos = parseInt(card.dataset.i, 10);

    if (actBtn) {
      if (actBtn.dataset.act === 'delete')       _deletePage(pos);
      else if (actBtn.dataset.act === 'restore') _restorePage(pos);
      return;
    }

    if (_deletedFlags[pos]) { _restorePage(pos); return; } // tap anywhere on a deleted card restores it
    if (_selected.has(pos)) _selected.delete(pos);
    else                     _selected.add(pos);
    _updateCard(pos);
    _updateHint();
  });

  grid?.addEventListener('keydown', e => {
    if (e.key === ' ' || e.key === 'Enter') {
      const card = e.target.closest('[data-i]');
      if (!card) return;
      e.preventDefault();
      card.click();
    }
  });
}

// Re-run any time the grid's DOM nodes are replaced wholesale (drag-reorder
// itself, undo, reset) — bindDragReorder() attaches per-item listeners with
// no "already bound" guard, so calling this after a content-only
// _updateCard() would double-bind every untouched card.
function _bindDrag() {
  const grid = id('orgGrid');
  if (!grid) return;
  bindDragReorder({
    container:    grid,
    itemSelector: '.org-card',
    arrays:       [_originalIndex, _deltas, _deletedFlags],
    onReorder:    () => { _selected.clear(); _refreshAllCards(); _updateSubmitBtn(); },
    isLocked:     isFilesLocked,
    mode:         'grid',
  });
}

// ── Mutations ──────────────────────────────────────────────────
// _snapshotForUndo() must run before ANY of these — see _undo().

function _snapshotForUndo() {
  _prevSnapshot = {
    originalIndex: [..._originalIndex],
    deltas:        [..._deltas],
    deletedFlags:  [..._deletedFlags],
  };
}

function _applyRotation(angle) {
  if (_selected.size === 0) { showToast(t('rot_select_first')); return; }
  _snapshotForUndo();
  for (const pos of _selected) {
    _deltas[pos] = ((_deltas[pos] + angle) % 360 + 360) % 360;
  }
  // See _BULK_UPDATE_THRESHOLD above.
  if (_selected.size > _BULK_UPDATE_THRESHOLD) {
    _refreshAllCards();
  } else {
    for (const pos of _selected) _updateCard(pos);
  }
  _updateHistoryButtons();
  _updateSubmitBtn();
}

function _deletePage(pos) {
  _snapshotForUndo();
  _deletedFlags[pos] = 1;
  _selected.delete(pos);
  _updateCard(pos);
  _updateHint();
  _updateHistoryButtons();
  _updateSubmitBtn();
}

function _restorePage(pos) {
  _snapshotForUndo();
  _deletedFlags[pos] = 0;
  _updateCard(pos);
  _updateHistoryButtons();
  _updateSubmitBtn();
}

function _deleteSelected() {
  if (_selected.size === 0) { showToast(t('rot_select_first')); return; }
  _snapshotForUndo();
  for (const pos of _selected) {
    _deletedFlags[pos] = 1;
  }
  // See _BULK_UPDATE_THRESHOLD above.
  if (_selected.size > _BULK_UPDATE_THRESHOLD) {
    _refreshAllCards();
  } else {
    for (const pos of _selected) _updateCard(pos);
  }
  _selected.clear();
  _updateHint();
  _updateHistoryButtons();
  _updateSubmitBtn();
}

async function _quickSelect(mode) {
  // 'blank' needs every page's ink-ratio computed first — the lazy
  // IntersectionObserver flow (_setupLazyThumbs) only renders pages the
  // user has actually scrolled to, so anything still off-screen would
  // otherwise silently be skipped from detection.
  if (mode === 'blank') {
    const btn = id('orgSelBlank');
    if (btn) { btn.disabled = true; btn.textContent = t('org_scanning'); }
    await _ensureBlankFlagsComputed();
    if (btn) { btn.disabled = false; btn.textContent = t('org_sel_blank'); }
  }

  _selected.clear();
  for (let pos = 0; pos < _originalIndex.length; pos++) {
    if (_deletedFlags[pos]) continue; // never auto-select a deleted page
    if (mode === 'all')                        _selected.add(pos);
    else if (mode === 'odd'  && pos % 2 === 0)  _selected.add(pos); // page 1,3,5… = position 0,2,4
    else if (mode === 'even' && pos % 2 === 1)  _selected.add(pos);
    else if (mode === 'blank' && _blankFlags[_originalIndex[pos]]) _selected.add(pos);
    // 'none' — already cleared
  }
  if (mode === 'blank' && _selected.size === 0) showToast(t('org_select_blank_none'));
  // Unlike _applyRotation()/_deleteSelected(), this loop always touches
  // EVERY card regardless of mode (each pass has to check every position
  // to know whether it belongs in the new selection) — so there's no
  // small-selection case where per-card _updateCard() wins. One
  // _refreshAllCards() call (single reflow) is strictly better here; see
  // _BULK_UPDATE_THRESHOLD above for the measured rationale. Order/content
  // don't change, only selection state, so the full rebuild is safe —
  // rotateUI.js's own _quickSelect() already uses this same pattern.
  _refreshAllCards();
  _updateHint();
}

// Renders (if needed) every page that hasn't had its ink ratio measured
// yet, bounded to MAX_RENDERS concurrent — same cap _drainThumbs() uses
// for the passive scroll-triggered path, kept as a separate worker pool
// here so this one-off burst doesn't fight over _renderQueue/_activeRenders
// state with any lazy loads still in flight.
async function _ensureBlankFlagsComputed() {
  const pending = [];
  for (let origIdx = 0; origIdx < _pageCount; origIdx++) {
    if (_blankFlags[origIdx] === undefined) pending.push(origIdx);
  }
  if (pending.length === 0) return;
  let next = 0;
  async function worker() {
    while (next < pending.length) {
      await _renderThumb(pending[next++]);
    }
  }
  await Promise.all(Array.from({ length: MAX_RENDERS }, worker));
}

// _undo/_reset mutate the arrays IN PLACE (splice, not reassignment) —
// bindDragReorder()'s closure over `arrays` captured the ORIGINAL array
// references in _bindDrag(); reassigning `_originalIndex = [...]` here
// would silently desync it from what dragReorder actually splices,
// breaking reorder after the first undo/reset.
function _undo() {
  if (!_prevSnapshot) return;
  _originalIndex.splice(0, _originalIndex.length, ..._prevSnapshot.originalIndex);
  _deltas.splice(0, _deltas.length, ..._prevSnapshot.deltas);
  _deletedFlags.splice(0, _deletedFlags.length, ..._prevSnapshot.deletedFlags);
  _prevSnapshot = null;
  _selected.clear();
  _refreshAllCards();
  _updateHistoryButtons();
  _updateSubmitBtn();
}

function _reset() {
  _snapshotForUndo();
  _originalIndex.splice(0, _originalIndex.length, ...Array.from({ length: _pageCount }, (_, i) => i));
  _deltas.splice(0, _deltas.length, ...new Array(_pageCount).fill(0));
  _deletedFlags.splice(0, _deletedFlags.length, ...new Array(_pageCount).fill(0));
  _selected.clear();
  _refreshAllCards();
  _updateHistoryButtons();
  _updateSubmitBtn();
}

// ── DOM updates ────────────────────────────────────────────────

// Content-only — the .org-card node itself is never replaced, so
// dragReorder's per-item listeners on it stay intact. See file header.
function _updateCard(pos) {
  const grid = id('orgGrid');
  if (!grid) return;
  const card = grid.querySelector(`[data-i="${pos}"]`);
  if (!card) return;

  card.classList.toggle('rot-card--selected', _selected.has(pos));
  card.classList.toggle('rot-card--changed', _deltas[pos] !== 0);
  card.classList.toggle('org-card--deleted', !!_deletedFlags[pos]);
  card.setAttribute('aria-label', _ariaLabelFor(pos));

  const wrap = card.querySelector('.rot-thumb, .rot-numbox');
  if (wrap) wrap.innerHTML = _thumbInnerHTML(pos);

  const origIdx = _originalIndex[pos];
  if (_useThumbs && !_thumbnailURLs[origIdx] && _observer) {
    _observer.observe(card); // still pending — (re)watch this same node
  }
}

// Full grid content replace + full drag re-bind — only when page ORDER
// actually changed (drag-reorder, undo, reset). See file header.
function _refreshAllCards() {
  const grid = id('orgGrid');
  if (grid) grid.innerHTML = _renderGrid();
  _bindDrag();
  _setupLazyThumbs();
}

function _hintText() {
  return _selected.size === 0
    ? t('org_hint_click')
    : tp(_selected.size, 'rot_hint_selected_one', 'rot_hint_selected_many', { n: _selected.size });
}

function _updateHint() {
  const el = id('orgHint');
  if (!el) return;
  el.textContent = _hintText();
}

function _anyChanged() {
  return _deltas.some(d => d !== 0)
    || _deletedFlags.some(d => d)
    || _originalIndex.some((idx, pos) => idx !== pos);
}

function _updateHistoryButtons() {
  const undoBtn  = id('orgUndo');
  const resetBtn = id('orgReset');
  if (undoBtn)  undoBtn.disabled  = !_prevSnapshot;
  if (resetBtn) resetBtn.disabled = !_anyChanged();
}

function _updateSubmitBtn() {
  const btn = id('mergeBtn');
  if (!btn) return;
  const keptCount = _deletedFlags.filter(d => !d).length;
  if (keptCount === 0) {
    btn.disabled    = true;
    btn.textContent = t('org_btn_no_pages');
    return;
  }
  btn.disabled    = false;
  btn.textContent = tp(keptCount, 'org_btn_one', 'org_btn_many', { n: keptCount });
}

// ── Cleanup ────────────────────────────────────────────────────

function _cleanup() {
  _observer?.disconnect();
  _observer      = null;
  _renderQueue   = [];
  _activeRenders = 0;
  _pdfJsDoc      = null;

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
