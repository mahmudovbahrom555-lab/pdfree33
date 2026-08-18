// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  ereaderUI.js — E-Reader Optimizer (margin auto-crop + grayscale/
//  contrast, targeting Kindle / Kobo / reMarkable aspect ratios)
//
//  The bbox-detection/reconciliation/aspect-compose MATH is a real
//  shared import from js/ereaderCrop.js (not duplicated — that module
//  is a plain ES module, unlike js/ereaderWorker.js which is a classic
//  Worker and can't be `import`ed here). Only the final crop+grayscale+
//  contrast CANVAS rendering is duplicated against a plain <canvas>
//  instead of OffscreenCanvas, for the live before/after preview — same
//  precedent as cleanScanUI.js/cleanScanWorker.js. Preview runs on a
//  small (~900px) downscaled copy regardless of the export resolution,
//  so slider drags stay responsive.
// ============================================================

import { id, esc }                   from './utils.js';
import { showToast, setButtonDisabled, setButtonReady } from './ui.js';
import { loadingRow, infoBanner }    from './uiComponents.js';
import { loadPdfJs }                 from './pdf2jpgUI.js';
import { TOOLS, getLocalizedTool }   from './config.js';
import { t, tp }                     from './i18n.js';
import { contentBBox, reconcileGlobalCrop, padBBox, composeWithAspect, DEVICE_PRESETS } from './ereaderCrop.js';

const PREVIEW_WIDTH = 900;
const SAMPLE_MAX = 8; // fewer than processor.js's export-time sample — UI only needs a quick estimate
const BBOX_EDGE  = 400;
const PREVIEW_DEBOUNCE_MS = 150;

// ── State ──────────────────────────────────────────────────────

let _device       = 'kindle';   // 'kindle' | 'remarkable' | 'kobo'
let _grayscale    = true;
let _contrast     = 0.5;
let _pageCount    = 0;
let _pdfJsDoc     = null;
let _previewPage  = 1;
let _beforeURL    = null;
let _afterURL     = null;
let _reconciled   = null; // device-independent bbox, computed once per file
let _previewGen   = 0;
let _previewTimer = null;

// ── Public API ─────────────────────────────────────────────────

export function getEreaderParams() {
  return {
    device:    _device,
    grayscale: _grayscale,
    contrast:  _contrast,
    hasFile:   !!_pdfJsDoc,
    pageCount: _pageCount,
  };
}

export async function initEreaderOptions(file) {
  const container = id('ereaderOptions');
  if (!container) return;
  if (!file) { container.innerHTML = ''; return; }

  container.innerHTML = loadingRow(t('er_loading'));
  container.style.display = 'block';

  // Deferred to a microtask — see cleanScanUI.js's initCleanScanOptions
  // for why this can't run synchronously (files.js's renderList() would
  // just overwrite it a few lines later on the same call stack).
  queueMicrotask(() => setButtonDisabled());

  try {
    await loadPdfJs();
    const buf = await file.arrayBuffer();
    _pdfJsDoc = await window.pdfjsLib.getDocument({
      data: new Uint8Array(buf), disableWorker: true,
    }).promise;

    _pageCount = _pdfJsDoc.numPages;
    if (_pageCount === 0) { showToast(t('no_pages_pdf')); _hide(container); return; }

    _previewPage = 1;
    await _detectGlobalCrop();
    _render(file);
    setButtonReady(getLocalizedTool(TOOLS.ereader).btn);
    await _updatePreview();
  } catch (err) {
    showToast(t('er_err_load', { msg: err.message }), 5000);
    _hide(container);
  }
}

export function hideEreaderOptions() {
  _cleanup();
  const container = id('ereaderOptions');
  if (container) { container.style.display = 'none'; container.innerHTML = ''; }
  _device = 'kindle'; _grayscale = true; _contrast = 0.5;
  _pageCount = 0; _pdfJsDoc = null; _previewPage = 1; _reconciled = null;
}

// ── Global crop detection (device-independent part, cached) ────

function _sampleIndices(pageCount, max) {
  if (pageCount <= max) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const step = (pageCount - 1) / (max - 1);
  const out = new Set();
  for (let i = 0; i < max; i++) out.add(1 + Math.round(i * step));
  return [...out].sort((a, b) => a - b);
}

