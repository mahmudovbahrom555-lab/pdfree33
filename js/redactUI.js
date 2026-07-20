// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors
//
// ============================================================
//  redactUI.js — Cover Area / Annotate / Markup tool
//
//  Phase 1 + 1.5 improvements (May 2026):
//  • Touch support fixed (proper coordinate resolver)
//  • 4 colors: Black, Red, Blue, White
//  • Opacity slider 50-100%
//  • Human UX language (no more "327×231 pt @ (374, 661)")
//  • SEO routing: /redact-pdf/, /annotate-pdf/, /highlight-pdf/
//  • MULTI-PAGE NAVIGATION — ← / → between pages
//  • Per-page rects when "apply to all" is OFF
//  • Tool picker: rect / arrow / cross / check / plus / minus / text
//  • Undo / Redo (Cmd+Z / Cmd+Shift+Z)
//  • Zoom slider (1x–4x) with magnifier on drag
//  • Move + resize handles on annotation boxes
//
//  Honesty with user (kept from v1):
//  ─────────────────────────────────
//  We do NOT call this "Remove Watermark" or promise deletion.
//  Text underneath remains in the PDF structure — for real
//  redaction use Acrobat Redact with flattening.
//
//  Memory: single pdf.js load — no pdf-lib in UI (OOM fix).
//  CRITICAL: do NOT change _toCanvasCoords logic (v9.5 fix).
// ============================================================

import { id, esc }                  from './utils.js';
import { showToast }                from './ui.js';
import { loadingRow, infoBanner } from './uiComponents.js';
import { loadPdfJs }                from './pdf2jpgUI.js';

// ── Constants ──────────────────────────────────────────────────

const MAX_RECTS_PER_PAGE = 5;
const _MIN_DRAG_SIZE = 30;  // px — compromise: mouse precision vs finger

// Color palette — 4 named colors with both hex (preview) and rgb (PDF output)
const COLORS = {
  black: { hex: '#000000', rgb: [0, 0, 0],          label: 'Black' },
  red:   { hex: '#DC2626', rgb: [0.86, 0.15, 0.15], label: 'Red'   },
  blue:  { hex: '#2563EB', rgb: [0.15, 0.39, 0.92], label: 'Blue'  },
  white: { hex: '#FFFFFF', rgb: [1, 1, 1],          label: 'White' },
};

// ── Luhn algorithm (credit card validation) ───────────────────
// Strips non-digits, then verifies the Luhn check digit.
// Returns false for purely sequential numbers, IDs, etc.
function _luhnCheck(str) {
  const digits = str.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ── PII Pattern Library ────────────────────────────────────────
// Each entry may have an optional `validate(matchStr) → bool` fn.
// When present, regex candidates that fail validation are skipped.
const PII_PATTERNS = [
  { id: 'email', label: '📧 Email',
    regex: /[a-zA-Z0-9._%+\w]+@[a-zA-Z0-9.]+\.[a-zA-Z]{2,}/gi },
  // Phone: require at least one separator between digit groups to avoid
  // matching bare numeric sequences like employee IDs or serial numbers.
  { id: 'phone', label: '📞 Phone',
    regex: /(?:\+\d{1,3}[\s]?)?\(?\d{2,4}\)?[\s.]\d{2,4}[\s.]\d{2,9}/g },
  // Credit card: regex finds 16-digit candidates; Luhn filters false positives.
  { id: 'cc', label: '💳 Credit Card',
    regex: /\b\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}\b/g,
    validate: _luhnCheck },
  { id: 'iban', label: '🏦 IBAN',
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{1,30}\b/g },
  { id: 'url', label: '🌐 URL',
    regex: /https?:\/\/[^\s]+/gi },
];

// SEO routing — page-level presets based on URL path
const PRESETS = {
  '/redact-pdf/':    { color: 'black', opacity: 1.0, tone: 'privacy' },
  '/annotate-pdf/':  { color: 'red',   opacity: 1.0, tone: 'markup'  },
  '/highlight-pdf/': { color: 'red',   opacity: 0.4, tone: 'markup'  },
  '/cover-pdf/':     { color: 'black', opacity: 1.0, tone: 'privacy' },
};

function _detectPreset() {
  const path = window.location.pathname;
  for (const key in PRESETS) {
    if (path.includes(key)) return PRESETS[key];
  }
  return PRESETS['/redact-pdf/'];
}

// ── State ──────────────────────────────────────────────────────

let _pageCount  = 0;
let _pageSizes  = [];   // [{width, height}] per page in PDF points — lazily populated
let _applyAll   = true;
let _previewLoaded = false;

// Per-page rects when applyAll=false; "shared" rects when applyAll=true
// Map: pageIndex (1-based) → array of rects in PDF coords
let _rectsByPage = {};  // {1: [...], 2: [...], ...}
let _sharedRects = [];  // used when applyAll=true (same on every page)

// Current view state
let _currentPage = 1;   // 1-based page being shown
let _pdfDoc = null;     // cached pdf.js document for fast page-switching
let _renderInProgress = null;  // promise of current render to allow cancel

// Color & opacity state
let _colorKey   = 'black';
let _opacity    = 1.0;

// Drag state
let _dragging   = false;
let _dragStart  = null;
let _canvasScale = 1;
let _canvasOffsetY = 0;

let _isTouch = false;
let _activeRectIdx = -1;
let _resizingHandle = null;
let _resizeStartRect = null;
let _moveHandler = null;
let _eventsBound = false;  // listeners on persistent UI elements — bind once
let _endHandler = null;
let _zoomLevel = 1;
let _currentTool = 'rect';

// History state
let _history = [];
let _historyIdx = -1;

function _saveHistory() {
  _history = _history.slice(0, _historyIdx + 1);
  _history.push({
    rectsByPage: JSON.parse(JSON.stringify(_rectsByPage)),
    sharedRects: JSON.parse(JSON.stringify(_sharedRects)),
  });
  _historyIdx++;
  _updateHistoryUI();
}

function _updateHistoryUI() {
  const undoBtn = document.getElementById('rdctUndoBtn');
  const redoBtn = document.getElementById('rdctRedoBtn');
  if (undoBtn) undoBtn.disabled = _historyIdx <= 0;
  if (redoBtn) redoBtn.disabled = _historyIdx >= _history.length - 1;
}

