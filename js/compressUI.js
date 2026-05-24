// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  compressUI.js — Compress PDF UI
//
//  🎯 Три вещи сверх ТЗ:
//  1. Pre-scan: анализируем файл сразу при добавлении — пользователь
//     видит ЧТО будет удалено ещё до нажатия кнопки.
//  2. Compression Report: после успеха — анимированный gauge +
//     пошаговый breakdown ("удалён XMP · 3 thumbnail · stream +12%").
//  3. "Already optimized" state: честное сообщение вместо "0% saved".
// ============================================================

import { id, fmtSize } from './utils.js';
import { MAX_COMPRESS_MB, SCAN_LIMIT_MB } from './config.js';
import { showToast } from './ui.js';
import { t } from './i18n.js';
import { chip, sliderRow, checkbox, loadingRow } from './uiComponents.js';
import { loadPdfLib } from './lazyLibs.js';
import { wmRemoveHtml, bindWmRemove, resetWmRemove } from './watermarkRemoveUI.js';

// ── State ──────────────────────────────────────────────────────
let _preset       = 'medium';  // 'low' | 'medium' | 'high'
let _preserveText = true;
let _targetDpi    = 150;       // null = no downsampling | 96 | 150
let _lastScan     = null;      // result of _scanFile(), null if skipped or not yet run

// Default DPI per preset (applied when user switches presets)
const _dpiDefaults = { low: null, medium: 150, high: 96 };

export function getCompressParams() {
  return { preset: _preset, preserveText: _preserveText, targetDpi: _targetDpi };
}

/** Returns the pre-scan result for the current file, or null if scan was skipped. */
export function getCompressScan() { return _lastScan; }

// ── Public API ─────────────────────────────────────────────────

/**
 * Инициализирует панель сжатия для загруженного файла.
 * Сразу запускает pre-scan через window.PDFLib (уже загружен для splitUI)
 * и показывает что конкретно будет удалено.
 * @param {File} file
 */
export async function initCompressOptions(file) {
  const container = id('compressOptions');
  if (!container) return;

  // Always show the panel immediately so stale data from a previous file never lingers.
  container.style.display = 'block';

  if (file.size > MAX_COMPRESS_MB * 1024 * 1024) {
    container.innerHTML = `
      <div class="compress-info">
        <span class="compress-info__name" title="${_esc(file.name)}">${_truncName(file.name)}</span>
        <span class="compress-info__dot" aria-hidden="true">·</span>
        <span class="compress-info__meta">${fmtSize(file.size)}</span>
      </div>
      <div class="compress-scan compress-scan--warn" role="alert">
        ⚠️ File too large for browser compression (max 150 MB).
        Try splitting it first, or use a desktop tool.
      </div>`;
    return;
  }

  container.innerHTML = loadingRow('Scanning PDF…');

  // Skip full PDFDocument.load for large files — it would consume 3–5× file size
  // in main thread heap (e.g. 25 MB file → ~120 MB RAM). Threshold: SCAN_LIMIT_MB.
  _lastScan = null;
  if (file.size <= SCAN_LIMIT_MB * 1024 * 1024) {
    try {
      _lastScan = await _scanFile(file);
    } catch {
      // Scan failed silently — UI still shows with _lastScan=null
    }
  }

  if (file.size > 40 * 1024 * 1024) {
    showToast(t('warn_compress_large', { size: fmtSize(file.size) }), 7000);
  }

  _render(file, _lastScan);
}

/** Скрывает и очищает панель */
export function hideCompressOptions() {
  const container = id('compressOptions');
  if (!container) return;
  container.style.display = 'none';
  container.innerHTML = '';
  _preset       = 'medium';
  _preserveText = true;
  _targetDpi    = 150;
  _lastScan     = null;
  resetWmRemove();
}

/**
 * Рендерит compression report прямо в success card.
 * Вызывается из app.js после получения pdfree:success для tool='compress'.
 *
 * Показывает:
 * - Анимированный gauge: исходный → сжатый с % экономии
 * - Пошаговый breakdown того что было найдено и удалено
 * - Если экономия < 2% — честное сообщение "already optimized"
 *   с советом про будущий Ghostscript движок
 *
 * @param {{ originalSize, compressedSize, savedBytes, report }} data
 */
