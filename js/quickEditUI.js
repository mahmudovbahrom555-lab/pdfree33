// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  quickEditUI.js — "Quick Edit PDF": fix a typo/small text change inside
//  a PDF entirely client-side, by round-tripping through this site's own
//  PDF->DOCX (pdf2word) and DOCX->PDF (docx2pdf) engines with an editing
//  step spliced in between.
//
//  See /Users/murodjon/.claude/plans/typed-plotting-wave.md for the full
//  design rationale — short version: docxToPdfCore.js's DOCX->PDF pipeline
//  already works by rendering a .docx into a real HTML DOM (docx-preview)
//  then WALKING that live DOM to build the output PDF, so editing the DOM
//  before the walk is sufficient to edit the final PDF. Full contenteditable
//  is unsafe (the walk parser depends on exact DOM shapes — direct-child
//  <span> runs, specific heading/list classes, :scope > td/p table
//  structure) — editing is constrained to per-run TEXT-ONLY edits, added in
//  a later stage (_bindEditableSpans). This file, as it stands, is Stage 2
//  of that plan: a READ-ONLY preview modal only — renders the DOCX and
//  shows it, no editing wired up yet.
//
//  Modal pattern mirrors js/formFieldsUI.js's proven .ff-modal subsystem
//  (full-viewport, inert/aria-hidden background while open, Escape/
//  backdrop-click close, focus trap) almost line-for-line — see that file
//  for the fuller rationale on each piece. The one structural difference:
//  the modal body holds the REAL container renderDocxToDom() rendered into
//  (moved via appendChild, not re-rendered), not a canvas.
// ============================================================

import { id, esc }                     from './utils.js';
import { setButtonDisabled }            from './ui.js';
import { loadPdfJs }                    from './pdf2jpgUI.js';
import { renderDocxToDom }              from './docxToPdfCore.js';
import { _buildPdf2WordDocxBlob }       from './processor.js';
// t()/showToast() land in Stage 5 (i18n + Atlas-gate copy) — no in-modal
// user-facing strings are localized yet, this stage is functional
// scaffolding only.

// Focus-trap selector — same standard set formFieldsUI.js uses.
const FOCUSABLE_SEL = 'a[href], button:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// ── State ──────────────────────────────────────────────────────
let _loading    = false;
let _generation = 0;    // staleness guard, same pattern as formFieldsUI.js
let _container  = null; // the outer #quickEditOptions panel
let _fileLabel  = '';
let _docContainer = null; // the live docx-preview render target — lives INSIDE the modal while open
let _modal      = null;
let _prevFocus  = null;
let _inerted    = [];

// ── Public API ────────────────────────────────────────────────

export function initQuickEditOptions(file) {
  const el = id('quickEditOptions');
  if (!el) return;
  el.style.display = '';
  if (!file) { el.innerHTML = ''; _closeModal({ silent: true }); return; }
  _prepareAndRender(file, el);
}

export function getQuickEditParams() {
  return {
    loading:        _loading,
    hasOpened:      !!_docContainer,
    editedContainer: _docContainer,
  };
}

