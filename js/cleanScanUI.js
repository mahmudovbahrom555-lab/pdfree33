// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  cleanScanUI.js — Clean Scan (whiten scanned-document backgrounds)
//
//  Live before/after preview runs the SAME grayscale/background-estimate/
//  threshold-or-enhance algorithm as js/cleanScanWorker.js, duplicated
//  here against a plain <canvas> instead of OffscreenCanvas — same
//  precedent as resizeUI.js/resizeWorker.js's duplicated _fitRect: worker
//  files use importScripts (classic worker, no ES modules), so sharing
//  via import isn't possible; small, pure functions, kept in sync
//  manually. Preview runs on a small (~900px) downscaled copy regardless
//  of the export quality setting, so slider drags stay responsive.
// ============================================================

import { id, esc }                   from './utils.js';
import { showToast }                 from './ui.js';
import { loadingRow, infoBanner }    from './uiComponents.js';
import { loadPdfJs }                 from './pdf2jpgUI.js';
import { t, tp }                     from './i18n.js';

const PREVIEW_WIDTH = 900;
const BG_LONG_EDGE   = 64;
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

  container.innerHTML = loadingRow(t('cs_loading'));
  container.style.display = 'block';

  try {
    await loadPdfJs();
    const buf = await file.arrayBuffer();
    _pdfJsDoc = await window.pdfjsLib.getDocument({
      data: new Uint8Array(buf), disableWorker: true,
    }).promise;

    _pageCount = _pdfJsDoc.numPages;
    if (_pageCount === 0) { showToast(t('no_pages_pdf')); _hide(container); return; }

    _previewPage = 1;
    await _checkLooksDigital();
    _render(file);
    await _updatePreview();
  } catch (err) {
    showToast(t('cs_err_load', { msg: err.message }), 5000);
    _hide(container);
  }
}

export function hideCleanScanOptions() {
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

// ── Preview rendering + algorithm (duplicated from cleanScanWorker.js) ──

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

function _toGrayscaleCanvas(src) {
  const dst = document.createElement('canvas');
  dst.width = src.width; dst.height = src.height;
  const ctx = dst.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, dst.width, dst.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return dst;
}

function _estimateBackground(gray) {
  const w = gray.width, h = gray.height;
  const scale = Math.min(1, BG_LONG_EDGE / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * scale)), sh = Math.max(1, Math.round(h * scale));

  const small = document.createElement('canvas');
  small.width = sw; small.height = sh;
  const sctx = small.getContext('2d');
  sctx.imageSmoothingEnabled = true; sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(gray, 0, 0, sw, sh);

  const bg = document.createElement('canvas');
  bg.width = w; bg.height = h;
  const bctx = bg.getContext('2d');
  bctx.imageSmoothingEnabled = true; bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(small, 0, 0, w, h);
  return bg;
}

function _flatFieldCorrect(gray, bg) {
  const w = gray.width, h = gray.height;
  const gctx = gray.getContext('2d'), bctx = bg.getContext('2d');
  const gImg = gctx.getImageData(0, 0, w, h), bImg = bctx.getImageData(0, 0, w, h);
  const gd = gImg.data, bd = bImg.data;
  for (let i = 0; i < gd.length; i += 4) {
    const bgv = bd[i] < 1 ? 1 : bd[i];
    const v   = Math.min(255, Math.max(0, (gd[i] / bgv) * 255));
    gd[i] = gd[i + 1] = gd[i + 2] = v;
  }
  gctx.putImageData(gImg, 0, 0);
  return gray;
}

function _otsuThreshold(data) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < data.length; i += 4) hist[data[i]]++;
  const total = data.length / 4;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0, sumB = 0, varMax = 0, threshold = 128;
  for (let t2 = 0; t2 < 256; t2++) {
    wB += hist[t2];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t2 * hist[t2];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) ** 2;
    if (varBetween > varMax) { varMax = varBetween; threshold = t2; }
  }
  return threshold;
}

function _applyClean(canvas, strength) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const base  = _otsuThreshold(d);
  const shift = (strength - 0.5) * 80;
  const th = Math.min(250, Math.max(5, base + shift));
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i];
    if (v >= th) { d[i] = d[i + 1] = d[i + 2] = 255; }
    else { const dark = Math.max(0, v - 30); d[i] = d[i + 1] = d[i + 2] = dark; }
  }
  ctx.putImageData(img, 0, 0);
}

function _applyEnhance(canvas, strength) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const contrast   = 1 + strength * 1.2;
  const brightness = strength * 40;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i];
    const c = Math.min(255, Math.max(0, (v - 128) * contrast + 128 + brightness));
    d[i] = d[i + 1] = d[i + 2] = c;
  }
  ctx.putImageData(img, 0, 0);
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

  const gray = _toGrayscaleCanvas(src);
  const bg   = _estimateBackground(gray);
  _flatFieldCorrect(gray, bg);
  if (_mode === 'enhance') _applyEnhance(gray, _strength);
  else _applyClean(gray, _strength);

  const afterBlob = await new Promise(res =>
    gray.toBlob(res, _mode === 'enhance' ? 'image/jpeg' : 'image/png', 0.87)
  );
  if (myGen !== _previewGen) return;
  _setPreviewImg('csAfterImg', afterBlob, true);
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
      <span class="compress-info__name" title="${esc(file.name)}">${_truncName(file.name)}</span>
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
}

function _hide(container) {
  container.style.display = 'none';
  container.innerHTML = '';
}

function _truncName(name) {
  return name.length > 35 ? name.slice(0, 32) + '…' : name;
}
