// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

import { id } from './utils.js';
import { loadPdfJs } from './pdf2jpgUI.js';
import { preprocessPdfBuffer } from './decryptPdf.js';
import { chipGroup, group, loadingRow } from './uiComponents.js';
import { detectTables } from './pdf2wordTables.js';
import { t, tp } from './i18n.js';

// Locale-correct slug for the "Run OCR first" cross-link in the scanned-PDF
// hint below. This module is shared across every locale's page, and the OCR
// tool is served at a translated pathname in several non-English locales
// (e.g. /ru/raspoznat-tekst-pdf/) — a bare '/ocr-pdf/' href resolves to the
// English page regardless of which locale the user is on. Mirrors the
// per-locale slugs in data/tools-config.json (same table/pattern as the fix
// in js/ocrUI.js).
const OCR_SLUGS = { en: 'ocr-pdf', de: 'ocr-pdf', es: 'ocr-pdf', fr: 'ocr-pdf', pt: 'ocr-pdf', id: 'ocr-pdf', vi: 'nhan-dang-van-ban-pdf', ru: 'raspoznat-tekst-pdf', ja: 'pdf-moji-ninshiki', tr: 'metin-tanima-pdf', it: 'riconosci-testo-pdf', ko: 'pdf-munja-insik', nl: 'pdf-tekstherkenning', pl: 'rozpoznaj-tekst-pdf' };
const KNOWN_LOCALES = new Set(['de', 'es', 'fr', 'pt', 'id', 'vi', 'ru', 'ja', 'it', 'ko', 'nl', 'pl', 'tr']);

function _ocrHref() {
  const seg = location.pathname.split('/')[1];
  const lc  = KNOWN_LOCALES.has(seg) ? seg : 'en';
  const slug = OCR_SLUGS[lc] || OCR_SLUGS.en;
  return lc === 'en' ? `/${slug}/` : `/${lc}/${slug}/`;
}

// ── Constants ─────────────────────────────────────────────────────────────────
// JPEG compression ratio at quality 0.85 over typical PDF content
// (mix of text, graphics). Actual ratio: 10–16×; 12× is a safe middle estimate.
const JPEG_RATIO       = 12;
const WARN_MB          = 80;    // yellow warning threshold
const DANGER_MB        = 200;   // red warning threshold + strong message
const MAX_IMAGE_PAGES  = 500;   // hard cap for image mode (browser memory safety)

// ── State ─────────────────────────────────────────────────────────────────────
let _file      = null;
let _mode      = 'text';
let _dpi       = 150;
let _pageCount = 0;
let _vpW       = 0;    // first page width in PDF points (for size estimation)
let _vpH       = 0;    // first page height in PDF points
let _loading   = false;
let _scanGen   = 0;    // incremented on each new file — cancels stale background scans

