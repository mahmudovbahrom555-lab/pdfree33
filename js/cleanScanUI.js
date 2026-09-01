// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  cleanScanUI.js — Clean Scan (whiten scanned-document backgrounds)
//
//  Live before/after preview reuses js/cleanScanWorker.js's REAL
//  'processPage' pipeline (grayscale/background-estimate/threshold-or-
//  enhance) via its own dedicated Worker instance, on a small (~900px)
//  downscaled copy regardless of the export quality setting — same idea
//  as before (small canvas keeps the actual pixel work cheap), but the
//  pixel work itself now runs off the main thread instead of duplicated
//  inline here.
//
//  This replaces an earlier version that duplicated the whole algorithm
//  against a plain <canvas> synchronously on the main thread (same
//  precedent resizeUI.js/resizeWorker.js's duplicated _fitRect still
//  uses for genuinely small functions). That was fine for a cheap
//  function; it wasn't for this one — a real Playwright measurement (4x
//  CPU throttle, rAF heartbeat, same methodology as the scan-document
//  warpToRect fix) found a 920ms single main-thread frame gap on every
//  slider drag, worse than the original scan-document bug. Reusing
//  cleanScanWorker.js's existing off-main-thread 'processPage' handler
//  fixes the jank AND removes the duplicate-algorithm-drift risk in one
//  change — the preview now produces byte-identical output to a real
//  export at preview resolution, since it's literally the same code path.
// ============================================================

import { id, esc }                   from './utils.js';
import { showToast, setButtonDisabled, setButtonReady } from './ui.js';
import { loadingRow, infoBanner }    from './uiComponents.js';
import { loadPdfJs }                 from './pdf2jpgUI.js';
import { TOOLS, getLocalizedTool }   from './config.js';
import { t, tp }                     from './i18n.js';

const PREVIEW_WIDTH = 900;
const PREVIEW_DEBOUNCE_MS = 150; // heavier than watermarkUI's 60ms — this redraw re-runs the whole algorithm, not just a cheap overlay

// ── State ──────────────────────────────────────────────────────

let _mode        = 'clean';    // 'clean' | 'enhance'
let _strength     = 0.5;        // 0..1, nudges the auto (Otsu) baseline
let _quality      = 'standard'; // 'standard' | 'high' — export render scale
let _pageCount    = 0;
let _pdfJsDoc     = null;
let _previewPage  = 1;
let _beforeURL    = null;
let _afterURL     = null;
let _hasColor     = false;
let _looksDigital = false;
let _previewGen   = 0;
let _previewTimer = null;
let _initGen      = 0;   // bumped on every initCleanScanOptions() call — separate from
                          // _previewGen above, which only guards _updatePreview()'s slider-driven
                          // re-renders WITHIN one file's session. Real bug found+confirmed via
                          // Playwright: swap files quickly and _pdfJsDoc could end up holding the
                          // FIRST file's document while the filename label (passed as a plain
                          // argument to _render(), unaffected by this race) correctly showed the
                          // second file's name — label and preview image visibly contradicting
                          // each other. _runCleanScan() (processor.js) re-reads the file fresh from
                          // its own filesSnapshot at click time, so the actual EXPORTED output was
                          // never wrong here — same "misleading preview only" class as resize's
                          // 1ee544a9, not meta's/redact's worse "wrong data" class.

// ── Public API ─────────────────────────────────────────────────

export function getCleanScanParams() {
  return {
    mode:     _mode,
    strength: _strength,
    scale:    _quality === 'high' ? 3 : 2,
    hasFile:  !!_pdfJsDoc,
    pageCount: _pageCount,
  };
}

