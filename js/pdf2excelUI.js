// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

import { id } from './utils.js';
import { loadPdfJs } from './pdf2jpgUI.js';
import { preprocessPdfBuffer } from './decryptPdf.js';
import { loadingRow } from './uiComponents.js';
import { detectTables, groupItemsIntoLines } from './pdf2wordTables.js';

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
  el.innerHTML    = loadingRow('Analysing PDF…');
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

    const _thisGen = ++_scanGen;
    _scanTablesBackground(doc, _thisGen).catch(() => {});

    _loading = false;
    _render(file);
  } catch (err) {
    _loading = false;
    el.innerHTML = `
      <div class="compress-scan compress-scan--found" role="alert">
        Cannot read PDF: ${_esc(err.message)}
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
      <span class="compress-info__meta">${_pageCount} page${_pageCount !== 1 ? 's' : ''}</span>
    </div>

    <div id="p2eModeHint" class="compress-scan compress-scan--ok" role="status" aria-live="polite">
      📊 Detected tables are converted into separate Excel sheets. Any other text is kept in a "Text" sheet so nothing is lost.
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
        '⚠️ No text layer detected — this PDF is a scanned image, so no tables can be extracted. ' +
        '<a href="/ocr-pdf/" style="color:inherit;font-weight:600;white-space:nowrap">' +
        'Run OCR first →</a> to get extractable text.';
      hint.before(div);
    }
  } else if (ocrHintEl) {
    ocrHintEl.remove();
  }

  // ── Table badge / no-tables nudge ─────────────────────────────────────────
  const badge = el.querySelector('#p2eTableBadge');
  if (totalTables > 0) {
    const msg = `🗂️ ${totalTables} table${totalTables !== 1 ? 's' : ''} detected — each will become its own Excel sheet`;
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
        'No tables detected in the first pages — this PDF may not be spreadsheet-like. ' +
        'Consider <a href="/pdf-to-word/" style="color:var(--green);font-weight:600">PDF to Word</a> instead.';
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

  const levelLabel = level === 'high' ? 'Good' : level === 'medium' ? 'Fair' : 'Limited';

  el.innerHTML = `<div class="p2w-confidence__row">
    <span class="p2w-confidence__label">Detected</span>
    <span class="p2w-confidence__items"><span>${tableCount} table${tableCount !== 1 ? 's' : ''}</span></span>
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
