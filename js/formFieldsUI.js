// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

// ============================================================
//  formFieldsUI.js — "Add Form Fields" tool: turn a flat/scanned PDF
//  into one with real, fillable AcroForm text fields.
//
//  MVP scope (see js/formFieldsWorker.js's own header for the write side):
//    - Text fields only (checkbox/radio/dropdown are a follow-up)
//    - Single field TYPE, click-to-place, drag to move, corner-drag to
//      resize, inline name input, delete button
//    - Multi-page supported (page nav, like drawUI.js/fillUI.js)
//    - A PDF that already has AcroForm fields is redirected to the
//      existing Fill tool instead of duplicating that tool's job — this
//      tool is only for documents that DON'T have fields yet.
//
//  Coordinate contract (matches js/formFieldsWorker.js exactly): each
//  field is stored as TOP-LEFT-origin FRACTIONS of the page (xFrac, yFrac,
//  wFrac, hFrac, all 0..1) — not raw canvas pixels. This is what makes the
//  field boxes pure-CSS-percentage-positioned (no JS resize handler needed
//  when the canvas itself resizes) and is also exactly the format the
//  worker expects, so getFormFieldsParams() can pass _fields through
//  unchanged.
//
//  Known limitation, same as drawUI.js's Rotate:180 comment but broader
//  here: page rendering forces rotation to 0 regardless of the PDF's own
//  /Rotate metadata, to keep the canvas's pixel space identical to
//  pdf-lib's own unrotated page.getWidth()/getHeight() space that the
//  worker converts fractions back into. A PDF whose pages carry real
//  /Rotate metadata will render right-side up here (pdf.js still applies
//  the rotation because we don't pass a viewport rotation override to
//  page.render — wait, see _renderPage's own comment) but a field's
//  placement could land in the wrong spot on such a page. Deferred — rare
//  in practice for scanned/flat documents, which is this tool's target.
// ============================================================

import { id, esc }           from './utils.js';
import { loadPdfJs }         from './pdf2jpgUI.js';
import { showToast, setButtonDisabled } from './ui.js';
import { t, tp }             from './i18n.js';

const MAX_DIMENSION  = 4096;
const DEFAULT_W_FRAC = 0.30;   // default placed-field width, as a fraction of page width
const DEFAULT_H_PX   = 30;     // default placed-field height, in CSS px at render time
const MIN_W_FRAC     = 0.04;
const MIN_H_FRAC     = 0.015;

// ── State ──────────────────────────────────────────────────────
let _pdfDoc      = null;
let _currentPage = 1;
let _pageCount   = 0;
let _fields      = [];     // { id, page, name, xFrac, yFrac, wFrac, hFrac }
let _fieldSeq    = 0;
let _hasExisting = false;
let _loading     = false;
let _generation  = 0;      // staleness guard, same pattern as fillUI.js/drawUI.js

// DOM refs — set inside _buildEditorHTML/_bindEditorEvents each render
let _container, _wrap, _canvas, _overlay, _countEl, _pageLabel, _btnPrev, _btnNext;

// ── Public API ────────────────────────────────────────────────

export function initFormFieldsOptions(file) {
  const el = id('formFieldsOptions');
  if (!el) return;
  el.style.display = '';
  if (!file) { el.innerHTML = ''; return; }
  _extractAndRender(file, el);
}

