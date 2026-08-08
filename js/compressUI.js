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
import { MAX_COMPRESS_MB } from './config.js';
import { showToast } from './ui.js';
import { t, tp } from './i18n.js';
import { sliderRow, checkbox, presetRememberCard } from './uiComponents.js';
import { wmRemoveHtml, bindWmRemove, resetWmRemove } from './watermarkRemoveUI.js';
import { loadPreset, clearPreset } from './presets.js';

// Locale-correct slug for the "splitting" cross-link in the email-size verdict
// below. This module is shared across every locale's page, and the Split PDF
// tool is served at a translated pathname in every non-English locale — a
// bare '/split-pdf/' href resolves to the English page regardless of which
// locale the user is on. Mirrors the per-locale slugs in data/tools-config.json
// (same table/pattern as the fix in js/ocrUI.js).
const SPLIT_SLUGS = { en: 'split-pdf', de: 'pdf-aufteilen', es: 'dividir-pdf', fr: 'diviser-pdf', pt: 'dividir-pdf', id: 'pisah-pdf', vi: 'tach-pdf', ru: 'razdelit-pdf', ja: 'pdf-bunkatsu', tr: 'pdf-bol', it: 'dividi-pdf', ko: 'pdf-bunhal', nl: 'pdf-splitsen', pl: 'podziel-pdf' };
const KNOWN_LOCALES = new Set(['de', 'es', 'fr', 'pt', 'id', 'vi', 'ru', 'ja', 'it', 'ko', 'nl', 'pl', 'tr']);

function _splitHref() {
  const seg = location.pathname.split('/')[1];
  const lc  = KNOWN_LOCALES.has(seg) ? seg : 'en';
  const slug = SPLIT_SLUGS[lc] || SPLIT_SLUGS.en;
  return lc === 'en' ? `/${slug}/` : `/${lc}/${slug}/`;
}

// ── State ──────────────────────────────────────────────────────
let _preset       = 'medium';  // 'low' | 'medium' | 'high'
let _preserveText = true;
let _targetDpi    = 150;       // null = no downsampling | 96 | 150
let _quality      = 82;        // JPEG quality %, 60–95 (sent as 0–1 to worker)
let _targetSizeMb = null;      // Target Size Mode: null | 25 | 10 | 5
let _lastScan     = null;      // scan report (background or worker), null until scan arrives
let _presetAutoSelected = false; // true when we auto-selected a preset from scan data
let _eventsBound  = false;     // listeners live on the persistent #compressOptions div — bind once
let _rememberLoaded = false;   // "Remember my settings" applied once per tool session — see initCompressOptions

// Defaults applied when user switches presets
const _dpiDefaults     = { low: null, medium: 150, high: 96 };
const _qualityDefaults = { medium: 82, high: 72 };

// Quality targets per size limit (Maximum preset + 96 DPI assumed)
const _targetQuality = { 25: 0.60, 10: 0.50, 5: 0.42 };

// ── Document classification + recommendation logic ─────────────

// Classify PDF into one of three types based on image byte ratio.
// imageRatio (image bytes / total bytes) is more reliable than imageCount
// because a single 4K cover image in a 100-page text doc should not make
// it "Mixed" — the imageRatio would be low and correctly classify as Text.
function _docType(scan) {
  const ratio = scan?.imageRatio ?? 0;
  if (ratio >= 0.5) return { icon: '📷', label: 'Scanned document', type: 'scan' };
  if (ratio >= 0.1) return { icon: '📚', label: 'Mixed document',   type: 'mixed' };
  return              { icon: '📄', label: 'Text document',     type: 'text' };
}

// Derive the recommended preset from doc type.
function _recommendedPreset(scan) {
  if (!scan) return 'medium';
  const doc = _docType(scan);
  if (doc.type === 'scan')  return 'high';
  if (doc.type === 'text' && scan.opportunities === 0) return 'low';
  return 'medium';
}