export async function initCleanScanOptions(file) {
  const container = id('cleanScanOptions');
  if (!container) return;
  if (!file) { container.innerHTML = ''; return; }

  // Captured before any await — see _initGen's own comment (state block above).
  const gen = ++_initGen;

  container.innerHTML = loadingRow(t('cs_loading'));
  container.style.display = 'block';

  // Disabled for the duration of PDF loading/parsing — otherwise a click
  // during this ~1s window falls through to the validate() error toast
  // ("please wait a moment") instead of simply being unavailable to click.
  // Deferred to a microtask: files.js dispatches 'pdfree:files-added'
  // (which synchronously reaches this point via the tool registry) and
  // THEN calls renderList() right after on the same call stack —
  // renderList()'s _updateMeta() unconditionally re-enables mergeBtn
  // based on file count alone, with no awareness of a tool's own async
  // loading state. Disabling synchronously here would just get
  // overwritten a few lines later in files.js; queueing it instead
  // guarantees this runs after that synchronous chain finishes.
  queueMicrotask(() => setButtonDisabled());

  try {
    await loadPdfJs();
    if (gen !== _initGen) return;
    const buf = await file.arrayBuffer();
    if (gen !== _initGen) return;
    const newDoc = await window.pdfjsLib.getDocument({ isEvalSupported: false,
      data: new Uint8Array(buf), disableWorker: true,
    }).promise;
    if (gen !== _initGen) return;
    _pdfJsDoc = newDoc;

    _pageCount = _pdfJsDoc.numPages;
    if (_pageCount === 0) { showToast(t('no_pages_pdf')); _hide(container); return; }

    _previewPage = 1;
    await _checkLooksDigital();
    if (gen !== _initGen) return;
    _render(file);
    setButtonReady(getLocalizedTool(TOOLS.cleanScan).btn);
    await _updatePreview();
  } catch (err) {
    if (gen !== _initGen) return;
    showToast(t('cs_err_load', { msg: err.message }), 5000);
    _hide(container);
  }
}

export function hideCleanScanOptions() {
  _initGen++; // invalidate any in-flight initCleanScanOptions() call
  _cleanup();
  const container = id('cleanScanOptions');
  if (container) { container.style.display = 'none'; container.innerHTML = ''; }
  _mode = 'clean'; _strength = 0.5; _quality = 'standard';
  _pageCount = 0; _pdfJsDoc = null; _previewPage = 1;
  _hasColor = false; _looksDigital = false;
}

// ── Non-scanned-PDF detection ─────────────────────────────────
// Heuristic only, non-blocking — a real digital-text PDF has substantial
// text content on page 1; a scanned page's "text" is empty or trivial
// (maybe an invisible OCR layer, but never this codebase's concern here).

async function _checkLooksDigital() {
  try {
    const page = await _pdfJsDoc.getPage(1);
    const tc = await page.getTextContent();
    const totalChars = tc.items.reduce((sum, it) => sum + (it.str?.length || 0), 0);
    _looksDigital = totalChars > 80;
  } catch { _looksDigital = false; }
}

// ── Preview rendering ─────────────────────────────────────────

async function _renderPreviewSource(pageNum) {
  const page = await _pdfJsDoc.getPage(pageNum);
  const vp0   = page.getViewport({ scale: 1 });
  const scale = PREVIEW_WIDTH / vp0.width;
  const vp    = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  page.cleanup?.();
  return canvas;
}

function _detectColor(canvas) {
  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let sampled = 0, colored = 0;
  for (let i = 0; i < data.length; i += 4 * 37) { // stride sample, not every pixel
    sampled++;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 15) colored++;
  }
  return sampled > 0 && (colored / sampled) > 0.02;
}

// ── Preview worker ─────────────────────────────────────────────
// Own dedicated Worker instance running the REAL cleanScanWorker.js —
// separate from the instance processor.js's _runCleanScan uses for the
// actual export (different lifetime/concern: this one only ever gets
// 'processPage' messages, never 'assemble', and can be torn down whenever
// the user leaves this tool). Reusing the export worker's own message
// type keeps preview and export byte-for-byte the same algorithm with
// zero duplicated pixel-math code to drift out of sync.

let _previewWorker = null;
function _ensurePreviewWorker() {
  if (!_previewWorker) {
    _previewWorker = new Worker(new URL('./cleanScanWorker.js', import.meta.url));
  }
  return _previewWorker;
}