export function hideFormFieldsOptions() {
  const el = id('formFieldsOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  _pdfDoc = null; _currentPage = 1; _pageCount = 0;
  _fields = []; _fieldSeq = 0; _hasExisting = false; _loading = false;
  _generation++;
  _container = _wrap = _canvas = _overlay = _countEl = _pageLabel = _btnPrev = _btnNext = null;
}

export function getFormFieldsParams() {
  _syncNamesFromDOM();
  return {
    loading:           _loading,
    hasExistingFields: _hasExisting,
    fields: _fields.map(f => ({
      page: f.page, name: f.name,
      xFrac: f.xFrac, yFrac: f.yFrac, wFrac: f.wFrac, hFrac: f.hFrac,
    })),
  };
}

// ── Extraction: does this PDF already have AcroForm fields? ────

async function _extractAndRender(file, container) {
  _loading = true;
  const myGen = ++_generation;
  container.innerHTML = _spinnerHTML(t('formfields_analysing'));

  try {
    await loadPdfJs();
    if (myGen !== _generation) return;
    if (!window.pdfjsLib) throw new Error(t('fill_pdfjs_unavailable'));

    const rawBuf = await file.arrayBuffer();
    const pdfDoc = await window.pdfjsLib.getDocument({ isEvalSupported: false,
      data: new Uint8Array(rawBuf), useSystemFonts: false,
      verbosity: 0, disableJavaScript: true,
    }).promise;
    if (myGen !== _generation) return;

    let hasWidgets = false;
    for (let p = 1; p <= pdfDoc.numPages && !hasWidgets; p++) {
      if (myGen !== _generation) return;
      const page   = await pdfDoc.getPage(p);
      const annots = await page.getAnnotations();
      hasWidgets = annots.some(a => a.subtype === 'Widget');
    }
    if (myGen !== _generation) return;

    _hasExisting = hasWidgets;
    _loading     = false;

    if (hasWidgets) {
      container.innerHTML = _blockedHTML();
      setButtonDisabled();
      return;
    }

    _pdfDoc      = pdfDoc;
    _pageCount   = pdfDoc.numPages;
    _currentPage = 1;
    _fields      = [];
    _fieldSeq    = 0;

    container.innerHTML = _buildEditorHTML();
    _bindEditorRefs(container);
    _bindEditorEvents();
    await _renderPage(1);
    _updateCount();

  } catch (err) {
    if (myGen !== _generation) return;
    _loading = false;
    container.innerHTML = _errorHTML(err.message);
    setButtonDisabled();
  }
}

// ── HTML builders ────────────────────────────────────────────

function _spinnerHTML(msg) {
  return `<div style="padding:24px 16px;text-align:center;color:var(--text3);font-size:14px;">
    <div style="font-size:24px;margin-bottom:8px;">⏳</div>${esc(msg)}</div>`;
}

function _errorHTML(msg) {
  return `<div style="padding:16px;border:1px solid #fca5a5;border-radius:10px;background:#fff1f2;color:#dc2626;font-size:13px;">
    ${esc(t('formfields_error_prefix', { msg }))}
  </div>`;
}

function _blockedHTML() {
  return `<div style="padding:20px 16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);">
    <p style="margin:0 0 8px;font-weight:600;color:var(--text);">${t('formfields_has_fields_title')}</p>
    <p style="margin:0;font-size:13px;color:var(--text3);line-height:1.5;">
      ${t('formfields_has_fields_body')}
      <a href="/fill/" style="color:var(--green-text);">${t('formfields_has_fields_link')}</a>${t('formfields_has_fields_suffix')}
    </p>
  </div>`;
}

function _buildEditorHTML() {
  // padding-bottom on the outer wrapper (not just ffCanvasScroll) is
  // deliberate: #mergeBtn is `position: sticky; bottom: 16px` (see
  // css/components.css), pinned to a fixed VIEWPORT position while any
  // part of this panel is in view — same mechanism documented in
  // CLAUDE.md's UX checklist item 8 (bit twice before: #fileList sitewide,
  // #btnInstallOcr/#glsDictionary). This tool's canvas can easily be
  // taller than the viewport (a full A4 page at 1:1 CSS px), so without
  // this clearance, scrolling down to place a field near the BOTTOM of the
  // page puts that exact click point under the sticky button instead of on
  // the canvas — confirmed live via document.elementFromPoint() during
  // Playwright verification (tests/e2e/formFields.e2e.mjs) before this fix
  // was added: the click landed on #mergeBtn, not #ffOverlay. ~90px matches
  // the button's own real height + its 16px sticky offset.
  return `
    <div class="ff-editor" style="padding:0 0 96px;">
      <p style="margin:0 0 12px;font-size:13px;color:var(--text3);line-height:1.5;">
        ${esc(t('formfields_click_hint'))}
      </p>
      <div style="display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:10px;">
        <button type="button" id="ffPrevBtn" aria-label="${esc(t('org_lightbox_prev'))}" style="
          width:36px;height:36px;border-radius:8px;border:1.5px solid var(--border);
          background:var(--surface);color:var(--text);font-size:16px;cursor:pointer;">‹</button>
        <span id="ffPageLabel" style="font-size:13px;color:var(--text2);min-width:70px;text-align:center;">1 / 1</span>
        <button type="button" id="ffNextBtn" aria-label="${esc(t('org_lightbox_next'))}" style="
          width:36px;height:36px;border-radius:8px;border:1.5px solid var(--border);
          background:var(--surface);color:var(--text);font-size:16px;cursor:pointer;">›</button>
      </div>
      <div id="ffCanvasScroll" style="display:flex;justify-content:center;overflow:auto;max-width:100%;">
        <div id="ffCanvasWrap" style="position:relative;flex-shrink:0;">
          <canvas id="ffCanvas" style="display:block;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.15);"></canvas>
          <div id="ffOverlay" style="position:absolute;inset:0;cursor:crosshair;"></div>
        </div>
      </div>
      <p id="ffCount" style="text-align:center;margin:10px 0 0;font-size:12px;color:var(--text3);"></p>
    </div>`;
}

function _fieldBoxHTML(f) {
  // Real bug found by the user right after shipping: .ff-name-input used
  // flex:1 to fill the whole box, so there was no pixel of the box NOT
  // covered by the text input — the wrapper's own cursor:move / drag-start
  // handling (_onOverlayPointerDown) never had anywhere to actually fire,
  // since a pointerdown anywhere on a placed field always landed on the
  // input and was explicitly excluded from starting a drag. Fixed with a
  // dedicated drag handle, positioned outside the box via negative offset —
  // same pattern already used here for delete (top-right) and resize
  // (bottom-right) — so it's always a real, reachable target regardless of
  // how small the field box itself gets resized to.
  return `<div class="ff-field-box" data-id="${f.id}" style="
      position:absolute;box-sizing:border-box;
      left:${(f.xFrac * 100).toFixed(3)}%; top:${(f.yFrac * 100).toFixed(3)}%;
      width:${(f.wFrac * 100).toFixed(3)}%; height:${(f.hFrac * 100).toFixed(3)}%;
      border:1.5px dashed #2D7A4F; background:rgba(45,122,79,0.10);
      display:flex; align-items:center; touch-action:none;">
    <div class="ff-drag-handle" data-id="${f.id}"
      aria-label="${esc(t('formfields_drag_aria'))}" title="${esc(t('formfields_drag_aria'))}"
      style="position:absolute;top:-11px;left:-11px;width:22px;height:22px;min-width:22px;
        border-radius:50%;border:2px solid #fff;background:#2D7A4F;color:#fff;
        font-size:12px;line-height:1;cursor:move;display:flex;align-items:center;justify-content:center;
        touch-action:none;">⠿</div>
    <input class="ff-name-input" data-id="${f.id}" value="${esc(f.name)}"
      placeholder="${esc(t('formfields_name_placeholder'))}"
      style="flex:1;min-width:0;height:100%;box-sizing:border-box;padding:0 22px 0 6px;
        border:none;background:transparent;color:#123;font-size:12px;font-weight:600;
        outline:none;cursor:text;">
    <button type="button" class="ff-delete-btn" data-id="${f.id}"
      aria-label="${esc(t('formfields_delete_aria'))}" title="${esc(t('formfields_delete_aria'))}"
      style="position:absolute;top:-11px;right:-11px;width:22px;height:22px;min-width:22px;
        border-radius:50%;border:2px solid #fff;background:#dc2626;color:#fff;
        font-size:12px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button>
    <div class="ff-resize-handle" data-id="${f.id}" style="
        position:absolute;right:-8px;bottom:-8px;width:24px;height:24px;cursor:nwse-resize;
        display:flex;align-items:flex-end;justify-content:flex-end;touch-action:none;">
      <div style="width:10px;height:10px;border-radius:3px;background:#2D7A4F;border:2px solid #fff;"></div>
    </div>
  </div>`;
}

// ── Editor: refs, page render, overlay ──────────────────────────

function _bindEditorRefs(container) {
  _container = container;
  _wrap      = id('ffCanvasWrap');
  _canvas    = id('ffCanvas');
  _overlay   = id('ffOverlay');
  _countEl   = id('ffCount');
  _pageLabel = id('ffPageLabel');
  _btnPrev   = id('ffPrevBtn');
  _btnNext   = id('ffNextBtn');
}

async function _renderPage(pageNum) {
  const myGen = _generation;
  try {
    const page = await _pdfDoc.getPage(pageNum);
    if (myGen !== _generation) return;

    // Rotation forced to 0 — see this file's own header comment for why
    // (must match pdf-lib's unrotated page.getWidth()/getHeight() space,
    // which is what js/formFieldsWorker.js converts field fractions into).
    const baseVp       = page.getViewport({ scale: 1, rotation: 0 });
    const outputScale  = window.devicePixelRatio || 1;
    const scrollEl     = id('ffCanvasScroll');
    const areaW        = Math.max(280, (scrollEl?.clientWidth || 760) - 8);

    // Height cap, not just width — see this file's own header comment on
    // #mergeBtn's sticky-bottom overlap (CLAUDE.md UX checklist item 8).
    // Without this, a page rendered at 1:1 (a full A4/Letter page is
    // visually taller than most viewports) leaves its lower portion
    // sitting UNDER the sticky button at essentially every scroll
    // position — confirmed live via document.elementFromPoint() during
    // Playwright verification: a click at a point that looked like it was
    // on the canvas landed on #mergeBtn instead. Capping height so the
    // whole page fits above the reserved chrome sidesteps the overlap for
    // the common case instead of relying on scroll position.
    //
    // A flat "reserve N px" guess doesn't work here — this same options
    // panel is embedded inside different page templates (the dedicated
    // /add-form-fields/ page has real nav + hero copy + page-nav buttons
    // above the canvas; a different host page could have more or less).
    // Measure the ACTUAL space already consumed above the canvas via
    // getBoundingClientRect() instead of guessing — real, dynamic per
    // page, not a magic number that only happened to fit one template.
    const scrollTop     = scrollEl?.getBoundingClientRect().top ?? 200;
    const stickyReserve = 110; // #mergeBtn's real height + its sticky offset + a small margin
    const maxCssHeight  = Math.max(220, (window.innerHeight || 800) - scrollTop - stickyReserve);
    let cssScale        = Math.min(1, areaW / baseVp.width, maxCssHeight / baseVp.height);

    const maxCss = MAX_DIMENSION / (Math.max(baseVp.width, baseVp.height) * outputScale);
    if (cssScale > maxCss) cssScale = maxCss;

    const cssW = Math.round(baseVp.width  * cssScale);
    const cssH = Math.round(baseVp.height * cssScale);
    const pixelScale = Math.min(outputScale, MAX_DIMENSION / cssW, MAX_DIMENSION / cssH);
    const viewport = page.getViewport({ scale: cssScale * pixelScale, rotation: 0 });

    const pxW = Math.round(viewport.width);
    const pxH = Math.round(viewport.height);

    _canvas.width  = pxW;
    _canvas.height = pxH;
    _canvas.style.width  = `${Math.round(viewport.width  / pixelScale)}px`;
    _canvas.style.height = `${Math.round(viewport.height / pixelScale)}px`;
    _wrap.style.width  = _canvas.style.width;
    _wrap.style.height = _canvas.style.height;

    const ctx = _canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pxW, pxH);
    await page.render({ canvasContext: ctx, viewport }).promise;
    if (myGen !== _generation) return;

    _currentPage = pageNum;
    if (_pageLabel) _pageLabel.textContent = `${pageNum} / ${_pageCount}`;
    if (_btnPrev)   _btnPrev.disabled = pageNum <= 1;
    if (_btnNext)   _btnNext.disabled = pageNum >= _pageCount;

    _renderOverlayFields();
  } catch (err) {
    if (myGen === _generation) showToast(t('formfields_error_prefix', { msg: err.message }));
  }
}