function _undo() {
  if (_historyIdx > 0) {
    _historyIdx--;
    const state = JSON.parse(JSON.stringify(_history[_historyIdx]));
    _rectsByPage = state.rectsByPage;
    _sharedRects = state.sharedRects;
    _activeRectIdx = -1;
    _redrawOverlay();
    _updateRectsList();
    _updateMergeBtn();
    _updateHistoryUI();
  }
}

function _redo() {
  if (_historyIdx < _history.length - 1) {
    _historyIdx++;
    const state = JSON.parse(JSON.stringify(_history[_historyIdx]));
    _rectsByPage = state.rectsByPage;
    _sharedRects = state.sharedRects;
    _activeRectIdx = -1;
    _redrawOverlay();
    _updateRectsList();
    _updateMergeBtn();
    _updateHistoryUI();
  }
}

const TOOL_ICONS = {
  rect: '<svg viewBox="0 0 24 24" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>',
  cross: '<svg viewBox="0 0 24 24" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
  check: '<svg viewBox="0 0 24 24" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>',
  plus: '<svg viewBox="0 0 24 24" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
  minus: '<svg viewBox="0 0 24 24" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
  text: '<svg viewBox="0 0 24 24" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>',
};

// ── Helper: get current page's rects (handles applyAll mode) ───

function _currentRects() {
  if (_applyAll) return _sharedRects;
  if (!_rectsByPage[_currentPage]) _rectsByPage[_currentPage] = [];
  return _rectsByPage[_currentPage];
}

function _setCurrentRects(rects) {
  if (_applyAll) {
    _sharedRects = rects;
  } else {
    _rectsByPage[_currentPage] = rects;
  }
}

// Get total rect count across all pages (or shared count)
function _totalRectCount() {
  if (_applyAll) return _sharedRects.length;
  return Object.values(_rectsByPage).reduce((sum, arr) => sum + arr.length, 0);
}

// ── Public API ─────────────────────────────────────────────────

export function getRedactParams() {
  const color = COLORS[_colorKey] || COLORS.black;

  if (_applyAll) {
    // Single rects array, same on every page
    return {
      rects: [..._sharedRects],
      applyAll: true,
      fillColor: color.rgb,
      opacity: _opacity,
    };
  } else {
    // Per-page rects map
    // Worker expects array — but we need to send per-page info
    // Use new format: rectsByPage = {1: [...], 2: [...]}
    return {
      rects: _rectsByPage[1] ? [..._rectsByPage[1]] : [],  // back-compat fallback
      rectsByPage: { ..._rectsByPage },
      applyAll: false,
      fillColor: color.rgb,
      opacity: _opacity,
    };
  }
}

export async function initRedactOptions(file) {
  const container = id('redactOptions');
  if (!container) return;

  // Apply SEO preset BEFORE rendering
  const preset = _detectPreset();
  _colorKey = preset.color;
  _opacity  = preset.opacity;

  container.innerHTML = loadingRow('Loading PDF…');
  container.style.display = 'block';

  try {
    // Single load: use pdf.js for both page count and rendering.
    // Page sizes are populated lazily per page in _renderPage (scale=1 viewport = PDF points).
    // Previously pdfree 12 used pdf-lib + pdf.js = 2 full copies in RAM (OOM on mobile).
    await loadPdfJs();
    const buf = await file.arrayBuffer();
    _pdfDoc = await window.pdfjsLib.getDocument({
      data: new Uint8Array(buf),
      disableWorker: true,
    }).promise;

    _pageCount = _pdfDoc.numPages;
    if (_pageCount === 0) { showToast('This PDF has no pages'); _collapse(container); return; }

    // Sizes populated lazily per page in _renderPage (viewport at scale=1 = PDF points).
    // _humanPosition/_sizeDescription have A4 fallbacks so no upfront load needed.
    _pageSizes = new Array(_pageCount).fill(null);

    // Reset state
    _sharedRects = [];
    _rectsByPage = {};
    _applyAll = true;
    _currentPage = 1;
    _previewLoaded = false;
    _history = [];
    _historyIdx = -1;
    _saveHistory();

    _render(container, file.name, preset);

    try {
      await _renderPage(_currentPage);
      _previewLoaded = true;
    } catch (e) {
      console.warn('[redactUI] Preview failed:', e.message);
      _showNoPreview();
    }

  } catch (err) {
    showToast('Could not read PDF: ' + err.message, 5000);
    _collapse(container);
  }
}

export function hideRedactOptions() {
  _cleanup();
  const container = id('redactOptions');
  if (!container) return;
  container.style.display = 'none';
  container.innerHTML = '';
}

// ── Main render ────────────────────────────────────────────────

