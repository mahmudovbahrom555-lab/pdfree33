// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  watermarkUI.js — Watermark PDF options panel
//
//  Live preview design:
//  • Renders the real first page via pdfjsLib (progressive — falls
//    back to fake content lines while loading or if unavailable).
//  • _drawWatermarkLayer() mirrors worker.js handleWatermark()
//    exactly — same tileGapX, tileGapY, stagger, fontSize*0.7 in
//    tile mode, same top/bottom/center y-positions.  Preview = PDF.
//  • DPR-aware canvas — crisp on Retina/HiDPI displays.
//  • Slider debounce — only redraws watermark layer over cached
//    ImageData; never re-renders the PDF page on drag.
// ============================================================

import { id }       from './utils.js';
import { chipGroup, sliderRow, group } from './uiComponents.js';
import { loadPdfJs } from './pdf2jpgUI.js';

// ── State ──────────────────────────────────────────────────────
let _text     = 'CONFIDENTIAL';
let _opacity  = 0.3;
let _position = 'center';       // 'center' | 'top' | 'bottom' | 'tile'
let _fontSize = 40;
let _color    = 'gray';         // 'gray' | 'red' | 'blue'

// Preview state — reset on each initWatermarkOptions() call
let _pageW       = 595;   // actual page width in PDF pts (A4 default)
let _pageH       = 842;   // actual page height in PDF pts (A4 default)
let _bgImageData = null;  // cached first-page render (physical canvas pixels)

export function getWatermarkParams() {
  return { text: _text, opacity: _opacity, position: _position,
           fontSize: _fontSize, color: _color };
}

// ── Public API ─────────────────────────────────────────────────

export function initWatermarkOptions(file) {
  _bgImageData = null;
  _pageW = 595;
  _pageH = 842;
  const container = id('watermarkOptions');
  if (!container) return;
  container.style.display = 'block';
  _render();
  if (file) _loadPageBackground(file);
}

export function hideWatermarkOptions() {
  clearTimeout(_previewTimer);
  const container = id('watermarkOptions');
  if (!container) return;
  container.style.display = 'none';
  container.innerHTML = '';
  _bgImageData = null;
}

// ── Render ─────────────────────────────────────────────────────

function _render() {
  const container = id('watermarkOptions');
  if (!container) return;

  const pctOpacity = Math.round(_opacity * 100);
  const displayH   = Math.round(200 * _pageH / _pageW);

  container.innerHTML = `
    <div class="wm-row">
      <div class="wm-controls">

        ${group('Watermark text', `
          <input type="text" id="wmText" class="wm-text-input"
                 value="${_escAttr(_text)}" maxlength="60"
                 placeholder="CONFIDENTIAL" aria-label="Watermark text">`)}

        ${group('Position', chipGroup('wmPos', [
          { value: 'center', label: '✦ Center' },
          { value: 'top',    label: '↑ Top'    },
          { value: 'bottom', label: '↓ Bottom' },
          { value: 'tile',   label: '⠿ Tile'   },
        ], _position, 'Position'))}

        ${group('Color', `
          <div class="wm-colors" role="group" aria-label="Color">
            ${[
              { v: 'gray', name: 'Gray' },
              { v: 'red',  name: 'Red'  },
              { v: 'blue', name: 'Blue' },
            ].map(c => `
              <label class="wm-color wm-color--${c.v}${_color === c.v ? ' wm-color--active' : ''}"
                     data-value="${c.v}" data-name="wmColor" title="${c.name}">
                <input type="radio" name="wmColor" value="${c.v}"${_color === c.v ? ' checked' : ''}>
                <span class="wm-color__swatch" aria-hidden="true"></span>
                <span class="wm-color__name">${c.name}</span>
              </label>`).join('')}
          </div>
        `)}

        ${sliderRow({ id: 'wmOpacity', label: 'Opacity', valId: 'wmOpacityVal',
                      valText: pctOpacity + '%', min: 5, max: 80, step: 5,
                      value: pctOpacity, ariaLabel: `Opacity ${pctOpacity}%` })}

        ${sliderRow({ id: 'wmFontSize', label: 'Size', valId: 'wmFontSizeVal',
                      valText: _fontSize + 'pt', min: 16, max: 80, step: 4,
                      value: _fontSize, ariaLabel: `Font size ${_fontSize}pt` })}

      </div>

      <!-- Live preview -->
      <div class="wm-preview-wrap" aria-label="Watermark preview" role="img">
        <canvas id="wmPreview" class="wm-preview"
                style="width:200px;height:${displayH}px"
                aria-label="Preview of watermark placement"></canvas>
        <div class="wm-preview__label">Preview</div>
      </div>
    </div>
  `;

  _bindEvents();
  _drawPreview();
}

