// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

// ============================================================
//  drawPointer.js — Pointer Events for Draw on PDF
//
//  Архитектурные решения:
//  - Pointer Events API (не mouse+touch) — Safari 13+, стилус бесплатно
//  - setPointerCapture / releasePointerCapture — симметричный lifecycle
//  - _coords() — инвариантен к CSS transform (getBoundingClientRect)
//  - Minimum distance filter (≥ 2px) — убирает jitter / stylus noise
//  - RAF batching в _onMove — один render pass на animation frame
//  - overlay через redrawPage(_current) — один проход, не два
//  - text через prompt() — блокирующий, без overlay, MVP tradeoff
//  - initPointer() вызывается один раз; canvas не пересоздаётся
// ============================================================

import {
  // state
  getActiveTool, getColor, getWidth,
  // canvas
  getDrawCanvas, getPdfCanvas,
  // document
  getCurrentPage, getPageCommandsRef,
  // actions
  clearRedoForCurrentPage, redrawPage, setColor, activatePrevTool,
  // constants
  HIGHLIGHT_OPACITY,
} from './drawUI.js';

let _current = null;   // команда в процессе рисования (null = не рисуем)
let _rafId   = 0;      // pending requestAnimationFrame id

// ── Text input overlay state ───────────────────────────────────
let _textOverlay  = null;
let _textInput    = null;
let _textCallback = null;   // (text: string|null) => void
let _fontSize     = 16;     // independent of widthSlider; persists between text clicks

// ── Public API ─────────────────────────────────────────────────

export function initPointer() {
  const canvas = getDrawCanvas();
  canvas.addEventListener('pointerdown',   _onDown);
  canvas.addEventListener('pointermove',   _onMove);
  canvas.addEventListener('pointerup',     _onUp);
  canvas.addEventListener('pointercancel', _onUp);

  _initTextInput();
}

// ── Text input helpers ─────────────────────────────────────────

function _initTextInput() {
  _textOverlay = document.getElementById('textInputOverlay');
  _textInput   = document.getElementById('floatingTextInput');
  const okBtn       = document.getElementById('textInputOk');
  const cnBtn       = document.getElementById('textInputCancel');
  const sizeUpBtn   = document.getElementById('textSizeUp');
  const sizeDownBtn = document.getElementById('textSizeDown');
  const sizeLabel   = document.getElementById('textSizeLabel');

  // stopPropagation prevents button clicks from reaching canvas _onDown
  okBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); _finalizeTextInput(false); });
  cnBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); _finalizeTextInput(true);  });

  // A+ / A− step through preset sizes
  const SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];
  const _updateSize = (delta) => {
    let idx = SIZES.indexOf(_fontSize);
    if (idx === -1) {
      idx = SIZES.findIndex(s => s >= _fontSize);
      if (idx === -1) idx = SIZES.length - 1;
    }
    _fontSize = SIZES[Math.max(0, Math.min(SIZES.length - 1, idx + delta))];
    sizeLabel.textContent = _fontSize + 'px';
  };
  sizeUpBtn  .addEventListener('pointerdown', (e) => { e.stopPropagation(); _updateSize(+1); });
  sizeDownBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); _updateSize(-1); });

  // textarea: Enter = newline, Ctrl/Shift+Enter = confirm, Escape = cancel
  _textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { _finalizeTextInput(true); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      e.preventDefault();
      _finalizeTextInput(false);
    }
    // plain Enter falls through to textarea default (inserts newline)
  });
}

function _showTextInput(screenX, screenY, callback) {
  _textCallback = callback;
  _textInput.value = '';

  // Measure overlay size before painting (visibility:hidden avoids flash)
  _textOverlay.style.visibility = 'hidden';
  _textOverlay.style.display    = 'block';
  const ow = _textOverlay.offsetWidth;
  const oh = _textOverlay.offsetHeight;

  // Clamp to viewport so overlay never hides behind screen edges
  const margin = 8;
  const left = Math.max(margin, Math.min(screenX, window.innerWidth  - ow - margin));
  const top  = Math.max(margin, Math.min(screenY, window.innerHeight - oh - margin));
  _textOverlay.style.left       = left + 'px';
  _textOverlay.style.top        = top  + 'px';
  _textOverlay.style.visibility = '';

  // Remove-before-add prevents duplicate listeners on rapid open/close
  window.visualViewport?.removeEventListener('resize', _onViewportResize);
  window.visualViewport?.addEventListener('resize', _onViewportResize);

  getDrawCanvas().style.pointerEvents = 'none';
  setTimeout(() => _textInput.focus(), 0);
}