// Savings expectation string derived from doc type.
function _savingsTier(scan) {
  if (!scan) return '';
  const doc = _docType(scan);
  if (doc.type === 'scan')     return `🔥 ${t('compress_tier_high')}`;
  if (doc.type === 'mixed')    return `⚡ ${t('compress_tier_moderate')}`;
  if (scan.opportunities > 0) return `✅ ${t('compress_tier_minor')}`;
  return '';
}

// Rough compression time estimate (seconds) based on file size + preset.
// Only shown for files > 3 MB where the wait is noticeable.
function _timeEstimate(scan, preset) {
  const mb = (scan?.fileSize ?? 0) / (1024 * 1024);
  if (mb < 3) return null;
  const imageDom = scan?.imageDominant ?? false;
  const mult = imageDom
    ? { low: 0.1, medium: 2.2, high: 3.5 }[preset] ?? 2.2
    : { low: 0.08, medium: 0.25, high: 0.4 }[preset] ?? 0.25;
  const sec = Math.round(mb * mult);
  if (sec < 2) return null;
  return sec < 60 ? `${sec}s` : `${Math.round(sec / 60)}min`;
}

// Target Size Mode chip row (shown below DPI row)
function _targetSizeRow() {
  const opts = [
    { value: null, label: t('compress_target_best'), hint: '' },
    { value: 25,   label: t('compress_target_email'), hint: '< 25 MB' },
    { value: 10,   label: t('compress_target_web'),   hint: '< 10 MB' },
    { value: 5,    label: t('compress_target_small'), hint: '< 5 MB'  },
  ];
  return `
    <div class="compress-dpi compress-target" role="group" aria-label="${t('compress_target_label')}">
      <span class="compress-dpi__label">${t('compress_target_label')}</span>
      <div class="compress-dpi__chips">
        ${opts.map(o => `
          <label class="compress-dpi__chip ${_targetSizeMb === o.value ? 'active' : ''}" data-target="${o.value ?? 'null'}">
            <input type="radio" name="compressTarget" value="${o.value ?? 'null'}" ${_targetSizeMb === o.value ? 'checked' : ''}>
            <span>${o.label}</span>
            ${o.hint ? `<span class="compress-dpi__hint">${o.hint}</span>` : ''}
          </label>`).join('')}
      </div>
    </div>`;
}

// Update #compressTimeEst span based on current scan + preset.
function _updateTimeEstimate() {
  const el  = id('compressTimeEst');
  if (!el) return;
  const est = _timeEstimate(_lastScan, _preset);
  el.textContent = est ? ` · ${t('compress_time_est', { t: est })}` : '';
}

// Apply preset defaults to quality/DPI sliders without re-rendering the whole panel.
function _syncPresetDefaults(preset) {
  _quality   = _qualityDefaults[preset] ?? 82;
  _targetDpi = _dpiDefaults[preset] ?? null;

  const qualityRow = id('qualityRow');
  const dpiRow     = document.querySelector('.compress-dpi');

  if (preset === 'low') {
    if (qualityRow) qualityRow.style.display = 'none';
    if (dpiRow)     dpiRow.style.display     = 'none';
  } else {
    if (qualityRow) {
      qualityRow.style.display = '';
      const slider = id('qualitySlider');
      if (slider) slider.value = _quality;
      const valEl = id('qualityVal');
      if (valEl) valEl.textContent = `${_quality}%`;
    }
    if (dpiRow) {
      dpiRow.style.display = '';
      dpiRow.querySelectorAll('.compress-dpi__chip').forEach(chip => {
        const v = chip.dataset.dpi === 'null' ? null : Number(chip.dataset.dpi);
        chip.classList.toggle('active', v === _targetDpi);
      });
      const matchingInput = dpiRow.querySelector(`input[value="${_targetDpi ?? 'null'}"]`);
      if (matchingInput) matchingInput.checked = true;
    }
  }
  _updateTimeEstimate();
}

export function getCompressParams() {
  return {
    preset:       _preset,
    preserveText: _preserveText,
    targetDpi:    _targetDpi,
    quality:      _quality / 100,
    targetSizeMb: _targetSizeMb,
  };
}

/** Returns the pre-scan result for the current file, or null if scan was skipped. */
export function getCompressScan() { return _lastScan; }

