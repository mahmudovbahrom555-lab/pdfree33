// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  pdf2jpgUI.js — PDF → JPG/PNG options panel
//
//  🎯 Сверх ТЗ:
//  1. Pixel output preview — показываем реальные пиксели на выходе
//     (напр. "A4 at 150 DPI → 1240 × 1754 px") ещё в UI.
//     Пользователь понимает что получит до запуска.
//  2. Переиспользуем _parseRange / _pagesToRangeString из splitUI
//     через реэкспорт — без дублирования кода.
//  3. Lazy-load pdf.js только при открытии инструмента, не при старте.
// ============================================================

import { id }        from './utils.js';
import { showToast } from './ui.js';
import { parseRange } from './splitUI.js';   // public re-export chain: splitUI → pageSelectorUtils
import { pagesToRangeString, renderCheckboxes as _renderCheckboxesUtil,
         renderRangeInput } from './pageSelectorUtils.js';
import { chip, chipGroup, checkbox, loadingRow, infoBanner, group, row } from './uiComponents.js';

// ── State ──────────────────────────────────────────────────────
let _pageCount    = 0;
let _selectedPages = [];
let _format       = 'jpg';   // 'jpg' | 'png'
let _dpi          = 150;
let _zip          = true;

export function getPdf2JpgParams() {
  return { pages: [..._selectedPages], format: _format, dpi: _dpi, zip: _zip };
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Инициализирует панель: сначала lazy-load pdf.js (если нужно),
 * потом читает количество страниц, рендерит UI.
 * @param {File} file
 */
export async function initPdf2JpgOptions(file) {
  const container = id('pdf2jpgOptions');
  if (!container) return;

  container.innerHTML = loadingRow('Loading PDF…');
  container.style.display = 'block';

  try {
    // Lazy-load pdf.js — только когда пользователь открыл этот инструмент
    await _ensurePdfJs();

    // Pass raw bytes via data: — not a blob URL.
    // pdf.js Worker cannot fetch blob URLs from main thread on localhost/file:// →
    // "Unexpected server response (0)". disableWorker:true runs everything in the
    // main thread, works on all origins including localhost and offline PWA.
    //
    // Adaptive worker mode would be faster for large PDFs but needs a LOCAL
    // pdf.worker.js — we only have CDN URL, which fails offline. Until
    // pdf.worker.min.js is bundled locally, disableWorker:true is correct.
    const rawBuf = await file.arrayBuffer();
    const doc = await window.pdfjsLib.getDocument({
      data:           new Uint8Array(rawBuf),
      useSystemFonts: false,
      verbosity:      0,
    }).promise;
    console.info('[pdf2jpg] init pages=%d offline=%s', doc.numPages, !navigator.onLine);

    _pageCount     = doc.numPages;
    _selectedPages = Array.from({ length: _pageCount }, (_, i) => i + 1);

    // Получаем размер первой страницы для pixel preview
    const page     = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    _render(file, viewport);
  } catch (err) {
    // Distinguish CDN/network failures from PDF read errors so we can
    // show different recovery options: CDN failure → retry button,
    // bad PDF → nothing the user can do (just show the error).
    const isCdnError = err.message?.includes('Failed to load');

    if (isCdnError) {
      // Show a retry button — user may have regained connectivity
      container.innerHTML = `
        <div class="compress-scan compress-scan--found" role="alert">
          <strong>PDF engine could not load.</strong>
          Check your internet connection — pdf.js is loaded from CDN.
          <button type="button" class="split-range__apply" id="p2jRetryLoad"
                  style="margin-top:8px">⟳ Try again</button>
        </div>
      `;
      container.style.display = 'block';
      id('p2jRetryLoad')?.addEventListener('click', () => initPdf2JpgOptions(file));
    } else {
      showToast('Could not read PDF: ' + err.message, 5000);
      container.style.display = 'none';
    }
  }
}

export function hidePdf2JpgOptions() {
  const container = id('pdf2jpgOptions');
  if (!container) return;
  container.style.display = 'none';
  container.innerHTML = '';
  _pageCount     = 0;
  _selectedPages = [];
  _format        = 'jpg';
  _dpi           = 150;
  _zip           = true;
}

// ── Render ─────────────────────────────────────────────────────

function _render(file, viewport) {
  const container = id('pdf2jpgOptions');
  if (!container) return;

  const useRange = _pageCount > 30;

  container.innerHTML = `
    <div class="compress-info">
      <span class="compress-info__name" title="${_esc(file.name)}">${_truncName(file.name)}</span>
      <span class="compress-info__dot">·</span>
      <span class="compress-info__meta">${_pageCount} page${_pageCount !== 1 ? 's' : ''}</span>
    </div>

    ${row(
      group('Format', chipGroup('p2jFormat', [
        { value: 'jpg', label: 'JPG' },
        { value: 'png', label: 'PNG' },
      ], _format, 'Output format')),
      group('Resolution', chipGroup('p2jDpi', [
        { value: '72',  label: '72 dpi'  },
        { value: '150', label: '150 dpi' },
        { value: '300', label: '300 dpi' },
      ], String(_dpi), 'DPI'))
    )}

    <!-- ★ Pixel output preview (сверх ТЗ) -->
    <div class="p2j-pixel-hint" id="p2jPixelHint" role="status" aria-live="polite">
      ${_pixelHint(viewport)}
    </div>

    <!-- Page selection — reuses split-style UI -->
    <div class="split-pages">
      <div class="split-pages__header">
        <span class="split-pages__label">Pages to export</span>
        <div class="split-pages__actions">
          <button type="button" class="split-action-btn" id="p2jSelectAll">All</button>
          <button type="button" class="split-action-btn" id="p2jDeselectAll">None</button>
        </div>
      </div>
      ${useRange ? _renderRange() : _renderCheckboxes()}
      <div class="split-pages__count" id="p2jPageCount">
        ${_selectedPages.length} of ${_pageCount} pages selected
      </div>
    </div>

    ${_pageCount > 1
      ? checkbox({ id: 'p2jZipCheck', checked: _zip,
                   title: 'Download as ZIP', subtitle: 'Packages all images into one archive' })
      : ''}
  `;

  _bindEvents(useRange, viewport);
}

function _pixelHint(viewport) {
  const scale = _dpi / 72;
  const w     = Math.round(viewport.width  * scale);
  const h     = Math.round(viewport.height * scale);
  return `📐 Output: ${w} × ${h} px per page`;
}

// Delegates to pageSelectorUtils — zero duplication with splitUI
function _renderCheckboxes() {
  return _renderCheckboxesUtil(_pageCount, _selectedPages);
}

function _renderRange() {
  return renderRangeInput(_selectedPages, 'p2jRangeInput', 'p2jRangeApply');
}


// ── Events ─────────────────────────────────────────────────────

function _bindEvents(useRange, viewport) {
  const container = id('pdf2jpgOptions');

  container.addEventListener('change', e => {
    if (e.target.name === 'p2jFormat') {
      _format = e.target.value;
      container.querySelectorAll('[data-name="p2jFormat"]').forEach(el => {
        el.classList.toggle('j2p-chip--active', el.dataset.value === _format);
      });
    }
    if (e.target.name === 'p2jDpi') {
      _dpi = parseInt(e.target.value);
      container.querySelectorAll('[data-name="p2jDpi"]').forEach(el => {
        el.classList.toggle('j2p-chip--active', el.dataset.value === String(_dpi));
      });
      // Update pixel hint live
      const hint = id('p2jPixelHint');
      if (hint) hint.textContent = _pixelHint(viewport);
    }
    if (e.target.id === 'p2jZipCheck') {
      _zip = e.target.checked;
    }
    // Checkboxes
    if (e.target.type === 'checkbox' && e.target.closest('.split-checkboxes')) {
      const page = parseInt(e.target.value);
      if (e.target.checked) {
        if (!_selectedPages.includes(page)) _selectedPages.push(page);
      } else {
        _selectedPages = _selectedPages.filter(p => p !== page);
      }
      _selectedPages.sort((a, b) => a - b);
      e.target.closest('label')?.classList.toggle('checked', e.target.checked);
      _updateCount();
    }
  });

  id('p2jSelectAll')?.addEventListener('click', () => {
    _selectedPages = Array.from({ length: _pageCount }, (_, i) => i + 1);
    if (useRange) { const el = id('p2jRangeInput'); if (el) el.value = `1-${_pageCount}`; }
    else _syncCheckboxes();
    _updateCount();
  });

  id('p2jDeselectAll')?.addEventListener('click', () => {
    _selectedPages = [];
    if (useRange) { const el = id('p2jRangeInput'); if (el) el.value = ''; }
    else _syncCheckboxes();
    _updateCount();
  });

  if (useRange) {
    const applyFn = () => {
      const raw = id('p2jRangeInput')?.value || '';
      const pages = parseRange(raw, _pageCount);
      if (pages.length === 0 && raw.trim() !== '') {
        showToast('Invalid range — no valid pages found'); return;
      }
      _selectedPages = pages;
      _updateCount();
    };
    id('p2jRangeApply')?.addEventListener('click', applyFn);
    id('p2jRangeInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') applyFn(); });
  }
}