async function _detectGlobalCrop() {
  const indices = _sampleIndices(_pageCount, SAMPLE_MAX);
  const bboxes = [];
  for (const i of indices) {
    const page = await _pdfJsDoc.getPage(i);
    const vp1  = page.getViewport({ scale: 1 });
    const scale = BBOX_EDGE / Math.max(vp1.width, vp1.height);
    const vp     = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width  = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    page.cleanup?.();
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    bboxes.push(contentBBox(data, canvas.width, canvas.height));
  }
  _reconciled = padBBox(reconcileGlobalCrop(bboxes));
}

function _currentCropRect(pageWidthPt, pageHeightPt) {
  const aspect = (DEVICE_PRESETS[_device] || DEVICE_PRESETS.kindle).aspect;
  return composeWithAspect(_reconciled || { top: 0, bottom: 1, left: 0, right: 1 }, pageWidthPt, pageHeightPt, aspect);
}

// ── Preview rendering (duplicated crop+grayscale+contrast from ereaderWorker.js) ──

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
  return { canvas, pageWidthPt: vp0.width, pageHeightPt: vp0.height };
}

function _drawCropOverlay(srcCanvas, cropRect) {
  const overlay = document.createElement('canvas');
  overlay.width = srcCanvas.width; overlay.height = srcCanvas.height;
  const ctx = overlay.getContext('2d');
  ctx.drawImage(srcCanvas, 0, 0);
  const x = cropRect.left * overlay.width;
  const y = cropRect.top * overlay.height;
  const w = (cropRect.right - cropRect.left) * overlay.width;
  const h = (cropRect.bottom - cropRect.top) * overlay.height;
  ctx.save();
  ctx.strokeStyle = '#2f6feb';
  ctx.lineWidth = 3;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
  return overlay;
}

// Kept in sync with ereaderWorker.js's grayscale/contrast pixel math —
// see that file's comment for why the contrast formula is a verbatim
// port of cleanScanWorker.js's _applyEnhance.
function _applyGrayscale(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
}

function _applyContrast(ctx, w, h, strength) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const contrast   = 1 + strength * 1.2;
  const brightness = strength * 40;
  for (let i = 0; i < d.length; i += 4) {
    d[i]     = Math.min(255, Math.max(0, (d[i]     - 128) * contrast + 128 + brightness));
    d[i + 1] = Math.min(255, Math.max(0, (d[i + 1] - 128) * contrast + 128 + brightness));
    d[i + 2] = Math.min(255, Math.max(0, (d[i + 2] - 128) * contrast + 128 + brightness));
  }
  ctx.putImageData(img, 0, 0);
}

function _renderAfterCanvas(srcCanvas, cropRect) {
  const aspect = (DEVICE_PRESETS[_device] || DEVICE_PRESETS.kindle).aspect;
  const outH = 400;
  const outW = Math.round(outH * aspect);

  const sx = Math.round(cropRect.left * srcCanvas.width);
  const sy = Math.round(cropRect.top * srcCanvas.height);
  const sw = Math.max(1, Math.round((cropRect.right - cropRect.left) * srcCanvas.width));
  const sh = Math.max(1, Math.round((cropRect.bottom - cropRect.top) * srcCanvas.height));

  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, outW, outH);

  const scale = Math.min(outW / sw, outH / sh);
  const dw = sw * scale, dh = sh * scale;
  const dx = (outW - dw) / 2, dy = (outH - dh) / 2;
  ctx.drawImage(srcCanvas, sx, sy, sw, sh, dx, dy, dw, dh);

  if (_grayscale) _applyGrayscale(ctx, outW, outH);
  _applyContrast(ctx, outW, outH, _contrast);
  return out;
}