function _renderOverlayFields() {
  if (!_overlay) return;
  _overlay.innerHTML = _fields
    .filter(f => f.page === _currentPage)
    .map(_fieldBoxHTML)
    .join('');
}

// ── Interaction: click-to-place, drag, resize, delete ──────────

function _bindEditorEvents() {
  _btnPrev.addEventListener('click', () => {
    if (_currentPage > 1) _renderPage(_currentPage - 1);
  });
  _btnNext.addEventListener('click', () => {
    if (_currentPage < _pageCount) _renderPage(_currentPage + 1);
  });

  _overlay.addEventListener('pointerdown', _onOverlayPointerDown);
  _overlay.addEventListener('click', e => {
    const del = e.target.closest('.ff-delete-btn');
    if (del) { _deleteField(del.dataset.id); return; }
    // Clicking directly on empty overlay space (not a field box) places a new field.
    if (e.target === _overlay) _placeFieldAtEvent(e);
  });
  _overlay.addEventListener('input', e => {
    if (!e.target.classList.contains('ff-name-input')) return;
    const f = _fields.find(x => String(x.id) === e.target.dataset.id);
    if (f) f.name = e.target.value;
  });
}

function _wrapRect() { return _wrap.getBoundingClientRect(); }

function _placeFieldAtEvent(e) {
  const r = _wrapRect();
  const clickXFrac = (e.clientX - r.left) / r.width;
  const clickYFrac = (e.clientY - r.top)  / r.height;
  const hFrac = DEFAULT_H_PX / r.height;

  const xFrac = Math.min(Math.max(0, clickXFrac - DEFAULT_W_FRAC / 2), Math.max(0, 1 - DEFAULT_W_FRAC));
  const yFrac = Math.min(Math.max(0, clickYFrac - hFrac / 2), Math.max(0, 1 - hFrac));

  _fieldSeq++;
  const field = {
    id: _fieldSeq, page: _currentPage,
    name: t('formfields_default_field_name', { n: _fieldSeq }),
    xFrac, yFrac, wFrac: DEFAULT_W_FRAC, hFrac,
  };
  _fields.push(field);
  _renderOverlayFields();
  _updateCount();

  // Focus + select the new field's name input so the user can type a label
  // right away — this IS the "simple inline name/label" affordance.
  const input = _overlay.querySelector(`.ff-name-input[data-id="${field.id}"]`);
  if (input) { input.focus(); input.select(); }
}