// ── Public API ─────────────────────────────────────────────────

/**
 * Инициализирует панель сжатия для загруженного файла.
 * Отображает UI немедленно; scan запускается в worker при нажатии кнопки
 * (Phase 0 handleCompress) — без ограничения по размеру файла.
 * @param {File} file
 */
export function initCompressOptions(file) {
  const container = id('compressOptions');
  if (!container) return;

  container.style.display = 'block';

  if (file.size > MAX_COMPRESS_MB * 1024 * 1024) {
    container.innerHTML = `
      <div class="compress-info">
        <span class="compress-info__name" title="${_esc(file.name)}">${_truncName(file.name)}</span>
        <span class="compress-info__dot" aria-hidden="true">·</span>
        <span class="compress-info__meta">${fmtSize(file.size)}</span>
      </div>
      <div class="compress-scan compress-scan--warn" role="alert">
        ${t('cmp_file_too_large')}
      </div>`;
    return;
  }

  if (file.size > 40 * 1024 * 1024) {
    showToast(t('warn_compress_large', { size: fmtSize(file.size) }), 7000);
  }

  _lastScan = null;

  // Restore saved settings once per tool session — NOT on every file add,
  // so switching preset mid-session for a later file isn't silently
  // overwritten each time a new file lands (see hideCompressOptions,
  // which clears _rememberLoaded for the next fresh session).
  if (!_rememberLoaded) {
    _rememberLoaded = true;
    const saved = loadPreset('compress');
    if (saved) {
      _preset       = saved.preset       ?? _preset;
      _preserveText = saved.preserveText ?? _preserveText;
      _targetDpi    = saved.targetDpi    ?? _targetDpi;
      _quality      = saved.quality != null ? Math.round(saved.quality * 100) : _quality;
      _targetSizeMb = saved.targetSizeMb ?? _targetSizeMb;
      _presetAutoSelected = true; // saved choice counts as explicit — don't let scan auto-override it
    }
  }

  _render(file, null);
}

/**
 * Обновляет scan-banner в compressOptions данными из worker scan-report.
 * Вызывается из app.js по событию pdfree:scan-report во время сжатия.
 * Заменяет placeholder "Analysis runs automatically…" реальными находками.
 * @param {{ pageCount, hasXMP, hasPieceInfo, thumbnails, isEncrypted, imageCount, imageDominant, opportunities }} report
 */
export function renderWorkerScanReport(report) {
  _lastScan = report;
  const container = id('compressOptions');
  if (!container || container.style.display === 'none') return;

  // Update scan banner (pass current targetDpi so DPI arrow shows immediately)
  const existing = id('compressScanBanner');
  const bannerHtml = _buildScanBanner(report, _targetDpi);
  if (existing) {
    existing.outerHTML = bannerHtml;
  } else {
    const info = container.querySelector('.compress-info');
    if (info) info.insertAdjacentHTML('afterend', bannerHtml);
    else container.insertAdjacentHTML('afterbegin', bannerHtml);
  }

  // Auto-select recommended preset if user hasn't manually changed it
  const rec = _recommendedPreset(report);
  if (!_presetAutoSelected && _preset === 'medium' && rec !== 'medium') {
    _preset             = rec;
    _presetAutoSelected = true;
    document.querySelectorAll('.compress-preset').forEach(el => {
      el.classList.toggle('j2p-chip--active', el.dataset.preset === _preset);
      const input = el.querySelector('input[type="radio"]');
      if (input) input.checked = input.value === _preset;
    });
    _syncPresetDefaults(_preset);
  }

  // Show time estimate in the tier span
  _updateTimeEstimate();


  // Add/update ⭐ Recommended badge on the correct preset card
  document.querySelectorAll('.compress-preset').forEach(el => {
    const value = el.dataset.preset;
    const label = el.querySelector('.compress-preset__label');
    if (!label) return;
    const existingBadge = label.querySelector('.compress-preset__rec');
    if (value === rec) {
      if (!existingBadge) {
        label.insertAdjacentHTML('beforeend', ` <span class="compress-preset__rec" aria-label="${t('cmp_recommended')}">⭐</span>`);
      }
    } else {
      existingBadge?.remove();
    }
  });

  // Update page count in file info bar (was unavailable at render time)
  const pcEl = id('compressPageCount');
  if (pcEl && report.pageCount > 0 && !pcEl.textContent) {
    pcEl.textContent = ` · ${report.pageCount} page${report.pageCount !== 1 ? 's' : ''}`;
  }

  // Show encrypted badge if discovered by scan
  if (report.isEncrypted) {
    const infoDiv = container.querySelector('.compress-info');
    if (infoDiv && !infoDiv.querySelector('.compress-info__badge--warn')) {
      infoDiv.insertAdjacentHTML('beforeend',
        '<span class="compress-info__badge compress-info__badge--warn">🔒 encrypted</span>');
    }
    showToast(t('cmp_encrypted_toast'), 5000);
  }
}

