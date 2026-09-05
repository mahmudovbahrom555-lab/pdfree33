// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors
//
// ── readUI.js ──────────────────────────────────────────────────────────────
// "Read PDF" — live in-browser reflow reading view. Self-managed tool (see
// SELF_MANAGED_TOOLS in app.js), same shape as compare-pdf: no js/worker.js,
// no runner in the registry, owns its own container end to end. Unlike
// compare, there's nothing to configure before showing a result, so this
// auto-runs the instant a file loads (mirrors pdf2pdfaUI's own precedent —
// #mergeBtn is hidden entirely, not bound).
//
// Reuses pdf2word's own page-data extraction (_p2wBuildPageData) and a new
// sibling of pdf2ppt's _p2pBuildSlideShapes — _rpBuildPageBlocks — which
// applies the exact same heading/list/table/column detectors already proven
// twice (pdf2word, pdf2ppt) but emits plain reading blocks instead of
// PPTX shapes or docx.js objects. Both now live in js/pdf2readCore.js (moved
// out of processor.js so packages/pdf2read-core/ can reuse them in Node) —
// see that file's own comments for the detection heuristics themselves.

import { loadPdfJs } from './pdf2jpgUI.js';
import { id, esc } from './utils.js';
import { _p2pCropCanvasRegion, _setProcessingFlag } from './processor.js';
import { _p2wBuildPageData, _rpBuildPageBlocks } from './pdf2readCore.js';
import { t } from './i18n.js';
import { setProgress, hideProgress, showCancelBtn, hideCancelBtn, showToast } from './ui.js';

const RENDER_SCALE = 1.5; // matches compareUI's own canvas render scale

let _file        = null;
let _generation   = 0; // bumped on every new file load or close — lets an in-flight
                        // run (still awaiting mid-pipeline) detect it's been superseded
                        // and bail instead of racing its results into the shared
                        // #readOptions container on top of a newer file. Same pattern
                        // already used by ocrUI.js/fillUI.js for the same real bug class.
let _resolvePw    = null;
let _fontScale    = 1.15; // starting size — deliberately larger than a normal paragraph default

// ── Reading mode (distraction-free full-screen) ─────────────────────────
// null | 'native' (real Fullscreen API) | 'pseudo' (same-page fixed-overlay
// fallback for iOS Safari and any other context that denies fullscreen).
// Single source of truth for whether reading mode is active AND which path,
// doubling as a re-entrancy guard in _enterReadingMode.
let _fsMode      = null;
let _fsHintShown = false; // rate-limits the "press Esc / tap X" hint to once per session

// Verbatim copies of js/theme.js's own MOON/SUN icons (same visual language)
// — duplicated, not imported, because theme.js is a plain synchronous
// <script> (deliberately not a module, to avoid flash-of-unstyled-content —
// see that file's own header comment) and can't export anything.
const _MOON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const _SUN  = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>';
const _EXPAND = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';

export function getReadParams() {
  return { hasFile: !!_file };
}

// Wired as this tool's `cancel` registry hook (see toolRegistry.js's own
// comment on that field) — app.js's shared #cancelBtn click handler calls
// this INSTEAD of cancelProcess() while Read is the active tool, since
// cancelProcess() only knows how to stop the shared js/worker.js pipeline,
// which Read never uses. Bumping _generation is what actually makes the
// in-flight _runRead() bail at its next checkpoint (see that function).
export function cancelRead() {
  _exitReadingMode();
  _generation++;
  hideCancelBtn();
  hideProgress();
  _setProcessingFlag(false);
  showToast(t('cancelled'));
  const el = id('readOptions');
  if (el) el.innerHTML = _cancelledHtml();
}

