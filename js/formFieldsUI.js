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

// Manual zoom ladder (competitive gap vs iLovePDF's own PDF-Forms editor,
// which ships %/+/−/fit-width controls — checked live 2026-09-17). Index 2
// (1.0) means "exactly what _renderPage's own fit-to-width computed", so
// "Fit to width" is simply a reset to this index, not separate math. Fixed
// steps rather than a multiply-by-1.25 loop so the displayed % is always a
// round, repeatable number and zooming out then in lands back where it was.
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];
const ZOOM_FIT_IDX = 2;

// Focus-trap selector (standard modal a11y set). Applied against the modal
// subtree only — see _focusables/_onModalKeydown.
const FOCUSABLE_SEL = 'a[href], button:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
let _zoomIdx = ZOOM_FIT_IDX;    // index into ZOOM_STEPS — user zoom on top of fit-to-width
let _activeFieldId = null;      // field highlighted by the sidebar list, null when none

// DOM refs — set inside _buildModalHTML/_bindEditorEvents each render
let _container, _wrap, _canvas, _overlay, _countEl, _pageLabel, _btnPrev, _btnNext;
let _listEl, _zoomLabel, _btnZoomIn, _btnZoomOut, _btnZoomFit;
let _modal     = null; // the editor modal's own root element, null when closed
let _fileLabel = '';   // file.name, shown in the modal header + reused by _triggerHTML
let _prevFocus = null; // element focused before the modal opened — restored on close
let _inerted   = [];   // body children this modal made inert; emptied on close

// Real, reported bug history (see form_field_creation_tool_2026_09 memory
// for the full trace): this options panel routinely renders far down a
// page with nav+hero+dropzone+filelist above it, so an inline canvas
// bounded to "whatever room is left above the sticky #mergeBtn" was
// chronically cramped — several rounds of scroll-height-tracking fixes
// here before this one, all now removed. A full-viewport modal (see
// .ff-modal in css/components.css) sidesteps the entire problem class:
// inside the modal there's no outer page scroll to fight — the canvas
// stage just flex-fills whatever's left after the header/footer via CSS
// (.ff-modal__stage's flex:1/min-height:0), same pattern already proven
// by .scan-cam-stage in js/scanCameraUI.js.

// ── Public API ────────────────────────────────────────────────

export function initFormFieldsOptions(file) {
  const el = id('formFieldsOptions');
  if (!el) return;
  el.style.display = '';
  if (!file) { el.innerHTML = ''; _closeModal({ silent: true }); return; }
  _extractAndRender(file, el);
}