/** Скрывает и очищает панель */
export function hideCompressOptions() {
  const container = id('compressOptions');
  if (!container) return;
  container.style.display = 'none';
  container.innerHTML = '';
  _preset             = 'medium';
  _preserveText       = true;
  _targetDpi          = 150;
  _quality            = 82;
  _targetSizeMb       = null;
  _lastScan           = null;
  _presetAutoSelected = false;
  _rememberLoaded     = false;
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
  id('targetVerdict')?.remove();

  const { originalSize, compressedSize, savedBytes, report, targetSizeMb } = data;
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
    whyNote = t('cmp_why_light_preset');
  } else if (noImages) {
    whyNote = t('cmp_why_no_images');
  } else if (allSkipped) {
    whyNote = t('cmp_why_all_skipped');
  }

  // Breakdown items — each has an optional href to the glossary explanation page
  const G = '/pdf-compression-glossary/';
  const items = [];
  if (report.hasXMP)        items.push({ icon: '📋', label: t('cmp_item_xmp'),          href: `${G}#xmp` });
  if (report.thumbnails > 0) items.push({ icon: '🖼️', label: tp(report.thumbnails, 'cmp_item_thumb_one', 'cmp_item_thumb_many', { n: report.thumbnails }), href: `${G}#thumbnails` });
  if (report.hasPieceInfo)  items.push({ icon: '🔧', label: t('cmp_item_pieceinfo'),     href: `${G}#pieceinfo` });
  if (report.metadataFields > 0) items.push({ icon: '🏷️', label: t('cmp_item_metafields', { n: report.metadataFields }), href: `${G}#metadata-fields` });
  if (report.imagesDeduplicated > 0) {
    const dedupSaved = report.dedupSavedBytes ?? 0;
    const label = tp(report.imagesDeduplicated, 'cmp_item_dedup_one', 'cmp_item_dedup_many', { n: report.imagesDeduplicated });
    items.push({ icon: '🔁', label: `${label}${dedupSaved > 0 ? ' (−' + fmtSize(dedupSaved) + ')' : ''}`, href: `${G}#duplicate-images` });
  }
  if (report.imagesRecompressed > 0) {
    const imgSaved = report.imagesSavedBytes ?? 0;
    const label = tp(report.imagesRecompressed, 'cmp_item_recompressed_one', 'cmp_item_recompressed_many', { n: report.imagesRecompressed });
    items.push({ icon: '📸', label: `${label}${imgSaved > 0 ? ' (−' + fmtSize(imgSaved) + ')' : ''}`, href: `${G}#image-recompression` });
  }
  if (report.flateStreamsRepacked > 0) {
    const flateSaved = report.flateSavedBytes ?? 0;
    const label = tp(report.flateStreamsRepacked, 'cmp_item_flate_one', 'cmp_item_flate_many', { n: report.flateStreamsRepacked });
    items.push({ icon: '🗄️', label: `${label}${flateSaved > 0 ? ' (−' + fmtSize(flateSaved) + ')' : ''}`, href: `${G}#stream-repacking` });
  }
  if (report.useObjectStreams) items.push({ icon: '📦', label: t('cmp_item_objstreams'), href: `${G}#object-streams` });

  const div = document.createElement('div');
  div.id        = 'compressReport';
  div.className = `compress-report${isOptimized ? ' compress-report--optimized' : ''}`;

  div.innerHTML = `
    <div class="compress-report__hero" aria-label="${t('cmp_hero_aria', { orig: fmtSize(originalSize), comp: fmtSize(compressedSize) })}">
      <span class="compress-report__hero-sizes">${fmtSize(originalSize)} → ${fmtSize(compressedSize)}</span>
      <span class="compress-report__hero-badge${pct <= 0 ? ' compress-report__hero-badge--neutral' : ''}">
        ${pct > 0 ? `−${pct}%` : t('cmp_no_change')}
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
           ${whyNote ?? t('cmp_already_optimized')}
         </div>`
      : `<div class="compress-report__breakdown" aria-label="${t('cmp_breakdown_aria')}">
           ${items.map((it, i) => `
             <div class="compress-report__item" style="animation-delay:${i * 60}ms">
               <span class="compress-report__item-icon" aria-hidden="true">${it.icon}</span>
               <span class="compress-report__item-label">${it.label}${it.href ? ` <a href="${it.href}" class="compress-report__explain" title="${t('cmp_explain_title')}" aria-label="${t('cmp_explain_aria')}" style="font-size:11px;color:var(--green);text-decoration:none;opacity:0.7;vertical-align:middle">?</a>` : ''}</span>
               <span class="compress-report__item-check" aria-hidden="true">✓</span>
             </div>
           `).join('')}
           ${whyNote ? `<div class="compress-report__note" style="margin-top:8px">${whyNote}</div>` : ''}
           ${report.warnings?.length > 0 ? `<div class="compress-report__note" style="margin-top:8px;opacity:0.7">⚠️ ${report.warnings.join(' · ')}</div>` : ''}
         </div>`
    }
  `;

  id('successDesc')?.insertAdjacentElement('afterend', div);

  // Target Size verdict — show after the compression report
  if (targetSizeMb) {
    const targetBytes = targetSizeMb * 1024 * 1024;
    const met         = compressedSize < targetBytes;
    const targetLabel = `${targetSizeMb} MB`;
    const verdictEl   = document.createElement('div');
    verdictEl.id        = 'targetVerdict';
    verdictEl.className = `compress-scan ${met ? 'compress-scan--found' : 'compress-scan--warn'}`;
    verdictEl.setAttribute('role', 'status');
    verdictEl.style.marginTop = '12px';
    verdictEl.innerHTML = met
      ? t('compress_target_met',  { size: fmtSize(compressedSize), target: targetLabel })
      : t('compress_target_over', { size: fmtSize(compressedSize), target: targetLabel });
    div.insertAdjacentElement('afterend', verdictEl);
  }

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const fill = div.querySelector('.compress-report__gauge-fill');
    if (fill) fill.style.width = fill.dataset.target + '%';
  }));
}

// ── Render ─────────────────────────────────────────────────────

function _render(file, scan) {
  const container = id('compressOptions');
  if (!container) return;

  container.innerHTML = `
    <div class="compress-info">
      <span class="compress-info__name" title="${_esc(file.name)}">${_truncName(file.name)}</span>
      <span class="compress-info__dot" aria-hidden="true">·</span>
      <span class="compress-info__meta">${fmtSize(file.size)}<span id="compressPageCount">${scan ? ` · ${scan.pageCount} page${scan.pageCount !== 1 ? 's' : ''}` : ''}</span></span>
      ${scan?.isEncrypted ? '<span class="compress-info__badge compress-info__badge--warn">🔒 encrypted</span>' : ''}
    </div>

    ${scan ? _buildScanBanner(scan, _targetDpi) : `<div class="compress-scan compress-scan--info" id="compressScanBanner" role="status">🔍 ${t('compress_placeholder')}</div>`}

    <div class="compress-presets">
      ${_presetCard('low',    '🪶', t('cmp_preset_light_name'),    t('cmp_preset_light_desc'),    _lastScan && _recommendedPreset(_lastScan) === 'low')}
      ${_presetCard('medium', '⚡', t('cmp_preset_standard_name'), t('cmp_preset_standard_desc'), _lastScan && _recommendedPreset(_lastScan) === 'medium')}
      ${_presetCard('high',   '🔥', t('cmp_preset_maximum_name'),  t('cmp_preset_maximum_desc'),  _lastScan && _recommendedPreset(_lastScan) === 'high')}
    </div>

    ${_qualityRow()}

    ${_dpiRow()}

    ${_targetSizeRow()}

    ${checkbox({
      id:       'preserveTextCheck',
      checked:  _preserveText,
      title:    t('cmp_preserve_title'),
      subtitle: t('cmp_preserve_sub'),
      ariaLabel: t('cmp_preserve_aria'),
    })}

    ${wmRemoveHtml()}

    ${presetRememberCard({
      id:       'compressRememberCheck',
      checked:  loadPreset('compress') !== null,
      title:    '💾 ' + t('preset_remember_title'),
      subtitle: t('preset_remember_sub'),
      ariaLabel: t('preset_remember_title'),
    })}
  `;

  _bindEvents();

  if (scan?.isEncrypted) {
    showToast(t('cmp_encrypted_toast'), 5000);
  }
}

function _buildScanBanner(scan, targetDpi = null) {
  const thumbCount = scan.thumbnails ?? scan.thumbCount ?? 0;
  const doc        = _docType(scan);
  const tier       = _savingsTier(scan);
  const tierHtml   = tier ? `<br><span class="compress-scan__tier">${tier}<span id="compressTimeEst"></span></span>` : '';

  // DPI info + optional downsample arrow for scan docs
  let dpiSuffix = '';
  if (doc.type === 'scan' && scan.medianDpi >= 72) {
    dpiSuffix = ` · ~${scan.medianDpi} DPI`;
    if (targetDpi && targetDpi < scan.medianDpi) {
      dpiSuffix += `<br><span class="compress-scan__dpi-arrow">→ ${t('compress_dpi_downsample', { dpi: targetDpi })}</span>`;
    }
  }

  const imgSuffix = scan.imageCount > 0
    ? ` · ${tp(scan.imageCount, 'compress_img', 'compress_imgs')}${dpiSuffix}`
    : '';

  // Metadata findings
  const found = [];
  if (scan.hasXMP)       found.push(t('cmp_found_xmp_stream'));
  if (thumbCount > 0)    found.push(tp(thumbCount, 'compress_thumb', 'compress_thumbs'));
  if (scan.hasPieceInfo) found.push(t('cmp_found_pieceinfo'));
  const findingsHtml = found.length > 0
    ? ` · <strong>${found.join(', ')}</strong> ${t('compress_findings_found')}`
    : '';

  if (scan.opportunities === 0 && scan.imageCount === 0) {
    return `<div class="compress-scan compress-scan--clean" id="compressScanBanner" role="status">
      ${doc.icon} ${t(`compress_doc_${doc.type}`)} · ${t('compress_doc_clean')}
    </div>`;
  }

  return `<div class="compress-scan compress-scan--found" id="compressScanBanner" role="status">
    ${doc.icon} ${t(`compress_doc_${doc.type}`)}${imgSuffix}${findingsHtml}${tierHtml}
  </div>`;
}

function _qualityRow() {
  if (_preset === 'low') return '';
  return sliderRow({
    id:          'qualitySlider',
    containerId: 'qualityRow',
    label:       t('cmp_quality_label'),
    valId:       'qualityVal',
    valText:     `${_quality}%`,
    min:         60,
    max:         95,
    step:        1,
    value:       _quality,
    ariaLabel:   t('cmp_quality_aria'),
    style:       'margin-bottom:18px',
  });
}

function _presetCard(value, icon, label, desc, isRecommended = false) {
  const recBadge = isRecommended
    ? ` <span class="compress-preset__rec" aria-label="${t('cmp_recommended')}">⭐</span>`
    : '';
  return `
    <label class="compress-preset ${_preset === value ? 'j2p-chip--active' : ''}" data-preset="${value}">
      <input type="radio" name="compressPreset" value="${value}" ${_preset === value ? 'checked' : ''}>
      <span class="compress-preset__icon" aria-hidden="true">${icon}</span>
      <span class="compress-preset__label">${label}${recBadge}</span>
      <span class="compress-preset__desc">${desc}</span>
    </label>
  `;
}

function _dpiRow() {
  if (_preset === 'low') return '';
  const opts = [
    { value: 96,   label: t('cmp_dpi_email'),    hint: t('cmp_dpi_email_hint') },
    { value: 150,  label: t('cmp_dpi_web'),      hint: t('cmp_dpi_web_hint') },
    { value: null, label: t('cmp_dpi_original'), hint: t('cmp_dpi_original_hint') },
  ];
  return `
    <div class="compress-dpi" role="group" aria-label="${t('cmp_dpi_resolution_label')}">
      <span class="compress-dpi__label">${t('cmp_dpi_resolution_label')}</span>
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