function _onViewportResize() {
  if (!window.visualViewport || _textOverlay.style.display === 'none') return;
  const margin   = 8;
  const vvBottom = window.visualViewport.offsetTop + window.visualViewport.height;
  const oh       = _textOverlay.offsetHeight;
  const curTop   = parseInt(_textOverlay.style.top) || 0;
  if (curTop + oh > vvBottom - margin) {
    _textOverlay.style.top = Math.max(margin, vvBottom - oh - margin) + 'px';
  }
}

function _finalizeTextInput(cancel) {
  _textOverlay.style.display = 'none';
  _textOverlay.style.left    = '';
  _textOverlay.style.top     = '';
  _textInput.blur();   // dismiss mobile virtual keyboard
  window.visualViewport?.removeEventListener('resize', _onViewportResize);
  getDrawCanvas().style.pointerEvents = '';
  if (_textCallback) {
    const cb  = _textCallback;
    _textCallback = null;
    // trim only trailing newlines — preserve intentional leading spaces / indentation
    const text = _textInput.value.replace(/\n+$/, '');
    cb(cancel ? null : text);
  }
}

// Вызывается из toolRegistrations hide() — сбрасывает in-flight stroke и RAF
export function resetPointer() {
  _current = null;
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
}

// ── Coordinate helper ──────────────────────────────────────────
// getBoundingClientRect инвариантен к CSS transform и zoom —
// формула корректна при любом масштабировании без изменений.

function _coords(e) {
  const canvas = getDrawCanvas();
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left)  * (canvas.width  / r.width),
    y: (e.clientY - r.top)   * (canvas.height / r.height),
  };
}

// ── Pointer down ───────────────────────────────────────────────

function _onDown(e) {
  e.preventDefault();
  const canvas = getDrawCanvas();
  canvas.setPointerCapture(e.pointerId);

  const tool = getActiveTool();
  const { x, y } = _coords(e);

  // Eyedropper: sample composite color, update active color, return to prev tool
  if (tool === 'eye') {
    const { x, y } = _coords(e);
    const ix = Math.round(x);
    const iy = Math.round(y);
    const hex = _sampleComposite(ix, iy);
    if (hex) setColor(hex);
    activatePrevTool();
    return;
  }

  // Text: show floating input at click position, no move/up stream needed
  if (tool === 'text') {
    _showTextInput(e.clientX, e.clientY, (text) => {
      if (!text) return;
      clearRedoForCurrentPage();
      _pushCommand({
        type: 'text', x, y, text,
        color: getColor(), size: _fontSize,
        fontWeight: 'normal', fontFamily: 'system-ui, sans-serif',
      });
      redrawPage();
    });
    return;
  }

  clearRedoForCurrentPage();

  if (tool === 'pen') {
    _current = { type: 'pen', points: [[x, y]], color: getColor(), width: getWidth() };
  } else if (tool === 'erase') {
    _current = { type: 'erase', points: [[x, y]], width: Math.max(20, getWidth() * 6) };
  } else if (tool === 'arrow' || tool === 'line') {
    _current = { type: tool, x1: x, y1: y, x2: x, y2: y, color: getColor(), width: getWidth() };
  } else if (tool === 'rect') {
    _current = { type: 'rect', _ox: x, _oy: y, x, y, w: 0, h: 0, color: getColor(), width: getWidth() };
  } else if (tool === 'highlight') {
    _current = { type: 'highlight', _ox: x, _oy: y, x, y, w: 0, h: 0, color: getColor(), opacity: HIGHLIGHT_OPACITY };
  } else if (tool === 'oval') {
    _current = { type: 'oval', _ox: x, _oy: y, x, y, rx: 0, ry: 0, color: getColor(), width: getWidth() };
  }
}

// ── Pointer move ───────────────────────────────────────────────

