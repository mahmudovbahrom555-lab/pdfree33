// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  resizeUI.js — Resize PDF (fit/fill/actual-size onto a paper size)
//
//  Controls are all chips/toggles — no free-text math, matching the
//  tool's whole point (predictable, math-free output).
//
//  Preview: a real pdf.js-rendered thumbnail of page 1, positioned
//  inside a CSS paper-outline frame using the SAME _fitRect scale/x/y
//  math the worker applies — so switching paper size/mode/margin/
//  orientation visibly re-scales/repositions the same real thumbnail,
//  not a static mockup. Duplicated arithmetic from resizeWorker.js —
//  same precedent as that file's _flattenPageTreeResources: small,
//  pure, kept in sync manually.
// ============================================================

import { id, esc }          from './utils.js';
import { showToast }        from './ui.js';
import { loadingRow, infoBanner, presetRememberCard } from './uiComponents.js';
import { loadPdfJs }        from './pdf2jpgUI.js'; // reuse CDN loader with retry logic
import { loadPdfLib }       from './lazyLibs.js';
import { loadPreset, clearPreset } from './presets.js';
import { t, tp }            from './i18n.js';

// ── Constants (mirrors resizeWorker.js's PAGE_SIZES — kept in sync manually) ──

const PAGE_SIZES = {
  a4:     [595.28, 841.89],
  a3:     [841.89, 1190.55],
  a5:     [419.53, 595.28],
  letter: [612, 792],
  legal:  [612, 1008],
};
const PAPER_LABELS = { a4: 'A4', a3: 'A3', a5: 'A5', letter: 'Letter', legal: 'Legal' };
const MARGIN_MM = { none: 0, small: 5, normal: 10, large: 20 };
const MM_TO_PT = 2.83465;

// ── State ──────────────────────────────────────────────────────

let _targetSize   = 'a4';
let _mode         = 'fit';    // 'fit' | 'fill' | 'actual'
let _marginKey    = 'normal'; // 'none' | 'small' | 'normal' | 'large'
let _orientation  = 'auto';   // 'auto' | 'portrait' | 'landscape'
let _rememberLoaded = false;
let _pageCount     = 0;
let _srcW = 0, _srcH = 0;     // page 1 size in pt — drives the live preview
let _pdfJsDoc       = null;
let _thumbURL        = null;   // objectURL of the rendered page-1 thumbnail
let _initGen         = 0;      // bumped on every initResizeOptions() call — lets a stale
                                // in-flight call detect it's been superseded and bail out
                                // instead of overwriting a newer file's state (same race
                                // class already found+fixed for compress's background scan
                                // in app.js's pdfree:files-added listener)

// ── Public API ─────────────────────────────────────────────────

export function getResizeParams() {
  return {
    targetSize: _targetSize,
    mode: _mode,
    marginPt: MARGIN_MM[_marginKey] * MM_TO_PT,
    orientation: _orientation,
  };
}

export async function initResizeOptions(file) {
  const container = id('resizeOptions');
  if (!container) return;

  // Captured before any await — a later call (user swapped files again while
  // this one was still loading) bumps _initGen, and every checkpoint below
  // bails out rather than clobbering the newer file's state with stale data.
  const gen = ++_initGen;

  container.innerHTML = loadingRow(t('rsz_loading'));
  container.style.display = 'block';

  try {
    await loadPdfLib();
    if (gen !== _initGen) return;
    const { PDFDocument } = window.PDFLib;
    const buf = await file.arrayBuffer();
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
    if (gen !== _initGen) return;

    _pageCount = doc.getPageCount();
    if (_pageCount === 0) { showToast(t('no_pages_pdf')); _hide(container); return; }

    const first = doc.getPages()[0];
    ({ width: _srcW, height: _srcH } = first.getSize());

    // Restore saved layout settings once per tool session — these four
    // params are genuine cross-document preferences (unlike rotate/organize,
    // there's no per-document state to strip), same class as jpg2pdf/pdf2jpg.
    if (!_rememberLoaded) {
      _rememberLoaded = true;
      const saved = loadPreset('resize');
      if (saved) {
        _targetSize  = saved.targetSize  ?? _targetSize;
        _mode        = saved.mode        ?? _mode;
        _orientation = saved.orientation ?? _orientation;
        if (typeof saved.marginPt === 'number') {
          const mm = saved.marginPt / MM_TO_PT;
          _marginKey = Object.keys(MARGIN_MM).find(k => Math.abs(MARGIN_MM[k] - mm) < 1) ?? _marginKey;
        }
      }
    }

    // Real page-1 thumbnail for the preview — wrapped in its own try/catch
    // so a pdf.js load failure degrades to a plain paper-outline preview
    // (no thumbnail image) instead of hiding the whole tool.
    try {
      await loadPdfJs();
      if (gen !== _initGen) return;
      _pdfJsDoc = await window.pdfjsLib.getDocument({
        data: new Uint8Array(buf.slice(0)),
        disableWorker: true,
      }).promise;
      if (gen !== _initGen) return;
      await _renderThumb();
      if (gen !== _initGen) return;
    } catch (thumbErr) {
      if (gen !== _initGen) return;
      _pdfJsDoc = null;
      console.warn('[resizeUI] pdf.js unavailable, preview will show frame only:', thumbErr.message);
    }

    _render(file);
  } catch (err) {
    if (gen !== _initGen) return;
    showToast(t('rsz_err_load', { msg: err.message }), 5000);
    _hide(container);
  }
}