function _render(container, fileName, preset) {
  const tone = preset.tone;

  const isTrueRedact = window.location.pathname.includes('/redact-pdf/');

  const bannerText = isTrueRedact
    ? '🔒 <strong>True PDF Redaction</strong> — permanently removes content from the document. ' +
      'Redacted pages are converted to images so underlying text cannot be recovered. Files never leave your device.'
    : tone === 'privacy'
      ? '🛡️ <strong>Cover Area</strong> — draws an opaque rectangle over the selected region. ' +
        'The content underneath is hidden visually but <em>not cryptographically deleted</em>. ' +
        'For legal redaction use the <a href="/redact-pdf/" style="color:var(--green)">Redact PDF</a> tool.'
      : '✏️ <strong>Annotate PDF</strong> — draw colored boxes, highlights, or covers on any page. ' +
        'Everything runs locally in your browser — your PDF never leaves your device.';

  const bannerType = isTrueRedact ? 'info' : (tone === 'privacy' ? 'warn' : 'info');

  // Build color swatches dynamically (4 colors)
  const swatchesHtml = Object.entries(COLORS).map(([key, c]) => {
    const isActive = key === _colorKey ? 'rdct-swatch--active' : '';
    return `<button type="button"
              class="rdct-swatch rdct-swatch--${key} ${isActive}"
              data-color="${key}"
              aria-label="${c.label}"
              aria-pressed="${key === _colorKey}"
              title="${c.label}"></button>`;
  }).join('');

  // Page navigation — only show when more than 1 page
  const pageNavHtml = _pageCount > 1 ? `
    <div class="rdct-page-nav" role="group" aria-label="Page navigation">
      <button type="button" class="rdct-page-btn" id="rdctPrevPage"
              aria-label="Previous page" disabled>‹</button>
      <span class="rdct-page-info">
        Page <strong id="rdctPageCurrent">1</strong> of <strong>${_pageCount}</strong>
      </span>
      <button type="button" class="rdct-page-btn" id="rdctNextPage"
              aria-label="Next page" ${_pageCount === 1 ? 'disabled' : ''}>›</button>
    </div>
  ` : '';

  const zoomCtrlHtml = `
    <div class="rdct-zoom-ctrl">
      <label>Zoom:</label>
      <input type="range" id="rdctZoomSlider" min="1" max="4" step="0.5" value="${_zoomLevel}">
      <span id="rdctZoomValue">${_zoomLevel}x</span>
    </div>
  `;

  container.innerHTML = `
    <div class="compress-info">
      <span class="compress-info__name" title="${esc(fileName)}">${_truncName(fileName)}</span>
      <span class="compress-info__dot">·</span>
      <span class="compress-info__meta">${_pageCount} page${_pageCount !== 1 ? 's' : ''}</span>
    </div>

    ${infoBanner(bannerText, bannerType)}

    <div class="rdct-layout">

      <!-- Left: canvas preview with page navigation -->
      <div class="rdct-preview-wrap">
        <div class="rdct-preview-label">
          <span id="rdctPreviewLabel">Drag to draw a shape on page 1</span>
        </div>
        <div class="rdct-canvas-wrap" id="rdctCanvasWrap">
          <canvas id="rdctCanvas" class="rdct-canvas"></canvas>
          <div id="rdctOverlay" class="rdct-overlay"></div>
          <canvas id="rdctMagnifier" class="rdct-magnifier"></canvas>
          <div id="rdctNoPreview" class="rdct-no-preview" style="display:none">
            Preview unavailable.<br>Use the options below to cover all pages.
          </div>
        </div>
        ${pageNavHtml}
        ${zoomCtrlHtml}
      </div>

      <!-- Right: controls -->
      <div class="rdct-controls">

        <!-- Tool picker -->
        <div class="rdct-tools">
          <div class="rdct-tool-label" style="display:flex; justify-content:space-between; align-items:center;">
            <span>Shape Tool</span>
            <div style="display:flex; gap:4px;">
              <button class="rdct-history-btn" id="rdctUndoBtn" disabled title="Undo (Cmd+Z)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3l-3 2.7"/></svg>
              </button>
              <button class="rdct-history-btn" id="rdctRedoBtn" disabled title="Redo (Cmd+Shift+Z)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"/></svg>
              </button>
            </div>
          </div>
          <div class="rdct-tool-picker" id="rdctToolPicker">
            ${Object.entries(TOOL_ICONS).map(([key, svg]) => `
              <button class="rdct-shape-btn ${key === _currentTool ? 'active' : ''}" data-tool="${key}" title="${key.charAt(0).toUpperCase() + key.slice(1)}">
                ${svg} ${key === 'rect' ? 'Box' : key.charAt(0).toUpperCase() + key.slice(1)}
              </button>
            `).join('')}
          </div>
        </div>

        <!-- Color picker -->
        <div class="rdct-tools">
          <div class="rdct-tool-label">Color</div>
          <div class="rdct-fill-swatches" role="group" aria-label="Fill colour">
            ${swatchesHtml}
          </div>
        </div>

        <!-- Opacity slider -->
        <div class="rdct-tools">
          <div class="rdct-tool-label">
            Opacity
            <span class="rdct-opacity-val" id="rdctOpacityVal">${Math.round(_opacity * 100)}%</span>
          </div>
          <input type="range" id="rdctOpacity"
                 class="rdct-opacity-slider"
                 min="50" max="100" step="5"
                 value="${Math.round(_opacity * 100)}"
                 aria-label="Opacity">
        </div>

        <!-- Selected areas list -->
        <div class="rdct-rects-wrap">
          <div class="rdct-rects-label">
            <span id="rdctCountText">No areas yet</span>
            <span class="rdct-rects-count" id="rdctCount">0 / ${MAX_RECTS_PER_PAGE}</span>
          </div>
          <ul class="rdct-rects-list" id="rdctRectsList">
            <li class="rdct-rects-empty" id="rdctEmpty">Drag on the preview to add areas</li>
          </ul>
          <button type="button" class="rdct-clear-btn" id="rdctClearAll"
                  disabled>✕ Remove all</button>
        </div>

        ${_pageCount > 1 ? `
        <div class="rdct-opts">
          <label class="compress-preserve rdct-apply-all">
            <input type="checkbox" id="rdctApplyAll" checked>
            <span class="compress-preserve__box" aria-hidden="true"></span>
            <div class="compress-preserve__text">
              <strong>Repeat on every page</strong>
              <small>Same position on all ${_pageCount} pages — ideal for diagonal DRAFT stamps</small>
            </div>
          </label>
        </div>` : ''}

        ${isTrueRedact ? `
        <!-- Search & Redact + PII patterns -->
        <div class="rdct-tools" id="rdctSearchWrap">
          <div class="rdct-tool-label">Search &amp; Redact</div>
          <div style="display:flex;gap:6px;margin-bottom:6px;">
            <input type="text" id="rdctSearchInput" placeholder="Type text or /regex/…"
              style="flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface2);color:var(--text);font-size:13px;">
            <button type="button" id="rdctSearchBtn"
              style="padding:6px 10px;background:var(--green);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap;">Find &amp; Mark</button>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:5px;">
            ${PII_PATTERNS.map(p => `<button type="button" class="rdct-pii-btn" data-pii="${p.id}"
              style="padding:4px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface2);color:var(--text);font-size:11px;cursor:pointer;white-space:nowrap;">${p.label}</button>`).join('')}
          </div>
          <div id="rdctSearchHint" style="font-size:11px;color:var(--text3);margin-top:5px;"></div>
        </div>

        <!-- View toggle + Metadata -->
        <div class="rdct-opts" style="display:flex;flex-direction:column;gap:8px;">
          <label class="compress-preserve" style="cursor:pointer;">
            <input type="checkbox" id="rdctHideRedactions">
            <span class="compress-preserve__box" aria-hidden="true"></span>
            <div class="compress-preserve__text">
              <strong>👁 Hide redaction boxes</strong>
              <small>Temporarily show document without black boxes to review context</small>
            </div>
          </label>
          <label class="compress-preserve" style="cursor:pointer;position:relative;">
            <input type="checkbox" id="rdctRemoveMeta" checked>
            <span class="compress-preserve__box" aria-hidden="true"></span>
            <div class="compress-preserve__text">
              <strong>Remove metadata
                <span id="rdctMetaTip" title="Removes Author, Creator, Producer, Keywords and other hidden fields embedded in the PDF" style="cursor:help;margin-left:3px;color:var(--text3);font-weight:400;">ⓘ</span>
              </strong>
              <small>Strip Author, Creator, keywords and other hidden fields from PDF</small>
            </div>
          </label>
        </div>` : ''}

      </div>
    </div>

    ${infoBanner(
      isTrueRedact
        ? '🔒 Processed entirely in your browser · Files never leave your device · Content permanently removed'
        : '🔒 Processed entirely in your browser · Files never leave your device',
      'info'
    )}
  `;

  _bindEvents(container);
}

