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
  getCurrentPage, getPageCommandsRef, getEffectiveCommands,
  // actions
  clearRedoForCurrentPage, redrawPage, setColor, activatePrevTool, setSelectedId, undo, redo,
  // constants
  HIGHLIGHT_OPACITY,
} from './drawUI.js';

let _current = null;   // { type, ...fields } | null — command in progress
let _rafId   = 0;      // pending requestAnimationFrame id (0 = none)

// ── Text input overlay state ───────────────────────────────────
let _textOverlay  = null;
let _textInput    = null;
let _textCallback = null;   // (text: string|null) => void
let _fontSize     = 16;     // independent of widthSlider; persists between text clicks
let _textCmdId    = 0;      // monotonic ID for text commands — required for drag-to-reposition

// ── Mobile text sheet ─────────────────────────────────────────
// DOM refs filled once in _initMobileSheet(); runtime fields via _resetMtsState().
const _mts = {
  // DOM refs (set once)
  sheet: null, backdrop: null, textarea: null,
  sizeLabel: null, color: null, ok: null, cancel: null, deleteBtn: null, title: null,
  // Per-invocation state — reset on every open, cleared on close
  callback:    null,    // ({ action: 'save'|'delete'|'cancel', text, fontSize, color }) => void
  mode:        'insert', // 'insert' | 'edit'
  editingId:   null,    // cmd.id when mode === 'edit'
  insertPoint: null,    // { x, y } canvas coords saved on tap
};

function _resetMtsState() {
  _mts.callback    = null;
  _mts.mode        = 'insert';
  _mts.editingId   = null;
  _mts.insertPoint = null;
}

// ── Text selection state ───────────────────────────────────────
let _selectedTextId  = null;   // id of selected text annotation — UI state only
let _pendingTextHit  = null;   // { cmd, startX, startY, clientX, clientY } — awaiting tap vs drag
let _longPressTimer  = 0;      // setTimeout id for long-press detection
let _selToolbar      = null;   // #textSelectToolbar element
let _selColorPicker  = null;   // #selColorPicker element
const SEL_SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];

// ── Public API ─────────────────────────────────────────────────

export function initPointer() {
  const canvas = getDrawCanvas();
  canvas.addEventListener('pointerdown',   _onDown);
  canvas.addEventListener('pointermove',   _onMove);
  canvas.addEventListener('pointerup',     _onUp);
  canvas.addEventListener('pointercancel', _onUp);

  _initTextInput();
  _initSelToolbar();
  _initMobileSheet();

  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;

    if (mod && key === 'z' && e.shiftKey) { e.preventDefault(); redo(); return; }
    if (mod && key === 'z')               { e.preventDefault(); undo(); return; }
    if (mod && key === 'y')               { e.preventDefault(); redo(); return; }

    if (!_selectedTextId) return;
    if (key === 'delete' || key === 'backspace') { e.preventDefault(); _deleteSelected(); }
    else if (key === 'escape')                   { _dismissSelection(); }
  });
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

// ── Text selection helpers ─────────────────────────────────────

function _initSelToolbar() {
  _selToolbar     = document.getElementById('textSelectToolbar');
  _selColorPicker = document.getElementById('selColorPicker');
  const sizeUp    = document.getElementById('selSizeUp');
  const sizeDown  = document.getElementById('selSizeDown');
  const delBtn    = document.getElementById('selDelete');

  _selColorPicker.addEventListener('input', () => {
    if (!_selectedTextId) return;
    clearRedoForCurrentPage();
    _pushCommand({ type: 'style', targetId: _selectedTextId, patch: { color: _selColorPicker.value } });
    redrawPage();
  });

  const _stepSize = (delta) => {
    if (!_selectedTextId) return;
    const eff = getEffectiveCommands().find(c => c.id === _selectedTextId);
    if (!eff) return;
    let idx = SEL_SIZES.indexOf(eff.size ?? 16);
    if (idx === -1) { idx = SEL_SIZES.findIndex(s => s >= (eff.size ?? 16)); }
    if (idx === -1) idx = SEL_SIZES.length - 1;
    const next = SEL_SIZES[Math.max(0, Math.min(SEL_SIZES.length - 1, idx + delta))];
    clearRedoForCurrentPage();
    _pushCommand({ type: 'style', targetId: _selectedTextId, patch: { size: next } });
    redrawPage();
  };

  sizeUp  .addEventListener('pointerdown', (e) => { e.stopPropagation(); _stepSize(+1); });
  sizeDown.addEventListener('pointerdown', (e) => { e.stopPropagation(); _stepSize(-1); });
  delBtn  .addEventListener('pointerdown', (e) => { e.stopPropagation(); _deleteSelected(); });
}

