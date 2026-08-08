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
import { chipGroup, sliderRow, group, presetRememberCard } from './uiComponents.js';
import { loadPdfJs } from './pdf2jpgUI.js';
import { computeWatermarkLayout } from './watermarkLayout.js';
import { showToast } from './ui.js';
import { t } from './i18n.js';
import { loadPreset, clearPreset } from './presets.js';

const LOGO_MAX_MB = 10;

// ── Constants ──────────────────────────────────────────────────
const PREVIEW_W = 280;  // preview canvas CSS width in px

// ── State ──────────────────────────────────────────────────────
let _kind     = 'text';         // 'text' | 'image'
let _text     = t('wm_text_placeholder');
let _opacity  = 0.3;
let _position = 'center';       // 'center' | 'top' | 'bottom' | 'tile'
let _fontSize = 40;
let _color    = 'gray';         // 'gray' | 'red' | 'blue'

// Logo (image) mode state
let _logoBytes   = null;  // Uint8Array — raw file bytes, sent to the worker as-is
let _logoMime    = null;  // 'image/png' | 'image/jpeg'
let _logoImg     = null;  // cached HTMLImageElement, for preview drawing only
let _logoSize    = 0.25;  // logo width as a fraction of page width (0..1)
// Separate, lower-range opacity for logo mode. A text watermark is thin
// font strokes with lots of empty space, so 30-80% still reads fine
// underneath; a logo often has large solid-fill shapes (a bold silhouette,
// not an outline), so the same opacity range turns it into a redaction
// block over the document text instead of a watermark. Default and cap
// both sit lower here on purpose.
let _logoOpacity = 0.15;

// Preview state — reset on each initWatermarkOptions() call
let _pageW       = 595;   // actual page width in PDF pts (A4 default)
let _pageH       = 842;   // actual page height in PDF pts (A4 default)
let _bgImageData = null;  // cached first-page render (physical canvas pixels)
let _rememberLoaded = false; // "Remember my settings" applied once per tool session