function _onMove(e) {
  if (!_current) return;
  e.preventDefault();

  const { x, y } = _coords(e);
  const { type } = _current;

  if (type === 'pen' || type === 'erase') {
    const last = _current.points[_current.points.length - 1];
    if (Math.hypot(x - last[0], y - last[1]) < 2) return;
    _current.points.push([x, y]);
  } else if (type === 'arrow' || type === 'line') {
    const SNAP  = 15;
    const adx   = Math.abs(x - _current.x1);
    const ady   = Math.abs(y - _current.y1);
    const snapX = adx < SNAP && adx < ady;   // snap to vertical axis
    const snapY = ady < SNAP && ady < adx;   // snap to horizontal axis
    _current.x2 = snapX ? _current.x1 : x;
    _current.y2 = snapY ? _current.y1 : y;
  } else if (type === 'rect' || type === 'highlight') {
    _current.x = Math.min(_current._ox, x);
    _current.y = Math.min(_current._oy, y);
    _current.w = Math.abs(x - _current._ox);
    _current.h = Math.abs(y - _current._oy);
  } else if (type === 'oval') {
    _current.x  = (_current._ox + x) / 2;
    _current.y  = (_current._oy + y) / 2;
    _current.rx = Math.abs(x - _current._ox) / 2;
    _current.ry = Math.abs(y - _current._oy) / 2;
  }

  // RAF batching: один render pass на animation frame, не на каждый pointermove
  if (_rafId) return;
  _rafId = requestAnimationFrame(() => {
    _rafId = 0;
    if (_current) redrawPage(_current);
  });
}

// ── Pointer up ─────────────────────────────────────────────────

function _onUp(e) {
  if (!_current) return;
  e.preventDefault();

  // Симметричный lifecycle: явный release после явного capture
  const canvas = getDrawCanvas();
  if (canvas.hasPointerCapture?.(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }

  // Отменяем pending RAF — финальный redraw делаем синхронно ниже
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }

  if (_isMeaningful(_current)) {
    const { type } = _current;
    let cmd;
    if (type === 'pen' || type === 'erase') {
      cmd = { ..._current, points: _current.points.slice() };   // defensive copy
    } else {
      const { _ox, _oy, ...rest } = _current;                   // strip internal fields
      cmd = rest;
    }
    _pushCommand(cmd);
  }

  _current = null;
  redrawPage();   // финальный redraw без overlay
}

// ── Helpers ────────────────────────────────────────────────────

function _pushCommand(cmd) {
  const page = getCurrentPage();
  const cmds = getPageCommandsRef().get(page) ?? [];
  getPageCommandsRef().set(page, [...cmds, cmd]);   // immutable push
}

function _isMeaningful(cmd) {
  switch (cmd.type) {
    case 'pen':
    case 'erase':  return cmd.points.length >= 2;
    case 'arrow':
    case 'line':   return Math.hypot(cmd.x2 - cmd.x1, cmd.y2 - cmd.y1) >= 3;
    case 'rect':
    case 'highlight': return cmd.w >= 3 && cmd.h >= 3;
    case 'oval':   return cmd.rx >= 3 && cmd.ry >= 3;
    default:       return true;
  }
}

// ── Eyedropper ─────────────────────────────────────────────────
// Samples composite color at canvas pixel (ix, iy) by manually alpha-compositing
// the PDF canvas (background) with the draw canvas (annotations).
// No temp canvas — reads 4 bytes from each canvas directly.
function _sampleComposite(ix, iy) {
  const pdfCanvas  = getPdfCanvas();
  const drawCanvas = getDrawCanvas();

  if (
    ix < 0 || iy < 0 ||
    ix >= pdfCanvas.width  || iy >= pdfCanvas.height ||
    ix >= drawCanvas.width || iy >= drawCanvas.height
  ) return null;

  const pdfCtx  = pdfCanvas.getContext('2d');
  const drawCtx = drawCanvas.getContext('2d');
  const pdf     = pdfCtx.getImageData(ix, iy, 1, 1).data;
  const draw    = drawCtx.getImageData(ix, iy, 1, 1).data;

  // source-over composite: draw layer on top of pdf layer
  const srcA = draw[3] / 255;
  const dstA = pdf[3]  / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA === 0) return null;

  const h = v => v.toString(16).padStart(2, '0');
  const r = Math.round((draw[0] * srcA + pdf[0] * dstA * (1 - srcA)) / outA);
  const g = Math.round((draw[1] * srcA + pdf[1] * dstA * (1 - srcA)) / outA);
  const b = Math.round((draw[2] * srcA + pdf[2] * dstA * (1 - srcA)) / outA);
  return `#${h(r)}${h(g)}${h(b)}`;
}