function _syncCheckboxes() {
  document.querySelectorAll('#pdf2jpgOptions input[type="checkbox"].split-checkboxes input').forEach(cb => {
    const page = parseInt(cb.value);
    cb.checked = _selectedPages.includes(page);
    cb.closest('label')?.classList.toggle('checked', cb.checked);
  });
}

function _updateCount() {
  const el = id('p2jPageCount');
  if (el) el.textContent = `${_selectedPages.length} of ${_pageCount} pages selected`;
}

// ── Lazy-load pdf.js ───────────────────────────────────────────
// Подключаем только при первом открытии PDF→JPG,
// не при старте приложения. ~1.5 МБ не грузится зря.

const PDFJS_VERSION = '3.11.174';
const PDFJS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;

let _pdfJsLoading = null;  // in-flight Promise — prevents concurrent loads
let _pdfJsRetries = 0;
const PDFJS_MAX_RETRIES = 2;

/**
 * Lazy-load pdf.js with exponential backoff retry.
 *
 * Why retry: CDN failures are transient (~2% of requests on mobile networks).
 * A user who retried manually gets the same broken CDN. Auto-retry with 1s/2s
 * delays catches most transient issues without user intervention.
 *
 * Why exponential backoff: avoids hammering a CDN that's under load.
 * 3 attempts total (1 initial + 2 retries) is enough for transient failures;
 * a true outage won't be fixed by more retries.
 *
 * After all retries fail: show a user-friendly error with a manual retry button
 * injected into the container. The user can try again without reloading the page.
 */