export function renderCompressionReport(data) {
  id('compressReport')?.remove();

  const { originalSize, compressedSize, savedBytes, report } = data;
  const pct = originalSize > 0 ? Math.round((savedBytes / originalSize) * 100) : 0;

  // Absolute threshold — % misleads on large files (1.9% of 100 MB = 1.9 MB = real savings)
  const isOptimized = savedBytes < 50 * 1024;

  // Classify WHY compression was limited — basis for actionable hints
  // useObjectStreams=false → Light preset → image recompression was never attempted
  const lightPreset = !report.useObjectStreams;
  const noImages    = !lightPreset && report.imagesRecompressed === 0 && report.imagesSkipped === 0;
  const allSkipped  = !lightPreset && report.imagesRecompressed === 0 && report.imagesSkipped > 0;

  // Actionable hint — tells the user WHY and WHAT TO DO, not internal tech details.
  // Shown in isOptimized note (replaces generic message) and in breakdown footer.
  let whyNote = null;
  if (lightPreset) {
    whyNote = '💡 <strong>Switch to Standard preset</strong> to also recompress images — that\'s where most savings come from.';
  } else if (noImages) {
    whyNote = '📄 This PDF has no raster images — text and vectors don\'t compress much. Savings are from metadata and structure cleanup only.';
  } else if (allSkipped) {
    whyNote = '🎨 Images were found but use CMYK color profiles or transparency layers — the browser must preserve them to avoid color distortion. Metadata has been cleaned up.';
  }

  // Breakdown items
  const items = [];
  if (report.hasXMP)        items.push({ icon: '📋', label: 'XMP metadata stream removed' });
  if (report.thumbnails > 0) items.push({ icon: '🖼️', label: `${report.thumbnails} embedded thumbnail${report.thumbnails > 1 ? 's' : ''} removed` });
  if (report.hasPieceInfo)  items.push({ icon: '🔧', label: 'Adobe PieceInfo metadata removed' });
  if (report.metadataFields > 0) items.push({ icon: '🏷️', label: `${report.metadataFields} metadata fields cleared` });
  if (report.imagesRecompressed > 0) {
    const imgSaved = report.imagesSavedBytes ?? 0;
    items.push({ icon: '📸', label: `${report.imagesRecompressed} image${report.imagesRecompressed > 1 ? 's' : ''} recompressed${imgSaved > 0 ? ' (−' + fmtSize(imgSaved) + ')' : ''}` });
  }
  if (report.useObjectStreams) items.push({ icon: '📦', label: 'Object stream compression applied' });

  const div = document.createElement('div');
  div.id        = 'compressReport';
  div.className = `compress-report${isOptimized ? ' compress-report--optimized' : ''}`;

  div.innerHTML = `
    <div class="compress-report__hero" aria-label="${fmtSize(originalSize)} compressed to ${fmtSize(compressedSize)}">
      <span class="compress-report__hero-sizes">${fmtSize(originalSize)} → ${fmtSize(compressedSize)}</span>
      <span class="compress-report__hero-badge${pct <= 0 ? ' compress-report__hero-badge--neutral' : ''}">
        ${pct > 0 ? `−${pct}%` : 'No change'}
      </span>
    </div>
    <div class="compress-report__gauge" role="img" aria-hidden="true">
      <div class="compress-report__gauge-track">
        <div
          class="compress-report__gauge-fill"
          style="width:0%"
          data-target="${Math.min(Math.max(pct, 0), 100)}"
        ></div>
      </div>
    </div>

    ${isOptimized
      ? `<div class="compress-report__note">
           ${whyNote ?? 'ℹ️ This PDF is already well-optimized — not much left to remove. For image-heavy PDFs, our upcoming <strong>Ghostscript engine</strong> will deliver deeper compression.'}
         </div>`
      : `<div class="compress-report__breakdown" aria-label="What was optimized">
           ${items.map((it, i) => `
             <div class="compress-report__item" style="animation-delay:${i * 60}ms">
               <span class="compress-report__item-icon" aria-hidden="true">${it.icon}</span>
               <span class="compress-report__item-label">${it.label}</span>
               <span class="compress-report__item-check" aria-hidden="true">✓</span>
             </div>
           `).join('')}
           ${whyNote ? `<div class="compress-report__note" style="margin-top:8px">${whyNote}</div>` : ''}
         </div>`
    }
  `;

  id('successDesc')?.insertAdjacentElement('afterend', div);

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const fill = div.querySelector('.compress-report__gauge-fill');
    if (fill) fill.style.width = fill.dataset.target + '%';
  }));
}