// ── Canvas preview: render a specific page ─────────────────────

async function _renderPage(pageNum) {
  if (!_pdfDoc) return;
  if (pageNum < 1 || pageNum > _pageCount) return;

  const canvas = id('rdctCanvas');
  const wrap   = id('rdctCanvasWrap');
  if (!canvas || !wrap) return;

  // Wait for previous render to settle (avoid race conditions on fast clicks)
  if (_renderInProgress) {
    try { await _renderInProgress; } catch { /* ignore */ }
  }

  _renderInProgress = (async () => {
    const page = await _pdfDoc.getPage(pageNum);

    // Scale to fit available width multiplied by zoom level
    const maxW      = Math.min(wrap.parentElement.offsetWidth || 340, 340);
    const vp0       = page.getViewport({ scale: 1 });

    // Lazily populate page size from pdf.js viewport (scale=1 units = PDF points).
    // Different pages can have different sizes — always update for current page.
    _pageSizes[pageNum - 1] = { width: vp0.width, height: vp0.height };

    const baseScale = maxW / vp0.width;
    const scale     = baseScale * _zoomLevel;
    const vp        = page.getViewport({ scale });

    canvas.width  = vp.width;
    canvas.height = vp.height;

    // Coordinate conversion uses CURRENT page size (different pages may differ!)
    _canvasScale   = vp0.width / vp.width;
    _canvasOffsetY = vp.height;

    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: vp
    }).promise;

    // Update div overlay dimensions
    const overlay = id('rdctOverlay');
    if (overlay) {
      overlay.style.width  = `${vp.width}px`;
      overlay.style.height = `${vp.height}px`;
    }

    // Bind drag ONLY on first render (otherwise listeners stack)
    if (!canvas.dataset.dragBound) {
      _bindDrag(id('rdctCanvasWrap'));
      canvas.dataset.dragBound = '1';
    }

    _redrawOverlay();
    _updatePageNav();
    _updatePreviewLabel();
  })();

  try {
    await _renderInProgress;
  } finally {
    _renderInProgress = null;
  }
}

function _updatePageNav() {
  const prev = id('rdctPrevPage');
  const next = id('rdctNextPage');
  const cur  = id('rdctPageCurrent');

  if (prev) prev.disabled = _currentPage <= 1;
  if (next) next.disabled = _currentPage >= _pageCount;
  if (cur)  cur.textContent = _currentPage;
}

function _updatePreviewLabel() {
  const lbl = id('rdctPreviewLabel');
  if (!lbl) return;
  if (_pageCount === 1) {
    lbl.textContent = 'Drag to draw a shape';
  } else if (_applyAll) {
    lbl.textContent = `Drag on page ${_currentPage} — applies to all pages`;
  } else {
    lbl.textContent = `Drag on page ${_currentPage} — only this page`;
  }
}

function _showNoPreview() {
  const noP = id('rdctNoPreview');
  const canvas = id('rdctCanvas');
  if (noP)    noP.style.display = 'flex';
  if (canvas) canvas.style.display = 'none';
}

// ── Coordinate conversion (CRITICAL — v9.5 fix) ────────────────

function _toCanvasCoords(clientX, clientY, canvas) {
  const rect   = canvas.getBoundingClientRect();
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top)  * scaleY,
  };
}

// ── Drag to select (mouse + touch unified) ─────────────────────

function _bindDrag(wrap) {
  wrap.addEventListener('mousedown',  _onMouseDown);
  wrap.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      if (e.cancelable !== false) e.preventDefault();
      _isTouch = true;
      _onMouseDown(e.touches[0]);
    }
  }, { passive: false });
}