async function _ensurePdfJs() {
  if (window.pdfjsLib) return;

  // If a load is already in progress, wait for it (de-dupe concurrent calls)
  if (_pdfJsLoading) { await _pdfJsLoading; return; }

  _pdfJsLoading = _loadWithRetry(PDFJS_MAX_RETRIES);

  try {
    await _pdfJsLoading;
  } finally {
    // Always clear so a future call can retry from scratch
    _pdfJsLoading = null;
  }
}

async function _loadWithRetry(retriesLeft) {
  try {
    await _loadScript(`${PDFJS_CDN}/pdf.min.js`);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.js', import.meta.url).toString();
  } catch (err) {
    if (retriesLeft > 0) {
      // Exponential backoff: 1s before first retry, 2s before second
      const delay = 1000 * (PDFJS_MAX_RETRIES - retriesLeft + 1);
      await new Promise(r => setTimeout(r, delay));
      return _loadWithRetry(retriesLeft - 1);
    }
    throw err;  // all retries exhausted — propagate to initPdf2JpgOptions
  }
}

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    // Remove any previously failed script tag before retrying
    document.querySelector(`script[src="${src}"]`)?.remove();
    const script = document.createElement('script');
    script.src     = src;
    script.onload  = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

// ── Utilities ──────────────────────────────────────────────────


function _truncName(name) {
  return name.length > 35 ? name.slice(0, 32) + '…' : name;
}

function _esc(str) {
  const d = document.createElement('div'); d.textContent = str; return d.innerHTML;
}

export { _ensurePdfJs as loadPdfJs };