function _bindEvents() {
  bindWmRemove();
  if (_eventsBound) return;
  _eventsBound = true;

  id('compressOptions').addEventListener('change', e => {
    if (e.target.name === 'compressPreset') {
      _preset             = e.target.value;
      _presetAutoSelected = true; // user explicitly chose — don't override on next scan
      _targetSizeMb       = null; // reset target size when preset changes manually
      document.querySelectorAll('.compress-preset').forEach(el => {
        el.classList.toggle('j2p-chip--active', el.dataset.preset === _preset);
      });
      // preserveText only has effect on High preset — dim the label otherwise
      const preserveLabel = document.querySelector('.compress-preserve');
      if (preserveLabel) {
        preserveLabel.classList.toggle('compress-preserve--inactive', _preset !== 'high');
      }
      // Apply preset quality default and sync slider
      const qualityRow = id('qualityRow');
      if (_preset === 'low') {
        if (qualityRow) qualityRow.style.display = 'none';
      } else {
        _quality = _qualityDefaults[_preset] ?? 82;
        if (qualityRow) {
          qualityRow.style.display = '';
          const slider = id('qualitySlider');
          if (slider) slider.value = _quality;
          const val = id('qualityVal');
          if (val) val.textContent = `${_quality}%`;
        }
      }

      // Apply preset DPI default and update DPI row visibility
      _targetDpi = _dpiDefaults[_preset] ?? null;
      const dpiRow = document.querySelector('.compress-dpi');
      if (_preset === 'low') {
        if (dpiRow) dpiRow.style.display = 'none';
      } else {
        if (dpiRow) {
          dpiRow.style.display = '';
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
    if (e.target.name === 'compressTarget') {
      const raw = e.target.value;
      _targetSizeMb = raw === 'null' ? null : Number(raw);
      // When a target is selected, force Maximum preset + 96 DPI + target quality
      if (_targetSizeMb !== null) {
        _preset             = 'high';
        _targetDpi          = 96;
        _presetAutoSelected = true;
        // Sync preset cards visual
        document.querySelectorAll('.compress-preset').forEach(el => {
          el.classList.toggle('j2p-chip--active', el.dataset.preset === 'high');
          const input = el.querySelector('input[type="radio"]');
          if (input) input.checked = input.value === 'high';
        });
        // _syncPresetDefaults overwrites _quality with the preset default (72%) —
        // we re-apply the target quality after so the slider shows the right value.
        _syncPresetDefaults('high');
        _quality = Math.round((_targetQuality[_targetSizeMb] ?? 0.60) * 100);
        const slider = id('qualitySlider');
        if (slider) slider.value = _quality;
        const valEl = id('qualityVal');
        if (valEl) valEl.textContent = `${_quality}%`;
      }
      document.querySelectorAll('.compress-target .compress-dpi__chip').forEach(chip => {
        const v = chip.dataset.target === 'null' ? null : Number(chip.dataset.target);
        chip.classList.toggle('active', v === _targetSizeMb);
      });
      _updateTimeEstimate();
    }
    if (e.target.id === 'preserveTextCheck') {
      _preserveText = e.target.checked;
    }
    // Unchecking forgets immediately — saving itself happens centrally in
    // app.js (_maybeSavePreset) right before processing starts, once the
    // final settings are known.
    if (e.target.id === 'compressRememberCheck' && !e.target.checked) {
      clearPreset('compress');
    }
  });

  // Slider needs 'input' (fires while dragging), not 'change' (fires on release only)
  id('compressOptions').addEventListener('input', e => {
    if (e.target.id === 'qualitySlider') {
      _quality = Number(e.target.value);
      const val = id('qualityVal');
      if (val) val.textContent = `${_quality}%`;
    }
  });
}

// ── Email mode ─────────────────────────────────────────────────
// Dedicated init/hide/verdict for the /compress-pdf-for-email/ page.
// Uses the same #compressOptions container and renderWorkerScanReport.
// getParams is fixed (no user controls) — always Maximum+96DPI+60%.

/**
 * Инициализирует email-режим сжатия: фиксированные настройки, нет слайдеров.
 * Scan запускается в worker (как Phase 0 handleCompress) — без ограничения по размеру.
 * @param {File} file
 */
export function initCompressEmailOptions(file) {
  const container = id('compressOptions');
  if (!container) return;
  container.style.display = 'block';

  if (file.size > MAX_COMPRESS_MB * 1024 * 1024) {
    container.innerHTML = `
      <div class="compress-info">
        <span class="compress-info__name" title="${_esc(file.name)}">${_truncName(file.name)}</span>
        <span class="compress-info__dot" aria-hidden="true">·</span>
        <span class="compress-info__meta">${fmtSize(file.size)}</span>
      </div>
      <div class="compress-scan compress-scan--warn" role="alert">
        ${t('cmp_file_too_large')}
      </div>`;
    return;
  }

  _lastScan = null;

  container.innerHTML = `
    <div class="compress-info">
      <span class="compress-info__name" title="${_esc(file.name)}">${_truncName(file.name)}</span>
      <span class="compress-info__dot" aria-hidden="true">·</span>
      <span class="compress-info__meta">${fmtSize(file.size)}</span>
    </div>

    <div class="compress-scan compress-scan--info" id="compressScanBanner" role="status">
      🔍 ${t('compress_placeholder')}
    </div>

    <div class="compress-scan compress-scan--info" role="status" style="margin-top:8px">
      ${t('cmp_email_locked')}
    </div>
  `;
}

/** Скрывает email-панель — сбрасывает весь shared state как hideCompressOptions */
export function hideCompressEmailOptions() {
  const container = id('compressOptions');
  if (!container) return;
  container.style.display = 'none';
  container.innerHTML     = '';
  _preset             = 'medium';
  _preserveText       = true;
  _targetDpi          = 150;
  _quality            = 82;
  _targetSizeMb       = null;
  _lastScan           = null;
  _presetAutoSelected = false;
}

/**
 * Показывает email-вердикт под compression report.
 * Вставляется после renderCompressionReport() в onSuccess.
 * @param {number} compressedSize — bytes
 */
export function renderEmailVerdict(compressedSize) {
  id('emailVerdict')?.remove();

  const mb    = compressedSize / (1024 * 1024);
  let cls, msg;

  if (mb < 20) {
    cls = 'compress-scan--found';
    msg = t('cmp_email_ok', { size: fmtSize(compressedSize) });
  } else if (mb < 25) {
    cls = 'compress-scan--warn';
    msg = t('cmp_email_warn_outlook', { size: fmtSize(compressedSize) });
  } else {
    cls = 'compress-scan--warn';
    msg = t('cmp_email_warn_gmail', { size: fmtSize(compressedSize), href: _splitHref() });
  }

  const div = document.createElement('div');
  div.id        = 'emailVerdict';
  div.className = `compress-scan ${cls}`;
  div.setAttribute('role', 'status');
  div.style.marginTop = '12px';
  div.innerHTML = msg;

  id('compressReport')?.insertAdjacentElement('afterend', div)
    || id('successDesc')?.insertAdjacentElement('afterend', div);
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