function _onMouseDown(e) {
  const canvas = id('rdctCanvas');
  if (!canvas) return;
  const c = _toCanvasCoords(e.clientX, e.clientY, canvas);

  const moveHandle = e.target.closest('.rdct-move-handle');
  if (moveHandle) {
    _dragging = true;
    _resizingHandle = 'move';
    _activeRectIdx = parseInt(moveHandle.closest('.rdct-box').dataset.idx, 10);
    _dragStart = { x: c.x, y: c.y };
    _resizeStartRect = { ..._currentRects()[_activeRectIdx] };
    _showMagnifier(e.clientX, e.clientY);
  } else {

  const handle = e.target.closest('.rdct-handle');
  if (handle) {
    _dragging = true;
    _resizingHandle = handle.className.split(' ').find(cls => ['nw','ne','sw','se'].includes(cls));
    _activeRectIdx = parseInt(handle.closest('.rdct-box').dataset.idx, 10);
    _dragStart = { x: c.x, y: c.y };
    _resizeStartRect = { ..._currentRects()[_activeRectIdx] };
    _showMagnifier(e.clientX, e.clientY);
  } else {
    const box = e.target.closest('.rdct-box');
    if (box) {
      if (e.target.tagName.toLowerCase() === 'textarea') return;
      _activeRectIdx = parseInt(box.dataset.idx, 10);
      _dragging = true;
      _resizingHandle = 'move';
      _dragStart = { x: c.x, y: c.y };
      _resizeStartRect = { ..._currentRects()[_activeRectIdx] };
      _redrawOverlay();
      return;
    }
    _activeRectIdx = -1;
    _redrawOverlay();

    _dragStartAt(c.x, c.y);
    _showMagnifier(e.clientX, e.clientY);
  }

  _moveHandler = ev => {
    if (!_dragging) return;
    const t = ev.touches ? ev.touches[0] : ev;
    if (!t) return;
    if (ev.cancelable !== false) ev.preventDefault();
    const pos = _toCanvasCoords(t.clientX, t.clientY, canvas);
    _showMagnifier(t.clientX, t.clientY);

    if (_resizingHandle) {
      const r = _resizeStartRect;
      const dx = pos.x - _dragStart.x;
      const dy = pos.y - _dragStart.y;

      const rects = _currentRects();
      const currentRect = rects[_activeRectIdx];

      if (_resizingHandle === 'move') {
        currentRect.x = r.x + dx * _canvasScale;
        currentRect.y = r.y - dy * _canvasScale;

        const box = document.querySelector(`.rdct-box[data-idx="${_activeRectIdx}"]`);
        if (box) {
          box.style.left = `${currentRect.x / _canvasScale}px`;
          box.style.top = `${(_canvasOffsetY - currentRect.y / _canvasScale - currentRect.h / _canvasScale)}px`;
        } else {
          _redrawOverlay();
        }
        return;
      }

      const cx0 = r.x / _canvasScale;
      const cy0 = _canvasOffsetY - (r.y + r.h) / _canvasScale;
      const cw0 = r.w / _canvasScale;
      const ch0 = r.h / _canvasScale;

      let cx = cx0, cy = cy0, cw = cw0, ch = ch0;
      let finalFlipX = r.flipX;
      let finalFlipY = r.flipY;

      if (_resizingHandle.includes('w')) { cx += dx; cw -= dx; }
      if (_resizingHandle.includes('e')) { cw += dx; }
      if (_resizingHandle.includes('n')) { cy += dy; ch -= dy; }
      if (_resizingHandle.includes('s')) { ch += dy; }

      if (cw < 0) {
        cw = Math.abs(cw);
        cx -= cw;
        finalFlipX = !finalFlipX;
      }
      if (ch < 0) {
        ch = Math.abs(ch);
        cy -= ch;
        finalFlipY = !finalFlipY;
      }

      if (cw < 5) { cw = 5; if (_resizingHandle.includes('w')) cx = cx0 + cw0 - 5; }
      if (ch < 5) { ch = 5; if (_resizingHandle.includes('n')) cy = cy0 + ch0 - 5; }

      currentRect.x = cx * _canvasScale;
      currentRect.y = (_canvasOffsetY - cy - ch) * _canvasScale;
      currentRect.w = cw * _canvasScale;
      currentRect.h = ch * _canvasScale;
      currentRect.flipX = finalFlipX;
      currentRect.flipY = finalFlipY;

      const box = document.querySelector(`.rdct-box[data-idx="${_activeRectIdx}"]`);
      if (box) {
        box.style.left   = `${cx}px`;
        box.style.top    = `${cy}px`;
        box.style.width  = `${cw}px`;
        box.style.height = `${ch}px`;
        const svg = box.querySelector('.rdct-shape-svg');
        if (svg && currentRect.type === 'arrow') {
          let transform = '';
          if (finalFlipX) transform += 'scaleX(-1) ';
          if (finalFlipY) transform += 'scaleY(-1) ';
          svg.style.transform = transform.trim();
        }
        const ta = box.querySelector('textarea');
        if (ta) ta.style.fontSize = `${ch * 0.8}px`;
      } else {
        _redrawOverlay();
      }
    } else {
      _dragMoveTo(pos.x, pos.y);
    }
  };

  _endHandler = ev => {
    if (!_dragging) return;
    _hideMagnifier();

    document.removeEventListener('mousemove', _moveHandler);
    document.removeEventListener('touchmove', _moveHandler);
    document.removeEventListener('mouseup', _endHandler);
    document.removeEventListener('touchend', _endHandler);

    if (_resizingHandle) {
      _dragging = false;
      _resizingHandle = null;
      _resizeStartRect = null;
      _updateMergeBtn();
      _saveHistory();
      return;
    }

    const t = ev.changedTouches ? ev.changedTouches[0] : ev;
    const pos = t ? _toCanvasCoords(t.clientX, t.clientY, canvas) : _dragStart;
    _dragEndAt(pos.x, pos.y);
  };

  document.addEventListener('mousemove', _moveHandler, { passive: false });
  document.addEventListener('touchmove', _moveHandler, { passive: false });
  document.addEventListener('mouseup', _endHandler);
  document.addEventListener('touchend', _endHandler);
}
}

function _dragStartAt(x, y) {
  if (_currentRects().length >= MAX_RECTS_PER_PAGE) {
    showToast(`Maximum ${MAX_RECTS_PER_PAGE} areas per page — remove some first`);
    return;
  }
  _dragging  = true;
  _dragStart = { x, y };
  _updateDragRect(x, y);
}

function _dragMoveTo(x, y) {
  _updateDragRect(x, y);
}

function _dragEndAt(endX, endY) {
  _dragging = false;

  const ghost = document.getElementById('rdctGhost');
  if (ghost) ghost.remove();

  if (!_dragStart) return;

  let cx = Math.min(_dragStart.x, endX);
  let cy = Math.min(_dragStart.y, endY);
  let cw = Math.abs(endX - _dragStart.x);
  let ch = Math.abs(endY - _dragStart.y);

  if (cw < 5 || ch < 5) {
    _dragStart = null;
    return;
  }

  const minSize = _isTouch ? 24 : 6;
  if (cw < minSize) { cx -= (minSize - cw) / 2; cw = minSize; }
  if (ch < minSize) { cy -= (minSize - ch) / 2; ch = minSize; }

  const flipX = _dragStart.x > endX;
  const flipY = _dragStart.y > endY;

  const pdfRect = {
    type: _currentTool,
    x: cx * _canvasScale,
    y: (_canvasOffsetY - cy - ch) * _canvasScale,
    w: cw * _canvasScale,
    h: ch * _canvasScale,
    flipX,
    flipY,
    text: '',
  };

  const rects = _currentRects();
  rects.push(pdfRect);
  _setCurrentRects(rects);

  _activeRectIdx = rects.length - 1;
  _dragStart = null;
  _redrawOverlay();
  _updateRectsList();
  _updateMergeBtn();
  _saveHistory();
}

function _updateDragRect(cx, cy) {
  if (!_dragStart) return;
  const overlay = id('rdctOverlay');
  if (!overlay) return;

  let ghost = id('rdctGhost');
  if (!ghost) {
    ghost = document.createElement('div');
    ghost.id = 'rdctGhost';
    ghost.className = 'rdct-box-ghost';
    overlay.appendChild(ghost);
  }

  const x = Math.min(_dragStart.x, cx);
  const y = Math.min(_dragStart.y, cy);
  const w = Math.abs(cx - _dragStart.x);
  const h = Math.abs(cy - _dragStart.y);

  ghost.style.left   = `${x}px`;
  ghost.style.top    = `${y}px`;
  ghost.style.width  = `${Math.max(1, w)}px`;
  ghost.style.height = `${Math.max(1, h)}px`;

  const color = COLORS[_colorKey]?.hex || '#000000';
  ghost.style.borderColor = color;
  ghost.style.backgroundColor = _currentTool === 'rect' ? color : 'transparent';
  ghost.style.opacity = _opacity * 0.7;

  if (_currentTool !== 'rect') {
    if (_currentTool === 'text') {
      ghost.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;color:${color};font-family:sans-serif;font-size:${Math.max(1,h)*0.8}px;padding:2px;overflow:hidden;">Text...</div>`;
    } else {
      ghost.innerHTML = TOOL_ICONS[_currentTool];
      const svg = ghost.querySelector('svg');
      if (svg) {
        svg.setAttribute('class', 'rdct-shape-svg');
        svg.style.color = color;
        if (_currentTool === 'arrow') {
          let transform = '';
          if (_dragStart.x > cx) transform += 'scaleX(-1) ';
          if (_dragStart.y > cy) transform += 'scaleY(-1) ';
          svg.style.transform = transform.trim();
        }
      }
    }
  } else {
    ghost.innerHTML = '';
  }
}

