// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

import { id }               from './utils.js';
import { showToast }        from './ui.js';
import { t }                from './i18n.js';
import { trackToolError }   from './analytics.js';
import { preprocessPdfBuffer } from './decryptPdf.js';

// ── State ──────────────────────────────────────────────────────
let _pageCount     = 0;
let _selectedPages = [];
let _format        = 'jpg';
let _dpi           = 150;
let _zip           = true;
let _pdfDoc        = null;    // cached PDF.js document — reused for thumbnails
let _viewport      = null;    // first-page viewport for size estimation
let _thumbZoom     = 160;     // thumbnail CSS width in px
let _observer      = null;    // IntersectionObserver for lazy rendering
let _renderQueue   = [];      // cells queued for canvas rendering
let _activeRenders = 0;       // concurrent renders in flight
const MAX_RENDERS  = 3;

// ── Public API ─────────────────────────────────────────────────

export function getPdf2JpgParams() {
  return { pages: [..._selectedPages], format: _format, dpi: _dpi, zip: _zip };
}

export async function initPdf2JpgOptions(file) {
  const container = id('pdf2jpgOptions');
  if (!container) return;

  container.style.display = 'block';
  container.innerHTML = `
    <div style="padding:40px 16px;text-align:center;color:var(--text3);font-size:14px;">
      <div style="font-size:28px;margin-bottom:10px;">&#x23F3;</div>Loading PDF…
    </div>`;

  try {
    await _ensurePdfJs();

    const rawBuf = file._decryptedBuffer
      ? file._decryptedBuffer.slice(0)
      : await preprocessPdfBuffer(await file.arrayBuffer());

    _pdfDoc?.destroy();
    _pdfDoc = await window.pdfjsLib.getDocument({
      data:              new Uint8Array(rawBuf),
      useSystemFonts:    false,
      verbosity:         0,
      disableJavaScript: true,
    }).promise;

    _pageCount     = _pdfDoc.numPages;
    _selectedPages = Array.from({ length: _pageCount }, (_, i) => i + 1);

    const firstPage = await _pdfDoc.getPage(1);
    _viewport = firstPage.getViewport({ scale: 1 });

    _render(file);
  } catch (err) {
    const isCdnError = err.message?.includes('Failed to load');
    if (isCdnError) {
      trackToolError('pdf2jpg', 'pdf_engine_failed');
      container.innerHTML = `
        <div class="compress-scan compress-scan--found" role="alert">
          ${t('err_pdf_engine')}
          <button type="button" class="split-range__apply" id="p2jRetryLoad"
                  style="margin-top:8px">${t('retry')}</button>
        </div>`;
      id('p2jRetryLoad')?.addEventListener('click', () => initPdf2JpgOptions(file));
    } else {
      trackToolError('pdf2jpg', 'pdf_read_failed');
      showToast(t('error_msg', { msg: err.message }));
      container.style.display = 'none';
    }
  }
}

export function hidePdf2JpgOptions() {
  _observer?.disconnect();
  _observer      = null;
  _renderQueue   = [];
  _activeRenders = 0;

  _pdfDoc?.destroy();
  _pdfDoc    = null;
  _viewport  = null;

  const container = id('pdf2jpgOptions');
  if (container) { container.style.display = 'none'; container.innerHTML = ''; }

  _pageCount     = 0;
  _selectedPages = [];
  _format        = 'jpg';
  _dpi           = 150;
  _zip           = true;
  _thumbZoom     = 160;
}

// ── Render ─────────────────────────────────────────────────────

