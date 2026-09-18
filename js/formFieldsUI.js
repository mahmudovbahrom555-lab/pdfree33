// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

// ============================================================
//  formFieldsUI.js — "Add Form Fields" tool: turn a flat/scanned PDF
//  into one with real, fillable AcroForm fields.
//
//  Scope (see js/formFieldsWorker.js's own header for the write side):
//    - Text and checkbox fields (radio groups/dropdowns are a follow-up —
//      those need real additional UI concepts this one doesn't: a shared
//      group name spanning multiple boxes, an options-list editor)
//    - A field-type chip toggle selects what the NEXT click places; once
//      placed a field's type is fixed (delete + re-place to change it)
//    - Click-to-place, drag to move, corner-drag to resize, inline name
//      input, delete button — all fully type-agnostic, shared by both
//      field types unchanged
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
import { chipGroup, group }  from './uiComponents.js';
import { t, tp }             from './i18n.js';

const MAX_DIMENSION  = 4096;
const DEFAULT_W_FRAC = 0.30;   // default placed-field width, as a fraction of page width
// Both of these are in PDF POINTS (the page's own, fixed, render-independent
// unit), not CSS px — deliberately. They're divided by _pageWPt/_pageHPt (the
// current page's real point dimensions, captured in _renderPage) rather than
// the canvas wrap's CSS pixel rect, so the same click-to-place action always
// produces the same real-world field size in the saved PDF regardless of
// what cssScale _renderPage happened to compute for the current viewport —
// mobile vs desktop, a tall vs short window, a differently-sized page all
// used to silently change the actual PDF-point size of a "24px" default.
const DEFAULT_H_PT   = 30;     // default placed text-field height, in PDF points
// Checkboxes are inherently small and square, unlike a text field that
// needs width for typed content — WCAG 2.5.8's 24px comfort-target size
// (same language already used for this in fillUI.js's own checkbox
// rendering) is a sensible fixed default, expressed here as PDF points (see
// above) rather than CSS px.
const DEFAULT_CHECKBOX_PT = 24;
const MIN_W_FRAC     = 0.04;
const MIN_H_FRAC     = 0.015;

// ── State ──────────────────────────────────────────────────────
let _pdfDoc      = null;
let _currentPage = 1;
let _pageCount   = 0;
let _fields      = [];     // { id, page, name, type: 'text'|'checkbox', xFrac, yFrac, wFrac, hFrac }
let _fieldSeq    = 0;
let _fieldType   = 'text'; // type the NEXT click will place — mirrors watermarkUI.js's _kind
let _hasExisting = false;
let _loading     = false;
let _generation  = 0;      // staleness guard, same pattern as fillUI.js/drawUI.js
let _pageWPt = 0, _pageHPt = 0; // current page's own PDF-point size — see DEFAULT_H_PT above

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
  _fields = []; _fieldSeq = 0; _fieldType = 'text'; _hasExisting = false; _loading = false;
  _generation++;
  _container = _wrap = _canvas = _overlay = _countEl = _pageLabel = _btnPrev = _btnNext = null;
}