function _redrawOverlay() {
  const overlay = id('rdctOverlay');
  if (!overlay) return;

  overlay.querySelectorAll('.rdct-box, .rdct-rect-label').forEach(el => el.remove());

  const color = COLORS[_colorKey]?.hex || '#000000';
  const rects = _currentRects();

  for (let i = 0; i < rects.length; i++) {
    const r   = rects[i];
    const cx  = r.x / _canvasScale;
    const cy  = _canvasOffsetY - (r.y + r.h) / _canvasScale;
    const cw  = r.w / _canvasScale;
    const ch  = r.h / _canvasScale;

    const box = document.createElement('div');
    box.className = `rdct-box ${i === _activeRectIdx ? 'active' : ''}`;
    box.dataset.idx = i;
    box.style.left   = `${cx}px`;
    box.style.top    = `${cy}px`;
    box.style.width  = `${cw}px`;
    box.style.height = `${ch}px`;

    box.style.borderColor = color;
    box.style.backgroundColor = r.type === 'rect' || !r.type ? color : 'transparent';
    box.style.opacity = _opacity;

    if (r.type && r.type !== 'rect') {
      if (r.type === 'text') {
        const ta = document.createElement('textarea');
        ta.className = 'rdct-text-input';
        ta.value = r.text || '';
        ta.style.color = color;
        ta.style.fontSize = `${ch * 0.8}px`;
        ta.placeholder = 'Type here...';

        // Prevent drag conflict
        ta.addEventListener('mousedown', e => e.stopPropagation());
        ta.addEventListener('touchstart', e => e.stopPropagation());

        ta.addEventListener('input', e => {
          r.text = e.target.value;

          if (ta.scrollWidth > box.offsetWidth) {
            const newW = ta.scrollWidth;
            box.style.width = `${newW}px`;
            r.w = newW * _canvasScale;
          }
          if (ta.scrollHeight > box.offsetHeight) {
            const newH = ta.scrollHeight;
            const oldH = box.offsetHeight;
            box.style.height = `${newH}px`;
            r.h = newH * _canvasScale;
            r.y = r.y - (newH - oldH) * _canvasScale;
          }
        });
        ta.addEventListener('blur', () => {
          _saveHistory();
        });
        box.appendChild(ta);
      } else {
        box.innerHTML = TOOL_ICONS[r.type];
        const svg = box.querySelector('svg');
        if (svg) {
          svg.setAttribute('class', 'rdct-shape-svg');
          svg.style.color = color;

          if (r.type === 'arrow') {
            let transform = '';
            if (r.flipX) transform += 'scaleX(-1) ';
            if (r.flipY) transform += 'scaleY(-1) ';
            svg.style.transform = transform.trim();
          }
        }
      }
    }

    ['nw', 'ne', 'sw', 'se'].forEach(pos => {
      const handle = document.createElement('div');
      handle.className = `rdct-handle ${pos}`;
      box.appendChild(handle);
    });

    const moveHandle = document.createElement('div');
    moveHandle.className = 'rdct-move-handle';
    moveHandle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="5 9 2 12 5 15"></polyline><polyline points="9 5 12 2 15 5"></polyline><polyline points="19 9 22 12 19 15"></polyline><polyline points="9 19 12 22 15 19"></polyline><line x1="2" y1="12" x2="22" y2="12"></line><line x1="12" y1="2" x2="12" y2="22"></line></svg>';
    moveHandle.title = 'Move';
    box.appendChild(moveHandle);

    const label = document.createElement('div');
    label.className = 'rdct-rect-label';
    label.style.color = (_colorKey === 'white') ? '#000' : color;
    label.textContent = `${i + 1}`;
    box.appendChild(label);

    overlay.appendChild(box);
  }
}

function _showMagnifier(clientX, clientY) {
  const mag = id('rdctMagnifier');
  const mainCanvas = id('rdctCanvas');
  const wrap = id('rdctCanvasWrap');
  if (!mag || !mainCanvas || !wrap) return;

  const wrapRect = wrap.getBoundingClientRect();
  const c = _toCanvasCoords(clientX, clientY, mainCanvas);

  mag.style.display = 'block';

  let magX = (clientX - wrapRect.left) - 130;
  let magY = (clientY - wrapRect.top) - 130;
  if (magX < 0) magX = (clientX - wrapRect.left) + 20;
  if (magY < 0) magY = (clientY - wrapRect.top) + 20;

  mag.style.left = `${magX}px`;
  mag.style.top  = `${magY}px`;

  mag.width  = 120;
  mag.height = 120;
  const magCtx = mag.getContext('2d');

  magCtx.fillStyle = 'white';
  magCtx.fillRect(0, 0, 120, 120);

  magCtx.drawImage(mainCanvas, c.x - 20, c.y - 20, 40, 40, 0, 0, 120, 120);

  magCtx.strokeStyle = 'rgba(239, 68, 68, 0.6)';
  magCtx.lineWidth = 1;
  magCtx.beginPath();
  magCtx.moveTo(0, 60);  magCtx.lineTo(120, 60);
  magCtx.moveTo(60, 0);  magCtx.lineTo(60, 120);
  magCtx.stroke();
}

function _hideMagnifier() {
  const mag = id('rdctMagnifier');
  if (mag) mag.style.display = 'none';
}

