// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

import { id } from './utils.js';
import { loadPdfJs } from './pdf2jpgUI.js';
import { preprocessPdfBuffer } from './decryptPdf.js';
import { loadingRow } from './uiComponents.js';
import { detectTables, groupItemsIntoLines } from './pdf2wordTables.js';
import { t, tp } from './i18n.js';

// Locale-correct slugs for the "Run OCR first" / "PDF to Word" cross-links in
// the hints below. This module is shared across every locale's page, and
// both target tools are served at translated pathnames in non-English
// locales (e.g. /ru/raspoznat-tekst-pdf/, /de/pdf-zu-word/) — bare
// '/ocr-pdf/' / '/pdf-to-word/' hrefs resolve to the English pages
// regardless of which locale the user is on. Mirrors the per-locale slugs in
// data/tools-config.json (same table/pattern as the fix in js/ocrUI.js).
const OCR_SLUGS      = { en: 'ocr-pdf', de: 'ocr-pdf', es: 'ocr-pdf', fr: 'ocr-pdf', pt: 'ocr-pdf', id: 'ocr-pdf', vi: 'nhan-dang-van-ban-pdf', ru: 'raspoznat-tekst-pdf', ja: 'pdf-moji-ninshiki', tr: 'metin-tanima-pdf', it: 'riconosci-testo-pdf', ko: 'pdf-munja-insik', nl: 'pdf-tekstherkenning', pl: 'rozpoznaj-tekst-pdf' };
const PDF2WORD_SLUGS = { en: 'pdf-to-word', de: 'pdf-zu-word', es: 'pdf-a-word', fr: 'pdf-en-word', pt: 'pdf-para-word', id: 'pdf-ke-word', vi: 'pdf-sang-word', ru: 'pdf-v-word', ja: 'pdf-word-henkan', tr: 'pdf-word-donustur', it: 'pdf-in-word', ko: 'pdf-word-byeonhwan', nl: 'pdf-naar-word', pl: 'pdf-do-word' };
const KNOWN_LOCALES  = new Set(['de', 'es', 'fr', 'pt', 'id', 'vi', 'ru', 'ja', 'it', 'ko', 'nl', 'pl', 'tr']);

function _crossToolHref(slugs) {
  const seg = location.pathname.split('/')[1];
  const lc  = KNOWN_LOCALES.has(seg) ? seg : 'en';
  const slug = slugs[lc] || slugs.en;
  return lc === 'en' ? `/${slug}/` : `/${lc}/${slug}/`;
}

// ── State ─────────────────────────────────────────────────────────────────────
let _file      = null;
let _pageCount = 0;
let _loading   = false;
let _scanGen   = 0;    // incremented on each new file — cancels stale background scans