// Single-flight request/response wrapper — reassigns onmessage/onerror per
// call, same shape as processor.js's _cleanScanWorkerRequest. A stale
// in-flight request whose response arrives after a newer one has already
// taken over onmessage just never resolves, which is fine: _updatePreview's
// myGen check means a stale response would have been discarded anyway.
function _previewWorkerRequest(worker, message, transfer) {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'error') { reject(new Error(d.message)); return; }
      if (d.type === 'pageDone') resolve(d);
    };
    worker.onerror = (e) => reject(new Error(e.message || 'Worker error'));
    worker.postMessage(message, transfer);
  });
}

async function _updatePreview() {
  if (!_pdfJsDoc) return;
  const myGen = ++_previewGen;

  const src = await _renderPreviewSource(_previewPage);
  if (myGen !== _previewGen) return;

  _hasColor = _detectColor(src);
  _syncWarnings();

  const beforeBlob = await new Promise(res => src.toBlob(res, 'image/jpeg', 0.85));
  if (myGen !== _previewGen) return;
  _setPreviewImg('csBeforeImg', beforeBlob, false);

  try {
    const bitmap = await createImageBitmap(src);
    const worker = _ensurePreviewWorker();
    const result = await _previewWorkerRequest(
      worker,
      { type: 'processPage', index: 0, bitmap, mode: _mode, strength: _strength },
      [bitmap]
    );
    if (myGen !== _previewGen) return;
    const afterBlob = new Blob([result.bytes], { type: result.format === 'jpeg' ? 'image/jpeg' : 'image/png' });
    _setPreviewImg('csAfterImg', afterBlob, true);
  } catch {
    // Preview is best-effort — leave the previous "after" image in place
    // rather than surfacing a toast for a non-critical redraw.
  }
}

function _setPreviewImg(elId, blob, isAfter) {
  const el = id(elId);
  if (!el || !blob) return;
  const url = URL.createObjectURL(blob);
  const prev = isAfter ? _afterURL : _beforeURL;
  if (prev) URL.revokeObjectURL(prev);
  if (isAfter) _afterURL = url; else _beforeURL = url;
  el.src = url;
}

function _schedulePreview() {
  clearTimeout(_previewTimer);
  _previewTimer = setTimeout(() => { _updatePreview(); }, PREVIEW_DEBOUNCE_MS);
}

// ── Render ─────────────────────────────────────────────────────

function _render(file) {
  const container = id('cleanScanOptions');
  if (!container) return;

  container.innerHTML = `
    <div class="compress-info">
      <span class="compress-info__name" title="${esc(file.name)}">${esc(_truncName(file.name))}</span>
      <span class="compress-info__dot">·</span>
      <span class="compress-info__meta">${tp(_pageCount, 'split_info_page', 'split_info_pages', { n: _pageCount })}</span>
    </div>

    ${_chipGroup('cs_mode', 'csMode', _mode, [
      { value: 'clean',   label: t('cs_mode_clean') },
      { value: 'enhance', label: t('cs_mode_enhance') },
    ])}

    <div class="j2p-group">
      <span class="j2p-group__label">${t('cs_strength')}</span>
      <input type="range" id="csStrength" class="cs-slider" min="0" max="1" step="0.05" value="${_strength}" aria-label="${t('cs_strength')}">
    </div>

    ${_chipGroup('cs_quality', 'csQuality', _quality, [
      { value: 'standard', label: t('cs_quality_standard') },
      { value: 'high',     label: t('cs_quality_high') },
    ])}

    ${_pageCount > 1 ? `
    <div class="j2p-group">
      <span class="j2p-group__label">${t('cs_preview_page')}</span>
      <select id="csPreviewPage" class="cs-page-select" aria-label="${t('cs_preview_page')}">
        ${Array.from({ length: _pageCount }, (_, i) => i + 1)
          .map(n => `<option value="${n}"${n === _previewPage ? ' selected' : ''}>${n}</option>`).join('')}
      </select>
    </div>` : ''}

    <div class="cs-preview">
      <div class="cs-preview__col">
        <span class="cs-preview__label">${t('cs_before')}</span>
        <img id="csBeforeImg" class="cs-preview__img" alt="${t('cs_before')}">
      </div>
      <div class="cs-preview__col">
        <span class="cs-preview__label">${t('cs_after')}</span>
        <img id="csAfterImg" class="cs-preview__img" alt="${t('cs_after')}">
      </div>
    </div>

    <div id="csColorWarning" class="cs-warning" style="display:none">
      <span>${t('cs_color_warning')}</span>
      <button type="button" id="csSwitchToEnhance" class="cs-warning__btn">${t('cs_switch_enhance')}</button>
    </div>

    ${_looksDigital ? `<div class="cs-warning cs-warning--info">${t('cs_digital_warning')}</div>` : ''}

    ${infoBanner(t('cs_banner'), 'info')}
  `;

  _bindEvents();
}