function _render() {
  const container = id('pdf2jpgOptions');
  if (!container) return;

  const aspectPct = _viewport
    ? (_viewport.height / _viewport.width * 100).toFixed(1)
    : '141.4';

  container.innerHTML = `
    <div class="p2j-top-row">

      <!-- 1: Output format -->
      <div class="p2j-section">
        <div class="p2j-section__hdr">
          <span class="p2j-step">1</span>Output format
        </div>
        <div class="p2j-fmt-cards">
          <label class="p2j-fmt-card p2j-fmt-card--on" data-fmt="jpg">
            <input type="radio" name="p2jFormat" value="jpg" checked>
            <svg class="p2j-fmt-card__ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21,15 16,10 5,21"/>
            </svg>
            <span class="p2j-fmt-card__name">JPG</span>
            <span class="p2j-fmt-card__desc">Best for photos and general use</span>
          </label>
          <label class="p2j-fmt-card" data-fmt="png">
            <input type="radio" name="p2jFormat" value="png">
            <svg class="p2j-fmt-card__ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <path d="M3 9h18M9 21V9"/>
            </svg>
            <span class="p2j-fmt-card__name">PNG</span>
            <span class="p2j-fmt-card__desc">Best for screenshots and graphics</span>
          </label>
        </div>
      </div>

      <!-- 2: Image quality -->
      <div class="p2j-section">
        <div class="p2j-section__hdr">
          <span class="p2j-step">2</span>Image quality (resolution)
        </div>
        <div class="p2j-dpi-cards">
          <label class="p2j-dpi-card" data-dpi="72">
            <input type="radio" name="p2jDpi" value="72">
            <span class="p2j-dpi-card__val">72 dpi</span>
            <span class="p2j-dpi-card__lbl">Smaller file size</span>
            <span class="p2j-dpi-card__sub">Web / Email</span>
          </label>
          <label class="p2j-dpi-card p2j-dpi-card--on" data-dpi="150">
            <input type="radio" name="p2jDpi" value="150" checked>
            <span class="p2j-dpi-card__val">150 dpi</span>
            <span class="p2j-dpi-card__lbl">Good quality</span>
            <span class="p2j-dpi-card__sub">Most common</span>
          </label>
          <label class="p2j-dpi-card" data-dpi="300">
            <input type="radio" name="p2jDpi" value="300">
            <span class="p2j-dpi-card__val">300 dpi</span>
            <span class="p2j-dpi-card__lbl">High quality</span>
            <span class="p2j-dpi-card__sub">Print</span>
          </label>
        </div>
      </div>

      <!-- Summary sidebar -->
      <aside class="p2j-summary">
        <div class="p2j-summary__title">Summary</div>
        <div class="p2j-summary__row">
          <span class="p2j-summary__key">Selected pages</span>
          <span class="p2j-summary__val" id="p2jSumPages">${_selectedPages.length} of ${_pageCount}</span>
        </div>
        <div class="p2j-summary__row">
          <span class="p2j-summary__key">Format</span>
          <span class="p2j-summary__val" id="p2jSumFormat">JPG</span>
        </div>
        <div class="p2j-summary__row">
          <span class="p2j-summary__key">Resolution</span>
          <span class="p2j-summary__val" id="p2jSumDpi">150 dpi</span>
        </div>
        <div class="p2j-summary__row p2j-summary__row--last">
          <span class="p2j-summary__key">Estimated size</span>
          <span class="p2j-summary__val" id="p2jSumSize">${_fmtEstimate()}</span>
        </div>
      </aside>
    </div>

    <!-- 3: Choose pages -->
    <div class="p2j-section">
      <div class="p2j-section__hdr">
        <span class="p2j-step">3</span>Choose pages to export
      </div>
      <div class="p2j-thumb-toolbar">
        <div class="p2j-presets">
          <span class="p2j-presets__lbl">Select:</span>
          <button type="button" class="p2j-preset p2j-preset--on" id="p2jAll">All</button>
          <button type="button" class="p2j-preset" id="p2jNone">None</button>
          <button type="button" class="p2j-preset" id="p2jOdd">Odd pages</button>
          <button type="button" class="p2j-preset" id="p2jEven">Even pages</button>
        </div>
        <div class="p2j-zoom">
          <span class="p2j-zoom__lbl">Zoom</span>
          <button type="button" class="p2j-zoom__btn" id="p2jZoomMinus">&#x2212;</button>
          <input type="range" id="p2jZoom" class="p2j-zoom__range"
                 min="80" max="240" step="20" value="${_thumbZoom}">
          <button type="button" class="p2j-zoom__btn" id="p2jZoomPlus">+</button>
        </div>
      </div>
      <div class="p2j-thumbs" id="p2jThumbs"
           style="--thumb-w:${_thumbZoom}px;--thumb-aspect:${aspectPct}%"></div>
      <div class="p2j-thumb-count" id="p2jThumbCount">
        ${_selectedPages.length} of ${_pageCount} pages selected
      </div>
    </div>

    ${_pageCount > 1 ? `
    <div class="p2j-section p2j-section--opts">
      <div class="p2j-section__hdr">
        <span class="p2j-step">4</span>More options
      </div>
      <div class="p2j-opt-row">
        <div class="p2j-opt-row__info">
          <span class="p2j-opt-row__title">Download as ZIP archive</span>
          <span class="p2j-opt-row__sub">Pack all images into a single ZIP file</span>
        </div>
        <label class="j2p-toggle">
          <input type="checkbox" id="p2jZipCheck" ${_zip ? 'checked' : ''}>
          <span class="j2p-toggle__track"></span>
          <span class="j2p-toggle__thumb"></span>
        </label>
      </div>
    </div>` : ''}
  `;

  _buildThumbs();
  _bindEvents();
  _updateMergeBtn();
}

