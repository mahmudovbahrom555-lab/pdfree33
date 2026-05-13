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
//
//  Honesty with user (kept from v1):
//  ─────────────────────────────────
//  We do NOT call this "Remove Watermark" or promise deletion.
//  Text underneath remains in the PDF structure — for real
//  redaction use Acrobat Redact with flattening.
//
//  CRITICAL: do NOT change _toCanvasCoords logic (v9.5 fix).
// ============================================================

import { id, esc }                  from './utils.js';
import { showToast }                from './ui.js';
import { loadingRow, infoBanner,
         checkbox, group }          from './uiComponents.js';
import { loadPdfJs }                from './pdf2jpgUI.js';

// ── Constants ──────────────────────────────────────────────────

const MAX_RECTS_PER_PAGE = 5;
const MIN_DRAG_SIZE = 30;  // px — compromise: mouse precision vs finger

// Color palette — 4 named colors with both hex (preview) and rgb (PDF output)
const COLORS = {
  black: { hex: '#000000', rgb: [0, 0, 0],          label: 'Black' },
  red:   { hex: '#DC2626', rgb: [0.86, 0.15, 0.15], label: 'Red'   },
  blue:  { hex: '#2563EB', rgb: [0.15, 0.39, 0.92], label: 'Blue'  },
  white: { hex: '#FFFFFF', rgb: [1, 1, 1],          label: 'White' },
};

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
let _pageSizes  = [];   // [{width, height}] per page in PDF points
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