export function hideResizeOptions() {
  _initGen++; // invalidate any in-flight initResizeOptions() call
  _cleanup();
  const container = id('resizeOptions');
  if (!container) return;
  container.style.display = 'none';
  container.innerHTML = '';
  _pageCount = 0;
  _srcW = 0; _srcH = 0;
  _targetSize  = 'a4';
  _mode        = 'fit';
  _marginKey   = 'normal';
  _orientation = 'auto';
  _rememberLoaded = false;
}

// ── Preview thumbnail ─────────────────────────────────────────

async function _renderThumb() {
  if (!_pdfJsDoc) return;
  const page     = await _pdfJsDoc.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const scale    = 500 / Math.max(viewport.width, viewport.height); // fixed-resolution preview
  const vp       = page.getViewport({ scale });

  const canvas  = document.createElement('canvas');
  canvas.width  = vp.width;
  canvas.height = vp.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.82));
  _thumbURL = URL.createObjectURL(blob);
  page.cleanup?.();
}

// ── Shared fit math (kept in sync with resizeWorker.js) ─────────

function _fitRect(srcW, srcH, availW, availH, mode) {
  let scale;
  if (mode === 'fill') {
    scale = Math.max(availW / srcW, availH / srcH);
  } else if (mode === 'actual') {
    scale = 1;
  } else {
    scale = Math.min(1, availW / srcW, availH / srcH);
  }
  const scaledW = srcW * scale;
  const scaledH = srcH * scale;
  return { scale, scaledW, scaledH, x: (availW - scaledW) / 2, y: (availH - scaledH) / 2 };
}

function _resolveTargetSize([baseW, baseH], origW, origH, orientation) {
  const portraitFrame  = [Math.min(baseW, baseH), Math.max(baseW, baseH)];
  const landscapeFrame = [portraitFrame[1], portraitFrame[0]];
  if (orientation === 'portrait')  return portraitFrame;
  if (orientation === 'landscape') return landscapeFrame;
  return origW > origH ? landscapeFrame : portraitFrame;
}

// ── Main render ────────────────────────────────────────────────