function _chipGroup(labelKey, name, current, options) {
  return `
    <div class="j2p-group">
      <span class="j2p-group__label">${t(labelKey)}</span>
      <div class="j2p-chips" role="group" aria-label="${t(labelKey)}">
        ${options.map(o => `
          <label class="j2p-chip${current === o.value ? ' j2p-chip--active' : ''}" data-value="${o.value}" data-name="${name}">
            <input type="radio" name="${name}" value="${o.value}"${current === o.value ? ' checked' : ''}>
            ${o.label}
          </label>
        `).join('')}
      </div>
    </div>`;
}

function _syncWarnings() {
  const el = id('csColorWarning');
  if (el) el.style.display = (_hasColor && _mode === 'clean') ? 'flex' : 'none';
}

function _syncChips(name, value) {
  const container = id('cleanScanOptions');
  container?.querySelectorAll(`[data-name="${name}"]`).forEach(el => {
    el.classList.toggle('j2p-chip--active', el.dataset.value === value);
  });
}

// ── Events ─────────────────────────────────────────────────────

function _bindEvents() {
  const container = id('cleanScanOptions');
  if (!container) return;

  container.addEventListener('change', e => {
    if (e.target.name === 'csMode') {
      _mode = e.target.value;
      _syncChips('csMode', _mode);
      _syncWarnings();
      _schedulePreview();
    }
    if (e.target.name === 'csQuality') {
      _quality = e.target.value;
      _syncChips('csQuality', _quality);
      // Quality only affects the final export scale, not the fixed-width
      // preview — no preview refresh needed.
    }
    if (e.target.id === 'csPreviewPage') {
      _previewPage = parseInt(e.target.value, 10) || 1;
      _schedulePreview();
    }
  });

  container.addEventListener('input', e => {
    if (e.target.id === 'csStrength') {
      _strength = parseFloat(e.target.value);
      _schedulePreview();
    }
  });

  container.addEventListener('click', e => {
    if (e.target.id === 'csSwitchToEnhance') {
      _mode = 'enhance';
      const radio = container.querySelector('input[name="csMode"][value="enhance"]');
      if (radio) radio.checked = true;
      _syncChips('csMode', _mode);
      _syncWarnings();
      _schedulePreview();
    }
  });
}

// ── Cleanup ────────────────────────────────────────────────────

function _cleanup() {
  clearTimeout(_previewTimer);
  _pdfJsDoc = null;
  if (_beforeURL) { URL.revokeObjectURL(_beforeURL); _beforeURL = null; }
  if (_afterURL)  { URL.revokeObjectURL(_afterURL);  _afterURL  = null; }
  if (_previewWorker) { _previewWorker.terminate(); _previewWorker = null; }
}

function _hide(container) {
  container.style.display = 'none';
  container.innerHTML = '';
}

function _truncName(name) {
  return name.length > 35 ? name.slice(0, 32) + '…' : name;
}
