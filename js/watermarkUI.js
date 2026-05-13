// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  watermarkUI.js — Watermark PDF options panel
//
//  🎯 Сверх ТЗ:
//  1. Live preview — canvas показывает как будет выглядеть
//     водяной знак на странице до обработки.
//  2. Tile mode — повторяет водяной знак сеткой по всей странице
//     (в ТЗ только центр/верх/низ — мы добавляем ещё один режим).
//  3. Размер шрифта — ползунок 20–80pt, не фиксированный 40pt.
// ============================================================

import { id }       from './utils.js';
import { showToast } from './ui.js';
import { chip, chipGroup, sliderRow, group, row } from './uiComponents.js';

// ── State ──────────────────────────────────────────────────────
let _text     = 'CONFIDENTIAL';
let _opacity  = 0.3;
let _position = 'center';       // 'center' | 'top' | 'bottom' | 'tile'
let _fontSize = 40;
let _color    = 'gray';         // 'gray' | 'red' | 'blue'

export function getWatermarkParams() {
  return { text: _text, opacity: _opacity, position: _position,
           fontSize: _fontSize, color: _color };
}

// ── Public API ─────────────────────────────────────────────────

export function initWatermarkOptions() {
  const container = id('watermarkOptions');
  if (!container) return;
  container.style.display = 'block';
  _render();
}

export function hideWatermarkOptions() {
  const container = id('watermarkOptions');
  if (!container) return;
  container.style.display = 'none';
  container.innerHTML = '';
}

// ── Render ─────────────────────────────────────────────────────

function _render() {
  const container = id('watermarkOptions');
  if (!container) return;

  const pctOpacity = Math.round(_opacity * 100);

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
        <canvas id="wmPreview" class="wm-preview" width="200" height="260"
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
      _drawPreview();  // immediate — discrete choice, not continuous
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
    _fontSize = parseInt(e.target.value);
    const val = id('wmFontSizeVal');
    if (val) val.textContent = e.target.value + 'pt';
    _schedulePreview();  // debounced — continuous drag
  });
}

// ── Live canvas preview ────────────────────────────────────────

const COLOR_MAP = {
  gray: 'rgba(128,128,128,',
  red:  'rgba(200,0,0,',
  blue: 'rgba(0,60,200,',
};

// Debounce: slider fast-drag fires dozens of events/second.
// We only redraw 60ms after the last event — imperceptible to user,
// saves ~10× redraws during a typical slider drag.
let _previewTimer = null;
function _schedulePreview() {
  clearTimeout(_previewTimer);
  _previewTimer = setTimeout(_drawPreview, 60);
}

function _drawPreview() {
  const canvas = id('wmPreview');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = 200, H = 260;

  // Page background
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  // Fake content lines
  ctx.fillStyle = '#e8e8e8';
  for (let y = 20; y < H - 20; y += 14) {
    const lw = 30 + Math.random() * 120;
    ctx.fillRect(16, y, lw, 5);
  }

  // Watermark
  const text    = _text || 'WATERMARK';
  const scale   = W / 595;              // A4 scale to preview
  const fs      = Math.round(_fontSize * scale * 2.2);
  const color   = (COLOR_MAP[_color] || COLOR_MAP.gray) + _opacity + ')';

  ctx.save();
  ctx.globalAlpha = 1; // already baked into color
  ctx.font        = `bold ${fs}px sans-serif`;
  ctx.fillStyle   = color;
  ctx.textAlign   = 'center';
  ctx.textBaseline = 'middle';

  if (_position === 'tile') {
    // Draw 3×4 grid
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 2; col++) {
        ctx.save();
        ctx.translate(50 + col * 100, 40 + row * 60);
        ctx.rotate(-25 * Math.PI / 180);
        ctx.fillText(text, 0, 0);
        ctx.restore();
      }
    }
  } else {
    let x = W / 2, y = H / 2;
    if (_position === 'top')    y = 30;
    if (_position === 'bottom') y = H - 30;
    const angle = _position === 'center' ? -25 * Math.PI / 180 : 0;
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillText(text, 0, 0);
  }

  ctx.restore();
}

// ── Helpers ────────────────────────────────────────────────────

// Local alias — attribute-safe escaping for value= attributes
function _escAttr(str) {
  const d = document.createElement('div'); d.textContent = str; return d.innerHTML;
}