function _selectText(cmd, clientX, clientY) {
  _selectedTextId = cmd.id;
  setSelectedId(cmd.id);

  if (_isTouchDevice()) {
    const eff = getEffectiveCommands().find(c => c.id === cmd.id) ?? cmd;
    _fontSize = eff.size ?? _fontSize;
    _openMobileSheet({
      mode: 'edit', editingId: cmd.id,
      initialText:  eff.text  ?? '',
      initialColor: eff.color ?? getColor(),
      callback: ({ action, text, fontSize, color }) => {
        if (action === 'cancel') { _dismissSelection(); return; }
        if (action === 'delete' || !text?.trim()) {
          // empty text = implicit delete (user cleared annotation)
          clearRedoForCurrentPage();
          _pushCommand({ type: 'delete', targetId: cmd.id });
          _dismissSelection(); redrawPage(); return;
        }
        const effNow = getEffectiveCommands().find(c => c.id === cmd.id);
        const patch  = {};
        if (effNow) {
          if (text     !== (effNow.text  ?? ''))        patch.text  = text;
          if (fontSize !== (effNow.size  ?? 16))        patch.size  = fontSize;
          if (color    !== (effNow.color ?? '#000000')) patch.color = color;
        } else {
          Object.assign(patch, { text, size: fontSize, color });
        }
        if (Object.keys(patch).length > 0) {
          clearRedoForCurrentPage();
          _pushCommand({ type: 'style', targetId: cmd.id, patch });
        }
        _dismissSelection(); redrawPage();
      },
    });
  } else {
    _showSelToolbar(cmd, clientX, clientY);
  }

  redrawPage();
}

function _dismissSelection() {
  if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = 0; }
  _pendingTextHit = null;
  const hadSelection = !!_selectedTextId;
  _selectedTextId = null;
  setSelectedId(null);
  if (_selToolbar) _selToolbar.style.display = 'none';
  if (hadSelection) redrawPage();  // skip redraw if nothing was selected
}

function _deleteSelected() {
  if (!_selectedTextId) return;
  clearRedoForCurrentPage();
  _pushCommand({ type: 'delete', targetId: _selectedTextId });
  _dismissSelection();
}

