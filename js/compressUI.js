// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

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

import { id }      from './utils.js';
import { showToast } from './ui.js';
import { fmtSize }  from './utils.js';
import { chip, sliderRow, checkbox, loadingRow } from './uiComponents.js';

// ── State ──────────────────────────────────────────────────────
let _preset       = 'medium';  // 'low' | 'medium' | 'high'
let _preserveText = true;

export function getCompressParams() {
  return { preset: _preset, preserveText: _preserveText };
}

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

  // Ограничение по размеру: 150 МБ
  if (file.size > 150 * 1024 * 1024) {
    showToast('⚠️ File too large (max 150 MB)', 5000);
    return;
  }

  container.innerHTML = loadingRow('Scanning PDF…');
  container.style.display = 'block';

  let scan = null;
  try {
    scan = await _scanFile(file);
  } catch {
    // Не смогли просканировать — показываем UI без scan-данных
  }

  _render(file, scan);
}

/** Скрывает и очищает панель */
export function hideCompressOptions() {
  const container = id('compressOptions');
  if (!container) return;
  container.style.display = 'none';
  container.innerHTML = '';
  _preset       = 'medium';
  _preserveText = true;
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
  // Убираем предыдущий репорт если есть
  id('compressReport')?.remove();

  const { originalSize, compressedSize, savedBytes, report } = data;
  const pct = originalSize > 0 ? Math.round((savedBytes / originalSize) * 100) : 0;
  const isOptimized = pct < 2;

  // Собираем breakdown items
  const items = [];
  if (report.hasXMP)        items.push({ icon: '📋', label: 'XMP metadata stream removed' });
  if (report.thumbnails > 0) items.push({ icon: '🖼️', label: `${report.thumbnails} embedded thumbnail${report.thumbnails > 1 ? 's' : ''} removed` });
  if (report.hasPieceInfo)  items.push({ icon: '🔧', label: 'Adobe PieceInfo metadata removed' });
  if (report.metadataFields > 0) items.push({ icon: '🏷️', label: `${report.metadataFields} metadata fields cleared` });
  if (report.imagesRecompressed > 0) {
    const imgSaved = report.imagesSavedBytes ?? 0;
    items.push({ icon: '📸', label: `${report.imagesRecompressed} image${report.imagesRecompressed > 1 ? 's' : ''} recompressed${imgSaved > 0 ? ' (−' + fmtSize(imgSaved) + ')' : ''}` });
  }
  items.push({ icon: '📦', label: 'Object stream compression applied' });

  const div = document.createElement('div');
  div.id        = 'compressReport';
  div.className = `compress-report${isOptimized ? ' compress-report--optimized' : ''}`;

  // gauge: visually shows before → after
  // Fill анимируется через JS ниже (CSS transition)
  div.innerHTML = `
    <div class="compress-report__gauge" role="img" aria-label="Compression: ${pct}% saved">
      <div class="compress-report__gauge-track">
        <div
          class="compress-report__gauge-fill"
          style="width:0%"
          data-target="${Math.min(Math.max(pct, 0), 100)}"
          aria-hidden="true"
        ></div>
      </div>
      <div class="compress-report__gauge-meta">
        <span class="compress-report__size">${fmtSize(originalSize)}</span>
        <span class="compress-report__pct ${pct > 0 ? 'compress-report__pct--saved' : ''}">
          ${pct > 0 ? `−${pct}% smaller` : 'No change'}
        </span>
        <span class="compress-report__size">${fmtSize(compressedSize)}</span>
      </div>
    </div>

    ${isOptimized
      ? `<div class="compress-report__note">
           ℹ️ This PDF is already well-optimized — not much left to remove.
           For image-heavy PDFs, our upcoming <strong>Ghostscript engine</strong>
           will deliver deeper compression.
         </div>`
      : `<div class="compress-report__breakdown" aria-label="What was optimized">
           ${items.map((it, i) => `
             <div class="compress-report__item" style="animation-delay:${i * 60}ms">
               <span class="compress-report__item-icon" aria-hidden="true">${it.icon}</span>
               <span class="compress-report__item-label">${it.label}</span>
               <span class="compress-report__item-check" aria-hidden="true">✓</span>
             </div>
           `).join('')}
         </div>`
    }
  `;

  // Вставляем после successDesc
  id('successDesc')?.insertAdjacentElement('afterend', div);

  // Анимируем gauge после двух rAF (браузер должен успеть отрисовать display:block)
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

    ${scan ? _buildScanBanner(scan) : ''}

    <div class="compress-presets">
      ${_presetCard('low',    '🪶', 'Light',    'Removes thumbnails and info fields only. No image recompression — maximum compatibility.')}
      ${_presetCard('medium', '⚡', 'Standard', 'Recommended. Removes metadata + recompresses images at 82% quality. Big win on photo PDFs.')}
      ${_presetCard('high',   '🔥', 'Maximum',  'Aggressive image recompression (72%) + structure cleanup. Smallest file, minor quality loss.')}
    </div>

    ${checkbox({
      id:       'preserveTextCheck',
      checked:  _preserveText,
      title:    'Preserve text &amp; accessibility',
      subtitle: 'On Maximum: keeps PDF tagging intact (turn off for smallest file)',
      ariaLabel: 'Preserve text quality — keeps PDF tagging and structure trees intact',
    })}
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
    <label class="compress-preset ${_preset === value ? 'active' : ''}" data-preset="${value}">
      <input type="radio" name="compressPreset" value="${value}" ${_preset === value ? 'checked' : ''}>
      <span class="compress-preset__icon" aria-hidden="true">${icon}</span>
      <span class="compress-preset__label">${label}</span>
      <span class="compress-preset__desc">${desc}</span>
    </label>
  `;
}

// ── Events ─────────────────────────────────────────────────────
// Примечание: безопасно вешать на container каждый раз, т.к.
// _render() перезаписывает innerHTML → старые узлы уничтожаются.

function _bindEvents() {
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