function _render(file) {
  const container = id('resizeOptions');
  if (!container) return;

  container.innerHTML = `
    <div class="compress-info">
      <span class="compress-info__name" title="${esc(file.name)}">${_truncName(file.name)}</span>
      <span class="compress-info__dot">·</span>
      <span class="compress-info__meta">${tp(_pageCount, 'split_info_page', 'split_info_pages', { n: _pageCount })}</span>
    </div>

    <div class="rsz-layout">
      <div class="rsz-preview">
        <div class="rsz-paper" id="rszPaper">
          ${_thumbURL ? `<img class="rsz-paper__thumb" id="rszThumb" src="${esc(_thumbURL)}" alt="${t('rsz_preview_alt')}">` : ''}
        </div>
        <div class="rsz-summary" id="rszSummary" aria-live="polite"></div>
        <div class="rsz-clip-warning" id="rszClipWarning" style="display:none" role="status">
          ${t('rsz_clip_warning')}
        </div>
      </div>

      <div class="rsz-controls">
        ${_chipGroup('rsz_paper_size', 'rszSize', _targetSize, [
          { value: 'a4',     label: 'A4' },
          { value: 'letter', label: 'Letter' },
          { value: 'legal',  label: 'Legal' },
          { value: 'a3',     label: 'A3' },
          { value: 'a5',     label: 'A5' },
        ])}

        ${_chipGroup('rsz_mode', 'rszMode', _mode, [
          { value: 'fit',    label: t('rsz_mode_fit') },
          { value: 'fill',   label: t('rsz_mode_fill') },
          { value: 'actual', label: t('rsz_mode_actual') },
        ])}

        ${_chipGroup('rsz_margin', 'rszMargin', _marginKey, [
          { value: 'none',   label: t('rsz_margin_none') },
          { value: 'small',  label: t('rsz_margin_small') + ' (5mm)' },
          { value: 'normal', label: t('rsz_margin_normal') + ' (10mm)' },
          { value: 'large',  label: t('rsz_margin_large') + ' (20mm)' },
        ])}

        ${_chipGroup('rsz_orientation', 'rszOrient', _orientation, [
          { value: 'auto',      label: t('rsz_orient_auto') },
          { value: 'portrait',  label: t('rsz_orient_portrait') },
          { value: 'landscape', label: t('rsz_orient_landscape') },
        ])}
      </div>
    </div>

    ${presetRememberCard({
      id:       'resizeRememberCheck',
      checked:  loadPreset('resize') !== null,
      title:    '💾 ' + t('preset_remember_title'),
      subtitle: t('preset_remember_sub'),
      ariaLabel: t('preset_remember_title'),
    })}

    ${infoBanner(t('rsz_banner'), 'info')}
  `;

  _bindEvents();
  _updatePreview();
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

// ── Live preview update ───────────────────────────────────────

function _updatePreview() {
  if (!_srcW || !_srcH) return;

  const baseSize = PAGE_SIZES[_targetSize];
  const [w, h]    = _resolveTargetSize(baseSize, _srcW, _srcH, _orientation);
  const marginPt  = MARGIN_MM[_marginKey] * MM_TO_PT;
  const availW    = Math.max(1, w - marginPt * 2);
  const availH    = Math.max(1, h - marginPt * 2);
  const { scale, scaledW, scaledH, x, y } = _fitRect(_srcW, _srcH, availW, availH, _mode);

  const paper = id('rszPaper');
  if (paper) paper.style.aspectRatio = `${w} / ${h}`;

  const thumb = id('rszThumb');
  if (thumb) {
    thumb.style.position = 'absolute';
    thumb.style.width  = `${(scaledW / w) * 100}%`;
    thumb.style.height = `${(scaledH / h) * 100}%`;
    thumb.style.left   = `${((marginPt + x) / w) * 100}%`;
    thumb.style.bottom = `${((marginPt + y) / h) * 100}%`;
  }

  // Compare against the full page (w/h), not the margin-reduced availW/
  // availH: _fitRect's symmetric centering offset cancels the margin out
  // exactly whenever content doesn't fit the margin box, landing it flush
  // with the true page edge — filling the page with nothing actually cut
  // off. Comparing against availW/availH was a false-positive bug: an A4
  // source at Actual size onto an A4 target always "overflowed" the margin
  // box and wrongly warned "will be clipped" on same-size documents, the
  // single most common case.
  const clips = scaledW > w + 0.5 || scaledH > h + 0.5;
  const warnEl = id('rszClipWarning');
  if (warnEl) warnEl.style.display = clips ? 'block' : 'none';

  const fromOrient = _srcW > _srcH ? t('rsz_orient_landscape') : t('rsz_orient_portrait');
  const toOrient    = w > h ? t('rsz_orient_landscape') : t('rsz_orient_portrait');
  const from = `${_fmtMm(_srcW)}×${_fmtMm(_srcH)}mm ${fromOrient}`;
  const to   = `${PAPER_LABELS[_targetSize]} ${toOrient}`;

  const summaryEl = id('rszSummary');
  if (summaryEl) {
    const noShrink = _mode === 'fit' && Math.abs(scale - 1) < 0.005;
    summaryEl.textContent = noShrink
      ? t('rsz_summary_no_shrink', { from, to })
      : t('rsz_summary', { from, to, pct: Math.round(scale * 100) });
  }
}

function _fmtMm(pt) {
  return Math.round(pt / MM_TO_PT);
}

// ── Events ─────────────────────────────────────────────────────

function _bindEvents() {
  const container = id('resizeOptions');
  if (!container) return;

  container.addEventListener('change', e => {
    if (e.target.name === 'rszSize') {
      _targetSize = e.target.value;
      _syncChips('rszSize', _targetSize);
      _updatePreview();
    }
    if (e.target.name === 'rszMode') {
      _mode = e.target.value;
      _syncChips('rszMode', _mode);
      _updatePreview();
    }
    if (e.target.name === 'rszMargin') {
      _marginKey = e.target.value;
      _syncChips('rszMargin', _marginKey);
      _updatePreview();
    }
    if (e.target.name === 'rszOrient') {
      _orientation = e.target.value;
      _syncChips('rszOrient', _orientation);
      _updatePreview();
    }
    // Unchecking forgets immediately — saving happens centrally in app.js
    // (_maybeSavePreset) right before processing starts.
    if (e.target.id === 'resizeRememberCheck' && !e.target.checked) {
      clearPreset('resize');
    }
  });
}

function _syncChips(name, value) {
  const container = id('resizeOptions');
  container?.querySelectorAll(`[data-name="${name}"]`).forEach(el => {
    el.classList.toggle('j2p-chip--active', el.dataset.value === value);
  });
}

// ── Cleanup ────────────────────────────────────────────────────

function _cleanup() {
  _pdfJsDoc = null;
  if (_thumbURL) { URL.revokeObjectURL(_thumbURL); _thumbURL = null; }
}

function _hide(container) {
  container.style.display = 'none';
  container.innerHTML = '';
}

function _truncName(name) {
  return name.length > 35 ? name.slice(0, 32) + '…' : name;
}