// ── Events ─────────────────────────────────────────────────────

function _bindEvents() {
  const container = id('watermarkOptions');

  id('wmText')?.addEventListener('input', e => {
    _text = e.target.value;
    _schedulePreview();  // debounced — typing fast won't flood redraws
  });

  container.addEventListener('change', e => {
    if (e.target.name === 'wmPos') {
      _position = e.target.value;
      container.querySelectorAll('[data-name="wmPos"]').forEach(el =>
        el.classList.toggle('j2p-chip--active', el.dataset.value === _position));
      _drawPreview();  // immediate — discrete choice
    }
    if (e.target.name === 'wmColor') {
      _color = e.target.value;
      container.querySelectorAll('[data-name="wmColor"]').forEach(el =>
        el.classList.toggle('wm-color--active', el.dataset.value === _color));
      _drawPreview();  // immediate — discrete choice
    }
  });

  id('wmOpacity')?.addEventListener('input', e => {
    _opacity = e.target.value / 100;
    const val = id('wmOpacityVal');
    if (val) val.textContent = e.target.value + '%';
    _schedulePreview();  // debounced — continuous drag
  });

  id('wmFontSize')?.addEventListener('input', e => {
    _fontSize = parseInt(e.target.value, 10) || 40;
    const val = id('wmFontSizeVal');
    if (val) val.textContent = e.target.value + 'pt';
    _schedulePreview();  // debounced — continuous drag
  });
}

// ── Canvas size helper ─────────────────────────────────────────

function _setCanvasSize(canvas, displayW, displayH) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width        = Math.round(displayW * dpr);
  canvas.height       = Math.round(displayH * dpr);
  canvas.style.width  = displayW + 'px';
  canvas.style.height = displayH + 'px';
}

// ── Background: render real first page ────────────────────────

async function _loadPageBackground(file) {
  let doc;
  try {
    await loadPdfJs();
    if (!window.pdfjsLib) return;

    const buf  = await file.arrayBuffer();
    doc        = await window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    const page = await doc.getPage(1);
    const vp1  = page.getViewport({ scale: 1 });
    _pageW = vp1.width;
    _pageH = vp1.height;

    const canvas = id('wmPreview');
    if (!canvas) return;

    const dpr      = window.devicePixelRatio || 1;
    const displayW = 200;
    const displayH = Math.round(displayW * _pageH / _pageW);
    _setCanvasSize(canvas, displayW, displayH);

    // Render at physical pixel resolution
    const renderScale = canvas.width / _pageW;
    const renderVP    = page.getViewport({ scale: renderScale });
    const ctx         = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: renderVP }).promise;

    // Cache so slider drags skip the expensive pdf.js render
    _bgImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Watermark layer in logical CSS pixel space
    ctx.save();
    ctx.scale(dpr, dpr);
    _drawWatermarkLayer(ctx, displayW, displayH);
    ctx.restore();
  } catch (_e) {
    _bgImageData = null;
    _drawPreview();
  } finally {
    if (doc) doc.destroy().catch(() => {});
  }
}

// ── Live canvas preview ────────────────────────────────────────

const COLOR_MAP = {
  gray: 'rgba(128,128,128,',
  red:  'rgba(200,0,0,',
  blue: 'rgba(0,60,200,',
};

// Fake content lines — deterministic widths so preview doesn't jitter on drag
const LINE_WIDTHS = [110, 140, 85, 130, 70, 150, 95, 125, 60, 140, 80, 120, 100, 145, 75, 135, 90, 115];

let _previewTimer = null;
function _schedulePreview() {
  clearTimeout(_previewTimer);
  _previewTimer = setTimeout(_drawPreview, 60);
}