async function _updatePreview() {
  if (!_pdfJsDoc) return;
  const myGen = ++_previewGen;

  const { canvas: src, pageWidthPt, pageHeightPt } = await _renderPreviewSource(_previewPage);
  if (myGen !== _previewGen) return;

  const cropRect = _currentCropRect(pageWidthPt, pageHeightPt);

  const beforeCanvas = _drawCropOverlay(src, cropRect);
  const beforeBlob = await new Promise(res => beforeCanvas.toBlob(res, 'image/jpeg', 0.85));
  if (myGen !== _previewGen) return;
  _setPreviewImg('erBeforeImg', beforeBlob, false);

  const afterCanvas = _renderAfterCanvas(src, cropRect);
  const afterBlob = await new Promise(res => afterCanvas.toBlob(res, 'image/jpeg', 0.87));
  if (myGen !== _previewGen) return;
  _setPreviewImg('erAfterImg', afterBlob, true);
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
  const container = id('ereaderOptions');
  if (!container) return;

  container.innerHTML = `
    <div class="compress-info">
      <span class="compress-info__name" title="${esc(file.name)}">${_truncName(file.name)}</span>
      <span class="compress-info__dot">·</span>
      <span class="compress-info__meta">${tp(_pageCount, 'split_info_page', 'split_info_pages', { n: _pageCount })}</span>
    </div>

    ${_chipGroup('er_device', 'erDevice', _device, [
      { value: 'kindle',     label: t('er_device_kindle') },
      { value: 'remarkable', label: t('er_device_remarkable') },
      { value: 'kobo',       label: t('er_device_kobo') },
    ])}

    <div class="j2p-group">
      <label class="j2p-chip" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
        <input type="checkbox" id="erGrayscale"${_grayscale ? ' checked' : ''}>
        ${t('er_grayscale')}
      </label>
    </div>

    <div class="j2p-group">
      <span class="j2p-group__label">${t('er_contrast')}</span>
      <input type="range" id="erContrast" class="cs-slider" min="0" max="1" step="0.05" value="${_contrast}" aria-label="${t('er_contrast')}">
    </div>

    ${_pageCount > 1 ? `
    <div class="j2p-group">
      <span class="j2p-group__label">${t('er_preview_page')}</span>
      <select id="erPreviewPage" class="cs-page-select" aria-label="${t('er_preview_page')}">
        ${Array.from({ length: _pageCount }, (_, i) => i + 1)
          .map(n => `<option value="${n}"${n === _previewPage ? ' selected' : ''}>${n}</option>`).join('')}
      </select>
    </div>` : ''}

    <div class="cs-preview">
      <div class="cs-preview__col">
        <span class="cs-preview__label">${t('er_before')}</span>
        <img id="erBeforeImg" class="cs-preview__img" alt="${t('er_before')}">
      </div>
      <div class="cs-preview__col">
        <span class="cs-preview__label">${t('er_after')}</span>
        <img id="erAfterImg" class="cs-preview__img" alt="${t('er_after')}">
      </div>
    </div>
    <p class="j2p-group__label">${t('er_crop_caption', { n: _pageCount })}</p>

    ${infoBanner(t('er_rasterize_warning'), 'info')}
    ${infoBanner(t('er_banner'), 'info')}
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

function _syncChips(name, value) {
  const container = id('ereaderOptions');
  container?.querySelectorAll(`[data-name="${name}"]`).forEach(el => {
    el.classList.toggle('j2p-chip--active', el.dataset.value === value);
  });
}

// ── Events ─────────────────────────────────────────────────────

function _bindEvents() {
  const container = id('ereaderOptions');
  if (!container) return;

  container.addEventListener('change', e => {
    if (e.target.name === 'erDevice') {
      _device = e.target.value;
      _syncChips('erDevice', _device);
      _schedulePreview();
    }
    if (e.target.id === 'erGrayscale') {
      _grayscale = e.target.checked;
      _schedulePreview();
    }
    if (e.target.id === 'erPreviewPage') {
      _previewPage = parseInt(e.target.value, 10) || 1;
      _schedulePreview();
    }
  });

  container.addEventListener('input', e => {
    if (e.target.id === 'erContrast') {
      _contrast = parseFloat(e.target.value);
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
}

function _hide(container) {
  container.style.display = 'none';
  container.innerHTML = '';
}

function _truncName(name) {
  return name.length > 35 ? name.slice(0, 32) + '…' : name;
}