function _humanPosition(r) {
  const size = _pageSizes[_currentPage - 1] || { width: 595, height: 842 };
  if (size.width === 0 || size.height === 0) return '';

  const centerX = r.x + r.w / 2;
  const centerY = r.y + r.h / 2;

  const xRatio = centerX / size.width;
  const horiz = xRatio < 0.33 ? 'left' : xRatio > 0.67 ? 'right' : 'center';

  const yRatio = centerY / size.height;
  const vert = yRatio > 0.67 ? 'top' : yRatio < 0.33 ? 'bottom' : 'middle';

  if (horiz === 'center' && vert === 'middle') return 'Center';
  if (horiz === 'center') return _capitalize(vert);
  if (vert === 'middle')  return _capitalize(horiz);
  return `${_capitalize(vert)} ${horiz}`;
}

function _capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function _sizeDescription(r) {
  const size = _pageSizes[_currentPage - 1] || { width: 595, height: 842 };
  const area = r.w * r.h;
  const pageArea = size.width * size.height;
  const ratio = area / pageArea;
  if (ratio < 0.02) return 'small';
  if (ratio < 0.15) return 'medium';
  return 'large';
}

// ── Rects list (right panel) — human-readable ──────────────────

function _updateRectsList() {
  const list      = id('rdctRectsList');
  const count     = id('rdctCount');
  const countText = id('rdctCountText');
  const clearBtn  = id('rdctClearAll');

  const rects = _currentRects();

  if (count) count.textContent = `${rects.length} / ${MAX_RECTS_PER_PAGE}`;

  if (countText) {
    if (_applyAll) {
      if (rects.length === 0) {
        countText.textContent = 'No areas yet';
      } else if (rects.length === 1) {
        countText.textContent = '1 area · all pages';
      } else {
        countText.textContent = `${rects.length} areas · all pages`;
      }
    } else {
      if (rects.length === 0) {
        countText.textContent = `No areas on page ${_currentPage}`;
      } else if (rects.length === 1) {
        countText.textContent = `1 area on page ${_currentPage}`;
      } else {
        countText.textContent = `${rects.length} areas on page ${_currentPage}`;
      }
    }
  }

  if (clearBtn) clearBtn.disabled = rects.length === 0;

  if (!list) return;

  list.innerHTML = rects.length === 0
    ? '<li class="rdct-rects-empty" id="rdctEmpty">Drag on the preview to add areas</li>'
    : rects.map((r, i) => {
        const position = _humanPosition(r);
        const size = _sizeDescription(r);
        return `
        <li class="rdct-rect-item" data-idx="${i}">
          <span class="rdct-rect-num">${i + 1}</span>
          <span class="rdct-rect-coords">${position} · ${size}</span>
          <button type="button" class="rdct-rect-del" data-idx="${i}" aria-label="Remove area ${i+1}">✕</button>
        </li>`;
      }).join('');
}

// ── Events ─────────────────────────────────────────────────────

function _bindEvents(container) {
  if (_eventsBound) return;
  _eventsBound = true;

  // History buttons
  id('rdctUndoBtn')?.addEventListener('click', _undo);
  id('rdctRedoBtn')?.addEventListener('click', _redo);

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key.toLowerCase() === 'z' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (e.shiftKey) _redo();
      else _undo();
    }
  });

  // Tool picker
  id('rdctToolPicker').addEventListener('click', e => {
    const btn = e.target.closest('.rdct-shape-btn');
    if (!btn) return;
    document.querySelectorAll('.rdct-shape-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _currentTool = btn.dataset.tool;
  });

  // Zoom slider — preview updates on change (not input) to avoid re-render on every tick
  id('rdctZoomSlider').addEventListener('input', e => {
    _zoomLevel = parseFloat(e.target.value);
    id('rdctZoomValue').textContent = _zoomLevel + 'x';
  });
  id('rdctZoomSlider').addEventListener('change', () => {
    _renderPage(_currentPage);
  });

  // Apply-all checkbox
  id('rdctApplyAll')?.addEventListener('change', e => {
    const newValue = e.target.checked;

    // When switching from per-page to all-pages, migrate page-1 rects to shared
    if (newValue && !_applyAll && Object.keys(_rectsByPage).length > 0) {
      _sharedRects = _rectsByPage[1] ? [..._rectsByPage[1]] : [];
    }
    // When switching from all-pages to per-page, copy shared rects to page 1
    if (!newValue && _applyAll && _sharedRects.length > 0) {
      _rectsByPage[1] = [..._sharedRects];
    }

    _applyAll = newValue;
    _redrawOverlay();
    _updateRectsList();
    _updateMergeBtn();
    _updatePreviewLabel();
  });

  // Opacity slider — update existing boxes in-place to avoid full DOM rebuild on every tick
  id('rdctOpacity')?.addEventListener('input', e => {
    _opacity = parseInt(e.target.value, 10) / 100;
    const valEl = id('rdctOpacityVal');
    if (valEl) valEl.textContent = `${e.target.value}%`;
    id('rdctOverlay')?.querySelectorAll('.rdct-box').forEach(b => {
      b.style.opacity = _opacity;
    });
  });

  // Page navigation buttons
  id('rdctPrevPage')?.addEventListener('click', () => _goToPage(_currentPage - 1));
  id('rdctNextPage')?.addEventListener('click', () => _goToPage(_currentPage + 1));

  // Keyboard navigation: ← / → arrow keys
  container.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' && _currentPage > 1)               _goToPage(_currentPage - 1);
    else if (e.key === 'ArrowRight' && _currentPage < _pageCount) _goToPage(_currentPage + 1);
  });

  // Color swatches + delete + clear (event delegation)
  container.addEventListener('click', e => {
    const sw = e.target.closest('.rdct-swatch');
    if (sw) {
      const colorKey = sw.dataset.color;
      if (colorKey && COLORS[colorKey]) {
        _colorKey = colorKey;
        container.querySelectorAll('.rdct-swatch').forEach(s => {
          s.classList.remove('rdct-swatch--active');
          s.setAttribute('aria-pressed', 'false');
        });
        sw.classList.add('rdct-swatch--active');
        sw.setAttribute('aria-pressed', 'true');
        // Update existing boxes in-place — avoids full DOM rebuild on color switch
        const newHex = COLORS[colorKey].hex;
        const rects  = _currentRects();
        id('rdctOverlay')?.querySelectorAll('.rdct-box').forEach(b => {
          const r = rects[parseInt(b.dataset.idx, 10)];
          if (!r) return;
          b.style.borderColor = newHex;
          if (r.type === 'rect' || !r.type) b.style.backgroundColor = newHex;
          const svg = b.querySelector('.rdct-shape-svg');
          if (svg) svg.style.color = newHex;
          const ta = b.querySelector('textarea');
          if (ta) ta.style.color = newHex;
        });
      }
      return;
    }

    const del = e.target.closest('.rdct-rect-del');
    if (del) {
      const idx = parseInt(del.dataset.idx, 10);
      const rects = _currentRects();
      rects.splice(idx, 1);
      _setCurrentRects(rects);
      _redrawOverlay();
      _updateRectsList();
      _updateMergeBtn();
      _saveHistory();
      return;
    }

    if (e.target.id === 'rdctClearAll' || e.target.closest('#rdctClearAll')) {
      _setCurrentRects([]);
      _redrawOverlay();
      _updateRectsList();
      _updateMergeBtn();
      _saveHistory();
      return;
    }
  });

  // ── True-redact-only controls ──────────────────────────────────
  const searchBtn = id('rdctSearchBtn');
  if (searchBtn) {
    searchBtn.addEventListener('click', () => {
      const input = id('rdctSearchInput');
      if (!input) return;
      const raw = input.value.trim();
      // Support /regex/ syntax
      const regexMatch = raw.match(/^\/(.+)\/([gimu]*)$/);
      if (regexMatch) {
        try {
          const rx = new RegExp(regexMatch[1], regexMatch[2] || 'gi');
          _runPatternSearch(rx, 'regex');
        } catch { showToast('Invalid regex pattern'); }
      } else {
        _runTextSearch(raw);
      }
    });
    id('rdctSearchInput')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') searchBtn.click();
    });
  }

  // PII pattern buttons
  document.querySelectorAll('.rdct-pii-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pii = PII_PATTERNS.find(p => p.id === btn.dataset.pii);
      if (pii) _runPatternSearch(new RegExp(pii.regex.source, pii.regex.flags), pii.id, pii.validate || null);
    });
  });

  id('rdctHideRedactions')?.addEventListener('change', e => {
    const overlay = id('rdctOverlay');
    if (overlay) overlay.style.opacity = e.target.checked ? '0' : '1';
  });
}