// Backward-compat
export function getRedactFillColor() {
  const color = COLORS[_colorKey] || COLORS.black;
  const { rgb } = window.PDFLib;
  return rgb(...color.rgb);
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
    const { PDFDocument } = window.PDFLib;
    const buf = await file.arrayBuffer();
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });

    _pageCount = doc.getPageCount();
    if (_pageCount === 0) { showToast('This PDF has no pages'); _collapse(container); return; }

    // Cache all page sizes
    _pageSizes = doc.getPages().map(p => {
      const { width, height } = p.getSize();
      return { width, height };
    });

    // Reset state
    _sharedRects = [];
    _rectsByPage = {};
    _applyAll = true;
    _currentPage = 1;
    _previewLoaded = false;
    _pdfDoc = null;

    _render(container, file.name, preset);

    // Load pdf.js + first page preview
    try {
      await loadPdfJs();
      _pdfDoc = await window.pdfjsLib.getDocument({
        data: new Uint8Array(buf.slice(0)),
        disableWorker: true,
      }).promise;

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

  const bannerText = tone === 'privacy'
    ? '🛡️ <strong>Cover Area</strong> — draws an opaque rectangle over the selected region. ' +
      'The content underneath is hidden visually but <em>not cryptographically deleted</em>. ' +
      'For legal redaction of sensitive data use dedicated redaction software.'
    : '✏️ <strong>Annotate PDF</strong> — draw colored boxes, highlights, or covers on any page. ' +
      'Everything runs locally in your browser — your PDF never leaves your device.';

  const bannerType = tone === 'privacy' ? 'warn' : 'info';

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
          <span id="rdctPreviewLabel">Drag to draw a box on page 1</span>
        </div>
        <div class="rdct-canvas-wrap" id="rdctCanvasWrap">
          <canvas id="rdctCanvas" class="rdct-canvas"></canvas>
          <svg id="rdctOverlay" class="rdct-overlay"></svg>
          <div id="rdctNoPreview" class="rdct-no-preview" style="display:none">
            Preview unavailable.<br>Use the options below to cover all pages.
          </div>
        </div>
        ${pageNavHtml}
      </div>

      <!-- Right: controls -->
      <div class="rdct-controls">

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

      </div>
    </div>

    ${infoBanner('🔒 Processed entirely in your browser · Files never leave your device', 'info')}
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
    const size = _pageSizes[pageNum - 1] || { width: 595, height: 842 };

    // Scale to fit container width (max ~340px)
    const maxW   = Math.min(wrap.offsetWidth || 340, 340);
    const vp0    = page.getViewport({ scale: 1 });
    const scale  = maxW / vp0.width;
    const vp     = page.getViewport({ scale });

    canvas.width  = vp.width;
    canvas.height = vp.height;

    // Coordinate conversion uses CURRENT page size (different pages may differ!)
    _canvasScale   = size.width  / vp.width;
    _canvasOffsetY = vp.height;

    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: vp
    }).promise;

    // Update overlay SVG dimensions
    const svg = id('rdctOverlay');
    if (svg) {
      svg.setAttribute('width',  vp.width);
      svg.setAttribute('height', vp.height);
      svg.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`);
    }

    // Bind drag ONLY on first render (otherwise listeners stack)
    if (!canvas.dataset.dragBound) {
      _bindDrag(canvas);
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
    lbl.textContent = 'Drag to draw a box';
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

function _bindDrag(canvas) {
  canvas.addEventListener('mousedown',  _onMouseDown);
  canvas.addEventListener('mousemove',  _onMouseMove);
  canvas.addEventListener('mouseup',    _onMouseUp);
  canvas.addEventListener('mouseleave', _onMouseUp);

  canvas.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      e.preventDefault();
      const t = e.touches[0];
      const c = _toCanvasCoords(t.clientX, t.clientY, canvas);
      _dragStartAt(c.x, c.y);
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    if (e.touches.length === 1 && _dragging) {
      e.preventDefault();
      const t = e.touches[0];
      const c = _toCanvasCoords(t.clientX, t.clientY, canvas);
      _dragMoveTo(c.x, c.y);
    }
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    if (_dragging) {
      e.preventDefault();
      const t = e.changedTouches[0];
      const c = _toCanvasCoords(t.clientX, t.clientY, canvas);
      _dragEndAt(c.x, c.y);
    }
  }, { passive: false });

  canvas.addEventListener('touchcancel', () => {
    if (_dragging) _dragEndAt(_dragStart?.x ?? 0, _dragStart?.y ?? 0);
  }, { passive: false });
}

function _onMouseDown(e) {
  const canvas = id('rdctCanvas');
  if (!canvas) return;
  const c = _toCanvasCoords(e.clientX, e.clientY, canvas);
  _dragStartAt(c.x, c.y);
}

function _onMouseMove(e) {
  if (!_dragging) return;
  const canvas = id('rdctCanvas');
  if (!canvas) return;
  const c = _toCanvasCoords(e.clientX, e.clientY, canvas);
  _dragMoveTo(c.x, c.y);
}

function _onMouseUp(e) {
  if (!_dragging) return;
  if (e && e.clientX != null) {
    const canvas = id('rdctCanvas');
    const c = _toCanvasCoords(e.clientX, e.clientY, canvas);
    _dragEndAt(c.x, c.y);
  } else {
    _dragEndAt(_dragStart?.x ?? 0, _dragStart?.y ?? 0);
  }
}

// Unified drag handlers

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

  const ghost = id('rdctGhost');
  if (ghost) ghost.remove();

  if (!_dragStart) return;

  const cx = Math.min(_dragStart.x, endX);
  const cy = Math.min(_dragStart.y, endY);
  const cw = Math.abs(endX - _dragStart.x);
  const ch = Math.abs(endY - _dragStart.y);

  if (cw < MIN_DRAG_SIZE || ch < MIN_DRAG_SIZE) {
    _dragStart = null;
    return;
  }

  const pdfRect = {
    x: cx * _canvasScale,
    y: (_canvasOffsetY - cy - ch) * _canvasScale,
    w: cw * _canvasScale,
    h: ch * _canvasScale,
  };

  const rects = _currentRects();
  rects.push(pdfRect);
  _setCurrentRects(rects);

  _dragStart = null;
  _redrawOverlay();
  _updateRectsList();
  _updateMergeBtn();
}

function _updateDragRect(cx, cy) {
  if (!_dragStart) return;
  const svg = id('rdctOverlay');
  if (!svg) return;

  let ghost = id('rdctGhost');
  if (!ghost) {
    ghost = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    ghost.setAttribute('id', 'rdctGhost');
    ghost.setAttribute('class', 'rdct-ghost');
    svg.appendChild(ghost);
  }

  const x = Math.min(_dragStart.x, cx);
  const y = Math.min(_dragStart.y, cy);
  const w = Math.abs(cx - _dragStart.x);
  const h = Math.abs(cy - _dragStart.y);

  const color = COLORS[_colorKey]?.hex || '#000000';
  ghost.setAttribute('x', x);
  ghost.setAttribute('y', y);
  ghost.setAttribute('width',  Math.max(1, w));
  ghost.setAttribute('height', Math.max(1, h));
  ghost.setAttribute('fill', color);
  ghost.setAttribute('fill-opacity', _opacity * 0.7);
  ghost.setAttribute('stroke', color);
  ghost.setAttribute('stroke-width', '2');
  ghost.setAttribute('stroke-opacity', _opacity);
}

function _redrawOverlay() {
  const svg = id('rdctOverlay');
  if (!svg) return;

  svg.querySelectorAll('.rdct-confirmed, .rdct-rect-label').forEach(el => el.remove());

  const color = COLORS[_colorKey]?.hex || '#000000';
  const rects = _currentRects();

  for (let i = 0; i < rects.length; i++) {
    const r   = rects[i];
    const cx  = r.x / _canvasScale;
    const cy  = _canvasOffsetY - (r.y + r.h) / _canvasScale;
    const cw  = r.w / _canvasScale;
    const ch  = r.h / _canvasScale;

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', cx);
    rect.setAttribute('y', cy);
    rect.setAttribute('width', cw);
    rect.setAttribute('height', ch);
    rect.setAttribute('class', 'rdct-confirmed');
    rect.setAttribute('data-idx', i);
    rect.setAttribute('fill', color);
    rect.setAttribute('fill-opacity', _opacity * 0.7);
    rect.setAttribute('stroke', color);
    rect.setAttribute('stroke-width', '1.5');
    rect.setAttribute('stroke-opacity', _opacity);
    svg.insertBefore(rect, svg.firstChild);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', cx + 6);
    text.setAttribute('y', cy + 16);
    text.setAttribute('class', 'rdct-rect-label');
    const labelColor = (_colorKey === 'white') ? '#000' : '#fff';
    text.setAttribute('fill', labelColor);
    text.textContent = `${i + 1}`;
    svg.appendChild(text);
  }
}

// ── Human position helper ──────────────────────────────────────

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
  const list  = id('rdctRectsList');
  const count = id('rdctCount');
  const countText = id('rdctCountText');
  const clearBtn = id('rdctClearAll');

  const rects = _currentRects();

  if (count) count.textContent = `${rects.length} / ${MAX_RECTS_PER_PAGE}`;

  if (countText) {
    if (_applyAll) {
      // Shared mode — same areas on every page
      if (rects.length === 0) {
        countText.textContent = 'No areas yet';
      } else if (rects.length === 1) {
        countText.textContent = '1 area · all pages';
      } else {
        countText.textContent = `${rects.length} areas · all pages`;
      }
    } else {
      // Per-page mode — show current page's count
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
  // Apply-all checkbox
  id('rdctApplyAll')?.addEventListener('change', e => {
    const newValue = e.target.checked;

    // When switching from per-page to all-pages, migrate page-1 rects to shared
    // (best heuristic — user has been mostly editing first page)
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

  // Opacity slider
  id('rdctOpacity')?.addEventListener('input', e => {
    _opacity = parseInt(e.target.value, 10) / 100;
    const valEl = id('rdctOpacityVal');
    if (valEl) valEl.textContent = `${e.target.value}%`;
    _redrawOverlay();
  });

  // Page navigation buttons
  id('rdctPrevPage')?.addEventListener('click', () => _goToPage(_currentPage - 1));
  id('rdctNextPage')?.addEventListener('click', () => _goToPage(_currentPage + 1));

  // Keyboard navigation: ← / → arrow keys
  container.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' && _currentPage > 1)        _goToPage(_currentPage - 1);
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
        _redrawOverlay();
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
      return;
    }

    if (e.target.id === 'rdctClearAll' || e.target.closest('#rdctClearAll')) {
      _setCurrentRects([]);
      _redrawOverlay();
      _updateRectsList();
      _updateMergeBtn();
      return;
    }
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

function _updateMergeBtn() {
  const btn = id('mergeBtn');
  if (!btn) return;

  const preset = _detectPreset();
  const verb = preset.tone === 'privacy' ? 'Cover' : 'Apply';
  const icon = preset.tone === 'privacy' ? '🛡️' : '✏️';

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
  // Don't reset _colorKey / _opacity — keep user preference across files
}

function _collapse(container) {
  container.style.display = 'none';
  container.innerHTML     = '';
}

function _truncName(name) {
  return name.length > 35 ? name.slice(0, 32) + '…' : name;
}