function _onOverlayPointerDown(e) {
  const handle = e.target.closest('.ff-resize-handle');
  const box    = e.target.closest('.ff-field-box');

  if (handle) { _startResize(e, handle.dataset.id); return; }
  if (box && !e.target.closest('.ff-name-input') && !e.target.closest('.ff-delete-btn')) {
    _startDrag(e, box.dataset.id);
  }
}

function _startDrag(e, fieldId) {
  const f = _fields.find(x => String(x.id) === fieldId);
  if (!f) return;
  e.preventDefault();
  const r = _wrapRect();
  const startX = e.clientX, startY = e.clientY;
  const startXFrac = f.xFrac, startYFrac = f.yFrac;
  const el = _overlay.querySelector(`.ff-field-box[data-id="${fieldId}"]`);

  function onMove(ev) {
    const dxFrac = (ev.clientX - startX) / r.width;
    const dyFrac = (ev.clientY - startY) / r.height;
    f.xFrac = Math.min(Math.max(0, startXFrac + dxFrac), Math.max(0, 1 - f.wFrac));
    f.yFrac = Math.min(Math.max(0, startYFrac + dyFrac), Math.max(0, 1 - f.hFrac));
    if (el) { el.style.left = `${(f.xFrac * 100).toFixed(3)}%`; el.style.top = `${(f.yFrac * 100).toFixed(3)}%`; }
  }
  function onUp() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup',   onUp);
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup',   onUp);
}