function _drawPreview() {
  const canvas = id('wmPreview');
  if (!canvas) return;

  const dpr      = window.devicePixelRatio || 1;
  const displayW = 200;
  const displayH = Math.round(displayW * _pageH / _pageW);
  _setCanvasSize(canvas, displayW, displayH);

  const ctx = canvas.getContext('2d');

  if (_bgImageData) {
    // Restore cached page render — putImageData writes to physical pixels
    // and bypasses the current transform, so no scale() needed here.
    ctx.putImageData(_bgImageData, 0, 0);
  } else {
    // Fallback: white page + placeholder content lines
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#e8e8e8';
    let li = 0;
    for (let y = 20; y < displayH - 20; y += 14) {
      ctx.fillRect(16, y, LINE_WIDTHS[li % LINE_WIDTHS.length], 5);
      li++;
    }
    ctx.restore();
  }

  // Watermark layer in logical CSS pixel space
  ctx.save();
  ctx.scale(dpr, dpr);
  _drawWatermarkLayer(ctx, displayW, displayH);
  ctx.restore();
}

// Watermark drawing — mirrors worker.js handleWatermark() exactly.
//
// worker.js uses PDF coordinates (y=0 at bottom of page).
// Canvas uses CSS coordinates (y=0 at top).  We flip the y-axis:
//   canvasY = displayH - (pdfY / pageH) * displayH
//
// Scale: all PDF point values are multiplied by scaleX = displayW / _pageW
// (= scaleY for aspect-ratio-preserving canvas, guaranteed by _setCanvasSize).
function _drawWatermarkLayer(ctx, W, H) {
  const text     = _text || 'WATERMARK';
  const scaleX   = W / _pageW;
  const scaleY   = H / _pageH;
  const colorStr = (COLOR_MAP[_color] || COLOR_MAP.gray) + _opacity + ')';

  ctx.save();
  ctx.fillStyle    = colorStr;
  ctx.textBaseline = 'middle';

  if (_position === 'tile') {
    // Mirror worker.js exactly:
    //   tileGapX = width / 2.5
    //   tileGapY = 120  (fixed, matching worker)
    //   row loop: -1 .. rows-1    col loop: -1 .. cols-1
    //   x = col * tileGapX + (row % 2) * (tileGapX / 2)  [stagger every other row]
    //   y = row * tileGapY   (PDF bottom-origin)
    //   size = fontSize * 0.7   (worker applies 0.7 in tile mode)
    const tileGapX = _pageW / 2.5;
    const tileGapY = 120;
    const cols     = Math.ceil(_pageW / tileGapX) + 2;
    const rows     = Math.ceil(_pageH / tileGapY) + 2;
    const fs       = _fontSize * 0.7 * scaleX;
    ctx.font      = `bold ${Math.round(fs)}px sans-serif`;
    ctx.textAlign = 'center';

    for (let row = -1; row < rows; row++) {
      for (let col = -1; col < cols; col++) {
        const pdfX = col * tileGapX + (row % 2) * (tileGapX / 2);
        const pdfY = row * tileGapY;       // PDF: y=0 at bottom
        const cx   = pdfX * scaleX;
        const cy   = H - pdfY * scaleY;   // flip to canvas: y=0 at top
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-25 * Math.PI / 180);
        ctx.fillText(text, 0, 0);
        ctx.restore();
      }
    }
  } else {
    // Mirror worker.js positions (converting PDF bottom-origin y to canvas top-origin y):
    //   center: PDF y = height/2   → canvas y = H/2
    //   top:    PDF y = height-50  → canvas y = 50 * scaleY
    //   bottom: PDF y = 30         → canvas y = H - 30 * scaleY
    const fs = _fontSize * scaleX;
    ctx.font      = `bold ${Math.round(fs)}px sans-serif`;
    ctx.textAlign = 'center';

    let cy;
    if      (_position === 'top')    cy = 50 * scaleY;
    else if (_position === 'bottom') cy = H - 30 * scaleY;
    else                             cy = H / 2;

    const angle = _position === 'center' ? -25 * Math.PI / 180 : 0;
    ctx.translate(W / 2, cy);
    ctx.rotate(angle);
    ctx.fillText(text, 0, 0);
  }

  ctx.restore();
}

// ── Helpers ────────────────────────────────────────────────────

// Attribute-safe escaping — pure string, no DOM dependency.
function _escAttr(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