export function hideFormFieldsOptions() {
  const el = id('formFieldsOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  _closeModal({ silent: true });
  _pdfDoc = null; _currentPage = 1; _pageCount = 0;
  _fields = []; _fieldSeq = 0; _fieldType = 'text'; _hasExisting = false; _loading = false;
  _fileLabel = ''; _zoomIdx = ZOOM_FIT_IDX; _activeFieldId = null;
  _generation++;
  _container = null;
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
  _closeModal({ silent: true }); // a new file replaces any editor already open for a previous one
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
    _fileLabel   = file.name;
    _container   = container;
    _zoomIdx     = ZOOM_FIT_IDX;
    _activeFieldId = null;

    // The outer options panel just holds a compact placeholder — the real
    // editing surface is the modal (see _openModal). Painted first so
    // there's no flash of empty panel while the modal's own first render
    // (pdf.js page render + field overlay) is still in flight.
    container.innerHTML = _triggerHTML();
    _bindTriggerEvents(container);
    await _openModal();

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

// Shown in the OUTER options panel — behind the modal while it's briefly
// building, and again if the user closes the modal without processing.
// Doesn't touch _fields/_pdfDoc state; this is a view, not a reset (see
// hideFormFieldsOptions for the real teardown).
function _triggerHTML() {
  const n = _fields.length;
  const countText = n > 0 ? tp(n, 'formfields_count_one', 'formfields_count_many', { n }) : '';
  return `
    <div style="padding:16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);text-align:center;">
      <p style="margin:0 0 10px;font-size:13px;color:var(--text3);word-break:break-word;">
        ${esc(_fileLabel)}${countText ? ` · ${esc(countText)}` : ''}
      </p>
      <button type="button" id="ffReopenBtn" class="split-action-btn">${esc(t('formfields_continue_editing'))}</button>
    </div>`;
}

function _bindTriggerEvents(container) {
  container.querySelector('#ffReopenBtn')?.addEventListener('click', () => _openModal());
}

// Two-column body: the editing surface on the left, a live list of every
// placed field on the right. The sidebar is the competitive gap iLovePDF's
// own PDF-Forms editor covers with its "Form Field List" (checked live
// 2026-09-17): on a document with many fields, finding a specific one by
// hunting across pages on the canvas doesn't scale. It's collapsed away
// entirely under 900px (see .ff-modal__side in css/components.css) rather
// than squeezing the canvas — the canvas IS the tool on a phone.
function _modalBodyHTML() {
  return `
    <div class="ff-modal__main">
      <p style="margin:0 0 12px;font-size:13px;color:var(--text3);line-height:1.5;">
        ${esc(t('formfields_click_hint'))}
      </p>
      <div style="max-width:320px;margin:0 auto 14px;">
        ${group(t('formfields_type_label'), chipGroup('ffType', [
          { value: 'text',     label: t('formfields_type_text') },
          { value: 'checkbox', label: t('formfields_type_checkbox') },
        ], _fieldType, t('formfields_type_label')))}
      </div>
      <div class="ff-modal__toolbar">
        <div class="ff-modal__navgroup">
          <button type="button" id="ffPrevBtn" class="ff-navbtn" aria-label="${esc(t('org_lightbox_prev'))}">‹</button>
          <span id="ffPageLabel" class="ff-modal__navlabel">1 / 1</span>
          <button type="button" id="ffNextBtn" class="ff-navbtn" aria-label="${esc(t('org_lightbox_next'))}">›</button>
        </div>
        <div class="ff-modal__navgroup">
          <button type="button" id="ffZoomOutBtn" class="ff-navbtn" aria-label="${esc(t('formfields_zoom_out'))}">−</button>
          <span id="ffZoomLabel" class="ff-modal__navlabel" role="status"
            aria-label="${esc(t('formfields_zoom_level'))}">100%</span>
          <button type="button" id="ffZoomInBtn" class="ff-navbtn" aria-label="${esc(t('formfields_zoom_in'))}">+</button>
          <!-- "Reset zoom", not "Fit to width": the underlying fit scale is
               Math.min(1, areaW / pageWidth) (see _renderPage), so on a wide
               desktop 100% is the page's own size, NOT the stage's width —
               labelling this button "fit to width" would be visibly untrue
               there. Icon-only so the whole toolbar stays one row at 390px
               instead of wrapping and eating ~44px of canvas height. -->
          <button type="button" id="ffZoomFitBtn" class="ff-navbtn"
            aria-label="${esc(t('formfields_zoom_reset'))}" title="${esc(t('formfields_zoom_reset'))}">⤢</button>
        </div>
      </div>
      <div id="ffCanvasScroll" class="ff-modal__stage">
        <div id="ffCanvasWrap" style="position:relative;flex-shrink:0;margin:auto;">
          <canvas id="ffCanvas" style="display:block;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.15);"></canvas>
          <div id="ffOverlay" style="position:absolute;inset:0;cursor:crosshair;"></div>
        </div>
      </div>
      <p id="ffCount" style="text-align:center;margin:10px 0 0;font-size:12px;color:var(--text3);"></p>
    </div>
    <aside class="ff-modal__side" id="ffFieldPanel" aria-label="${esc(t('formfields_fieldlist_title'))}">
      <p class="ff-modal__side-title">${esc(t('formfields_fieldlist_title'))}</p>
      <div id="ffFieldList" class="ff-fieldlist"></div>
    </aside>`;
}

// Full-viewport editor modal — see css/components.css's .ff-modal block
// for the full rationale (this tool's canvas was chronically cramped
// rendering inline in the options panel; a dedicated modal sidesteps the
// whole problem class instead of tracking scroll position to work around
// it). Re-entrant: calling this while already open (e.g. clicking
// "Continue editing" is a no-op if somehow still mounted) just returns.
async function _openModal() {
  if (_modal) return;
  const active = document.activeElement;
  _prevFocus = active && typeof active.focus === 'function' ? active : null;
  _modal = document.createElement('div');
  _modal.className = 'ff-modal';
  // Reuses the REAL #mergeBtn's own current label (already set for this
  // tool by the time this runs, via config.js's TOOLS.formFields.btn/btns —
  // see app.js's tool-switch flow) rather than a second hardcoded/
  // translated copy that could drift out of sync with it across 15 locales.
  const saveLabel = id('mergeBtn')?.textContent?.trim() || '📝 Add Fields & Download';
  _modal.innerHTML = `
    <div class="ff-modal__card" role="dialog" aria-modal="true" aria-label="${esc(_fileLabel)}">
      <div class="ff-modal__header">
        <p class="ff-modal__title">${esc(_fileLabel)}</p>
        <button type="button" class="ff-modal-close" id="ffModalClose" aria-label="${esc(t('scan_cam_close'))}">✕</button>
      </div>
      <div class="ff-modal__body">${_modalBodyHTML()}</div>
      <div class="ff-modal__footer">
        <button type="button" class="merge-btn" id="ffModalSaveBtn" style="position:static;margin-top:0;">${esc(saveLabel)}</button>
      </div>
    </div>`;
  document.body.appendChild(_modal);
  // Everything else on the page is made inert (and aria-hidden) for as long
  // as the modal is up. Without it a screen-reader / keyboard user can walk
  // straight "behind" the backdrop into the still-focusable page underneath
  // — the backdrop only hides it VISUALLY. Checked first: no other modal in
  // this codebase (.scan-cam-modal, .org-lightbox) does this either, so it's
  // a real pre-existing sitewide gap; fixed properly here, noted for the
  // others rather than half-fixed everywhere.
  _setBackgroundInert(true);
  requestAnimationFrame(() => _modal?.classList.add('ff-modal--open'));

  id('ffModalClose').addEventListener('click', () => _closeModal());
  document.addEventListener('keydown', _onModalKeydown);
  _modal.addEventListener('click', e => { if (e.target === _modal) _closeModal(); });
  // Forwards to the REAL #mergeBtn rather than duplicating its processing
  // wiring — this button's only job is closing the modal out of the way
  // first so the shared progress bar/success card (which live in the main
  // page, not the modal) are visible right away, same as if the user had
  // closed the modal and clicked #mergeBtn directly themselves.
  id('ffModalSaveBtn').addEventListener('click', () => {
    _closeModal({ silent: true });
    id('mergeBtn')?.click();
  });

  _bindEditorRefs();
  _bindEditorEvents();
  // Focus lands inside the modal immediately, on the close button — the
  // conventional "first focusable in the dialog" target, and the one that
  // makes the trap below start from a known point instead of from <body>.
  id('ffModalClose')?.focus();
  await _renderPage(_currentPage);
  _updateCount();
}

// Escape closes; Tab/Shift+Tab is trapped inside the modal. Bound on
// document (not _modal) so it still fires if focus somehow lands outside —
// in which case the first branch pulls it straight back in.
function _onModalKeydown(e) {
  if (e.key === 'Escape') { _closeModal(); return; }
  if (e.key !== 'Tab' || !_modal) return;
  const els = _focusables();
  if (!els.length) return;
  const first  = els[0];
  const last   = els[els.length - 1];
  const active = document.activeElement;
  if (!_modal.contains(active)) { e.preventDefault(); first.focus(); return; }
  if (e.shiftKey && active === first)  { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}

// offsetParent===null filters out display:none entries (the chip group's own
// radios are opacity:0/width:0 but still laid out and still genuinely
// focusable, so they're correctly kept).
function _focusables() {
  if (!_modal) return [];
  return Array.from(_modal.querySelectorAll(FOCUSABLE_SEL))
    .filter(el => el.offsetParent !== null || el === document.activeElement);
}

function _setBackgroundInert(on) {
  if (on) {
    for (const el of Array.from(document.body.children)) {
      if (el === _modal) continue;
      // Never touch (or later clear) something that was already hidden by
      // someone else — only elements this modal itself marked get restored.
      if (el.hasAttribute('inert') || el.getAttribute('aria-hidden') === 'true') continue;
      el.setAttribute('inert', '');
      el.setAttribute('aria-hidden', 'true');
      _inerted.push(el);
    }
  } else {
    for (const el of _inerted) { el.removeAttribute('inert'); el.removeAttribute('aria-hidden'); }
    _inerted = [];
  }
}

// Tears down the modal DOM only — _fields/_pdfDoc state is untouched, so
// reopening (via _triggerHTML's button) resumes exactly where the user
// left off. silent:true skips re-rendering the outer trigger (used when
// the caller is about to overwrite the outer container itself right after,
// e.g. a new file replacing this one, or the whole tool closing).
function _closeModal({ silent = false } = {}) {
  const wasOpen = !!_modal;
  if (_modal) {
    document.removeEventListener('keydown', _onModalKeydown);
    _modal.remove();
    _modal = null;
  }
  _setBackgroundInert(false);
  _wrap = _canvas = _overlay = _countEl = _pageLabel = _btnPrev = _btnNext = null;
  _listEl = _zoomLabel = _btnZoomIn = _btnZoomOut = _btnZoomFit = null;
  if (!silent && _container) {
    _container.innerHTML = _triggerHTML();
    _bindTriggerEvents(_container);
  }
  if (wasOpen) _restoreFocus(silent);
}

// Returning focus to <body> on close is the classic half-done modal — a
// keyboard user is dumped back at the top of the document. Prefer the
// "Continue editing" button that now represents this editor in the outer
// panel (it's the natural place to carry on from, and it's freshly
// re-created by _triggerHTML so a saved reference to the OLD one would be
// stale); fall back to whatever actually had focus when the modal opened.
function _restoreFocus(silent) {
  let target = null;
  if (!silent && _container) target = _container.querySelector('#ffReopenBtn');
  if (!target && _prevFocus && _prevFocus.isConnected) target = _prevFocus;
  _prevFocus = null;
  try { target?.focus(); } catch { /* element became unfocusable — nothing to restore to */ }
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
  // Highlight state for the sidebar's "click an entry to find it on the
  // page" action. Written into the inline style rather than a CSS class
  // because the box's border/background are themselves inline here, and an
  // inline declaration always beats a class — a .ff-field-box--active rule
  // would silently lose. The colors are the same green already used by the
  // box + the site's own --red for nothing else; no new color introduced.
  const active = String(f.id) === String(_activeFieldId);
  const boxBorder = active ? '2px solid #2D7A4F' : '1.5px dashed #2D7A4F';
  const boxBg     = active ? 'rgba(45,122,79,0.22)' : 'rgba(45,122,79,0.10)';
  const boxRing   = active ? 'box-shadow:0 0 0 3px rgba(45,122,79,0.45);' : '';
  return `<div class="ff-field-box${active ? ' ff-field-box--active' : ''}" data-id="${f.id}" style="
      position:absolute;box-sizing:border-box;
      left:${(f.xFrac * 100).toFixed(3)}%; top:${(f.yFrac * 100).toFixed(3)}%;
      width:${(f.wFrac * 100).toFixed(3)}%; height:${(f.hFrac * 100).toFixed(3)}%;
      border:${boxBorder}; background:${boxBg}; ${boxRing}
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

function _bindEditorRefs() {
  _wrap      = id('ffCanvasWrap');
  _canvas    = id('ffCanvas');
  _overlay   = id('ffOverlay');
  _countEl   = id('ffCount');
  _pageLabel = id('ffPageLabel');
  _btnPrev   = id('ffPrevBtn');
  _btnNext   = id('ffNextBtn');
  _listEl    = id('ffFieldList');
  _zoomLabel = id('ffZoomLabel');
  _btnZoomIn = id('ffZoomInBtn');
  _btnZoomOut= id('ffZoomOutBtn');
  _btnZoomFit= id('ffZoomFitBtn');
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

    // Scale by width only — the modal's own #ffCanvasScroll (class
    // ff-modal__stage) flex-fills whatever vertical space the modal has
    // left after its header/footer (see css/components.css) and handles
    // overflow via plain CSS scroll, so there's no JS-computed height cap
    // to fight here at all. This file used to carry several rounds of
    // scroll-position-tracking height math for exactly this purpose, back
    // when the canvas rendered inline in the page's own scroll flow next
    // to a sticky process button — see form_field_creation_tool_2026_09
    // memory for that history — all now moot inside a dedicated modal.
    // The user's zoom multiplier layers straight on top of the fit-to-width
    // scale and nothing else changes: fields are stored as xFrac/yFrac/
    // wFrac/hFrac (page fractions, not pixels) and positioned in CSS
    // percentages of the wrap, so they follow any render scale for free —
    // there is deliberately no placement math to adjust here. The existing
    // maxCss clamp below (a real canvas-pixel-limit guard, not a UX choice)
    // still applies AFTER the multiplier, so zooming can never push the
    // backing canvas past MAX_DIMENSION.
    let cssScale = Math.min(1, areaW / baseVp.width) * ZOOM_STEPS[_zoomIdx];

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
    _updateZoomUI();

    _renderOverlayFields();
    _renderFieldList();
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

// ── Zoom ───────────────────────────────────────────────────────

function _updateZoomUI() {
  if (_zoomLabel) _zoomLabel.textContent = `${Math.round(ZOOM_STEPS[_zoomIdx] * 100)}%`;
  if (_btnZoomOut) _btnZoomOut.disabled = _zoomIdx <= 0;
  if (_btnZoomIn)  _btnZoomIn.disabled  = _zoomIdx >= ZOOM_STEPS.length - 1;
  if (_btnZoomFit) _btnZoomFit.disabled = _zoomIdx === ZOOM_FIT_IDX;
}

function _setZoom(nextIdx) {
  const clamped = Math.min(Math.max(0, nextIdx), ZOOM_STEPS.length - 1);
  if (clamped === _zoomIdx) return;
  _zoomIdx = clamped;
  _renderPage(_currentPage);
}

// ── Field list sidebar ─────────────────────────────────────────

// Lists fields across ALL pages, not just the current one — the whole point
// is navigating a many-field document without hunting, and a per-page list
// would still leave the user paging around to find something.
function _renderFieldList() {
  if (!_listEl) return;
  if (_fields.length === 0) {
    _listEl.innerHTML = `<p class="ff-fieldlist__empty">${esc(t('formfields_fieldlist_empty'))}</p>`;
    return;
  }
  _listEl.innerHTML = _fields.map(f => {
    const typeLabel = f.type === 'checkbox' ? t('formfields_type_checkbox') : t('formfields_type_text');
    const isActive  = String(f.id) === String(_activeFieldId);
    return `<button type="button" class="ff-fieldlist__item${isActive ? ' ff-fieldlist__item--active' : ''}"
        data-id="${f.id}"${isActive ? ' aria-current="true"' : ''}>
      <span class="ff-fieldlist__name" data-id="${f.id}">${esc(f.name)}</span>
      <span class="ff-fieldlist__meta">${esc(typeLabel)} · ${esc(t('formfields_fieldlist_page', { n: f.page }))}</span>
    </button>`;
  }).join('');
}

// Sidebar entry → find that field on the canvas. Switches page first if the
// field lives on a different one (via the same _renderPage the page-nav
// buttons use — no second code path).
async function _revealField(fieldId) {
  const f = _fields.find(x => String(x.id) === String(fieldId));
  if (!f) return;
  _activeFieldId = f.id;
  if (f.page !== _currentPage) await _renderPage(f.page);
  else { _renderOverlayFields(); _renderFieldList(); }

  const el = _overlay?.querySelector(`.ff-field-box[data-id="${f.id}"]`);
  const scrollEl = id('ffCanvasScroll');
  if (!el || !scrollEl) return;
  // Scroll the modal's OWN stage, not via el.scrollIntoView() — that walks
  // every scrollable ancestor including the document behind the modal, which
  // would move the page underneath the backdrop for no reason.
  const sRect = scrollEl.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  scrollEl.scrollTop  += (eRect.top  + eRect.height / 2) - (sRect.top  + sRect.height / 2);
  scrollEl.scrollLeft += (eRect.left + eRect.width  / 2) - (sRect.left + sRect.width  / 2);
}

// ── Interaction: click-to-place, drag, resize, delete ──────────

function _bindEditorEvents() {
  _btnPrev.addEventListener('click', () => {
    if (_currentPage > 1) _renderPage(_currentPage - 1);
  });
  _btnNext.addEventListener('click', () => {
    if (_currentPage < _pageCount) _renderPage(_currentPage + 1);
  });

  _btnZoomOut.addEventListener('click', () => _setZoom(_zoomIdx - 1));
  _btnZoomIn .addEventListener('click', () => _setZoom(_zoomIdx + 1));
  _btnZoomFit.addEventListener('click', () => _setZoom(ZOOM_FIT_IDX));

  _listEl.addEventListener('click', e => {
    const item = e.target.closest('.ff-fieldlist__item');
    if (item) _revealField(item.dataset.id);
  });

  // Only affects the NEXT placed field — no re-render needed, same as
  // watermarkUI.js's wmKind handler for a mode that doesn't change
  // anything already on screen. Bound on _modal (not the outer _container,
  // which no longer holds this markup — see _openModal).
  _modal.addEventListener('change', e => {
    if (e.target.name === 'ffType') {
      _fieldType = e.target.value;
      _modal.querySelectorAll('[data-name="ffType"]').forEach(el =>
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
    if (!f) return;
    f.name = e.target.value;
    // Update just this entry's label rather than re-rendering the whole
    // list on every keystroke — a full _renderFieldList() here would also
    // destroy and recreate the button the user may be about to click.
    const label = _listEl?.querySelector(`.ff-fieldlist__name[data-id="${f.id}"]`);
    if (label) label.textContent = f.name;
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
  if (String(_activeFieldId) === String(fieldId)) _activeFieldId = null;
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

// The single place "the set of fields changed" is announced — place,
// delete and first render all route through here, so the sidebar list stays
// in lockstep with the count without a second set of call sites to keep
// in sync.
function _updateCount() {
  _renderFieldList();
  if (!_countEl) return;
  const n = _fields.length;
  _countEl.textContent = n === 0 ? '' : tp(n, 'formfields_count_one', 'formfields_count_many', { n });
}
