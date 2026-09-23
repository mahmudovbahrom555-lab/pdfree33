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
//  structure) — editing is constrained to per-run TEXT-ONLY edits via
//  _bindEditableSpans (Stage 3, below). Save/walk-to-PDF wiring is Stage 4.
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
let _atlasEri   = null; // {eri, components, findings} from _buildPdf2WordDocxBlob — pre-edit gate
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
  _atlasEri = null;
  _generation++;
  _container = null;
}

// ── Atlas ERI pre-edit gate ──────────────────────────────────────
// Reuses the SAME verdict thresholds pdf2wordUI.js's own (unexported)
// _atlasVerdict uses (READY>=95/MINOR>=80/NOTABLE>=60/HEAVY<60) — same
// bar, not invented separately. Can't reuse that function directly (not
// exported) or the shared #atlasCheck div (it lives INSIDE #successCard,
// display:none until a real success fires — semantically scoped to
// POST-conversion results, not a pre-edit gate a user needs to see before
// ever clicking anything). Renders the same .atlas-check__* classes
// (css/components.css, already theme-aware) inline in this tool's own
// options panel instead.
function _atlasVerdict(eri) {
  if (eri >= 95) return { key: 'ready',   label: 'Ready' };
  if (eri >= 80) return { key: 'minor',   label: 'Minor issues' };
  if (eri >= 60) return { key: 'notable', label: 'Notable issues' };
  return { key: 'heavy', label: 'Heavy issues' };
}

// Below HEAVY, block entirely rather than let the user into an editor with
// no power to fix what's already wrong. Deliberately DIFFERENT from
// pdf2word's own leniency (pdf2word ships a full .docx the user can fix by
// hand in Word; Quick Edit's only recovery power is "retype text inside a
// run" — it can't repair a mis-split paragraph or a lost table row, so
// shipping a PDF built from an already-HEAVY conversion would silently
// bake in corruption the constrained editor can't fix and the user never
// even sees).
const _ATLAS_BLOCK_THRESHOLD = 60;

