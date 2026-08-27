// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  jpg2pdfUI.js — JPG/PNG → PDF options panel
//
//  🎯 Сверх ТЗ:
//  1. EXIF orientation fix — читаем тег 0x0112 из JPEG до передачи
//     в worker, чтобы изображения, снятые телефоном вертикально,
//     не выходили повёрнутыми в PDF (это ломает 90% онлайн-инструментов).
//  2. Pixel preview — canvas-миниатюры каждого файла в панели,
//     пользователь видит порядок до конвертации.
//  3. Smart auto-orient — если Auto + Auto, определяем ориентацию
//     каждой страницы по реальным размерам изображения.
// ============================================================

import { id }       from './utils.js';
import { t, tp }    from './i18n.js';
import { showToast } from './ui.js';
import { selectedFiles, isFilesLocked } from './files.js';
import { bindDragReorder } from './dragReorder.js';
import { presetRememberCard } from './uiComponents.js';
import { loadPreset, clearPreset } from './presets.js';
import { isHeicFile, decodeHeicToJpegBlob } from './heicDecode.js';

// Soft, non-blocking heads-up — not a hard cap. Canvas thumbnail decoding
// happens one file at a time (see _renderPreviews), so memory pressure is
// mild even well past this, but very large batches can still get slow on
// low-RAM devices. The user asked to remove the old hard 20-file preview
// cap and only warn, never block, past a reasonable size.
const _MANY_IMAGES_WARN_THRESHOLD = 80;
let _warnedManyImages = false;

// ── State ──────────────────────────────────────────────────────
let _pageSize    = 'auto';      // 'auto' | 'a4' | 'letter' | 'fit'
let _orientation = 'auto';     // 'auto' | 'portrait' | 'landscape'
let _compress    = true;
let _quality     = 0.82;       // JPEG quality 0–1
let _exifAngles  = [];         // cached EXIF rotation per file (degrees)
let _rememberLoaded = false;   // "Remember my settings" applied once per tool session
let _settingsRendered = false; // see _render()'s split-render comment