// ── Pre-scan ──────────────────────────────────────────────────
// Использует window.PDFLib (загружен в main thread для splitUI).
// Читаем только структуру — не декомпрессируем контент.
// Для 50 МБ файла это занимает ~200-500ms — приемлемо.

async function _scanFile(file) {
  await loadPdfLib();
  const { PDFDocument, PDFName } = window.PDFLib;
  const buf = await file.arrayBuffer();
  const pdf = await PDFDocument.load(buf, { ignoreEncryption: true });

  const cat = pdf.catalog;
  const hasXMP       = cat.has(PDFName.of('Metadata'));
  const hasPieceInfo = cat.has(PDFName.of('PieceInfo'));
  const isEncrypted  = pdf.isEncrypted;

  let thumbCount = 0;
  let pageHasPieceInfo = false;
  for (const page of pdf.getPages()) {
    if (page.node.has(PDFName.of('Thumb')))    thumbCount++;
    if (page.node.has(PDFName.of('PieceInfo'))) pageHasPieceInfo = true;
  }

  // Сколько opportunities (0 = уже чистый)
  let opportunities = 0;
  if (hasXMP)                              opportunities++;
  if (thumbCount > 0)                      opportunities++;
  if (hasPieceInfo || pageHasPieceInfo)    opportunities++;

  return {
    pageCount:    pdf.getPageCount(),
    hasXMP,
    hasPieceInfo: hasPieceInfo || pageHasPieceInfo,
    thumbCount,
    isEncrypted,
    opportunities,
    fileSize: file.size,
  };
}

// ── Render ─────────────────────────────────────────────────────

function _render(file, scan) {
  const container = id('compressOptions');
  if (!container) return;

  container.innerHTML = `
    <div class="compress-info">
      <span class="compress-info__name" title="${_esc(file.name)}">${_truncName(file.name)}</span>
      <span class="compress-info__dot" aria-hidden="true">·</span>
      <span class="compress-info__meta">${fmtSize(file.size)}${scan ? ` · ${scan.pageCount} page${scan.pageCount !== 1 ? 's' : ''}` : ''}</span>
      ${scan?.isEncrypted ? '<span class="compress-info__badge compress-info__badge--warn">🔒 encrypted</span>' : ''}
    </div>

    ${scan ? _buildScanBanner(scan) : file.size > SCAN_LIMIT_MB * 1024 * 1024 ? `<div class="compress-scan compress-scan--info" role="status">ℹ️ ${t('compress_scan_skipped')}</div>` : ''}

    <div class="compress-presets">
      ${_presetCard('low',    '🪶', 'Light',    'Removes thumbnails and info fields only. No image recompression, no DPI change — maximum compatibility.')}
      ${_presetCard('medium', '⚡', 'Standard', 'Recommended. Removes metadata + recompresses images at 82% quality. Big win on photo PDFs.')}
      ${_presetCard('high',   '🔥', 'Maximum',  'Aggressive image recompression (72%) + structure cleanup. Smallest file, minor quality loss.')}
    </div>

    ${_dpiRow()}

    ${checkbox({
      id:       'preserveTextCheck',
      checked:  _preserveText,
      title:    'Preserve text &amp; accessibility',
      subtitle: 'On Maximum: keeps PDF tagging intact (turn off for smallest file)',
      ariaLabel: 'Preserve text quality — keeps PDF tagging and structure trees intact',
    })}

    ${wmRemoveHtml()}
  `;

  _bindEvents();

  if (scan?.isEncrypted) {
    showToast('⚠️ Encrypted PDF — some content may not be fully optimized', 5000);
  }
}

