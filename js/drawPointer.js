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
  getActiveTool, getColor, getWidth,
  getDrawCanvas, getCurrentPage,
  getPageCommandsRef,
  clearRedoForCurrentPage, redrawPage,
  HIGHLIGHT_OPACITY,
} from './drawUI.js';

let _current = null;   // команда в процессе рисования (null = не рисуем)
let _rafId   = 0;      // pending requestAnimationFrame id

// ── Text input overlay state ───────────────────────────────────
let _textOverlay  = null;
let _textInput    = null;
let _textCallback = null;   // (text: string|null) => void

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
  const okBtn  = document.getElementById('textInputOk');
  const cnBtn  = document.getElementById('textInputCancel');

  // stopPropagation prevents button clicks from reaching canvas _onDown
  okBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); _finalizeTextInput(false); });
  cnBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); _finalizeTextInput(true);  });

  _textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); _finalizeTextInput(false); }
    if (e.key === 'Escape') { _finalizeTextInput(true); }
  });
}

function _showTextInput(screenX, screenY, callback) {
  _textCallback = callback;
  _textInput.value = '';
  _textOverlay.style.left    = screenX + 'px';
  _textOverlay.style.top     = screenY + 'px';
  _textOverlay.style.display = 'block';
  // Defer focus: browser needs a tick after pointer event before focus works reliably
  setTimeout(() => _textInput.focus(), 0);
  // Block canvas during text entry so accidental pointer moves don't draw
  getDrawCanvas().style.pointerEvents = 'none';
}

function _finalizeTextInput(cancel) {
  _textOverlay.style.display = 'none';
  getDrawCanvas().style.pointerEvents = '';
  if (_textCallback) {
    const cb  = _textCallback;
    _textCallback = null;
    cb(cancel ? null : _textInput.value.trim());
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

  // Text: show floating input at click position, no move/up stream needed
  if (tool === 'text') {
    _showTextInput(e.clientX, e.clientY, (text) => {
      if (!text) return;
      clearRedoForCurrentPage();
      const size = Math.max(12, getWidth() * 6);
      _pushCommand({ type: 'text', x, y, text, color: getColor(), size });
      redrawPage();
    });
    return;
  }

  clearRedoForCurrentPage();

  if (tool === 'pen' || tool === 'erase') {
    _current = { type: tool, points: [[x, y]], color: getColor(), width: getWidth() };
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
    _current.x2 = x;
    _current.y2 = y;
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
