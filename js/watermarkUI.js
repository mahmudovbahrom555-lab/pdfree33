// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  watermarkUI.js — Watermark PDF options panel
//
//  Live preview design:
//  • Renders the real first page via pdfjsLib (progressive — falls
//    back to fake content lines while loading or if unavailable).
//  • _drawWatermarkLayer() delegates to computeWatermarkLayout()
//    from watermarkLayout.js — the canonical source of tile math.
//  • DPR-aware canvas — crisp on Retina/HiDPI displays.
//  • Slider debounce — only redraws watermark layer over cached
//    ImageData; never re-renders the PDF page on drag.
// ============================================================

import { id }       from './utils.js';
import { chipGroup, sliderRow, group } from './uiComponents.js';
import { loadPdfJs } from './pdf2jpgUI.js';
import { computeWatermarkLayout } from './watermarkLayout.js';
import { showToast } from './ui.js';

const LOGO_MAX_MB = 10;

// ── Constants ──────────────────────────────────────────────────
const PREVIEW_W = 280;  // preview canvas CSS width in px

// ── State ──────────────────────────────────────────────────────
let _kind     = 'text';         // 'text' | 'image'
let _text     = 'CONFIDENTIAL';
let _opacity  = 0.3;
let _position = 'center';       // 'center' | 'top' | 'bottom' | 'tile'
let _fontSize = 40;
let _color    = 'gray';         // 'gray' | 'red' | 'blue'

// Logo (image) mode state
let _logoBytes   = null;  // Uint8Array — raw file bytes, sent to the worker as-is
let _logoMime    = null;  // 'image/png' | 'image/jpeg'
let _logoImg     = null;  // cached HTMLImageElement, for preview drawing only
let _logoSize    = 0.25;  // logo width as a fraction of page width (0..1)

// Preview state — reset on each initWatermarkOptions() call
let _pageW       = 595;   // actual page width in PDF pts (A4 default)
let _pageH       = 842;   // actual page height in PDF pts (A4 default)
let _bgImageData = null;  // cached first-page render (physical canvas pixels)

export function getWatermarkParams() {
  if (_kind === 'image') {
    return { kind: 'image', bytes: _logoBytes, mime: _logoMime,
              opacity: _opacity, size: _logoSize, position: _position };
  }
  return { kind: 'text', text: _text, opacity: _opacity, position: _position,
           fontSize: _fontSize, color: _color };
}

// ── Public API ─────────────────────────────────────────────────