export function getFormFieldsParams() {
  _syncNamesFromDOM();
  return {
    loading:           _loading,
    hasExistingFields: _hasExisting,
    fields: _fields.map(f => ({
      page: f.page, name: f.name, type: f.type,
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
  // This used to carry a 96px bottom padding to clear #mergeBtn's sticky
  // position (CLAUDE.md UX checklist item 8) — needed back when the canvas
  // rendered at full, un-clipped height directly in the page's normal
  // scroll flow (a full A4 page at 1:1 CSS px could easily be taller than
  // the viewport, so scrolling to the bottom of it put that click point
  // under the sticky button). Now that #ffCanvasScroll itself is bounded
  // (max-height + internal scroll, set in _renderPage — see that function's
  // own comment) to the exact "space available before the sticky button"
  // measurement, the canvas's visible footprint is already guaranteed safe
  // — this extra padding became pure dead space below it (a real user-
  // reported screenshot showed a large empty gap between the canvas and
  // the process button). Removed; a small gap remains for basic breathing
  // room around #ffCount, not sticky-button clearance.
  return `
    <div class="ff-editor" style="padding:0 0 8px;">
      <p style="margin:0 0 12px;font-size:13px;color:var(--text3);line-height:1.5;">
        ${esc(t('formfields_click_hint'))}
      </p>
      <div style="max-width:320px;margin:0 auto 14px;">
        ${group(t('formfields_type_label'), chipGroup('ffType', [
          { value: 'text',     label: t('formfields_type_text') },
          { value: 'checkbox', label: t('formfields_type_checkbox') },
        ], _fieldType, t('formfields_type_label')))}
      </div>
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
  // Checkbox fields default to a small (24px) square box — real PDF
  // checkbox widgets are just the tick square, the descriptive label is
  // normally separate page text, not part of the widget itself — so
  // there's rarely room for a usable inline name input at default size.
  // Rather than invent a second box layout, this prepends a small glyph
  // and reuses the exact same name-input/drag/resize/delete structure
  // text fields already use: the auto-generated name ("Checkbox 1", …)
  // works even if the input itself is too cramped to interact with at
  // default size, and dragging the resize handle bigger (already-existing
  // functionality, zero special-casing needed) makes the same input
  // usable for renaming, same as it always has been for text fields.
  const checkboxGlyph = f.type === 'checkbox'
    ? `<span aria-hidden="true" style="flex-shrink:0;font-size:13px;line-height:1;padding-left:4px;color:#123;">☐</span>`
    : '';
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
    ${checkboxGlyph}
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
    _pageWPt = baseVp.width;
    _pageHPt = baseVp.height;
    const outputScale  = window.devicePixelRatio || 1;
    const scrollEl     = id('ffCanvasScroll');
    const areaW        = Math.max(280, (scrollEl?.clientWidth || 760) - 8);

    // Previously this also capped cssScale by height (maxCssHeight /
    // baseVp.height, folded into the same Math.min as the width term) to
    // keep #mergeBtn's sticky-bottom overlap from covering the canvas's
    // lower portion (CLAUDE.md UX checklist item 8). Real, reported bug in
    // that approach: since ONE scale factor drives both width and height
    // (a canvas render can't scale them independently without distorting
    // the page), a tall page on a viewport with limited headroom above the
    // sticky button shrank the WHOLE render — including width — down to a
    // tiny thumbnail, even though plenty of horizontal space was still
    // available. A real portrait certificate PDF made this obvious: the
    // rendered page was a fraction of the panel's actual width.
    //
    // Fix: scale by WIDTH ONLY (maximize the render size that actually
    // matters for precise click-to-place accuracy), and instead bound
    // #ffCanvasScroll itself (max-height + its existing overflow:auto) to
    // the same "space available above the sticky button" measurement.
    // This gives the identical overlap guarantee as before — the visible
    // box never extends into the sticky button's territory — but a tall
    // page now scrolls WITHIN that fixed-size box instead of shrinking
    // sideways to avoid ever needing to scroll.
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
    if (scrollEl) {
      scrollEl.style.maxHeight = `${maxCssHeight}px`;
      scrollEl.style.overflowY = 'auto';
    }
    let cssScale = Math.min(1, areaW / baseVp.width);

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

  // Only affects the NEXT placed field — no re-render needed, same as
  // watermarkUI.js's wmKind handler for a mode that doesn't change
  // anything already on screen.
  _container.addEventListener('change', e => {
    if (e.target.name === 'ffType') {
      _fieldType = e.target.value;
      _container.querySelectorAll('[data-name="ffType"]').forEach(el =>
        el.classList.toggle('j2p-chip--active', el.dataset.value === _fieldType));
    }
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

  // Checkboxes get a small square default (24pt comfort-target, matching
  // fillUI.js's own checkbox-sizing language) instead of the wide
  // text-field default — a 30%-page-width box would look absurd for a
  // checkbox. Divide by _pageWPt/_pageHPt (the page's own fixed PDF-point
  // size, captured in _renderPage), NOT r.width/r.height (the CSS wrap
  // rect) — the wrap rect scales with _renderPage's dynamic cssScale
  // (viewport width, available scroll height, DPR all affect it), so
  // dividing by it made the SAME click produce a different real-world PDF
  // point size depending on what viewport happened to render the page.
  // Dividing by the page's own point dimensions keeps the saved field size
  // constant regardless of render viewport.
  const isCheckbox = _fieldType === 'checkbox';
  const wFrac = isCheckbox ? DEFAULT_CHECKBOX_PT / _pageWPt : DEFAULT_W_FRAC;
  const hFrac = isCheckbox ? DEFAULT_CHECKBOX_PT / _pageHPt : DEFAULT_H_PT / _pageHPt;

  const xFrac = Math.min(Math.max(0, clickXFrac - wFrac / 2), Math.max(0, 1 - wFrac));
  const yFrac = Math.min(Math.max(0, clickYFrac - hFrac / 2), Math.max(0, 1 - hFrac));

  _fieldSeq++;
  const field = {
    id: _fieldSeq, page: _currentPage, type: _fieldType,
    name: isCheckbox
      ? t('formfields_default_checkbox_name', { n: _fieldSeq })
      : t('formfields_default_field_name', { n: _fieldSeq }),
    xFrac, yFrac, wFrac, hFrac,
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
  // Pointer capture keeps move/up events targeted at this element even if a
  // fast touch drag slips outside its bounds mid-gesture — window-level
  // listeners still receive the events either way (capture affects the
  // event's target, not whether it bubbles to window), so this is a pure
  // reliability addition, not a change to the existing listener wiring.
  if (el?.setPointerCapture && e.pointerId != null) el.setPointerCapture(e.pointerId);

  function onMove(ev) {
    const dxFrac = (ev.clientX - startX) / r.width;
    const dyFrac = (ev.clientY - startY) / r.height;
    f.xFrac = Math.min(Math.max(0, startXFrac + dxFrac), Math.max(0, 1 - f.wFrac));
    f.yFrac = Math.min(Math.max(0, startYFrac + dyFrac), Math.max(0, 1 - f.hFrac));
    if (el) { el.style.left = `${(f.xFrac * 100).toFixed(3)}%`; el.style.top = `${(f.yFrac * 100).toFixed(3)}%`; }
  }
  function onUp(ev) {
    if (el?.releasePointerCapture && ev.pointerId != null) {
      try { el.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    }
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
  if (el?.setPointerCapture && e.pointerId != null) el.setPointerCapture(e.pointerId);

  function onMove(ev) {
    const dwFrac = (ev.clientX - startX) / r.width;
    const dhFrac = (ev.clientY - startY) / r.height;
    if (f.type === 'checkbox') {
      // Lock aspect ratio to 1:1 IN PDF POINTS (not in xFrac/yFrac space,
      // which is only square when the page itself is square) — a real PDF
      // viewer renders a checkbox's tick centered in whatever rect the
      // widget was given, so a checkbox this tool lets the user stretch
      // into a rectangle would misleadingly not match how it actually
      // renders. Average the two drag deltas converted to points, then
      // apply that single point delta to both dimensions so the box stays
      // square in the units that actually matter (the saved PDF's points).
      const dPt = (dwFrac * _pageWPt + dhFrac * _pageHPt) / 2;
      f.wFrac = Math.min(Math.max(MIN_W_FRAC, (startWFrac * _pageWPt + dPt) / _pageWPt), Math.max(MIN_W_FRAC, 1 - f.xFrac));
      f.hFrac = Math.min(Math.max(MIN_H_FRAC, (startHFrac * _pageHPt + dPt) / _pageHPt), Math.max(MIN_H_FRAC, 1 - f.yFrac));
    } else {
      f.wFrac = Math.min(Math.max(MIN_W_FRAC, startWFrac + dwFrac), Math.max(MIN_W_FRAC, 1 - f.xFrac));
      f.hFrac = Math.min(Math.max(MIN_H_FRAC, startHFrac + dhFrac), Math.max(MIN_H_FRAC, 1 - f.yFrac));
    }
    if (el) { el.style.width = `${(f.wFrac * 100).toFixed(3)}%`; el.style.height = `${(f.hFrac * 100).toFixed(3)}%`; }
  }
  function onUp(ev) {
    if (el?.releasePointerCapture && ev.pointerId != null) {
      try { el.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    }
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