export function hideQuickEditOptions() {
  const el = id('quickEditOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  _closeModal({ silent: true });
  _loading = false;
  _fileLabel = '';
  _docContainer = null;
  _generation++;
  _container = null;
}

// ── Trigger / spinner / error views (outer panel, behind the modal) ──

function _spinnerHTML(msg) {
  return `<div style="padding:24px 16px;text-align:center;color:var(--text3);font-size:14px;">
    <div style="font-size:24px;margin-bottom:8px;">⏳</div>${esc(msg)}</div>`;
}

function _errorHTML(msg) {
  return `<div style="padding:16px;border:1px solid #fca5a5;border-radius:10px;background:#fff1f2;color:#dc2626;font-size:13px;">
    ${esc(msg)}
  </div>`;
}

// Shown in the outer options panel — behind the modal while it's briefly
// building, and again if the user closes the modal without processing.
function _triggerHTML() {
  return `
    <div style="padding:16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);text-align:center;">
      <p style="margin:0 0 10px;font-size:13px;color:var(--text3);word-break:break-word;">
        ${esc(_fileLabel)}
      </p>
      <button type="button" id="qeReopenBtn" class="split-action-btn">Continue editing</button>
    </div>`;
}

function _bindTriggerEvents(container) {
  container.querySelector('#qeReopenBtn')?.addEventListener('click', () => _openModal());
}

// ── Build: PDF -> DOCX blob (reusing pdf2word's own engine, text mode
// only — image mode has no text runs to click-edit) -> render for preview ──

async function _prepareAndRender(file, container) {
  _loading = true;
  const myGen = ++_generation;
  _closeModal({ silent: true }); // a new file replaces any editor already open for a previous one
  container.innerHTML = _spinnerHTML('Converting to an editable form…');

  try {
    // _buildPdf2WordDocxBlob expects window.pdfjsLib to already be loaded
    // by its caller (same contract pdf2wordUI.js's own initPdf2WordOptions
    // follows) — it only checks for it, doesn't load it itself.
    await loadPdfJs();
    if (myGen !== _generation) return;

    // Reuses pdf2word's own conversion engine — text mode only, since
    // image mode produces no text runs to click-edit at all (Atlas ERI
    // scoring is also mode==='text'-only, matching processor.js's own
    // gate). Stage 2 scope: build the DOCX blob, render it for preview —
    // no Atlas gate UI yet (Stage 5), no click-to-edit yet (Stage 3).
    const { blob } = await _buildPdf2WordDocxBlob(file, {
      mode: 'text',
      onProgress:  () => {},
      isCancelled: () => myGen !== _generation,
    });
    if (myGen !== _generation) return;

    // Off-screen render target, moved into the modal's stage once built —
    // same "caller owns the container" contract renderDocxToDom documents.
    // MUST be attached to document.body (off-screen, not display:none)
    // before renderAsync runs: docx-preview needs real layout to compute
    // column/measurement CSS — same reasoning docxToPdfCore.js's own
    // off-screen container comment documents, confirmed the hard way here
    // (renderAsync hangs indefinitely against a detached node instead of
    // erroring, so a timeout would have looked like a mystery hang without
    // this fix, not a clean failure).
    const docContainer = document.createElement('div');
    docContainer.className = 'docx-preview-target';
    docContainer.style.cssText = 'position:absolute; top:-99999px; left:-99999px; width:800px;';
    document.body.appendChild(docContainer);
    await renderDocxToDom(blob, docContainer, { isCancelled: () => myGen !== _generation });
    if (myGen !== _generation) { docContainer.remove(); return; }
    // Un-off-screen it now that render is done — the modal's own stage
    // gives it real, on-screen layout from here on.
    docContainer.style.cssText = '';

    _loading    = false;
    _fileLabel  = file.name;
    _container  = container;

    container.innerHTML = _triggerHTML();
    _bindTriggerEvents(container);
    await _openModal(docContainer);
  } catch (err) {
    if (myGen !== _generation) return;
    _loading = false;
    container.innerHTML = _errorHTML(err.message);
    setButtonDisabled();
  }
}

// ── Full-viewport modal (mirrors js/formFieldsUI.js's _openModal almost
// line-for-line — see that file for the fuller rationale on each piece) ──

async function _openModal(docContainer) {
  if (_modal) return;
  const active = document.activeElement;
  _prevFocus = active && typeof active.focus === 'function' ? active : null;
  _modal = document.createElement('div');
  _modal.className = 'qe-modal';
  _modal.innerHTML = `
    <div class="qe-modal__card" role="dialog" aria-modal="true" aria-label="${esc(_fileLabel)}">
      <div class="qe-modal__header">
        <p class="qe-modal__title">${esc(_fileLabel)}</p>
        <button type="button" class="qe-modal-close" id="qeModalClose" aria-label="Close">✕</button>
      </div>
      <p class="qe-modal__hint">Preview — click-to-edit lands in a follow-up stage.</p>
      <div class="qe-modal__stage" id="qeModalStage"></div>
      <div class="qe-modal__footer">
        <button type="button" class="merge-btn" id="qeModalSaveBtn" style="position:static;margin-top:0;">Save Edited PDF</button>
      </div>
    </div>`;
  document.body.appendChild(_modal);
  _setBackgroundInert(true);
  requestAnimationFrame(() => _modal?.classList.add('qe-modal--open'));

  id('qeModalClose').addEventListener('click', () => _closeModal());
  document.addEventListener('keydown', _onModalKeydown);
  _modal.addEventListener('click', e => { if (e.target === _modal) _closeModal(); });
  // Stage 2: no real Save wiring yet (that's Stage 4) — placeholder only.
  id('qeModalSaveBtn').addEventListener('click', () => {
    _closeModal({ silent: true });
  });

  // On first open (called from _prepareAndRender), docContainer is the
  // freshly-rendered target. On reopen (the "Continue editing" trigger),
  // it's called with no argument — fall back to the one already built and
  // saved in module state, so reopening resumes the SAME live DOM (and any
  // edits already made to it, once Stage 3 lands) rather than re-rendering
  // from scratch.
  const target = docContainer || _docContainer;
  if (target) {
    id('qeModalStage').appendChild(target);
    _docContainer = target;
    _fitDocContainerToStage(target);
  }

  id('qeModalClose')?.focus();
}

// docx-preview renders `.docx-wrapper > section.docx` at the page's own
// real width (e.g. ~595pt/~793px for A4) — a fixed size, not
// viewport-relative. On a real mobile viewport (confirmed empirically,
// not assumed: a 390px-wide screenshot showed the title/paragraphs
// truncated on both edges, requiring horizontal scroll to read a single
// line) that overflows the stage badly. Scale the whole rendered section
// down to fit the stage's available width — same "fit to width" idea
// `.qe-modal__stage`'s `overflow:auto` already allows scrolling past, just
// applied as a default so the common case doesn't NEED scrolling sideways
// to read a line of body text. Computed once per modal-open (not on
// resize) — a deliberately simple v1, not a full responsive re-layout.
function _fitDocContainerToStage(container) {
  const section = container.querySelector('.docx-wrapper > section.docx');
  const stage   = id('qeModalStage');
  if (!section || !stage) return;
  const sectionWidth = section.getBoundingClientRect().width;
  const stageWidth   = stage.getBoundingClientRect().width - 32; // minus .qe-modal__stage's own padding
  if (sectionWidth <= 0 || stageWidth <= 0) return;
  const scale = Math.min(1, stageWidth / sectionWidth);
  const wrapper = container.querySelector('.docx-wrapper');
  if (!wrapper) return;
  wrapper.style.transform       = scale < 1 ? `scale(${scale})` : '';
  wrapper.style.transformOrigin = 'top center';
  // Scaling via CSS transform doesn't shrink the element's own layout box
  // (the stage would still reserve/scroll the UNSCALED height) — compensate
  // so the visible content doesn't leave a tall dead-space gap below it.
  if (scale < 1) {
    const rect = wrapper.getBoundingClientRect();
    wrapper.style.marginBottom = `${-rect.height * (1 - scale)}px`;
  }
}

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

function _focusables() {
  if (!_modal) return [];
  return Array.from(_modal.querySelectorAll(FOCUSABLE_SEL))
    .filter(el => el.offsetParent !== null || el === document.activeElement);
}

function _setBackgroundInert(on) {
  if (on) {
    for (const el of Array.from(document.body.children)) {
      if (el === _modal) continue;
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

function _closeModal({ silent = false } = {}) {
  const wasOpen = !!_modal;
  if (_modal) {
    document.removeEventListener('keydown', _onModalKeydown);
    _modal.remove();
    _modal = null;
  }
  _setBackgroundInert(false);
  if (!silent && _container) {
    _container.innerHTML = _triggerHTML();
    _bindTriggerEvents(_container);
  }
  if (wasOpen) _restoreFocus(silent);
}

function _restoreFocus(silent) {
  let target = null;
  if (!silent && _container) target = _container.querySelector('#qeReopenBtn');
  if (!target && _prevFocus && _prevFocus.isConnected) target = _prevFocus;
  _prevFocus = null;
  try { target?.focus(); } catch { /* element became unfocusable — nothing to restore to */ }
}