export function initWatermarkOptions(file) {
  _bgImageData = null;
  _pageW = 595;
  _pageH = 842;
  _kind = 'text';
  _logoBytes = null;
  _logoMime = null;
  _logoImg = null;
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
  const pctSize    = Math.round(_logoSize * 100);
  const displayH   = Math.round(PREVIEW_W * _pageH / _pageW);
  const isImage    = _kind === 'image';

  container.innerHTML = `
    <div class="wm-row">
      <div class="wm-controls">

        ${group('Watermark type', chipGroup('wmKind', [
          { value: 'text',  label: 'Aa Text' },
          { value: 'image', label: '🖼 Logo' },
        ], _kind, 'Watermark type'))}

        ${isImage ? `
          ${group('Upload logo', `
            <label class="wm-logo-drop" for="wmLogoInput">
              <input type="file" id="wmLogoInput" accept="image/png,image/jpeg" style="display:none">
              ${_logoImg
                ? `<img src="${_logoImg.src}" alt="Logo preview" class="wm-logo-drop__preview">`
                : `<span class="wm-logo-drop__hint">Tap to choose a PNG or JPG logo</span>`}
            </label>`)}
        ` : `
          ${group('Watermark text', `
            <input type="text" id="wmText" class="wm-text-input"
                   value="${_escAttr(_text)}" maxlength="60"
                   placeholder="CONFIDENTIAL" aria-label="Watermark text">`)}
        `}

        ${group('Position', chipGroup('wmPos', [
          { value: 'center', label: '✦ Center' },
          { value: 'top',    label: '↑ Top'    },
          { value: 'bottom', label: '↓ Bottom' },
          { value: 'tile',   label: '⠿ Tile'   },
        ], _position, 'Position'))}

        ${!isImage ? group('Color', `
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
        `) : ''}

        ${sliderRow({ id: 'wmOpacity', label: 'Opacity', valId: 'wmOpacityVal',
                      valText: pctOpacity + '%', min: 5, max: 80, step: 5,
                      value: pctOpacity, ariaLabel: `Opacity ${pctOpacity}%` })}

        ${isImage
          ? sliderRow({ id: 'wmLogoSize', label: 'Size', valId: 'wmLogoSizeVal',
                        valText: pctSize + '%', min: 10, max: 60, step: 5,
                        value: pctSize, ariaLabel: `Logo size ${pctSize}% of page width` })
          : sliderRow({ id: 'wmFontSize', label: 'Size', valId: 'wmFontSizeVal',
                        valText: _fontSize + 'pt', min: 16, max: 80, step: 4,
                        value: _fontSize, ariaLabel: `Font size ${_fontSize}pt` })}

      </div>

      <!-- Live preview -->
      <div class="wm-preview-wrap" aria-label="Watermark preview" role="img">
        <canvas id="wmPreview" class="wm-preview"
                style="width:${PREVIEW_W}px;height:${displayH}px"
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
    if (e.target.name === 'wmKind') {
      _kind = e.target.value;
      _render();  // controls differ enough between modes to re-render the whole panel
      return;
    }
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

  id('wmLogoSize')?.addEventListener('input', e => {
    _logoSize = e.target.value / 100;
    const val = id('wmLogoSizeVal');
    if (val) val.textContent = e.target.value + '%';
    _schedulePreview();  // debounced — continuous drag
  });

  id('wmLogoInput')?.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      showToast('Please choose a PNG or JPG image');
      return;
    }
    if (file.size > LOGO_MAX_MB * 1024 * 1024) {
      showToast(`Logo image is too large — please use one under ${LOGO_MAX_MB} MB`);
      return;
    }

    const img = new Image();
    img.onload = async () => {
      _logoImg = img;

      if (file.type === 'image/png') {
        // Some PNGs (indexed/palette color, 16-bit depth — common from
        // stock-asset sites) aren't reliably alpha-decoded by pdf-lib's
        // embedPng(), and render as an opaque white block instead of a
        // transparent logo. Re-encoding through canvas normalizes any
        // input into standard 8-bit RGBA, which pdf-lib always handles.
        const canvas = document.createElement('canvas');
        canvas.width  = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        _logoBytes = new Uint8Array(await blob.arrayBuffer());
        _logoMime  = 'image/png';
      } else {
        _logoBytes = new Uint8Array(await file.arrayBuffer());
        _logoMime  = file.type;
      }

      _render();  // re-render to swap the upload placeholder for the preview thumbnail
    };
    img.src = URL.createObjectURL(file);
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
    const displayW = PREVIEW_W;
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
  const displayW = PREVIEW_W;
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

// Watermark drawing — uses computeWatermarkLayout() from watermarkLayout.js.
// Positions are returned in PDF coordinate space (y=0 at bottom); we flip
// the y-axis when converting to canvas (y=0 at top):
//   canvasX = x * scaleX
//   canvasY = H - y * scaleY
function _drawWatermarkLayer(ctx, W, H) {
  if (_kind === 'image') {
    _drawLogoLayer(ctx, W, H);
    return;
  }

  const text     = _text || 'WATERMARK';
  const scaleX   = W / _pageW;
  const scaleY   = H / _pageH;
  const colorStr = (COLOR_MAP[_color] || COLOR_MAP.gray) + _opacity + ')';

  const items = computeWatermarkLayout({
    pageWidth:  _pageW,
    pageHeight: _pageH,
    fontSize:   _fontSize,
    position:   _position,
  });

  ctx.save();
  ctx.fillStyle    = colorStr;
  ctx.textBaseline = 'middle';
  ctx.textAlign    = 'center';

  for (const { x, y, angle, size } of items) {
    ctx.save();
    ctx.font = `bold ${Math.round(size * scaleX)}px sans-serif`;
    ctx.translate(x * scaleX, H - y * scaleY);
    ctx.rotate(-angle);  // y-axis flip (PDF y-up → canvas y-down) reverses rotation
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  ctx.restore();
}

// Logo preview — mirrors the geometry in js/watermarkImage.js (worker-side,
// PDF-point space) so the preview matches the actual output. Keep the two
// in sync when changing margins/gap factor.
const IMG_TILE_GAP_FACTOR = 1.6;

function _drawLogoLayer(ctx, W, H) {
  if (!_logoImg) return;
  const scaleX = W / _pageW;
  const scaleY = H / _pageH;
  const aspect = _logoImg.naturalHeight / _logoImg.naturalWidth;
  const w = _pageW * _logoSize;
  const h = w * aspect;

  ctx.save();
  ctx.globalAlpha = _opacity;

  const drawAt = (x, y) => {
    // PDF space is y-up from bottom-left; canvas is y-down from top-left.
    ctx.drawImage(_logoImg, x * scaleX, H - (y + h) * scaleY, w * scaleX, h * scaleY);
  };

  if (_position === 'tile') {
    const gapX = w * IMG_TILE_GAP_FACTOR;
    const gapY = h * IMG_TILE_GAP_FACTOR;
    const cols = Math.ceil(_pageW / gapX) + 2;
    const rows = Math.ceil(_pageH / gapY) + 2;
    for (let row = -1; row < rows; row++) {
      for (let col = -1; col < cols; col++) {
        drawAt(col * gapX + (row % 2) * (gapX / 2), row * gapY);
      }
    }
  } else {
    const x = (_pageW - w) / 2;
    const y = _position === 'top'    ? _pageH - h - 40
            : _position === 'bottom' ? 40
            :                          (_pageH - h) / 2;
    drawAt(x, y);
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