// ── Thumbnail grid ──────────────────────────────────────────────

function _buildThumbs() {
  const grid = id('p2jThumbs');
  if (!grid) return;

  const frag = document.createDocumentFragment();
  for (let p = 1; p <= _pageCount; p++) {
    const cell = document.createElement('div');
    cell.className = 'p2j-thumb-cell p2j-thumb-cell--on';
    cell.dataset.page = p;
    cell.innerHTML = `
      <div class="p2j-thumb-chk">
        <svg viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="2.2">
          <polyline points="1.5,6 4.5,9 10.5,3"/>
        </svg>
      </div>
      <div class="p2j-thumb-ph"></div>
      <div class="p2j-thumb-badge">${p}</div>
    `;
    frag.appendChild(cell);
  }
  grid.appendChild(frag);

  _observer?.disconnect();
  _observer = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) {
        _observer.unobserve(e.target);
        _enqueue(e.target);
      }
    }
  }, { rootMargin: '300px' });

  grid.querySelectorAll('.p2j-thumb-cell').forEach(c => _observer.observe(c));
}

function _enqueue(cell) {
  if (cell.dataset.rendered) return;
  _renderQueue.push(cell);
  _drain();
}

function _drain() {
  while (_activeRenders < MAX_RENDERS && _renderQueue.length > 0) {
    const cell = _renderQueue.shift();
    if (cell.dataset.rendered) continue;
    _activeRenders++;
    _renderThumb(cell).finally(() => { _activeRenders--; _drain(); });
  }
}

async function _renderThumb(cell) {
  if (!_pdfDoc || cell.dataset.rendered) return;
  const pageNum = parseInt(cell.dataset.page);
  try {
    const page   = await _pdfDoc.getPage(pageNum);
    // Always render at 160px width — CSS scales via --thumb-w (no re-render on zoom)
    const scale  = 160 / page.getViewport({ scale: 1 }).width;
    const vp     = page.getViewport({ scale });

    const canvas  = document.createElement('canvas');
    canvas.width  = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    canvas.className = 'p2j-thumb-canvas';
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

    const ph = cell.querySelector('.p2j-thumb-ph');
    if (ph) ph.replaceWith(canvas);
    cell.dataset.rendered = '1';
    page.cleanup?.();
  } catch { /* leave placeholder */ }
}

// ── Events ─────────────────────────────────────────────────────

function _bindEvents() {
  const container = id('pdf2jpgOptions');
  if (!container) return;

  // Thumb click — toggle page selection
  id('p2jThumbs')?.addEventListener('click', e => {
    const cell = e.target.closest('.p2j-thumb-cell');
    if (!cell) return;
    const p = parseInt(cell.dataset.page);
    if (_selectedPages.includes(p)) {
      _selectedPages = _selectedPages.filter(x => x !== p);
    } else {
      _selectedPages.push(p);
      _selectedPages.sort((a, b) => a - b);
    }
    cell.classList.toggle('p2j-thumb-cell--on', _selectedPages.includes(p));
    _afterSelectionChange('custom');
  });

  // Format / DPI radio cards
  container.addEventListener('change', e => {
    if (e.target.name === 'p2jFormat') {
      _format = e.target.value;
      container.querySelectorAll('.p2j-fmt-card').forEach(c =>
        c.classList.toggle('p2j-fmt-card--on', c.dataset.fmt === _format)
      );
      _updateSummary();
    }
    if (e.target.name === 'p2jDpi') {
      _dpi = parseInt(e.target.value);
      container.querySelectorAll('.p2j-dpi-card').forEach(c =>
        c.classList.toggle('p2j-dpi-card--on', parseInt(c.dataset.dpi) === _dpi)
      );
      _updateSummary();
    }
    if (e.target.id === 'p2jZipCheck') {
      _zip = e.target.checked;
    }
  });

  // Presets
  const presets = { p2jAll: 'all', p2jNone: 'none', p2jOdd: 'odd', p2jEven: 'even' };
  for (const [btnId, preset] of Object.entries(presets)) {
    id(btnId)?.addEventListener('click', () => _applyPreset(preset));
  }

  // Zoom controls
  const zoomEl  = id('p2jZoom');
  const thumbEl = id('p2jThumbs');
  const applyZoom = v => {
    _thumbZoom = Math.max(80, Math.min(240, v));
    if (zoomEl)  zoomEl.value = _thumbZoom;
    if (thumbEl) thumbEl.style.setProperty('--thumb-w', `${_thumbZoom}px`);
  };
  zoomEl?.addEventListener('input', e => applyZoom(parseInt(e.target.value)));
  id('p2jZoomMinus')?.addEventListener('click', () => applyZoom(_thumbZoom - 20));
  id('p2jZoomPlus')?.addEventListener('click',  () => applyZoom(_thumbZoom + 20));
}