export function getWatermarkParams() {
  if (_kind === 'image') {
    return { kind: 'image', bytes: _logoBytes, mime: _logoMime,
              opacity: _logoOpacity, size: _logoSize, position: _position };
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
  _logoOpacity = 0.15;
  // Restore saved text-watermark settings once per tool session — image
  // mode is always reset above and never saved (see presetFilter in
  // toolRegistrations.js), so there's nothing to restore for it.
  if (!_rememberLoaded) {
    _rememberLoaded = true;
    const saved = loadPreset('watermark');
    if (saved) {
      _text     = saved.text     ?? _text;
      _opacity  = saved.opacity  ?? _opacity;
      _position = saved.position ?? _position;
      _fontSize = saved.fontSize ?? _fontSize;
      _color    = saved.color    ?? _color;
    }
  }

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
  _rememberLoaded = false;
}

// ── Render ─────────────────────────────────────────────────────

function _render() {
  const container = id('watermarkOptions');
  if (!container) return;

  const isImage    = _kind === 'image';
  const pctOpacity = Math.round((isImage ? _logoOpacity : _opacity) * 100);
  const pctSize    = Math.round(_logoSize * 100);
  const displayH   = Math.round(PREVIEW_W * _pageH / _pageW);

  container.innerHTML = `
    <div class="wm-row">
      <div class="wm-controls">

        ${group(t('wm_type_label'), chipGroup('wmKind', [
          { value: 'text',  label: `Aa ${t('wm_type_text')}` },
          { value: 'image', label: `🖼 ${t('wm_type_image')}` },
        ], _kind, t('wm_type_label')))}

        ${isImage ? `
          ${group(t('wm_upload_logo'), `
            <label class="wm-logo-drop" for="wmLogoInput">
              <input type="file" id="wmLogoInput" accept="image/png,image/jpeg" style="display:none">
              ${_logoImg
                ? `<img src="${_logoImg.src}" alt="${t('wm_logo_preview_alt')}" class="wm-logo-drop__preview">`
                : `<span class="wm-logo-drop__icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></span>
                   <span class="wm-logo-drop__btn">${t('wm_logo_choose')}</span>
                   <span class="wm-logo-drop__hint">${t('wm_logo_hint')}</span>`}
            </label>`)}
        ` : `
          ${group(t('wm_text_label'), `
            <input type="text" id="wmText" class="wm-text-input"
                   value="${_escAttr(_text)}" maxlength="60"
                   placeholder="${_escAttr(t('wm_text_placeholder'))}" aria-label="${_escAttr(t('wm_text_label'))}">`)}
        `}

        ${group(t('wm_position_label'), chipGroup('wmPos', [
          { value: 'center', label: `✦ ${t('wm_pos_center')}` },
          { value: 'top',    label: `↑ ${t('wm_pos_top')}`    },
          { value: 'bottom', label: `↓ ${t('wm_pos_bottom')}` },
          { value: 'tile',   label: `⠿ ${t('wm_pos_tile')}`   },
        ], _position, t('wm_position_label')))}

        ${!isImage ? group(t('wm_color_label'), `
          <div class="wm-colors" role="group" aria-label="${_escAttr(t('wm_color_label'))}">
            ${[
              { v: 'gray', name: t('wm_color_gray') },
              { v: 'red',  name: t('wm_color_red')  },
              { v: 'blue', name: t('wm_color_blue') },
            ].map(c => `
              <label class="wm-color wm-color--${c.v}${_color === c.v ? ' wm-color--active' : ''}"
                     data-value="${c.v}" data-name="wmColor" title="${_escAttr(c.name)}">
                <input type="radio" name="wmColor" value="${c.v}"${_color === c.v ? ' checked' : ''}>
                <span class="wm-color__swatch" aria-hidden="true"></span>
                <span class="wm-color__name">${c.name}</span>
              </label>`).join('')}
          </div>
        `) : ''}

        ${isImage
          ? sliderRow({ id: 'wmOpacity', label: t('wm_opacity_label'), valId: 'wmOpacityVal',
                        valText: pctOpacity + '%', min: 5, max: 50, step: 5,
                        value: pctOpacity, ariaLabel: t('wm_aria_opacity', { pct: pctOpacity }) })
          : sliderRow({ id: 'wmOpacity', label: t('wm_opacity_label'), valId: 'wmOpacityVal',
                        valText: pctOpacity + '%', min: 5, max: 80, step: 5,
                        value: pctOpacity, ariaLabel: t('wm_aria_opacity', { pct: pctOpacity }) })}
        ${isImage ? `<p class="wm-hint">${t('wm_opacity_hint')}</p>` : ''}

        ${isImage
          ? sliderRow({ id: 'wmLogoSize', label: t('wm_size_label'), valId: 'wmLogoSizeVal',
                        valText: pctSize + '%', min: 10, max: 60, step: 5,
                        value: pctSize, ariaLabel: t('wm_aria_logo_size', { pct: pctSize }) })
          : sliderRow({ id: 'wmFontSize', label: t('wm_size_label'), valId: 'wmFontSizeVal',
                        valText: _fontSize + 'pt', min: 16, max: 80, step: 4,
                        value: _fontSize, ariaLabel: t('wm_aria_font_size', { size: _fontSize }) })}

        ${!isImage ? presetRememberCard({
          id:       'watermarkRememberCheck',
          checked:  loadPreset('watermark') !== null,
          title:    '💾 ' + t('preset_remember_title'),
          subtitle: t('preset_remember_sub'),
          ariaLabel: t('preset_remember_title'),
        }) : ''}

      </div>

      <!-- Live preview -->
      <div class="wm-preview-wrap" aria-label="${_escAttr(t('wm_preview_aria'))}" role="img">
        <canvas id="wmPreview" class="wm-preview"
                style="width:${PREVIEW_W}px;height:${displayH}px"
                aria-label="${_escAttr(t('wm_preview_img_aria'))}"></canvas>
        <div class="wm-preview__label">${t('wm_preview_label')}</div>
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
    // Unchecking forgets immediately — saving happens centrally in app.js
    // (_maybeSavePreset) right before processing starts.
    if (e.target.id === 'watermarkRememberCheck' && !e.target.checked) {
      clearPreset('watermark');
    }
  });

  id('wmOpacity')?.addEventListener('input', e => {
    if (_kind === 'image') {
      _logoOpacity = e.target.value / 100;
    } else {
      _opacity = e.target.value / 100;
    }
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
      showToast(t('wm_toast_invalid_type'));
      return;
    }
    if (file.size > LOGO_MAX_MB * 1024 * 1024) {
      showToast(t('wm_toast_too_large', { max: LOGO_MAX_MB }));
      return;
    }

    const img = new Image();
    img.onload = async () => {
      if (file.type === 'image/png') {
        // Some PNGs (indexed/palette color, 16-bit depth — common from
        // stock-asset sites) aren't reliably alpha-decoded by pdf-lib's
        // embedPng(), and render as an opaque white block instead of a
        // transparent logo. Re-encoding through canvas normalizes any
        // input into standard 8-bit RGBA, which pdf-lib always handles.
        const canvas = document.createElement('canvas');
        canvas.width  = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        // De-matte: many exported PNGs bake a white background into the
        // RGB of every semi-transparent (anti-aliased edge) pixel, rather
        // than storing the "true" color under a straight alpha channel.
        // On artwork with lots of soft/thin edges (fine linework, hair,
        // feathers) this shows up as a faint white haze over the whole
        // logo once composited, even though the alpha channel itself
        // decodes fine. Reverse the over-white blend per pixel:
        //   observed = true*a + 255*(1-a)  ⇒  true = (observed - 255*(1-a)) / a
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
          const a = d[i + 3] / 255;
          if (a > 0 && a < 1) {
            d[i]     = Math.max(0, Math.min(255, (d[i]     - 255 * (1 - a)) / a));
            d[i + 1] = Math.max(0, Math.min(255, (d[i + 1] - 255 * (1 - a)) / a));
            d[i + 2] = Math.max(0, Math.min(255, (d[i + 2] - 255 * (1 - a)) / a));
          }
        }
        ctx.putImageData(imgData, 0, 0);

        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        _logoBytes = new Uint8Array(await blob.arrayBuffer());
        _logoMime  = 'image/png';

        // Preview from the de-matted canvas, not the raw upload, so the
        // preview matches what actually gets embedded in the PDF.
        const correctedImg = new Image();
        correctedImg.onload = () => { _logoImg = correctedImg; _render(); };
        correctedImg.src = URL.createObjectURL(blob);
        return;
      }

      _logoBytes = new Uint8Array(await file.arrayBuffer());
      _logoMime  = file.type;
      _logoImg   = img;
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

  const text     = _text || t('wm_default_text');
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
  ctx.globalAlpha = _logoOpacity;

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