async function _goToPage(pageNum) {
  if (pageNum < 1 || pageNum > _pageCount) return;
  if (pageNum === _currentPage) return;
  _currentPage = pageNum;
  await _renderPage(pageNum);
  _updateRectsList();
}

// ── Merge button state ─────────────────────────────────────────

// ── Search & Redact (Phase 2) ──────────────────────────────────
// _runTextSearch: plain text (case-insensitive substring)
// _runPatternSearch: regex + source tag for the redaction report

async function _runTextSearch(query) {
  if (!query) { const h = id('rdctSearchHint'); if (h) h.textContent = 'Enter text to search.'; return; }
  const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  await _runPatternSearch(rx, 'text');
}

async function _runPatternSearch(regex, source, validateFn = null) {
  if (!_pdfDoc) return;
  const hint = id('rdctSearchHint');
  if (hint) hint.textContent = 'Searching…';

  let matchCount = 0;

  for (let p = 1; p <= _pageCount; p++) {
    const page    = await _pdfDoc.getPage(p);
    const content = await page.getTextContent();
    const items   = content.items;

    for (const item of items) {
      const str = item.str;
      if (!str) continue;
      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(str)) !== null) {
        // Skip if a validator rejects this match (e.g. Luhn check for CC)
        if (validateFn && !validateFn(m[0])) continue;

        const [,, , scaleY, tx, ty] = item.transform;
        const charW = item.width / (str.length || 1);
        const x = tx + m.index * charW;
        const w = Math.max(m[0].length * charW, 4);
        const h = Math.max(Math.abs(scaleY) * 1.2, 4);
        const y = ty - h * 0.1;

        const existing = _rectsByPage[p] || [];
        existing.push({ type: 'rect', x, y, w, h, source });
        _rectsByPage[p] = existing;
        matchCount++;
      }
    }
  }

  _applyAll = false;
  const piiLabel = PII_PATTERNS.find(p => p.id === source)?.label || source;
  if (hint) hint.textContent = matchCount > 0
    ? `${piiLabel !== source ? piiLabel + ': ' : ''}Found ${matchCount} match${matchCount !== 1 ? 'es' : ''} — marked on pages`
    : 'No matches found.';
  if (_currentPage) { _redrawOverlay(); _updateRectsList(); }
  _updateMergeBtn();
  if (matchCount > 0) _saveHistory();
}

function _updateMergeBtn() {
  const btn = id('mergeBtn');
  if (!btn) return;

  const isTrueRedact = window.location.pathname.includes('/redact-pdf/');
  const preset = _detectPreset();
  const verb = isTrueRedact ? 'Redact' : (preset.tone === 'privacy' ? 'Cover' : 'Apply');
  const icon = isTrueRedact ? '🔒' : (preset.tone === 'privacy' ? '🛡️' : '✏️');

  const total = _totalRectCount();

  if (total > 0) {
    btn.disabled = false;
    const plural = total !== 1 ? 's' : '';
    let suffix = '';
    if (_applyAll && _pageCount > 1) {
      suffix = ' · all pages';
    } else if (!_applyAll) {
      const pageCount = Object.keys(_rectsByPage).filter(k => _rectsByPage[k].length > 0).length;
      if (pageCount > 1) suffix = ` · ${pageCount} pages`;
    }
    btn.textContent = `${icon} ${verb} ${total} area${plural}${suffix}`;
  } else {
    btn.disabled = true;
    btn.textContent = `${icon} Draw areas to ${verb.toLowerCase()}`;
  }
}

// ── Cleanup ────────────────────────────────────────────────────

function _cleanup() {
  _pageCount = 0;
  _pageSizes = [];
  _sharedRects = [];
  _rectsByPage = {};
  _currentPage = 1;
  _dragging  = false;
  _dragStart = null;
  _previewLoaded = false;
  _pdfDoc = null;
  _renderInProgress = null;
  _activeRectIdx = -1;
  _zoomLevel = 1;
  _currentTool = 'rect';
  _resizingHandle = null;
  _history = [];
  _historyIdx = -1;
  _resizeStartRect = null;
  if (_moveHandler) {
    document.removeEventListener('mousemove', _moveHandler);
    document.removeEventListener('touchmove', _moveHandler);
    document.removeEventListener('mouseup', _endHandler);
    document.removeEventListener('touchend', _endHandler);
  }
  // Don't reset _colorKey / _opacity — keep user preference across files
}

function _collapse(container) {
  container.style.display = 'none';
  container.innerHTML     = '';
}

function _truncName(name) {
  return name.length > 35 ? name.slice(0, 32) + '…' : name;
}