function _applyPreset(preset) {
  const all = Array.from({ length: _pageCount }, (_, i) => i + 1);
  if (preset === 'all')  _selectedPages = all;
  if (preset === 'none') _selectedPages = [];
  if (preset === 'odd')  _selectedPages = all.filter(p => p % 2 !== 0);
  if (preset === 'even') _selectedPages = all.filter(p => p % 2 === 0);

  document.querySelectorAll('#p2jThumbs .p2j-thumb-cell').forEach(cell => {
    const p = parseInt(cell.dataset.page);
    cell.classList.toggle('p2j-thumb-cell--on', _selectedPages.includes(p));
  });
  _afterSelectionChange(preset);
}

function _afterSelectionChange(activePreset) {
  // Highlight active preset button
  document.querySelectorAll('.p2j-preset').forEach(btn => {
    const map = { p2jAll: 'all', p2jNone: 'none', p2jOdd: 'odd', p2jEven: 'even' };
    btn.classList.toggle('p2j-preset--on', map[btn.id] === activePreset);
  });

  const el = id('p2jThumbCount');
  if (el) el.textContent = `${_selectedPages.length} of ${_pageCount} pages selected`;
  _updateSummary();
  _updateMergeBtn();
}

function _updateSummary() {
  const sp = id('p2jSumPages');
  const sf = id('p2jSumFormat');
  const sd = id('p2jSumDpi');
  const ss = id('p2jSumSize');
  if (sp) sp.textContent = `${_selectedPages.length} of ${_pageCount}`;
  if (sf) sf.textContent = _format.toUpperCase();
  if (sd) sd.textContent = `${_dpi} dpi`;
  if (ss) ss.textContent = _fmtEstimate();
}

function _updateMergeBtn() {
  const btn = document.getElementById('mergeBtn');
  if (!btn) return;
  const n = _selectedPages.length;
  if (n === 0) {
    btn.disabled = true;
    btn.textContent = 'Select pages to export';
  } else {
    btn.disabled = false;
    btn.textContent = `Export ${n} image${n !== 1 ? 's' : ''}`;
  }
}

// ── Estimated output size ───────────────────────────────────────

function _fmtEstimate() {
  if (!_viewport || _selectedPages.length === 0) return '—';
  const scale  = _dpi / 72;
  const w      = Math.round(_viewport.width  * scale);
  const h      = Math.round(_viewport.height * scale);
  // Empirical bytes-per-pixel: JPG@0.92 ≈ 0.18, PNG ≈ 0.50
  const bpp    = _format === 'jpg' ? 0.18 : 0.50;
  const total  = w * h * bpp * _selectedPages.length;
  if (total < 1024 * 1024) return `≈ ${Math.round(total / 1024)} KB`;
  return `≈ ${(total / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Lazy-load pdf.js ───────────────────────────────────────────

const PDFJS_VERSION     = '3.11.174';
const PDFJS_CDN         = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;
let   _pdfJsLoading     = null;
const PDFJS_MAX_RETRIES = 2;

async function _ensurePdfJs() {
  if (window.pdfjsLib) return;
  if (_pdfJsLoading) { await _pdfJsLoading; return; }
  _pdfJsLoading = _loadWithRetry(PDFJS_MAX_RETRIES);
  try { await _pdfJsLoading; } finally { _pdfJsLoading = null; }
}

async function _loadWithRetry(retriesLeft) {
  try {
    await _loadScript(`${PDFJS_CDN}/pdf.min.js`);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      new URL('./vendor/pdf.worker.min.js', import.meta.url).toString();
  } catch (err) {
    if (retriesLeft > 0) {
      await new Promise(r => setTimeout(r, 1000 * (PDFJS_MAX_RETRIES - retriesLeft + 1)));
      return _loadWithRetry(retriesLeft - 1);
    }
    throw err;
  }
}

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    document.querySelector(`script[src="${src}"]`)?.remove();
    const s = document.createElement('script');
    s.src     = src;
    s.onload  = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

export { _ensurePdfJs as loadPdfJs };