function _buildScanBanner(scan) {
  if (scan.opportunities === 0) {
    return `
      <div class="compress-scan compress-scan--clean" role="status">
        ✅ PDF looks clean — no redundant metadata detected
      </div>
    `;
  }

  const found = [];
  if (scan.hasXMP)                          found.push('XMP stream');
  if (scan.thumbCount > 0)                  found.push(`${scan.thumbCount} thumbnail${scan.thumbCount > 1 ? 's' : ''}`);
  if (scan.hasPieceInfo)                    found.push('PieceInfo metadata');

  return `
    <div class="compress-scan compress-scan--found" role="status">
      🔍 Found: <strong>${found.join(' · ')}</strong> — will be removed automatically
    </div>
  `;
}

function _presetCard(value, icon, label, desc) {
  return `
    <label class="compress-preset ${_preset === value ? 'j2p-chip--active' : ''}" data-preset="${value}">
      <input type="radio" name="compressPreset" value="${value}" ${_preset === value ? 'checked' : ''}>
      <span class="compress-preset__icon" aria-hidden="true">${icon}</span>
      <span class="compress-preset__label">${label}</span>
      <span class="compress-preset__desc">${desc}</span>
    </label>
  `;
}

function _dpiRow() {
  if (_preset === 'low') return '';
  const opts = [
    { value: 96,   label: 'Email',    hint: '96 DPI' },
    { value: 150,  label: 'Web',      hint: '150 DPI' },
    { value: null, label: 'Original', hint: 'no resize' },
  ];
  return `
    <div class="compress-dpi" role="group" aria-label="Image resolution">
      <span class="compress-dpi__label">Image resolution</span>
      <div class="compress-dpi__chips">
        ${opts.map(o => `
          <label class="compress-dpi__chip ${_targetDpi === o.value ? 'active' : ''}" data-dpi="${o.value ?? 'null'}">
            <input type="radio" name="compressDpi" value="${o.value ?? 'null'}" ${_targetDpi === o.value ? 'checked' : ''}>
            <span>${o.label}</span>
            <span class="compress-dpi__hint">${o.hint}</span>
          </label>`).join('')}
      </div>
    </div>`;
}

// ── Events ─────────────────────────────────────────────────────
// Примечание: безопасно вешать на container каждый раз, т.к.
// _render() перезаписывает innerHTML → старые узлы уничтожаются.

function _bindEvents() {
  bindWmRemove();

  id('compressOptions').addEventListener('change', e => {
    if (e.target.name === 'compressPreset') {
      _preset = e.target.value;
      document.querySelectorAll('.compress-preset').forEach(el => {
        el.classList.toggle('j2p-chip--active', el.dataset.preset === _preset);
      });
      // preserveText only has effect on High preset — dim the label otherwise
      const preserveLabel = document.querySelector('.compress-preserve');
      if (preserveLabel) {
        preserveLabel.classList.toggle('compress-preserve--inactive', _preset !== 'high');
      }
      // Apply preset DPI default and update DPI row visibility
      _targetDpi = _dpiDefaults[_preset] ?? null;
      const dpiRow = document.querySelector('.compress-dpi');
      if (_preset === 'low') {
        if (dpiRow) dpiRow.style.display = 'none';
      } else {
        if (dpiRow) {
          dpiRow.style.display = '';
          // Sync chip active state to new DPI
          dpiRow.querySelectorAll('.compress-dpi__chip').forEach(chip => {
            const val = chip.dataset.dpi === 'null' ? null : Number(chip.dataset.dpi);
            chip.classList.toggle('active', val === _targetDpi);
          });
          const matchingInput = dpiRow.querySelector(`input[value="${_targetDpi ?? 'null'}"]`);
          if (matchingInput) matchingInput.checked = true;
        }
      }
    }
    if (e.target.name === 'compressDpi') {
      const raw = e.target.value;
      _targetDpi = raw === 'null' ? null : Number(raw);
      document.querySelectorAll('.compress-dpi__chip').forEach(chip => {
        const val = chip.dataset.dpi === 'null' ? null : Number(chip.dataset.dpi);
        chip.classList.toggle('active', val === _targetDpi);
      });
    }
    if (e.target.id === 'preserveTextCheck') {
      _preserveText = e.target.checked;
    }
  });
}

// ── Helpers ────────────────────────────────────────────────────

function _truncName(name) {
  return name.length > 35 ? name.slice(0, 32) + '…' : name;
}

function _esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