function _startResize(e, fieldId) {
  const f = _fields.find(x => String(x.id) === fieldId);
  if (!f) return;
  e.preventDefault();
  e.stopPropagation();
  const r = _wrapRect();
  const startX = e.clientX, startY = e.clientY;
  const startWFrac = f.wFrac, startHFrac = f.hFrac;
  const el = _overlay.querySelector(`.ff-field-box[data-id="${fieldId}"]`);

  function onMove(ev) {
    const dwFrac = (ev.clientX - startX) / r.width;
    const dhFrac = (ev.clientY - startY) / r.height;
    f.wFrac = Math.min(Math.max(MIN_W_FRAC, startWFrac + dwFrac), Math.max(MIN_W_FRAC, 1 - f.xFrac));
    f.hFrac = Math.min(Math.max(MIN_H_FRAC, startHFrac + dhFrac), Math.max(MIN_H_FRAC, 1 - f.yFrac));
    if (el) { el.style.width = `${(f.wFrac * 100).toFixed(3)}%`; el.style.height = `${(f.hFrac * 100).toFixed(3)}%`; }
  }
  function onUp() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup',   onUp);
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup',   onUp);
}

function _deleteField(fieldId) {
  _fields = _fields.filter(x => String(x.id) !== String(fieldId));
  _renderOverlayFields();
  _updateCount();
}

function _syncNamesFromDOM() {
  if (!_overlay) return;
  _overlay.querySelectorAll('.ff-name-input').forEach(input => {
    const f = _fields.find(x => String(x.id) === input.dataset.id);
    if (f) f.name = input.value;
  });
}

function _updateCount() {
  if (!_countEl) return;
  const n = _fields.length;
  _countEl.textContent = n === 0 ? '' : tp(n, 'formfields_count_one', 'formfields_count_many', { n });
}
