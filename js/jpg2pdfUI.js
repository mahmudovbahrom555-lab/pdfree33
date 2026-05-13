// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

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
import { showToast } from './ui.js';
import { chip, chipGroup, checkbox, sliderRow, group, row } from './uiComponents.js';

// ── State ──────────────────────────────────────────────────────
let _pageSize    = 'auto';      // 'auto' | 'a4' | 'letter' | 'fit'
let _orientation = 'auto';     // 'auto' | 'portrait' | 'landscape'
let _compress    = true;
let _quality     = 0.82;       // JPEG quality 0–1
let _exifAngles  = [];         // cached EXIF rotation per file (degrees)

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

  container.innerHTML = `
    <div class="j2p-loading">
      <span class="compress-loading__spinner" aria-hidden="true"></span>
      Reading images…
    </div>
  `;
  container.style.display = 'block';

  // Read EXIF in parallel — fast, only first 64KB per file
  _exifAngles = await Promise.all(files.map(f => _readExifAngle(f)));

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
}

// ── Render ─────────────────────────────────────────────────────

function _render(files) {
  const container = id('jpg2pdfOptions');
  if (!container) return;

  const rotated = _exifAngles.filter(a => a !== 0).length;
  const exifNote = rotated > 0
    ? `<div class="j2p-exif-note" role="status">
         📐 ${rotated} image${rotated > 1 ? 's' : ''} will be auto-rotated (EXIF correction)
       </div>`
    : '';

  container.innerHTML = `
    ${exifNote}

    <div class="j2p-previews" aria-label="Image preview" role="list">
      ${files.slice(0, 20).map((f, i) => `
        <div class="j2p-thumb" role="listitem" data-index="${i}" title="${_esc(f.name)}">
          <canvas class="j2p-thumb__canvas" data-index="${i}"
                  width="48" height="48" aria-hidden="true"></canvas>
          <span class="j2p-thumb__name">${_truncName(f.name, 12)}</span>
          ${_exifAngles[i] !== 0 ? `<span class="j2p-thumb__badge" aria-label="Will be rotated">↺</span>` : ''}
        </div>
      `).join('')}
      ${files.length > 20
        ? `<div class="j2p-thumb j2p-thumb--more" role="listitem" aria-label="${files.length - 20} more images">
             <div class="j2p-thumb__more-box">+${files.length - 20}</div>
             <span class="j2p-thumb__name">more</span>
           </div>`
        : ''}
    </div>

    <div class="j2p-row">
      <div class="j2p-group">
        <span class="j2p-group__label">Page size</span>
        <div class="j2p-chips" role="group" aria-label="Page size">
          ${[
            { value: 'auto',   label: '📐 Auto'  },
            { value: 'a4',     label: 'A4'       },
            { value: 'letter', label: 'Letter'   },
            { value: 'fit',    label: '⤡ Fit'   },
          ].map(o => `
            <label class="j2p-chip${_pageSize === o.value ? ' j2p-chip--active' : ''}" data-value="${o.value}" data-name="j2pSize">
              <input type="radio" name="j2pSize" value="${o.value}"${_pageSize === o.value ? ' checked' : ''}>
              ${o.label}
            </label>
          `).join('')}
        </div>
      </div>

      <div class="j2p-group">
        <span class="j2p-group__label">Orientation</span>
        <div class="j2p-chips" role="group" aria-label="Orientation">
          ${[
            { value: 'auto',      label: '🔄 Auto'      },
            { value: 'portrait',  label: '▯ Portrait'   },
            { value: 'landscape', label: '▭ Landscape'  },
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
          <strong>Compress images</strong>
          <small>Reduces PDF size — JPEG quality stays high</small>
        </div>
        <label class="j2p-toggle" aria-label="Compress images">
          <input type="checkbox" id="j2pCompressCheck"${_compress ? ' checked' : ''}>
          <span class="j2p-toggle__track"></span>
          <span class="j2p-toggle__thumb"></span>
        </label>
      </div>

      <div class="j2p-quality-row${_compress ? '' : ' j2p-quality-row--disabled'}" id="j2pQualityRow">
        <div class="j2p-quality-header">
          <span>Quality</span>
          <span class="j2p-quality-val" id="j2pQualityVal">${Math.round(_quality * 100)}%</span>
        </div>
        <input type="range" id="j2pQuality" class="j2p-quality-slider"
               min="40" max="100" step="1" value="${Math.round(_quality * 100)}"
               aria-label="JPEG quality ${Math.round(_quality * 100)}%">
      </div>
    </div>
  `;

  _bindEvents();
  _renderPreviews(files);
}


// ── Canvas previews ────────────────────────────────────────────
// Рендерим миниатюры после того как DOM готов.
// createImageBitmap не блокирует — идеально.

async function _renderPreviews(files) {
  // Only render the first 20 thumbnails — DOM is also capped at 20
  const visible = files.slice(0, 20);
  for (let i = 0; i < visible.length; i++) {
    const canvas = document.querySelector(`.j2p-thumb__canvas[data-index="${i}"]`);
    if (!canvas) continue;
    try {
      const url    = URL.createObjectURL(visible[i]);
      const img    = new Image();
      // onerror = res (not rej) is intentional: preview is cosmetic, we don't
      // want one broken image to abort the entire preview loop. Resolving on
      // error also guarantees URL.revokeObjectURL runs in all cases without
      // needing a try/finally — the promise always resolves, revoke always runs.
      await new Promise(res => { img.onload = res; img.onerror = res; img.src = url; });
      URL.revokeObjectURL(url);

      const ctx = canvas.getContext('2d');
      const s   = Math.min(48 / img.naturalWidth, 48 / img.naturalHeight);
      const w   = img.naturalWidth  * s;
      const h   = img.naturalHeight * s;

      // Apply EXIF rotation on preview
      const angle = _exifAngles[i] || 0;
      ctx.save();
      ctx.translate(24, 24);
      ctx.rotate(angle * Math.PI / 180);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();
    } catch { /* silent — preview is cosmetic */ }
  }
}

// ── Events ─────────────────────────────────────────────────────

function _bindEvents() {
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