export function hideReadOptions() {
  _exitReadingMode();
  _generation++;
  if (_resolvePw) { _resolvePw(null); _resolvePw = null; }
  const el = id('readOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  const btn = id('mergeBtn');
  if (btn) btn.style.display = '';
  _file = null;
  _setProcessingFlag(false);
}

export async function initReadOptions(file) {
  const el = id('readOptions');
  if (!el) return;
  _exitReadingMode(); // a replaced file's container is about to be wiped below
  el.style.display = '';
  _file      = file;
  const myGen = ++_generation; // toolRegistry may call initReadOptions again for a
                                // replaced file without ever calling hideReadOptions
                                // first — this generation bump is what actually
                                // invalidates the still-running previous call.

  const btn = id('mergeBtn');
  if (btn) btn.style.display = 'none';

  el.innerHTML = _loadingHtml();
  // Spans the WHOLE pipeline (pdf load + extraction + per-page render loop),
  // not just the extraction step — cancelRead() and this tool's `cancel`
  // registry hook both rely on isProcessing/#cancelBtn being accurate for
  // as long as _runRead() can still be usefully interrupted.
  _setProcessingFlag(true);
  showCancelBtn();
  try {
    await _runRead(el, myGen);
  } catch (err) {
    // Superseded by a newer run, or the user dismissed the password prompt
    // (its own onCancel rejects with this exact message) — either way, not
    // a real error worth showing; leave whatever's already on screen.
    if (myGen !== _generation || err?.message === 'cancelled') return;
    _exitReadingMode(); // reachable if page.render()/getPage() throws after _renderShell ran
    el.innerHTML = _errorHtml(err?.message);
  } finally {
    // Only the run that's still current tears down shared UI state — a
    // superseded run's finally must not hide the cancel button / flip
    // isProcessing off out from under the newer run that replaced it.
    if (myGen === _generation) {
      _setProcessingFlag(false);
      hideCancelBtn();
    }
  }
}

// ── Main pipeline ────────────────────────────────────────────────────────

async function _runRead(container, myGen) {
  await loadPdfJs();
  if (myGen !== _generation) return;

  const buf = await _file.arrayBuffer();
  const pdfDoc = await new Promise((resolve, reject) => {
    const task = window.pdfjsLib.getDocument({
      isEvalSupported: false,
      data:              new Uint8Array(buf),
      verbosity:         0,
      disableJavaScript: true,
      onPassword: (updateCallback, reason) => {
        _promptPassword(_file?.name || '', reason,
          pw => updateCallback(pw),
          ()  => { task.destroy(); reject(new Error('cancelled')); }
        );
      },
    });
    task.promise.then(resolve).catch(err => {
      if (myGen !== _generation) { reject(new Error('cancelled')); return; }
      reject(err);
    });
  });
  if (myGen !== _generation) return;

  // isProcessing/#cancelBtn are already set for the whole pipeline by the
  // caller (initReadOptions) — _p2wBuildPageData's own cancellation comes
  // from the injected isCancelled callback below, wired to this run's own
  // captured generation.
  let pageData, median, repeatTextSet, repeatPatternSet;
  ({ pageData, median, repeatTextSet, repeatPatternSet } = await _p2wBuildPageData(pdfDoc, {
    onProgress:  (pct, label) => { if (myGen === _generation) setProgress(pct, label); },
    isCancelled: () => myGen !== _generation,
  }));
  if (myGen !== _generation) { pdfDoc.destroy(); return; }

  const perPage = pageData.map(page => _rpBuildPageBlocks(page, median, repeatTextSet, repeatPatternSet));
  const anyText = perPage.some(p => p.blocks.length > 0);

  if (!anyText) {
    container.innerHTML = _emptyStateHtml();
    pdfDoc.destroy();
    hideProgress();
    return;
  }

  _renderShell(container);
  const contentEl = container.querySelector('#readContent');

  for (let i = 0; i < perPage.length; i++) {
    if (myGen !== _generation) { pdfDoc.destroy(); return; }
    const { blocks } = perPage[i];
    if (!blocks.length) continue;

    // Only pages with an actual image block pay the canvas-render cost —
    // same lazy-render-only-when-needed optimization pdf2word's own
    // _p2wRenderAllVisuals uses, not a redundant render for every page.
    let canvas = null, pageHeightPt = pageData[i].pageH;
    if (blocks.some(b => b.type === 'image')) {
      const page = await pdfDoc.getPage(i + 1);
      if (myGen !== _generation) { pdfDoc.destroy(); return; } // getPage() is its own await gap
      const vp   = page.getViewport({ scale: RENDER_SCALE });
      canvas = document.createElement('canvas');
      canvas.width  = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      if (myGen !== _generation) { pdfDoc.destroy(); return; } // render() too — don't write a stale run's canvas into the container below
    }

    for (const block of blocks) {
      contentEl.insertAdjacentHTML('beforeend', _blockHtml(block, canvas, RENDER_SCALE, pageHeightPt));
    }
    if (canvas) { canvas.width = 0; canvas.height = 0; }

    // Yield so the browser can paint what's already rendered — same idiom
    // compareUI's own per-page loop uses.
    await new Promise(r => setTimeout(r, 0));
  }

  pdfDoc.destroy();
  // _p2wBuildPageData()'s own internal setProgress() calls leave the shared
  // progress bar showing its last "Reading page N/M…" label indefinitely —
  // clear it now that the whole reading view has actually finished
  // rendering, not just the extraction pass.
  hideProgress();
}

// ── Password prompt (mirrors compareUI's own, same container-repaint shape) ─

function _promptPassword(filename, reason, onSubmit, onCancel) {
  const container = id('readOptions');
  if (!container) { onCancel(); return; }
  const isRetry   = reason === 2;
  const shortName = filename.length > 32 ? filename.slice(0, 29) + '…' : filename;

  container.innerHTML = `
    <div style="padding:24px 20px;border:1px solid var(--border);border-radius:12px;
      background:var(--surface);max-width:380px;margin:0 auto;text-align:center;">
      <div style="font-size:28px;margin-bottom:10px;">🔒</div>
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:var(--text);">${esc(t('read_password_title'))}</p>
      <p style="margin:0 0 16px;font-size:12px;color:var(--text2);word-break:break-all;">${esc(shortName)}</p>
      ${isRetry ? `
        <div style="margin:0 0 14px;padding:8px 10px;background:var(--red-light,#fdecea);
          border:1px solid var(--red,#c0392b);border-radius:6px;font-size:13px;color:var(--red,#c0392b);">
          ${esc(t('read_password_retry'))}
        </div>` : ''}
      <input id="readPwInput" type="password" placeholder="${esc(t('read_password_placeholder'))}" autocomplete="current-password"
        style="width:100%;box-sizing:border-box;padding:9px 12px;margin-bottom:12px;
          border:1px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit;
          background:var(--bg);color:var(--text);outline:none;text-align:left;">
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="readPwCancel" type="button" style="padding:8px 16px;border:1px solid var(--border);
          border-radius:8px;background:var(--bg);color:var(--text);font-size:13px;font-weight:600;
          cursor:pointer;font-family:inherit;">${esc(t('read_cancel'))}</button>
        <button id="readPwOpen" type="button" style="padding:8px 16px;border:none;border-radius:8px;
          background:var(--green);color:#fff;font-size:13px;font-weight:600;
          cursor:pointer;font-family:inherit;">${esc(t('read_password_open'))}</button>
      </div>
    </div>`;

  const input = container.querySelector('#readPwInput');
  input.focus();
  const submit = () => { const pw = input.value; if (!pw) { input.focus(); return; } onSubmit(pw); };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  container.querySelector('#readPwOpen').addEventListener('click', submit);
  container.querySelector('#readPwCancel').addEventListener('click', onCancel);
}

// ── Reading-view shell + controls ───────────────────────────────────────────

// Recessed icon-button style shared by the reading-mode toggle in the
// sticky header and the mini controls injected once reading mode is
// active (_buildReadingModeChrome) — mirrors .theme-toggle (css/layout.css)
// inline, matching this file's own all-inline-styles convention.
const _ICON_BTN_STYLE = 'width:44px;height:44px;flex-shrink:0;padding:0;display:flex;' +
  'align-items:center;justify-content:center;border:1px solid var(--border);' +
  'border-radius:var(--radius-sm);background:var(--surface2);color:var(--text2);' +
  'cursor:pointer;font-family:inherit;';

function _renderShell(container) {
  container.innerHTML = `
    <div id="readView">
      <div id="readColumn" style="max-width:640px;margin:0 auto;">
        <div style="position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;
          padding:10px 4px;margin-bottom:8px;background:var(--bg);border-bottom:1px solid var(--border);">
          <label for="readFontSlider" style="font-size:12px;color:var(--text2);white-space:nowrap;">${esc(t('read_font_size'))}</label>
          <input id="readFontSlider" type="range" min="0.85" max="2" step="0.05" value="${_fontScale}"
            style="flex:1;min-height:44px;">
          <button id="readFsToggle" type="button" aria-pressed="false"
            title="${esc(t('read_reading_mode'))}" aria-label="${esc(t('read_reading_mode'))}"
            style="${_ICON_BTN_STYLE}">${_EXPAND}</button>
        </div>
        <div id="readContent" style="font-size:${_fontScale}rem;line-height:1.6;color:var(--text);
          padding:4px 4px 40px;word-wrap:break-word;overflow-wrap:break-word;"></div>
      </div>
    </div>`;

  container.querySelector('#readFontSlider').addEventListener('input', e => {
    _fontScale = parseFloat(e.target.value);
    const contentEl = container.querySelector('#readContent');
    if (contentEl) contentEl.style.fontSize = `${_fontScale}rem`;
  });
  container.querySelector('#readFsToggle').addEventListener('click', () => {
    _enterReadingMode(container.querySelector('#readView'));
  });
}

// ── Reading mode (distraction-free full screen) ─────────────────────────
// Real Fullscreen API when it's available — this hides the BROWSER's own
// chrome too (tabs/address bar), not just this site's nav/hero/footer —
// falling back to a same-page fixed overlay ('pseudo') when it isn't: iOS
// Safari never implements Element.requestFullscreen() at all, and some
// embed contexts may deny it. Feature-detected via the actual outcome of
// the request, never UA-sniffing.

function _fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}
function _fsRequest(el) {
  try { return (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el); }
  catch { return null; } // some sandboxed iframe contexts throw synchronously rather than reject
}
function _fsExit() {
  try { return (document.exitFullscreen || document.webkitExitFullscreen)?.call(document); }
  catch { return null; }
}

async function _enterReadingMode(view) {
  if (_fsMode || !view) return; // already active, or the shell isn't rendered (shouldn't happen)
  // Must be the very first thing that happens — Fullscreen API requires a
  // real user gesture on the call stack, so nothing may be awaited before it.
  const req = _fsRequest(view);
  if (req && typeof req.then === 'function') {
    try { await req; } catch { /* rejection just means we fall back below */ }
  } else {
    // No promise at all (old prefixed WebKit, or the API doesn't exist) —
    // give the browser one tick to actually apply it before checking.
    await new Promise(r => setTimeout(r, 0));
  }
  // Verify against real state rather than trusting a bare resolve — some
  // prefixed implementations "succeed" without actually entering fullscreen.
  _fsMode = (_fsElement() === view) ? 'native' : 'pseudo';
  _fsHintShown = false;
  _applyReadingModeStyles(view, _fsMode);
  _buildReadingModeChrome(view);
  document.addEventListener('keydown', _onReadingKeydown);
  document.addEventListener('fullscreenchange', _onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', _onFullscreenChange);
  view.querySelector('#readFsToggle')?.setAttribute('aria-pressed', 'true');
}

// Exactly the properties either mode can set — removed unconditionally on
// exit via removeProperty (a no-op for ones that were never set), rather
// than clobbering the element's style wholesale.
const _RM_STYLE_PROPS = ['background', 'color', 'overflow-y', 'overscroll-behavior',
  '-webkit-overflow-scrolling', 'padding', 'position', 'inset', 'z-index', 'padding-top'];

function _applyReadingModeStyles(view, mode) {
  // position/inset/width/height in native mode come from the browser's own
  // `:fullscreen` UA-stylesheet rules — don't fight them here.
  view.style.setProperty('background', 'var(--bg)');
  view.style.setProperty('color', 'var(--text)');
  view.style.setProperty('overflow-y', 'auto');
  view.style.setProperty('overscroll-behavior', 'contain');
  view.style.setProperty('-webkit-overflow-scrolling', 'touch');
  view.style.setProperty('padding', '0 16px calc(24px + env(safe-area-inset-bottom))');
  if (mode === 'pseudo') {
    view.style.setProperty('position', 'fixed');
    view.style.setProperty('inset', '0');
    view.style.setProperty('z-index', '250'); // above nav(100)/#swUpdateBanner(200), below #toast(300)
    view.style.setProperty('padding-top', 'env(safe-area-inset-top)');
  }
}

function _buildReadingModeChrome(view) {
  const bar = document.createElement('div');
  bar.id = 'readFsBar';
  bar.style.cssText = 'position:fixed;top:calc(10px + env(safe-area-inset-top));' +
    'right:calc(10px + env(safe-area-inset-right));z-index:3;display:flex;gap:8px;';
  bar.innerHTML = `
    <button id="readFsTheme" type="button" style="${_ICON_BTN_STYLE}box-shadow:var(--shadow-lg);"></button>
    <button id="readFsExit" type="button" aria-label="${esc(t('read_exit_reading_mode'))}"
      title="${esc(t('read_exit_reading_mode'))}"
      style="${_ICON_BTN_STYLE}box-shadow:var(--shadow-lg);font-size:18px;">&#10005;</button>`;
  view.appendChild(bar);

  const themeBtn = bar.querySelector('#readFsTheme');
  _readSyncMiniTheme(themeBtn);
  themeBtn.addEventListener('click', () => {
    // Delegates to the real nav toggle (js/theme.js) instead of duplicating
    // its toggle/localStorage logic — zero drift risk, this button only
    // reflects the resulting state afterward.
    document.getElementById('themeToggle')?.click();
    _readSyncMiniTheme(themeBtn);
  });
  bar.querySelector('#readFsExit').addEventListener('click', _exitReadingMode);

  // A separate hint element, NOT the shared #toast: a real fullscreened
  // element is promoted to the browser's top layer, so #toast (outside it)
  // would be invisible in 'native' mode — and re-parenting the shared node
  // in and out risks destroying the site's only toast if the container
  // gets wiped while it's adopted. `.toast` is already a plain, global CSS
  // class (not scoped to the #toast id), so this gets identical styling
  // for free without touching shared state.
  const hint = document.createElement('div');
  hint.id = 'readFsHint';
  hint.className = 'toast';
  view.appendChild(hint);
}

function _readIsDark() {
  return document.documentElement.dataset.theme === 'dark';
}
function _readSyncMiniTheme(btn) {
  if (!btn) return;
  btn.innerHTML = _readIsDark() ? _SUN : _MOON;
  btn.setAttribute('aria-label', _readIsDark() ? 'Switch to light mode' : 'Switch to dark mode');
}

function _onReadingKeydown(e) {
  if (e.target?.id === 'readFontSlider') return; // arrow keys resize the font there, not exit
  if (e.key === 'Escape') {
    // Native mode: the browser already exits on its own (no action needed).
    // Pseudo mode has no native Escape handling at all, so wire it here —
    // otherwise a keyboard user would have zero keyboard way out.
    if (_fsMode === 'pseudo') _exitReadingMode();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'F11'].includes(e.key)) return;
  if (_fsHintShown) return; // once per session — a discoverability nudge, not a nag
  _fsHintShown = true;
  const hint = document.getElementById('readFsHint');
  if (!hint) return;
  hint.textContent = t(_fsMode === 'pseudo' ? 'read_exit_hint_tap' : 'read_exit_hint_esc');
  hint.classList.add('show');
  setTimeout(() => hint.classList.remove('show'), 3000);
}

function _onFullscreenChange() {
  // Fires on native Escape, browser-UI exit, or the element leaving the
  // DOM — any of which means reading mode is no longer really active.
  if (_fsMode === 'native' && _fsElement() !== id('readView')) _exitReadingMode();
}

// The one teardown path — idempotent, called by the exit button, native
// Escape (via _onFullscreenChange), pseudo-mode Escape, and defensively
// from every place that's about to wipe #readOptions's content.
function _exitReadingMode() {
  if (!_fsMode) return;
  const mode = _fsMode;
  _fsMode = null; // null first so the fullscreenchange _fsExit() below triggers is a no-op
  document.removeEventListener('keydown', _onReadingKeydown);
  document.removeEventListener('fullscreenchange', _onFullscreenChange);
  document.removeEventListener('webkitfullscreenchange', _onFullscreenChange);
  document.getElementById('readFsBar')?.remove();
  document.getElementById('readFsHint')?.remove();
  const view = id('readView');
  if (view) {
    for (const prop of _RM_STYLE_PROPS) view.style.removeProperty(prop);
    view.querySelector('#readFsToggle')?.setAttribute('aria-pressed', 'false');
  }
  if (mode === 'native' && _fsElement()) _fsExit()?.catch?.(() => {});
}

// ── Block → HTML ─────────────────────────────────────────────────────────

function _blockHtml(block, canvas, scale, pageHeightPt) {
  const styleFor = (bold, italic) =>
    `${bold ? 'font-weight:700;' : ''}${italic ? 'font-style:italic;' : ''}`;

  switch (block.type) {
    case 'heading':
      return `<h2 style="margin:1.2em 0 .5em;font-size:1.3em;line-height:1.3;${styleFor(block.bold, block.italic)}">${esc(block.text)}</h2>`;

    case 'list-item':
      // Numbered items already carry their own marker text ("1.", "2.5.1.")
      // — no extra bullet glyph needed. Bullet/lettered items had their
      // marker stripped in js/processor.js, so they get a CSS bullet here.
      return `<div style="display:flex;gap:.5em;margin:.4em 0;padding-left:.2em;">
        ${block.ordinal === 'number' ? '' : '<span aria-hidden="true">•</span>'}
        <span style="${styleFor(block.bold, block.italic)}">${esc(block.text)}</span>
      </div>`;

    case 'paragraph':
      return `<p style="margin:0 0 1em;${styleFor(block.bold, block.italic)}">${esc(block.text)}</p>`;

    case 'table': {
      const rows = block.rows.map(row => `<tr>${
        row.map(cell => `<td colspan="${cell.span}" style="border:1px solid var(--border);padding:6px 8px;
          ${cell.bold ? 'font-weight:700;' : ''}vertical-align:top;">${esc(cell.text)}</td>`).join('')
      }</tr>`).join('');
      return `<div style="overflow-x:auto;margin:1em 0;">
        <table style="border-collapse:collapse;width:100%;font-size:.85em;">${rows}</table>
      </div>`;
    }

    case 'image': {
      if (!canvas || !block.region) return '';
      const { x0, x1, y0, y1 } = block.region;
      const xPx = Math.round(x0 * scale);
      const yPx = Math.round((pageHeightPt - y0) * scale);
      const wPx = Math.round((x1 - x0) * scale);
      const hPx = Math.round((y0 - y1) * scale);
      const dataUrl = _p2pCropCanvasRegion(canvas, xPx, yPx, wPx, hPx);
      if (!dataUrl) return '';
      return `<div style="margin:1em 0;text-align:center;">
        <img src="${dataUrl}" alt="" style="max-width:100%;height:auto;border-radius:4px;">
      </div>`;
    }

    default:
      return '';
  }
}

// ── Empty / loading / error states ──────────────────────────────────────────

function _loadingHtml() {
  return `<div style="padding:14px 16px;border:1px solid var(--border);border-radius:10px;
    background:var(--surface);font-size:13px;color:var(--text2);">${esc(t('read_loading'))}</div>`;
}

function _emptyStateHtml() {
  return `<div style="padding:20px 18px;border:1px solid var(--border);border-radius:10px;
    background:var(--surface);text-align:center;">
    <div style="font-size:28px;margin-bottom:8px;">📄</div>
    <p style="margin:0 0 10px;font-size:14px;color:var(--text);font-weight:600;">${esc(t('read_no_text_title'))}</p>
    <p style="margin:0 0 14px;font-size:13px;color:var(--text2);">${esc(t('read_no_text_desc'))}</p>
    <a href="/ocr-pdf/" style="display:inline-block;padding:9px 18px;border-radius:8px;
      background:var(--green);color:#fff;font-size:13px;font-weight:600;text-decoration:none;">${esc(t('read_try_ocr'))}</a>
  </div>`;
}

function _errorHtml(msg) {
  return `<div style="padding:14px 16px;border:1px solid var(--border);border-radius:10px;
    background:var(--surface);font-size:13px;color:var(--text2);">
    ${esc(t('read_error'))}${msg ? `<br><span style="color:var(--text3);font-size:12px;">${esc(msg)}</span>` : ''}
  </div>`;
}

function _cancelledHtml() {
  // Reuses the existing 'cancelled' key (already shown as a toast
  // site-wide by processor.js's own cancelProcess()) rather than adding a
  // new i18n key that would need translating across all 14 locales for
  // a one-line message.
  return `<div style="padding:14px 16px;border:1px solid var(--border);border-radius:10px;
    background:var(--surface);font-size:13px;color:var(--text2);">${esc(t('cancelled'))}</div>`;
}