export function getPdf2ExcelParams() {
  return { pageCount: _pageCount, loading: _loading };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function initPdf2ExcelOptions(file) {
  const el = id('pdf2excelOptions');
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
    const doc = await window.pdfjsLib.getDocument({ isEvalSupported: false,
      data:              new Uint8Array(rawBuf),
      useSystemFonts:    false,
      verbosity:         0,
      disableJavaScript: true,
    }).promise;

    _pageCount = doc.numPages;

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

export function hidePdf2ExcelOptions() {
  const el = id('pdf2excelOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  _file = null; _pageCount = 0; _loading = false;
  ++_scanGen; // cancel any in-flight background scan
  clearP2eConfidence();
}

// ── Render ────────────────────────────────────────────────────────────────────

function _render(file) {
  const el = id('pdf2excelOptions');
  if (!el) return;

  const name = file.name.length > 35 ? file.name.slice(0, 32) + '…' : file.name;

  el.innerHTML = `
    <div class="compress-info">
      <span class="compress-info__name" title="${_esc(file.name)}">${name}</span>
      <span class="compress-info__dot">·</span>
      <span class="compress-info__meta">${tp(_pageCount, 'split_info_page', 'split_info_pages', { n: _pageCount })}</span>
    </div>

    <div id="p2eModeHint" class="compress-scan compress-scan--ok" role="status" aria-live="polite">
      ${t('p2e_mode_hint')}
    </div>
  `;
}

function _esc(str) {
  const d = document.createElement('div'); d.textContent = str; return d.innerHTML.replace(/"/g, '&quot;');
}

// ── Background table scanner ──────────────────────────────────────────────────
// Runs detectTables() on first N pages after PDF loads.
// Shows a compact info badge in the UI when tables are found — same technique
// as pdf2wordUI.js's _scanTablesBackground (kept separate rather than shared
// since the two tools' UI markup/hint text genuinely differ).
const SCAN_PAGES = 5;   // scan only first N pages to keep init snappy

async function _scanTablesBackground(doc, gen) {
  const pageLimit = Math.min(doc.numPages, SCAN_PAGES);
  let totalTables    = 0;
  let totalTextItems = 0;

  for (let p = 1; p <= pageLimit; p++) {
    const page    = await doc.getPage(p);
    const content = await page.getTextContent({ normalizeWhitespace: false });
    page.cleanup?.();

    const items = content.items
      .filter(item => 'str' in item && item.str.trim())
      .map(item => ({
        str:      item.str,
        x:        item.transform[4],
        y:        item.transform[5],
        fontSize: (item.height > 0 ? item.height : Math.abs(item.transform[3])) || 10,
      }));

    totalTextItems += items.length;

    const lines = groupItemsIntoLines(items);

    totalTables += detectTables(lines).length;
  }

  if (gen !== _scanGen) return;

  const el = id('pdf2excelOptions');
  if (!el) return;

  const hint = id('p2eModeHint');

  // ── OCR hint: pure-image PDF has no extractable text layer ───────────────
  const ocrHintEl   = el.querySelector('#p2eOcrHint');
  const isPureImage = (totalTextItems / pageLimit) < 3;
  if (isPureImage) {
    if (!ocrHintEl && hint) {
      const div = document.createElement('div');
      div.id        = 'p2eOcrHint';
      div.className = 'compress-scan compress-scan--found';
      div.style.cssText = 'margin-top:8px;font-size:13px;padding:10px 12px';
      div.setAttribute('role', 'alert');
      div.innerHTML =
        t('p2e_ocr_hint') +
        `<a href="${_crossToolHref(OCR_SLUGS)}" style="color:inherit;font-weight:600;white-space:nowrap">` +
        `${t('p2w_run_ocr_link')}</a>${t('p2e_ocr_to_get_extractable')}`;
      hint.before(div);
    }
  } else if (ocrHintEl) {
    ocrHintEl.remove();
  }

  // ── Table badge / no-tables nudge ─────────────────────────────────────────
  const badge = el.querySelector('#p2eTableBadge');
  if (totalTables > 0) {
    const msg = tp(totalTables, 'p2e_tables_detected_one', 'p2e_tables_detected_many', { n: totalTables });
    if (badge) {
      badge.textContent = msg;
    } else if (hint) {
      const div = document.createElement('div');
      div.id        = 'p2eTableBadge';
      div.className = 'compress-scan';
      div.style.cssText = 'margin-top:8px;font-size:12px;color:var(--text3);padding:6px 10px';
      div.textContent   = msg;
      hint.after(div);
    }
  } else {
    if (badge) badge.remove();
    if (!isPureImage && !el.querySelector('#p2eNoTableHint') && hint) {
      const div = document.createElement('div');
      div.id        = 'p2eNoTableHint';
      div.className = 'compress-scan';
      div.style.cssText = 'margin-top:8px;font-size:12px;color:var(--text3);padding:6px 10px';
      div.innerHTML =
        t('p2e_no_table_hint') +
        `<a href="${_crossToolHref(PDF2WORD_SLUGS)}" style="color:var(--green-text);font-weight:600">${t('p2e_pdf_to_word_link')}</a>${t('p2e_instead_suffix')}`;
      hint.after(div);
    }
  }
}

// ── Confidence report ─────────────────────────────────────────────────────────

export function renderP2eConfidence({ score, level, tableCount }) {
  const el = id('p2eConfidence');
  if (!el) return;

  if (!tableCount) {
    el.innerHTML    = '';
    el.style.display = 'none';
    return;
  }

  const levelLabel = level === 'high' ? t('p2w_confidence_good') : level === 'medium' ? t('p2w_confidence_fair') : t('p2w_confidence_limited');

  el.innerHTML = `<div class="p2w-confidence__row">
    <span class="p2w-confidence__label">${t('p2w_detected_label')}</span>
    <span class="p2w-confidence__items"><span>${tp(tableCount, 'p2e_table_count_one', 'p2e_table_count_many', { n: tableCount })}</span></span>
    <span class="p2w-confidence__badge p2w-confidence__badge--${level}">${score}% ${levelLabel}</span>
  </div>`;
  el.style.display = '';
}

export function clearP2eConfidence() {
  const el = id('p2eConfidence');
  if (!el) return;
  el.innerHTML    = '';
  el.style.display = 'none';
}