export function getJpg2PdfParams() {
  return { pageSize: _pageSize, orientation: _orientation,
           compress: _compress, quality: _quality, exifAngles: _exifAngles };
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Инициализирует панель настроек для переданного списка файлов.
 * Запускает асинхронное чтение EXIF и рендер превью.
 * @param {File[]} files
 */
export async function initJpg2PdfOptions(files) {
  const container = id('jpg2pdfOptions');
  if (!container) return;

  if (files.length === 0) { container.style.display = 'none'; return; }

  // Restore saved layout/quality settings once per tool session — exifAngles
  // is never part of the saved preset (this batch's own per-image rotation,
  // see presetFilter in toolRegistrations.js), so it always starts fresh.
  if (!_rememberLoaded) {
    _rememberLoaded = true;
    const saved = loadPreset('jpg2pdf');
    if (saved) {
      _pageSize    = saved.pageSize    ?? _pageSize;
      _orientation = saved.orientation ?? _orientation;
      _compress    = saved.compress    ?? _compress;
      _quality     = saved.quality     ?? _quality;
    }
  }

  // Loading spinner only on the very first call — a full destructive
  // rebuild here would wipe the settings panel (including an in-progress
  // quality-slider drag) on every later file add/remove too, before
  // _render() even runs. EXIF reading is fast (first 64KB per file only,
  // per the comment below), so later calls don't need a spinner at all.
  if (!_settingsRendered) {
    container.innerHTML = `
      <div class="j2p-loading">
        <span class="compress-loading__spinner" aria-hidden="true"></span>
        ${t('j2p_reading_images')}
      </div>
    `;
  }
  container.style.display = 'block';

  // Read EXIF in parallel — fast, only first 64KB per file
  _exifAngles = await Promise.all(files.map(f => _readExifAngle(f)));

  // One-time soft warning per session past the threshold — never blocks.
  if (files.length > _MANY_IMAGES_WARN_THRESHOLD && !_warnedManyImages) {
    _warnedManyImages = true;
    showToast(t('warn_many_images', { n: files.length }), 7000);
  }
  if (files.length <= _MANY_IMAGES_WARN_THRESHOLD) {
    _warnedManyImages = false; // back under threshold — allow warning again if it grows past it later
  }

  _render(files);
}

export function hideJpg2PdfOptions() {
  const container = id('jpg2pdfOptions');
  if (!container) return;
  container.style.display = 'none';
  container.innerHTML = '';
  _pageSize    = 'auto';
  _orientation = 'auto';
  _compress    = true;
  _quality     = 0.82;
  _exifAngles  = [];
  _warnedManyImages = false;
  _rememberLoaded = false;
  _settingsRendered = false;
}

// ── Render ─────────────────────────────────────────────────────
// Split into two independently-updatable regions — real bug found during
// the 2026-08-20/21 UI-glue audit (same class as merge's #mergeFilenameInput
// focus-loss, fixed in 8122056): _render() used to be ONE innerHTML
// assignment covering both the thumbnail grid (which genuinely needs to
// refresh on every file add/remove/reorder) and the settings panel — page
// size, orientation, compress toggle, quality slider. A user mid-drag on
// the quality slider who added or removed one more image got the drag
// silently interrupted, since the slider node itself was destroyed and
// recreated. Now the settings panel is built exactly once; only the
// thumbnail-grid wrapper is replaced on later calls.

// CSS renders .j2p-thumb__canvas at 56x56 (css/components.css) — the
// canvas's own raster width/height must match that, scaled by
// devicePixelRatio, or the browser upscales a lower-res bitmap into the
// CSS box and every thumbnail comes out visibly soft (worse on a real
// phone's retina display). Found via code review of js/scanDocumentUI.js
// (this file's own thumbnail grid + EXIF preview markup was copied
// there) — same bug, same shared CSS class/markup, fixed in both.
const _THUMB_CSS_SIZE = 56;
const _THUMB_RASTER_SIZE = Math.round(_THUMB_CSS_SIZE * (window.devicePixelRatio || 1));

function _previewsHtml(files) {
  const rotated = _exifAngles.filter(a => a !== 0).length;
  const exifNote = rotated > 0
    ? `<div class="j2p-exif-note" role="status">
         ${tp(rotated, 'j2p_exif_note_one', 'j2p_exif_note_many', { n: rotated })}
       </div>`
    : '';
  return `
    ${exifNote}
    <div class="j2p-previews" aria-label="${t('j2p_image_preview')}" role="list">
      ${files.map((f, i) => `
        <div class="j2p-thumb" role="listitem" data-index="${i}" data-i="${i}" title="${_esc(f.name)}">
          <canvas class="j2p-thumb__canvas" data-index="${i}"
                  width="${_THUMB_RASTER_SIZE}" height="${_THUMB_RASTER_SIZE}" aria-hidden="true"></canvas>
          <span class="j2p-thumb__name">${_truncName(f.name, 12)}</span>
          ${_exifAngles[i] !== 0 ? `<span class="j2p-thumb__badge" aria-label="${t('j2p_will_be_rotated')}">↺</span>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function _settingsHtml() {
  return `
    <div class="j2p-row">
      <div class="j2p-group">
        <span class="j2p-group__label">${t('j2p_page_size')}</span>
        <div class="j2p-chips" role="group" aria-label="${t('j2p_page_size')}">
          ${[
            { value: 'auto',   label: t('j2p_size_auto') },
            { value: 'a4',     label: 'A4'       },
            { value: 'letter', label: 'Letter'   },
            { value: 'fit',    label: t('j2p_fit') },
          ].map(o => `
            <label class="j2p-chip${_pageSize === o.value ? ' j2p-chip--active' : ''}" data-value="${o.value}" data-name="j2pSize">
              <input type="radio" name="j2pSize" value="${o.value}"${_pageSize === o.value ? ' checked' : ''}>
              ${o.label}
            </label>
          `).join('')}
        </div>
      </div>

      <div class="j2p-group">
        <span class="j2p-group__label">${t('j2p_orientation')}</span>
        <div class="j2p-chips" role="group" aria-label="${t('j2p_orientation')}">
          ${[
            { value: 'auto',      label: t('j2p_orient_auto')      },
            { value: 'portrait',  label: t('j2p_orient_portrait')  },
            { value: 'landscape', label: t('j2p_orient_landscape') },
          ].map(o => `
            <label class="j2p-chip${_orientation === o.value ? ' j2p-chip--active' : ''}" data-value="${o.value}" data-name="j2pOrient">
              <input type="radio" name="j2pOrient" value="${o.value}"${_orientation === o.value ? ' checked' : ''}>
              ${o.label}
            </label>
          `).join('')}
        </div>
      </div>
    </div>

    <div class="j2p-compress-block">
      <div class="j2p-compress-row">
        <div class="j2p-compress-label">
          <strong>${t('j2p_compress_images')}</strong>
          <small>${t('j2p_compress_desc')}</small>
        </div>
        <label class="j2p-toggle" aria-label="${t('j2p_compress_images')}">
          <input type="checkbox" id="j2pCompressCheck"${_compress ? ' checked' : ''}>
          <span class="j2p-toggle__track"></span>
          <span class="j2p-toggle__thumb"></span>
        </label>
      </div>

      <div class="j2p-quality-row${_compress ? '' : ' j2p-quality-row--disabled'}" id="j2pQualityRow">
        <div class="j2p-quality-header">
          <span>${t('j2p_quality')}</span>
          <span class="j2p-quality-val" id="j2pQualityVal">${Math.round(_quality * 100)}%</span>
        </div>
        <input type="range" id="j2pQuality" class="j2p-quality-slider"
               min="40" max="100" step="1" value="${Math.round(_quality * 100)}"
               aria-label="${t('j2p_aria_quality', { pct: Math.round(_quality * 100) })}">
      </div>
    </div>

    ${presetRememberCard({
      id:       'jpg2pdfRememberCheck',
      checked:  loadPreset('jpg2pdf') !== null,
      title:    '💾 ' + t('preset_remember_title'),
      subtitle: t('preset_remember_sub'),
      ariaLabel: t('preset_remember_title'),
    })}
  `;
}

function _render(files) {
  const container = id('jpg2pdfOptions');
  if (!container) return;

  if (!_settingsRendered) {
    _settingsRendered = true;
    container.innerHTML = `<div id="j2pPreviewsWrap">${_previewsHtml(files)}</div>${_settingsHtml()}`;
    _bindSettingsEvents();
  } else {
    const wrap = id('j2pPreviewsWrap');
    if (wrap) wrap.innerHTML = _previewsHtml(files);
  }

  _bindThumbGridEvents();
  _renderPreviews(files);
}


// ── Canvas previews ────────────────────────────────────────────
// Рендерим миниатюры после того как DOM готов.
// createImageBitmap не блокирует — идеально.

// File → decoded <img> element. Keyed by the File object itself (not index,
// which changes on every reorder) so dragging to reorder redraws instantly
// from cache instead of re-fetching + re-decoding every image again — this
// matters more now that the old 20-file cap is gone and a batch can be large.
const _imgCache = new WeakMap();

async function _loadImage(file) {
  const cached = _imgCache.get(file);
  if (cached) return cached;

  // HEIC/HEIF: no browser except Safari can decode it into an <img>, so
  // decode to JPEG first via the vendored libheif WASM build. Cached
  // inside heicDecode.js itself, so this costs nothing extra when
  // _runJpg2Pdf (processor.js) decodes the same file again at conversion time.
  const source = isHeicFile(file) ? (await decodeHeicToJpegBlob(file)) ?? file : file;

  const url = URL.createObjectURL(source);
  const img = new Image();
  // onerror = res (not rej) is intentional: preview is cosmetic, we don't
  // want one broken image to abort the entire preview loop. Resolving on
  // error also guarantees URL.revokeObjectURL runs in all cases without
  // needing a try/finally — the promise always resolves, revoke always runs.
  await new Promise(res => { img.onload = res; img.onerror = res; img.src = url; });
  URL.revokeObjectURL(url);
  _imgCache.set(file, img);
  return img;
}

async function _renderPreviews(files) {
  for (let i = 0; i < files.length; i++) {
    const canvas = document.querySelector(`.j2p-thumb__canvas[data-index="${i}"]`);
    if (!canvas) continue;
    try {
      const img = await _loadImage(files[i]);
      if (!img.naturalWidth) continue; // failed to decode — leave canvas blank

      const ctx = canvas.getContext('2d');
      const s   = Math.min(_THUMB_RASTER_SIZE / img.naturalWidth, _THUMB_RASTER_SIZE / img.naturalHeight);
      const w   = img.naturalWidth  * s;
      const h   = img.naturalHeight * s;

      // Apply EXIF rotation on preview
      const angle = _exifAngles[i] || 0;
      const half = _THUMB_RASTER_SIZE / 2;
      ctx.clearRect(0, 0, _THUMB_RASTER_SIZE, _THUMB_RASTER_SIZE);
      ctx.save();
      ctx.translate(half, half);
      ctx.rotate(angle * Math.PI / 180);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();
    } catch { /* silent — preview is cosmetic */ }
  }
}

// ── Events ─────────────────────────────────────────────────────
// Split to match _render()'s two regions: settings events are delegated on
// the (never-destroyed) #jpg2pdfOptions container itself, so binding them
// once on first render is sufficient — a click on a LATER-created radio/
// checkbox still bubbles up to this same listener. The quality slider is
// bound directly (not delegated) but lives in the settings region, which
// is now only ever built once, so this binding stays valid for the whole
// tool session too. Thumb-grid events (drag-reorder) DO need re-binding on
// every refresh, since dragReorder.js's own doc comment is explicit that
// its listeners are per-item, not delegated, and thumbnails are real DOM
// nodes that get recreated on every file add/remove/reorder.

function _bindSettingsEvents() {
  const container = id('jpg2pdfOptions');

  container.addEventListener('change', e => {
    if (e.target.name === 'j2pSize') {
      _pageSize = e.target.value;
      container.querySelectorAll('[data-name="j2pSize"]').forEach(el => {
        el.classList.toggle('j2p-chip--active', el.dataset.value === _pageSize);
      });
    }
    if (e.target.name === 'j2pOrient') {
      _orientation = e.target.value;
      container.querySelectorAll('[data-name="j2pOrient"]').forEach(el => {
        el.classList.toggle('j2p-chip--active', el.dataset.value === _orientation);
      });
    }
    if (e.target.id === 'j2pCompressCheck') {
      _compress = e.target.checked;
      const row = id('j2pQualityRow');
      if (row) row.classList.toggle('j2p-quality-row--disabled', !_compress);
    }
    // Unchecking forgets immediately — saving happens centrally in app.js
    // (_maybeSavePreset) right before processing starts.
    if (e.target.id === 'jpg2pdfRememberCheck' && !e.target.checked) {
      clearPreset('jpg2pdf');
    }
  });

  const slider = id('j2pQuality');
  if (slider) {
    slider.addEventListener('input', () => {
      _quality = slider.value / 100;
      const val = id('j2pQualityVal');
      if (val) val.textContent = slider.value + '%';
      // (label update removed — new design shows percentage in the slider header only)
    });
  }

}

function _bindThumbGridEvents() {
  const container = id('jpg2pdfOptions');
  if (!container) return;

  // Drag-to-reorder the thumbnail grid — mouse + touch, shared with merge's
  // file list (dragReorder.js). selectedFiles and _exifAngles are spliced
  // in lockstep so a thumbnail's rotation correction follows it to its new
  // position instead of staying pinned to the old index.
  const previews = container.querySelector('.j2p-previews');
  if (previews) {
    bindDragReorder({
      container:    previews,
      itemSelector: '.j2p-thumb',
      arrays:       [selectedFiles, _exifAngles],
      onReorder:    () => _render(selectedFiles), // _render() only refreshes the thumb grid now — settings untouched
      isLocked:     isFilesLocked,
      mode:         'grid',
    });
  }
}

// ── EXIF angle extraction ──────────────────────────────────────
// Читаем первые 64KB файла — там всегда APP1 сегмент с EXIF.
// Тег 0x0112 (Orientation):
//   1 = normal, 3 = 180°, 6 = 90° CW, 8 = 90° CCW
// Это критично для фото с мобильных — без коррекции PDF выходит повёрнутым.

async function _readExifAngle(file) {
  if (!file.type.includes('jpeg') && !file.name.toLowerCase().endsWith('.jpg')) return 0;
  try {
    const slice = file.slice(0, 65536);
    const buf   = await slice.arrayBuffer();
    const view  = new DataView(buf);
    // Check JPEG magic
    if (view.getUint16(0) !== 0xFFD8) return 0;
    let offset = 2;
    while (offset < buf.byteLength - 1) {
      const marker = view.getUint16(offset);
      if (marker === 0xFFE1) { // APP1
        const segLen = view.getUint16(offset + 2);
        const exifHeader = String.fromCharCode(
          view.getUint8(offset + 4), view.getUint8(offset + 5),
          view.getUint8(offset + 6), view.getUint8(offset + 7)
        );
        if (exifHeader === 'Exif') {
          return _extractOrientation(view, offset + 10);
        }
        offset += 2 + segLen;
      } else if ((marker & 0xFF00) === 0xFF00) {
        offset += 2 + view.getUint16(offset + 2);
      } else break;
    }
  } catch { /* ignore — non-critical */ }
  return 0;
}

function _extractOrientation(view, tiffStart) {
  try {
    const littleEndian = view.getUint16(tiffStart) === 0x4949;
    const ifdOffset    = view.getUint32(tiffStart + 4, littleEndian);
    const entryCount   = view.getUint16(tiffStart + ifdOffset, littleEndian);
    for (let i = 0; i < entryCount; i++) {
      const entryOffset = tiffStart + ifdOffset + 2 + i * 12;
      if (view.getUint16(entryOffset, littleEndian) === 0x0112) {
        const val = view.getUint16(entryOffset + 8, littleEndian);
        return { 1: 0, 3: 180, 6: 90, 8: -90 }[val] ?? 0;
      }
    }
    return 0;
  } catch {
    // Corrupted EXIF structure — safe fallback, no rotation applied
    return 0;
  }
}

// ── Helpers ────────────────────────────────────────────────────

function _truncName(name, max) {
  if (name.length <= max) return name;
  const ext = name.lastIndexOf('.');
  const e   = ext > 0 ? name.slice(ext) : '';
  return name.slice(0, max - e.length - 1) + '…' + e;
}

function _esc(str) {
  const d = document.createElement('div'); d.textContent = str; return d.innerHTML;
}