function _atlasSummaryHTML(atlasEri) {
  if (!atlasEri || atlasEri.error) return '';
  const v = _atlasVerdict(atlasEri.eri);
  return `
    <div class="atlas-check" style="border-top:none;padding:0 0 12px;text-align:left;">
      <div class="atlas-check__header">
        <span class="atlas-check__title">Structural check</span>
        <span class="atlas-check__badge atlas-check__badge--${v.key}">${Math.round(atlasEri.eri)}% ${esc(v.label)}</span>
      </div>
    </div>`;
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

// Shown when the source PDF's structure survived the PDF->DOCX step too
// poorly to safely enter the constrained editor at all — see
// _ATLAS_BLOCK_THRESHOLD's own comment for why this is stricter than
// pdf2word's own no-blocking policy.
function _blockedHTML(atlasEri) {
  const v = _atlasVerdict(atlasEri.eri);
  return `
    <div style="padding:16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);">
      <div class="atlas-check" style="border-top:none;padding:0 0 10px;">
        <div class="atlas-check__header">
          <span class="atlas-check__title">Structural check</span>
          <span class="atlas-check__badge atlas-check__badge--${v.key}">${Math.round(atlasEri.eri)}% ${esc(v.label)}</span>
        </div>
      </div>
      <p style="margin:0;font-size:13px;color:var(--text3);line-height:1.5;">
        This PDF's structure didn't convert cleanly enough for Quick Edit's
        constrained editor to safely fix. Try
        <a href="/pdf-to-word/" style="color:var(--green-text);">PDF to Word</a>
        instead — it gives you a full, freely-editable document.
      </p>
    </div>`;
}

// Shown in the outer options panel — behind the modal while it's briefly
// building, and again if the user closes the modal without processing.
function _triggerHTML() {
  return `
    <div style="padding:16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);text-align:center;">
      ${_atlasSummaryHTML(_atlasEri)}
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
  _atlasEri = null;
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
    // gate). This whole build+render step can genuinely exceed 1-2s on a
    // real document (Doherty Threshold, CLAUDE.md's UX checklist item 6)
    // — real progress text, not a static spinner message.
    const { blob, atlasEri } = await _buildPdf2WordDocxBlob(file, {
      mode: 'text',
      onProgress:  (pct, label) => {
        if (myGen === _generation) container.innerHTML = _spinnerHTML(label || 'Converting to an editable form…');
      },
      isCancelled: () => myGen !== _generation,
    });
    if (myGen !== _generation) return;
    _atlasEri = atlasEri;

    // Atlas gate: block entirely below the HEAVY threshold — see
    // _ATLAS_BLOCK_THRESHOLD's own comment for why this is stricter than
    // pdf2word's own leniency. Never blocks on a scoring FAILURE (atlasEri
    // null/errored) — best-effort scoring, same posture processor.js's own
    // Atlas call already takes; only an ACTUAL low score blocks.
    if (atlasEri && !atlasEri.error && atlasEri.eri < _ATLAS_BLOCK_THRESHOLD) {
      _loading = false;
      container.innerHTML = _blockedHTML(atlasEri);
      setButtonDisabled();
      return;
    }

    container.innerHTML = _spinnerHTML('Rendering preview…');

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
      <p class="qe-modal__hint">Click any line of text to edit it.</p>
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
  // Forwards to the REAL #mergeBtn rather than duplicating its processing
  // wiring — closes the modal first so the shared progress bar/success
  // card (which live in the main page, invisible while the modal covers
  // it) are visible the instant processing starts. Exact same pattern
  // formFieldsUI.js's own #ffModalSaveBtn uses. If an edit is still
  // in-progress (span focused, not yet blurred), commit it first — the
  // walk needs the FINAL text, not whatever was mid-edit.
  id('qeModalSaveBtn').addEventListener('click', () => {
    if (_activeEditSpan) _commitEdit(_activeEditSpan);
    _closeModal({ silent: true });
    id('mergeBtn')?.click();
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
    // Real bug, found via empirical click-testing (Stage 3): while
    // renderDocxToDom() built `target` off-screen, it was a direct child
    // of document.body (see _prepareAndRender's own comment on why —
    // docx-preview needs real layout). _setBackgroundInert(true) below
    // walks document.body.children and marks everything except the modal
    // itself inert, for the WHOLE background-dimming duration this modal
    // is open — including `target`, since at that exact moment it still
    // looked like ordinary background content, not modal content.
    // Reparenting into qeModalStage (the line above) does NOT clear an
    // already-set `inert` attribute — it just carries the tainted node
    // into a live, interactive subtree, where every descendant span
    // silently stops receiving click/focus events at all (confirmed via
    // document.elementsFromPoint: hit-testing skipped straight past the
    // whole rendered document to the stage div itself). Clear it here,
    // now that `target` genuinely IS inside the modal.
    target.removeAttribute('inert');
    target.removeAttribute('aria-hidden');
    _docContainer = target;
    _fitDocContainerToStage(target);
    // Only bind once per container — reopening (docContainer===undefined,
    // falls back to _docContainer) must NOT re-run this, since the
    // delegated listener + editable-run classes already applied the first
    // time are still intact on the same, never-torn-down DOM node.
    if (docContainer) _bindEditableSpans(target);
  }

  id('qeModalClose')?.focus();
}

// ── Stage 3: constrained per-run click-to-edit ──────────────────
//
// THE core design constraint (see this file's header + the plan doc): only
// a run's TEXT may change, never its class/style/element identity — every
// selector docxToPdfCore.js's walk depends on (direct-child <span> of <p>,
// bold/italic style regex, heading/list classes) must survive untouched.
// contenteditable="plaintext-only" is the browser's own native guarantee
// of exactly that (Chrome/Edge): the node can be typed into, but can never
// gain a child ELEMENT. Firefox/Safari don't support it yet, so those get
// a manual fallback that enforces the same invariant by hand.
const _PLAINTEXT_ONLY_SUPPORTED = (() => {
  try {
    const probe = document.createElement('span');
    probe.contentEditable = 'plaintext-only';
    return probe.contentEditable === 'plaintext-only';
  } catch { return false; }
})();

function _isEditableSpan(span) {
  return span?.tagName === 'SPAN'
    && span.parentElement?.tagName === 'P'
    // Footnote MARKER text (the small superscript reference number) — see
    // docxToPdfCore.js's `docx_footnotereference` class, `_parseRun`'s own
    // `sup` flag. Editing a marker's own text has no sensible meaning
    // (it's not the footnote's content, just its in-line number).
    && !span.classList.contains('docx_footnotereference');
}

// Adds the discoverable-affordance class to every currently-eligible span.
// Called once per fresh render (not on every click) — matches _isEditableSpan
// exactly, so "looks clickable" and "is clickable" never drift apart.
function _markEditableSpans(container) {
  for (const span of container.querySelectorAll('p > span')) {
    if (_isEditableSpan(span)) span.classList.add('qe-editable-run');
  }
}

let _activeEditSpan = null; // the one span currently in edit mode, or null

function _bindEditableSpans(container) {
  _markEditableSpans(container);
  container.addEventListener('click', e => {
    const span = e.target.closest('span');
    if (!_isEditableSpan(span)) return;
    if (span === _activeEditSpan) return; // already editing this one
    _enterEditMode(span);
  });
}

function _enterEditMode(span) {
  if (_activeEditSpan && _activeEditSpan !== span) _commitEdit(_activeEditSpan);

  _activeEditSpan = span;
  span.dataset.qeOriginalText = span.textContent;
  span.classList.add('qe-editable-run--active');

  if (_PLAINTEXT_ONLY_SUPPORTED) {
    span.contentEditable = 'plaintext-only';
  } else {
    // Fallback: plain contenteditable="true" plus explicit enforcement —
    // see this section's header comment for why each layer exists.
    span.contentEditable = 'true';
    span.addEventListener('beforeinput', _onFallbackBeforeInput);
    span.addEventListener('paste', _onFallbackPaste);
    // Last-resort safety net: if any non-text-node child ever appears
    // despite the above (an edge case the explicit handlers didn't
    // anticipate — unusual IME composition, a stray drag-drop), collapse
    // back to plain text immediately rather than let it reach the walk.
    span._qeObserver = new MutationObserver(() => {
      // nodeType 3 === TEXT_NODE (raw literal matches this codebase's own
      // existing convention, see js/eriAnatomy.js's nodeType===1 check).
      if (Array.from(span.childNodes).some(n => n.nodeType !== 3)) {
        // Re-flattening via textContent collapses all child nodes into one
        // plain text node, discarding whatever stray element the mutation
        // observer just caught.
        const flat = span.textContent;
        span.textContent = flat;
      }
    });
    span._qeObserver.observe(span, { childList: true });
  }

  span.addEventListener('keydown', _onEditKeydown);
  span.addEventListener('blur', _onEditBlur);

  span.focus();
  // Place the caret at the click point rather than selecting/resetting to
  // start — matches native text-field click behavior a user expects.
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) { /* leave an active click-drag selection alone */ }
}

function _onEditKeydown(e) {
  if (e.key === 'Enter') {
    // Under plaintext-only, Enter is a no-op by the browser's own contract
    // (can't insert a paragraph break) — still explicitly blur to commit,
    // for a consistent "Enter commits" UX under BOTH code paths.
    e.preventDefault();
    e.stopPropagation(); // see the Escape branch's comment below — same bug class
    e.target.blur();
  } else if (e.key === 'Escape') {
    // Real bug, found via empirical testing: Escape here is meant to
    // cancel just THIS edit — but this listener is bound on the span
    // itself, and keydown BUBBLES. _onModalKeydown (bound on `document`,
    // for the modal's own Escape-to-close shortcut) was ALSO firing for
    // the exact same keypress, closing the entire modal out from under an
    // in-progress edit (confirmed: the whole #qeModalStage vanished
    // immediately after pressing Escape while editing). preventDefault()
    // alone only blocks the browser's own default action, not propagation
    // to other listeners — stopPropagation() is the piece that was missing.
    e.preventDefault();
    e.stopPropagation();
    const span = e.target;
    span.textContent = span.dataset.qeOriginalText ?? span.textContent;
    span.blur();
  }
}

function _onFallbackBeforeInput(e) {
  if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
    e.preventDefault();
  }
}

function _onFallbackPaste(e) {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, text);
}

function _onEditBlur(e) {
  _commitEdit(e.target);
}

// Empty guard: _parseRun (docxToPdfCore.js) returns null for an empty span
// and parseParagraph silently filters nulls — an emptied run wouldn't
// crash anything, it would just silently VANISH from the output PDF. That
// is exactly the "silent no-op" CLAUDE.md's UX rule warns against — block
// it here (revert to the original text) rather than let it through quietly.
function _commitEdit(span) {
  if (!span) return;
  if (span.textContent.trim() === '') {
    span.textContent = span.dataset.qeOriginalText || '';
  }
  span.removeAttribute('contenteditable');
  span.classList.remove('qe-editable-run--active');
  span.removeEventListener('keydown', _onEditKeydown);
  span.removeEventListener('blur', _onEditBlur);
  span.removeEventListener('beforeinput', _onFallbackBeforeInput);
  span.removeEventListener('paste', _onFallbackPaste);
  if (span._qeObserver) { span._qeObserver.disconnect(); span._qeObserver = null; }
  delete span.dataset.qeOriginalText;
  if (_activeEditSpan === span) _activeEditSpan = null;
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