function _showSelToolbar(cmd, screenX, screenY) {
  // Position toolbar just below the text in screen coordinates
  const canvas  = getDrawCanvas();
  const r       = canvas.getBoundingClientRect();
  const scaleX  = r.width  / canvas.width;
  const scaleY  = r.height / canvas.height;
  const size    = cmd.size ?? 16;
  const lines   = (cmd.text ?? '').replace(/\n+$/, '').split('\n');
  const h       = size * 1.25 * lines.length;
  const preferX = r.left + cmd.x * scaleX;
  const preferY = r.top  + (cmd.y + h) * scaleY + 8;

  _selToolbar.style.visibility = 'hidden';
  _selToolbar.style.display    = 'flex';
  const ow = _selToolbar.offsetWidth;
  const oh = _selToolbar.offsetHeight;
  const margin = 8;
  _selToolbar.style.left       = Math.max(margin, Math.min(preferX, window.innerWidth  - ow - margin)) + 'px';
  _selToolbar.style.top        = Math.max(margin, Math.min(preferY, window.innerHeight - oh - margin)) + 'px';
  _selToolbar.style.visibility = '';

  // Sync color picker to effective color of selected text
  const eff = getEffectiveCommands().find(c => c.id === cmd.id);
  if (eff) {
    const color = eff.color ?? '#000000';
    if (/^#[0-9a-f]{6}$/i.test(color)) _selColorPicker.value = color;
  }
}

// ── Вызывается из toolRegistrations hide() — сбрасывает in-flight stroke и RAF ──
export function resetPointer() {
  _current = null;
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
  _closeMobileSheet({ action: 'cancel' });
}

function _isTouchDevice() {
  return window.matchMedia('(pointer: coarse)').matches;
}

// ── Mobile text sheet lifecycle ────────────────────────────────

function _initMobileSheet() {
  if (_mts.sheet) return;
  _mts.sheet = document.getElementById('mobileTextSheet');
  if (!_mts.sheet) return;

  _mts.backdrop  = document.getElementById('mtsBackdrop');
  _mts.textarea  = document.getElementById('mtsTextarea');
  _mts.sizeLabel = document.getElementById('mtsSizeLabel');
  _mts.color     = document.getElementById('mtsColor');
  _mts.ok        = document.getElementById('mtsOk');
  _mts.cancel    = document.getElementById('mtsCancel');
  _mts.deleteBtn = document.getElementById('mtsDelete');
  _mts.title     = document.getElementById('mtsTitle');

  const _stepSize = (delta) => {
    let idx = SEL_SIZES.indexOf(_fontSize);
    if (idx === -1) idx = Math.max(0, SEL_SIZES.findIndex(s => s >= _fontSize));
    if (idx === -1) idx = SEL_SIZES.length - 1;
    _fontSize = SEL_SIZES[Math.max(0, Math.min(SEL_SIZES.length - 1, idx + delta))];
    _mts.sizeLabel.textContent = _fontSize + 'px';
  };

  document.getElementById('mtsSizeUp')  .addEventListener('click', () => _stepSize(+1));
  document.getElementById('mtsSizeDown').addEventListener('click', () => _stepSize(-1));

  _mts.ok.addEventListener('click', () => {
    _closeMobileSheet({
      action:   'save',
      text:     _mts.textarea.value.replace(/\n+$/, ''),
      fontSize: _fontSize,
      color:    _mts.color.value,
    });
  });
  _mts.cancel   .addEventListener('click', () => _closeMobileSheet({ action: 'cancel' }));
  _mts.deleteBtn.addEventListener('click', () => _closeMobileSheet({ action: 'delete' }));
  _mts.backdrop .addEventListener('click', () => _closeMobileSheet({ action: 'cancel' }));

  window.addEventListener('orientationchange', () => {
    if (_mts.sheet && !_mts.sheet.hidden) _closeMobileSheet({ action: 'cancel' });
  });
}

function _openMobileSheet(opts) {
  if (!_mts.sheet || !_mts.sheet.hidden) return;
  _resetMtsState();

  _mts.mode        = opts.mode        ?? 'insert';
  _mts.editingId   = opts.editingId   ?? null;
  _mts.insertPoint = opts.insertPoint ?? null;
  _mts.callback    = opts.callback    ?? null;

  _mts.title.textContent     = _mts.mode === 'edit' ? 'Edit text' : 'Add text';
  _mts.ok.textContent        = _mts.mode === 'edit' ? 'Save' : 'Add';
  _mts.deleteBtn.hidden      = _mts.mode !== 'edit';
  _mts.textarea.value        = opts.initialText  ?? '';
  _mts.sizeLabel.textContent = _fontSize + 'px';

  const color = opts.initialColor ?? getColor();
  if (/^#[0-9a-f]{6}$/i.test(color)) _mts.color.value = color;

  _mts.sheet.hidden    = false;
  _mts.backdrop.hidden = false;
  document.body.classList.add('mts-open');
  const canvas = getDrawCanvas();
  if (canvas) canvas.style.pointerEvents = 'none';

  requestAnimationFrame(() => _mts.textarea?.focus());
}

function _closeMobileSheet(result) {
  if (!_mts.sheet || _mts.sheet.hidden) return;

  const cb = _mts.callback;

  _mts.sheet.hidden    = true;
  _mts.backdrop.hidden = true;
  document.body.classList.remove('mts-open');
  _mts.textarea.blur();
  const canvas = getDrawCanvas();
  if (canvas) canvas.style.pointerEvents = '';
  _resetMtsState();

  if (cb && result) cb(result);
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

  // Dismiss selection on any canvas tap (toolbar buttons use stopPropagation to prevent this)
  if (_selectedTextId) _dismissSelection();

  // Text: quick-tap existing text = select; drag existing text = move; tap empty area = place new
  if (tool === 'text') {
    const hit = _hitTestText(x, y);
    if (hit) {
      // Hold: resolve quick-tap vs drag in _onMove (threshold 8px) or _onUp (quick release)
      _pendingTextHit = { cmd: hit, startX: x, startY: y, clientX: e.clientX, clientY: e.clientY };
      _longPressTimer = setTimeout(() => {
        _longPressTimer = 0;
        _pendingTextHit = null;
        _selectText(hit, e.clientX, e.clientY);
      }, _isTouchDevice() ? 450 : 350);
      return;
    }
    if (_isTouchDevice()) {
      _openMobileSheet({
        mode: 'insert', insertPoint: { x, y }, initialColor: getColor(),
        callback: ({ action, text, fontSize, color }) => {
          if (action !== 'save' || !text?.trim()) return;
          clearRedoForCurrentPage();
          _pushCommand({
            type: 'text', id: ++_textCmdId, x, y, text,
            color, size: fontSize, fontWeight: 'normal', fontFamily: 'system-ui, sans-serif',
          });
          redrawPage();
        },
      });
    } else {
      _showTextInput(e.clientX, e.clientY, (text) => {
        if (!text?.trim()) return;
        clearRedoForCurrentPage();
        _pushCommand({
          type: 'text', id: ++_textCmdId, x, y, text,
          color: getColor(), size: _fontSize,
          fontWeight: 'normal', fontFamily: 'system-ui, sans-serif',
        });
        redrawPage();
      });
    }
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
  // Handle pending text hit: if finger moved beyond threshold, promote to drag
  if (_pendingTextHit) {
    e.preventDefault();
    const { x, y } = _coords(e);
    if (Math.abs(x - _pendingTextHit.startX) > 8 || Math.abs(y - _pendingTextHit.startY) > 8) {
      if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = 0; }
      const h = _pendingTextHit;
      _pendingTextHit = null;
      if (_selectedTextId) _dismissSelection();  // clear stale outline from another text
      clearRedoForCurrentPage();
      document.body.style.cursor = 'grabbing';
      _current = { type: 'text-drag', cmd: h.cmd,
                   x: h.cmd.x, y: h.cmd.y, _ox: h.startX - h.cmd.x, _oy: h.startY - h.cmd.y };
      _current.x = x - _current._ox;
      _current.y = y - _current._oy;
      if (!_rafId) _rafId = requestAnimationFrame(() => { _rafId = 0; if (_current) redrawPage(_current); });
    }
    return;
  }

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
  } else if (type === 'text-drag') {
    _current.x = x - _current._ox;
    _current.y = y - _current._oy;
  }

  // RAF batching: один render pass на animation frame, не на каждый pointermove
  if (_rafId) return;
  _rafId = requestAnimationFrame(() => {
    _rafId = 0;
    if (_current) redrawPage(_current);
  });
}

// ── Pointer up (also handles pointercancel via initPointer listener) ───────

function _onUp(e) {
  // Quick-tap on text (no drag in _onMove) → select it; pointercancel also clears pending state
  if (_pendingTextHit) {
    e.preventDefault();
    if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = 0; }
    const h = _pendingTextHit;   // snapshot before clearing state
    _pendingTextHit = null;
    document.body.style.cursor = '';
    const c = getDrawCanvas();
    if (c.hasPointerCapture?.(e.pointerId)) c.releasePointerCapture(e.pointerId);
    _selectText(h.cmd, h.clientX, h.clientY);
    return;
  }

  if (!_current) return;
  e.preventDefault();

  // Always reset — covers text-drag and pointercancel paths
  document.body.style.cursor = '';

  // Симметричный lifecycle: явный release после явного capture
  const canvas = getDrawCanvas();
  if (canvas.hasPointerCapture?.(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }

  // Отменяем pending RAF — финальный redraw делаем синхронно ниже
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }

  // Text drag: commit a 'move' command if position actually changed; Undo pops it for free
  if (_current.type === 'text-drag') {
    const { cmd, x, y } = _current;
    if (Math.hypot(x - cmd.x, y - cmd.y) >= 3) {
      _pushCommand({ type: 'move', targetId: cmd.id, x, y });
    }
    _current = null;
    redrawPage();
    return;
  }

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

// ── Text hit-test ──────────────────────────────────────────────
// Returns the topmost text command whose bounding box contains (x, y).
// ctx.save/restore prevents font assignment leaking into other canvas ops.
function _hitTestText(x, y) {
  const cmds = getEffectiveCommands();
  const ctx  = getDrawCanvas().getContext('2d');
  ctx.save();
  for (let i = cmds.length - 1; i >= 0; i--) {
    const c = cmds[i];
    if (c.type !== 'text') continue;
    const size   = c.size ?? 16;
    const lines  = (c.text ?? '').replace(/\n+$/, '').split('\n');
    ctx.font     = `${c.fontWeight ?? 'normal'} ${size}px ${c.fontFamily ?? 'system-ui, sans-serif'}`;
    const widths = lines.map(l => ctx.measureText(l).width);
    const w      = widths.length ? Math.max(...widths) : 0;
    const h      = size * 1.25 * lines.length;
    const pad    = _isTouchDevice() ? 16 : 6;
    if (x >= c.x - pad && x <= c.x + w + pad &&
        y >= c.y - pad && y <= c.y + h + pad) {
      ctx.restore();
      return c;
    }
  }
  ctx.restore();
  return null;
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