export function getPdf2WordParams() {
  return { mode: _mode, dpi: _dpi, pageCount: _pageCount, loading: _loading };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function initPdf2WordOptions(file) {
  const el = id('pdf2wordOptions');
  if (!el) return;

  _file    = file;
  _loading = true;
  el.innerHTML    = loadingRow(t('val_analysing_pdf'));
  el.style.display = '';

  try {
    await loadPdfJs();
    const rawBuf = file._decryptedBuffer
      ? file._decryptedBuffer.slice(0)
      : await preprocessPdfBuffer(await file.arrayBuffer());
    const doc = await window.pdfjsLib.getDocument({
      data:              new Uint8Array(rawBuf),
      useSystemFonts:    false,
      verbosity:         0,
      disableJavaScript: true,
    }).promise;

    _pageCount = doc.numPages;

    // First page dimensions → used for real-time size estimation
    const firstPage = await doc.getPage(1);
    const vp        = firstPage.getViewport({ scale: 1 });
    _vpW = vp.width;
    _vpH = vp.height;
    firstPage.cleanup?.();

    // Background table scan — runs on first 5 pages max to keep init fast.
    // Results shown in UI for debug/tuning; doesn't block rendering.
    const _thisGen = ++_scanGen;
    _scanTablesBackground(doc, _thisGen).catch(() => {});

    _loading = false;
    _render(file);
  } catch (err) {
    _loading = false;
    el.innerHTML = `
      <div class="compress-scan compress-scan--found" role="alert">
        ${t('p2w_cannot_read', { msg: _esc(err.message) })}
      </div>`;
  }
}

export function hidePdf2WordOptions() {
  const el = id('pdf2wordOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  _file = null; _mode = 'text'; _dpi = 150;
  _pageCount = 0; _vpW = 0; _vpH = 0; _loading = false;
  ++_scanGen; // cancel any in-flight background scan
  clearP2wConfidence();
  clearAtlasCheck();
}

// ── Size estimation ───────────────────────────────────────────────────────────
// Returns estimated .docx file size in MB for current dpi + pageCount.
// Formula: (pixels per page × RGB channels / compression ratio) × pages
function _estimateMB(dpi) {
  if (!_vpW || !_vpH) return null;
  const scale = dpi / 72;
  const w     = _vpW * scale;
  const h     = _vpH * scale;
  return (w * h * 3 / JPEG_RATIO / 1024 / 1024) * _pageCount;
}

// ── Render ────────────────────────────────────────────────────────────────────

function _render(file) {
  const el = id('pdf2wordOptions');
  if (!el) return;

  const name = file.name.length > 35 ? file.name.slice(0, 32) + '…' : file.name;

  el.innerHTML = `
    <div class="compress-info">
      <span class="compress-info__name" title="${_esc(file.name)}">${name}</span>
      <span class="compress-info__dot">·</span>
      <span class="compress-info__meta">${tp(_pageCount, 'split_info_page', 'split_info_pages', { n: _pageCount })}</span>
    </div>

    ${group(t('p2w_output_mode'), chipGroup('p2wMode', [
      { value: 'text',  label: t('p2w_mode_text') },
      { value: 'image', label: t('p2w_mode_image') },
    ], _mode, t('p2w_conversion_mode_aria')))}

    <div id="p2wImageBlock" style="${_mode === 'image' ? '' : 'display:none'}">
      ${group(t('p2w_resolution'), `
        <div class="j2p-chips" role="group" aria-label="${t('p2w_image_resolution_aria')}">
          ${_dpiChip('72',  t('p2w_dpi_compact'),  '72',  _dpi)}
          ${_dpiChip('150', t('p2w_dpi_balanced'), '150', _dpi, true)}
          ${_dpiChip('300', t('p2w_dpi_high'),     '300', _dpi)}
        </div>
      `)}
      <div id="p2wSizeHint" style="margin-top:8px">${_sizeHintHTML(_dpi)}</div>
    </div>

    <div id="p2wModeHint" class="compress-scan compress-scan--ok" role="status" aria-live="polite">
      ${_modeHintText()}
    </div>
  `;

  el.removeEventListener('change', _onChange);
  el.addEventListener('change', _onChange);
}

// A DPI chip that renders "Compact · 72 dpi", with optional "★ Recommended" badge
function _dpiChip(value, label, display, current, recommended = false) {
  const active  = current === parseInt(value) ? ' j2p-chip--active' : '';
  const checked = current === parseInt(value) ? ' checked' : '';
  const badge   = recommended
    ? ' <span style="font-size:10px;opacity:.7;font-weight:600">★</span>'
    : '';
  return `<label class="j2p-chip${active}" data-value="${value}" data-name="p2wDpi">
    <input type="radio" name="p2wDpi" value="${value}"${checked}>
    ${label}${badge} <span style="opacity:.55;font-size:11px">${display} dpi</span>
  </label>`;
}

// Real-time size estimate HTML with colour-coded severity
function _sizeHintHTML(dpi) {
  const mb  = _estimateMB(dpi);
  if (!mb)  return '';

  const mbStr = mb < 1 ? '<1' : Math.round(mb);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  if (mb >= DANGER_MB) {
    const pages = _pageCount;
    const detail = pages > MAX_IMAGE_PAGES
      ? t('p2w_size_danger_limited', { max: MAX_IMAGE_PAGES })
      : t('p2w_size_danger_try');
    const safari = isSafari ? t('p2w_safari_note') : '';
    return `<div class="compress-scan compress-scan--found" style="margin:0" role="alert">
      ${t('p2w_size_danger', { mb: mbStr, detail, safari })}
    </div>`;
  }

  if (mb >= WARN_MB) {
    const safari = isSafari ? t('p2w_size_warn_safari') : '';
    return `<div class="compress-scan" style="margin:0;background:rgba(200,130,0,.08);border:1px solid rgba(200,130,0,.3);border-radius:8px;padding:10px 12px;font-size:13px;color:var(--text2)">
      ${t('p2w_size_warn', { mb: mbStr, safari })}
    </div>`;
  }

  return `<div style="font-size:12px;color:var(--text3);padding:4px 0">
    ${t('p2w_size_normal', { mb: mbStr })}
  </div>`;
}

function _modeHintText() {
  return _mode === 'text' ? t('p2w_mode_text_hint') : t('p2w_mode_image_hint');
}

// ── Events ────────────────────────────────────────────────────────────────────

function _onChange(e) {
  if (e.target.name === 'p2wMode') {
    _mode = e.target.value;

    const imageBlock = id('p2wImageBlock');
    if (imageBlock) imageBlock.style.display = _mode === 'image' ? '' : 'none';

    const hint = id('p2wModeHint');
    if (hint) hint.textContent = _modeHintText();

    document.querySelectorAll('[data-name="p2wMode"]').forEach(el => {
      el.classList.toggle('j2p-chip--active', el.dataset.value === _mode);
    });
  }

  if (e.target.name === 'p2wDpi') {
    _dpi = parseInt(e.target.value);
    document.querySelectorAll('[data-name="p2wDpi"]').forEach(el => {
      el.classList.toggle('j2p-chip--active', el.dataset.value === String(_dpi));
    });
    // Live-update the size estimate
    const sizeHint = id('p2wSizeHint');
    if (sizeHint) sizeHint.innerHTML = _sizeHintHTML(_dpi);
  }
}

function _esc(str) {
  const d = document.createElement('div'); d.textContent = str; return d.innerHTML.replace(/"/g, '&quot;');
}

// ── Background table scanner ──────────────────────────────────────────────────
// Runs detectTables() on first N pages after PDF loads.
// Shows a compact info badge in the UI when tables are found.
const SCAN_PAGES = 5;   // scan only first N pages to keep init snappy
const YTOL       = 6;   // must match processor.js _p2wExtractText (was 4; see processor.js:865)

async function _scanTablesBackground(doc, gen) {
  const pageLimit = Math.min(doc.numPages, SCAN_PAGES);
  let totalTables    = 0;
  let totalTextItems = 0;  // track meaningful text items across scanned pages

  for (let p = 1; p <= pageLimit; p++) {
    const page    = await doc.getPage(p);
    const content = await page.getTextContent({ normalizeWhitespace: false });
    page.cleanup?.();

    // Build lines (identical logic to _p2wExtractText in processor.js)
    const items = content.items
      .filter(item => 'str' in item && item.str.trim())
      .map(item => ({
        str:      item.str,
        x:        item.transform[4],
        y:        item.transform[5],
        fontSize: (item.height > 0 ? item.height : Math.abs(item.transform[3])) || 10,
      }));

    totalTextItems += items.length;

    const lines = [];
    for (const item of [...items].sort((a, b) => b.y - a.y)) {
      let merged = false;
      for (const ln of lines) {
        if (Math.abs(ln.y - item.y) <= YTOL) { ln.items.push(item); merged = true; break; }
      }
      if (!merged) lines.push({ y: item.y, items: [item] });
    }
    lines.forEach(ln => ln.items.sort((a, b) => a.x - b.x));

    const tables = detectTables(lines);
    totalTables += tables.length;
  }

  // Abort if a newer file was loaded while we were scanning
  if (gen !== _scanGen) return;

  const el = id('pdf2wordOptions');
  if (!el) return;

  // ── OCR hint: pure-image PDF has no extractable text layer ───────────────
  // Fewer than 3 meaningful text items per scanned page = scanned image only.
  // Word output will be image-based; recommend OCR first.
  const ocrHintEl  = el.querySelector('#p2wOcrHint');
  const isPureImage = (totalTextItems / pageLimit) < 3;
  if (isPureImage) {
    if (!ocrHintEl) {
      const hint = id('p2wModeHint');
      if (hint) {
        const div = document.createElement('div');
        div.id        = 'p2wOcrHint';
        div.className = 'compress-scan compress-scan--found';
        div.style.cssText = 'margin-top:8px;font-size:13px;padding:10px 12px';
        div.setAttribute('role', 'alert');
        div.innerHTML =
          t('p2w_ocr_hint') +
          `<a href="${_ocrHref()}" style="color:inherit;font-weight:600;white-space:nowrap">` +
          `${t('p2w_run_ocr_link')}</a>${t('p2w_ocr_to_get_editable')}`;
        hint.before(div);
      }
    }
  } else if (ocrHintEl) {
    ocrHintEl.remove();
  }

  // ── Table badge (only visible when tables found) ──────────────────────────
  const badge = el.querySelector('#p2wTableBadge');

  if (totalTables > 0) {
    const msg = tp(totalTables, 'p2w_tables_detected_one', 'p2w_tables_detected_many', { n: totalTables });
    if (badge) {
      badge.textContent = msg;
    } else {
      const hint = id('p2wModeHint');
      if (hint) {
        const div = document.createElement('div');
        div.id        = 'p2wTableBadge';
        div.className = 'compress-scan';
        div.style.cssText = 'margin-top:8px;font-size:12px;color:var(--text3);padding:6px 10px';
        div.textContent   = msg;
        hint.after(div);
      }
    }
  } else if (badge) {
    badge.remove();
  }
}

// Export for processor.js (needs the cap value)
export { MAX_IMAGE_PAGES };

// ── Confidence report ─────────────────────────────────────────────────────────

export function renderP2wConfidence({ score, level, detected, warnings }) {
  const el = id('p2wConfidence');
  if (!el) return;

  const levelLabel = level === 'high' ? t('p2w_confidence_good') : level === 'medium' ? t('p2w_confidence_fair') : t('p2w_confidence_limited');

  let html = `<div class="p2w-confidence__row">
    <span class="p2w-confidence__label">${t('p2w_detected_label')}</span>
    <span class="p2w-confidence__items">${detected.map(d => `<span>${d}</span>`).join('')}</span>
    <span class="p2w-confidence__badge p2w-confidence__badge--${level}">${score}% ${levelLabel}</span>
  </div>`;

  if (warnings.length > 0) {
    html += `<div class="p2w-confidence__warnings">${
      warnings.map(w => `<span class="p2w-confidence__warn-item">${w}</span>`).join(' &nbsp;·&nbsp; ')
    }</div>`;
  }

  el.innerHTML    = html;
  el.style.display = '';
}

export function clearP2wConfidence() {
  const el = id('p2wConfidence');
  if (!el) return;
  el.innerHTML    = '';
  el.style.display = 'none';
}

// ── Atlas structural check ──────────────────────────────────────────────────
// Surfaces eriScore.js's evaluateStructural() result (see _runPdf2Word's
// `atlasEri`) — real, measured structural editability of the ACTUAL shipped
// DOCX (tables real vs. layout-mis-detected, paragraphs trapped in text
// boxes, flow chopped by hard breaks). Deliberately named/framed as a
// "structural check," not a quality score or review — it covers 3 of
// Atlas's 5 channels (see Atlas_DR/ROADMAP.md Stage 2), not the full
// benchmark. Verdict thresholds match Atlas_DR's own eri_core/evaluate.py
// verdict() function (READY>=95 / MINOR>=80 / NOTABLE>=60 / HEAVY<60) —
// same bar, not invented separately for this UI. Deliberately shows NO time
// estimate ("~3-5 minutes to fix") — ROADMAP.md is explicit that this would
// be a real, user-facing overclaim until manual_fix_minutes is measured
// against real human editing time, which hasn't happened yet.
function _atlasVerdict(eri) {
  if (eri >= 95) return { key: 'ready',   labelKey: 'atlas_verdict_ready' };
  if (eri >= 80) return { key: 'minor',   labelKey: 'atlas_verdict_minor' };
  if (eri >= 60) return { key: 'notable', labelKey: 'atlas_verdict_notable' };
  return { key: 'heavy', labelKey: 'atlas_verdict_heavy' };
}

export function renderAtlasCheck(atlasEri) {
  const el = id('atlasCheck');
  if (!el) return;
  if (!atlasEri || atlasEri.error) { clearAtlasCheck(); return; }

  const { eri, findings } = atlasEri;
  const verdict = _atlasVerdict(eri);

  // The one always-present findings.flow entry ("channels L/O aren't scored
  // without a profile") is an internal scope note aimed at this codebase's
  // own future readers, not end users — atlas_check_scope_note below covers
  // the same disclosure in user-facing language, so it's filtered here
  // rather than shown twice in two different tones.
  const items = [
    ...(findings.tables || []),
    ...(findings.paragraphs || []),
    ...(findings.flow || []).filter(f => !f.startsWith('channels L')),
  ];

  let html = `<div class="atlas-check__header">
    <span class="atlas-check__title">${t('atlas_check_title')}</span>
    <span class="atlas-check__badge atlas-check__badge--${verdict.key}">${Math.round(eri)}% ${t(verdict.labelKey)}</span>
  </div>
  <p class="atlas-check__scope">${t('atlas_check_scope_note')}</p>`;

  if (items.length) {
    html += `<ul class="atlas-check__findings">${items.map(f => `<li>${f}</li>`).join('')}</ul>`;
  }

  el.innerHTML     = html;
  el.style.display = '';
}

export function clearAtlasCheck() {
  const el = id('atlasCheck');
  if (!el) return;
  el.innerHTML    = '';
  el.style.display = 'none';
}
