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
  getCurrentPage, getPageCommandsRef, getEffectiveCommands, getPageTextCache,
  // actions
  clearRedoForCurrentPage, redrawPage, setColor, activatePrevTool, setSelectedId, setSelectedHighlightId, undo, redo,
  setLassoSelection, computeMovePatch, computeGroupBounds,
  // constants
  HIGHLIGHT_OPACITY, MARKER_OPACITY,
} from './drawUI.js';
import { t } from './i18n.js';

let _current = null;   // { type, ...fields } | null — command in progress
let _rafId   = 0;      // pending requestAnimationFrame id (0 = none)

// ── Text input overlay state ───────────────────────────────────
let _textOverlay  = null;
let _textInput    = null;
let _textCallback = null;   // (text: string|null) => void
let _fontSize     = 16;     // independent of widthSlider; persists between text clicks
let _cmdId        = 0;      // monotonic ID for every command — required for drag-to-reposition,
                            // style edits, and lasso multi-select (a single shared counter, not
                            // per-type, so ids stay unique across all command types on a page)
                            // TODO: restore from max existing id after document load (needed for future persistence)

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

// ── Highlight selection state ──────────────────────────────────
let _selectedHighlightId = null;   // id of selected highlight — UI state only
let _hlToolbar           = null;   // #hlSelectToolbar element
let _hlColorPicker       = null;   // #hlColorPicker element

// ── Text selection state ───────────────────────────────────────
let _selectedTextId  = null;   // id of selected text annotation — UI state only
let _pendingTextHit  = null;   // { cmd, startX, startY, clientX, clientY } — awaiting tap vs drag
let _longPressTimer  = 0;      // setTimeout id for long-press detection
let _selToolbar      = null;   // #textSelectToolbar element
let _selColorPicker  = null;   // #selColorPicker element
const SEL_SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];

// ── Lasso multi-select state ───────────────────────────────────
let _lassoIds = [];   // ids currently selected by the lasso tool — mirrored into drawUI via setLassoSelection

// ── Public API ─────────────────────────────────────────────────

export function initPointer() {
  const canvas = getDrawCanvas();
  canvas.addEventListener('pointerdown',   _onDown);
  canvas.addEventListener('pointermove',   _onMove);
  canvas.addEventListener('pointerup',     _onUp);
  canvas.addEventListener('pointercancel', _onUp);

  _initTextInput();
  _initSelToolbar();
  _initHlToolbar();
  _initMobileSheet();

  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;

    if (mod && key === 'z' && e.shiftKey) { e.preventDefault(); redo(); return; }
    if (mod && key === 'z')               { e.preventDefault(); undo(); return; }
    if (mod && key === 'y')               { e.preventDefault(); redo(); return; }

    if (!_selectedTextId && !_lassoIds.length) return;
    if (key === 'delete' || key === 'backspace') {
      e.preventDefault();
      if (_selectedTextId) _deleteSelected();
      else                 _deleteLassoSelection();
    } else if (key === 'escape') {
      if (_selectedTextId) _dismissSelection();
      if (_lassoIds.length) _dismissLassoSelection();
    }
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

// ── Lasso selection lifecycle ──────────────────────────────────

function _dismissLassoSelection() {
  const had = !!_lassoIds.length;
  _lassoIds = [];
  setLassoSelection([]);
  if (had) redrawPage();
}

function _deleteLassoSelection() {
  if (!_lassoIds.length) return;
  clearRedoForCurrentPage();
  _pushCommand({ type: 'batch', ops: _lassoIds.map(targetId => ({ type: 'delete', targetId })) });
  _lassoIds = [];
  setLassoSelection([]);
  redrawPage();
}

function _showSelToolbar(cmd, _screenX, _screenY) {
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
  // Clear pending text interactions so stale long-press timers can't fire after reset
  if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = 0; }
  _pendingTextHit = null;
  _selectedTextId = null;
  setSelectedId(null);
  if (_selToolbar) _selToolbar.style.display = 'none';
  _selectedHighlightId = null;
  setSelectedHighlightId(null);
  if (_hlToolbar) _hlToolbar.style.display = 'none';
  _lassoIds = [];
  setLassoSelection([]);
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

  _mts.title.textContent     = _mts.mode === 'edit' ? t('draw_edit_text') : t('draw_add_text');
  _mts.ok.textContent        = _mts.mode === 'edit' ? t('draw_save_btn') : t('draw_add_btn');
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
  const { x, y } = _coords(e);

  // Comment icon — check before pointer capture so click doesn't start a draw stroke
  const commentHit = _hitTestCommentIcon(x, y);
  if (commentHit) {
    _openCommentInput(commentHit, e.clientX, e.clientY);
    return;
  }

  const canvas = getDrawCanvas();
  canvas.setPointerCapture(e.pointerId);
  const tool = getActiveTool();

  // Eyedropper: sample composite color, update active color, return to prev tool
  if (tool === 'eye') {
    const hex = _sampleComposite(Math.round(x), Math.round(y));
    if (hex) setColor(hex);
    activatePrevTool();
    return;
  }

  // Dismiss selections on any canvas tap (toolbar buttons use stopPropagation to prevent this)
  if (_selectedTextId)      _dismissSelection();
  if (_selectedHighlightId) _dismissHighlightSelection();
  if (_lassoIds.length && tool !== 'lasso') _dismissLassoSelection();

  if (tool === 'lasso') {
    // Tap inside the current selection's bounding box → drag the whole group.
    // Tap outside (or no active selection) → start a fresh lasso loop.
    if (_lassoIds.length) {
      const selCmds = getEffectiveCommands().filter(c => _lassoIds.includes(c.id));
      const b = computeGroupBounds(selCmds, getDrawCanvas().getContext('2d'));
      const pad = 6;
      if (b && x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad) {
        _current = { type: 'lasso-drag', ids: _lassoIds.slice(), startX: x, startY: y, dx: 0, dy: 0 };
        return;
      }
      _dismissLassoSelection();
    }
    _current = { type: 'lasso', points: [[x, y]] };
    return;
  }

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
            type: 'text', id: ++_cmdId, x, y, text,
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
          type: 'text', id: ++_cmdId, x, y, text,
          color: getColor(), size: _fontSize,
          fontWeight: 'normal', fontFamily: 'system-ui, sans-serif',
        });
        redrawPage();
      });
    }
    return;
  }

  if (tool === 'pen') {
    clearRedoForCurrentPage();
    _current = { type: 'pen', id: ++_cmdId, points: [[x, y]], color: getColor(), width: getWidth() };
  } else if (tool === 'marker') {
    clearRedoForCurrentPage();
    const width = Math.max(6, getWidth() * 3);
    // Starting on text: track a drag rectangle (like rect/highlight) so _onUp can snap
    // to the actual text touched — a tap-without-drag still marks the whole line, a real
    // drag snaps to every line the drag rectangle overlaps. Starting off text keeps the
    // plain freehand marker stroke (original behavior, unchanged).
    if (_hitTestTextItem(x, y)) {
      _current = { type: 'marker-smart-drag', _ox: x, _oy: y, x, y, w: 0, h: 0, color: getColor(), width };
    } else {
      _current = { type: 'marker', id: ++_cmdId, points: [[x, y]], color: getColor(), width, opacity: MARKER_OPACITY };
    }
  } else if (tool === 'erase') {
    clearRedoForCurrentPage();
    _current = { type: 'erase', id: ++_cmdId, points: [[x, y]], width: Math.max(20, getWidth() * 6) };
  } else if (tool === 'arrow' || tool === 'line') {
    const hit = tool === 'arrow' ? _hitTestArrow(x, y) : null;
    if (hit) {
      // Drag existing arrow — redo cleared in _onUp only if position actually changed
      _current = { type: 'shape-drag', cmd: hit, startX: x, startY: y, dx: 0, dy: 0 };
    } else if (tool === 'arrow') {
      clearRedoForCurrentPage();
      _current = { type: 'arrow', id: ++_cmdId, number: _nextArrowNumber(),
                   x1: x, y1: y, x2: x, y2: y, color: getColor(), width: getWidth() };
    } else {
      clearRedoForCurrentPage();
      _current = { type: 'line', id: ++_cmdId, x1: x, y1: y, x2: x, y2: y, color: getColor(), width: getWidth() };
    }
  } else if (tool === 'rect') {
    clearRedoForCurrentPage();
    _current = { type: 'rect', id: ++_cmdId, _ox: x, _oy: y, x, y, w: 0, h: 0, color: getColor(), width: getWidth() };
  } else if (tool === 'highlight') {
    const hit = _hitTestHighlight(x, y);
    if (hit) {
      _selectHighlight(hit, e.clientX, e.clientY);
      return;
    }
    clearRedoForCurrentPage();
    _current = { type: 'highlight', _ox: x, _oy: y, x, y, w: 0, h: 0, color: getColor(), opacity: HIGHLIGHT_OPACITY };
  } else if (tool === 'oval') {
    clearRedoForCurrentPage();
    _current = { type: 'oval', id: ++_cmdId, _ox: x, _oy: y, x, y, rx: 0, ry: 0, color: getColor(), width: getWidth() };
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

  if (type === 'pen' || type === 'erase' || type === 'marker') {
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
  } else if (type === 'rect' || type === 'highlight' || type === 'marker-smart-drag') {
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
  } else if (type === 'shape-drag') {
    _current.dx = x - _current.startX;
    _current.dy = y - _current.startY;
  } else if (type === 'lasso') {
    _current.points.push([x, y]);
  } else if (type === 'lasso-drag') {
    _current.dx = x - _current.startX;
    _current.dy = y - _current.startY;
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
  if (_pendingTextHit) {
    e.preventDefault();
    if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = 0; }
    const h = _pendingTextHit;
    _pendingTextHit = null;
    document.body.style.cursor = '';
    const c = getDrawCanvas();
    if (c.hasPointerCapture?.(e.pointerId)) c.releasePointerCapture(e.pointerId);
    if (e.type === 'pointercancel') return;   // system gesture cancelled — clear state, don't select
    _selectText(h.cmd, h.clientX, h.clientY);
    return;
  }

  if (!_current) return;

  // Always reset — covers text-drag and pointercancel paths
  document.body.style.cursor = '';

  // Симметричный lifecycle: явный release после явного capture
  const canvas = getDrawCanvas();
  if (canvas.hasPointerCapture?.(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }

  // Отменяем pending RAF — финальный redraw делаем синхронно ниже
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }

  // pointercancel: system interrupted gesture — discard in-progress stroke without committing
  if (e.type === 'pointercancel') {
    _current = null;
    redrawPage();
    return;
  }

  e.preventDefault();

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

  // Shape drag (numbered arrows): commit absolute positions so Undo restores original coords
  if (_current.type === 'shape-drag') {
    const { cmd, dx, dy } = _current;
    if (Math.hypot(dx, dy) >= 3) {
      clearRedoForCurrentPage();
      _pushCommand({ type: 'move', targetId: cmd.id,
                     x1: cmd.x1 + dx, y1: cmd.y1 + dy,
                     x2: cmd.x2 + dx, y2: cmd.y2 + dy });
    }
    _current = null;
    redrawPage();
    return;
  }

  // Lasso loop finished: select every command with a probe point inside the polygon.
  // A degenerate loop (<3 points) selects nothing, same as clicking without dragging.
  if (_current.type === 'lasso') {
    const polygon = _current.points;
    _lassoIds = polygon.length >= 3 ? _lassoSelect(polygon) : [];
    setLassoSelection(_lassoIds);
    _current = null;
    redrawPage();
    return;
  }

  // Lasso group drag: commit one 'batch' move covering every selected command,
  // so Undo restores the whole group in a single step, not one item at a time.
  if (_current.type === 'lasso-drag') {
    const { ids, dx, dy } = _current;
    if (Math.hypot(dx, dy) >= 3) {
      clearRedoForCurrentPage();
      const selCmds = getEffectiveCommands().filter(c => ids.includes(c.id));
      const ops = selCmds.map(c => ({ type: 'move', targetId: c.id, ...computeMovePatch(c, dx, dy) }));
      _pushCommand({ type: 'batch', ops });
    }
    _current = null;
    redrawPage();
    return;
  }

  // Marker started on text: a tap marks the whole line (no drag needed); a real drag
  // snaps to every line the drag rectangle touches — "close enough" beats pixel-precise
  // hand-dragging, matching how a real highlighter is actually used. Multiple lines
  // become one 'batch' of add-ops so Undo removes the whole drag's marks in one step.
  if (_current.type === 'marker-smart-drag') {
    const { x, y, w, h, color, width } = _current;
    if (w >= 3 && h >= 3) {
      const lineRects = _textRectsFromDrag(getPageTextCache().get(getCurrentPage()) ?? [], { x, y, w, h });
      if (lineRects?.length) {
        const newCmds = lineRects.map(r => ({
          type: 'marker', id: ++_cmdId,
          points: [[r.x, r.y + r.h / 2], [r.x + r.w, r.y + r.h / 2]],
          color, width, opacity: MARKER_OPACITY, comment: '',
        }));
        if (newCmds.length === 1) _pushCommand(newCmds[0]);
        else _pushCommand({ type: 'batch', ops: newCmds.map(cmd => ({ type: 'add', cmd })) });
      }
    } else {
      const line = _lineRectAtPoint(_current._ox, _current._oy);
      if (line) {
        const midY = line.y + line.h / 2;
        _pushCommand({
          type: 'marker', id: ++_cmdId,
          points: [[line.x, midY], [line.x + line.w, midY]],
          color, width, opacity: MARKER_OPACITY, comment: '',
        });
      }
    }
    _current = null;
    redrawPage();
    return;
  }

  // A plain tap (pointerdown immediately followed by pointerup, no pointermove
  // in between) leaves pen/marker with exactly ONE point — _isMeaningful()
  // requires >=2, so the tap was silently discarded: no mark, no error, no
  // feedback at all. Real Analytics Engine data (2026-08-20) showed this is
  // the single largest rage-click source site-wide by a wide margin (43 on
  // #drawCanvas, plus 7 on #btnUndo — consistent with someone tapping
  // repeatedly, seeing nothing, then mashing undo). Every mainstream drawing
  // app (Preview, Paint, Procreate) draws a dot on a plain click — duplicate
  // the sole point so the stroke has a real (zero-length) segment. Canvas's
  // existing lineCap:'round' (js/drawUI.js) renders that as a visible dot
  // with zero rendering-side changes needed. Scoped to pen/marker (freehand
  // tools where "tap = dot" is the universal convention) — not erase, which
  // has no such convention and no evidence in the data of the same problem.
  if (_current && (_current.type === 'pen' || _current.type === 'marker') && _current.points.length === 1) {
    _current.points.push(_current.points[0]);
  }

  if (_isMeaningful(_current)) {
    const { type } = _current;
    let cmd;
    if (type === 'pen' || type === 'erase' || type === 'marker') {
      cmd = { ..._current, points: _current.points.slice() };
      if (type === 'marker') cmd.comment = '';   // icon appears only after stroke is committed
    } else {
      const { _ox, _oy, ...rest } = _current;
      cmd = type === 'highlight' ? _buildHighlightCmd(rest) : rest;
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
    case 'erase':
    case 'marker': return cmd.points.length >= 2;
    case 'arrow':
    case 'line':   return Math.hypot(cmd.x2 - cmd.x1, cmd.y2 - cmd.y1) >= 3;
    case 'rect':
    case 'highlight': return cmd.w >= 3 && cmd.h >= 3;
    case 'oval':   return cmd.rx >= 3 && cmd.ry >= 3;
    default:       return true;
  }
}

// ── Lasso hit-test ──────────────────────────────────────────────
// PNPOLY (W. Randolph Franklin) — standard point-in-polygon ray-casting test.
function _pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// Representative points per command type — a command is selected by the lasso
// if ANY of its probe points falls inside the loop (standard lasso-select
// semantics: touching the loop is enough, the shape needn't be fully enclosed).
function _commandProbePoints(cmd) {
  switch (cmd.type) {
    case 'pen': case 'erase': case 'marker':
      return cmd.points;
    case 'line': case 'arrow':
      return [[cmd.x1, cmd.y1], [cmd.x2, cmd.y2], [(cmd.x1 + cmd.x2) / 2, (cmd.y1 + cmd.y2) / 2]];
    case 'rect':
      return [
        [cmd.x, cmd.y], [cmd.x + cmd.w, cmd.y], [cmd.x, cmd.y + cmd.h], [cmd.x + cmd.w, cmd.y + cmd.h],
        [cmd.x + cmd.w / 2, cmd.y + cmd.h / 2],
      ];
    case 'oval':
      return [
        [cmd.x, cmd.y],
        [cmd.x - cmd.rx, cmd.y], [cmd.x + cmd.rx, cmd.y],
        [cmd.x, cmd.y - cmd.ry], [cmd.x, cmd.y + cmd.ry],
      ];
    case 'highlight':
      return (cmd.rects ?? [{ x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h }])
        .flatMap(r => [[r.x, r.y], [r.x + r.w, r.y + r.h], [r.x + r.w / 2, r.y + r.h / 2]]);
    case 'text':
      return [[cmd.x, cmd.y]];
    default:
      return [];
  }
}

function _lassoSelect(polygon) {
  const ids = [];
  for (const cmd of getEffectiveCommands()) {
    if (_commandProbePoints(cmd).some(([px, py]) => _pointInPolygon(px, py, polygon))) ids.push(cmd.id);
  }
  return ids;
}

// ── Arrow hit-test and geometry ───────────────────────────────
// Returns the topmost numbered arrow whose line or start-circle contains (x, y).
// Only arrows with an id are returned — required for shape-drag move command.
function _hitTestArrow(x, y) {
  const cmds = getEffectiveCommands();
  const pad  = _isTouchDevice() ? 20 : 10;
  for (let i = cmds.length - 1; i >= 0; i--) {
    const c = cmds[i];
    if (c.type !== 'arrow' || c.id == null) continue;
    // Hit the start circle first (larger target)
    const r = Math.max(10, (c.width ?? 3) * 3.5) + 4;
    if (Math.hypot(x - c.x1, y - c.y1) <= r) return c;
    // Hit the shaft
    if (_distToSegment(x, y, c.x1, c.y1, c.x2, c.y2) <= pad) return c;
  }
  return null;
}

function _distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Returns the next sequential number for a numbered arrow on the current page.
// Uses max(existing visible numbers) + 1 so deleted arrows leave a gap (no renumbering).
function _nextArrowNumber() {
  return getEffectiveCommands()
    .filter(c => c.type === 'arrow' && c.number != null)
    .reduce((m, c) => Math.max(m, c.number), 0) + 1;
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

// True if (x, y) lands on any text item — decides whether the marker tool starts a
// text-snapping drag or a plain freehand stroke.
function _hitTestTextItem(x, y) {
  const items = getPageTextCache().get(getCurrentPage()) ?? [];
  return items.some(it => x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h);
}

// Finds the full text line at a click point (marker's tap-to-underline shortcut).
// Same "same line = top-y within 70% of item height" grouping as _textRectsFromDrag,
// just seeded from a single point instead of a drag rectangle's hit-set.
function _lineRectAtPoint(x, y) {
  const items = getPageTextCache().get(getCurrentPage()) ?? [];
  const hitItem = items.find(it => x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h);
  if (!hitItem) return null;
  const lineItems = items.filter(it => Math.abs(it.y - hitItem.y) <= hitItem.h * 0.7);
  const xs = lineItems.map(it => it.x);
  const xe = lineItems.map(it => it.x + it.w);
  const ys = lineItems.map(it => it.y);
  const ye = lineItems.map(it => it.y + it.h);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xe) - Math.min(...xs), h: Math.max(...ye) - Math.min(...ys) };
}

// ── Smart highlight ────────────────────────────────────────────

function _buildHighlightCmd(baseCmd) {
  const textItems  = getPageTextCache().get(getCurrentPage()) ?? [];
  const textRects  = textItems.length ? _textRectsFromDrag(textItems, baseCmd) : null;
  const finalRects = textRects?.length
    ? textRects
    : [{ x: baseCmd.x, y: baseCmd.y, w: baseCmd.w, h: baseCmd.h }];
  return {
    type:    'highlight',
    id:      ++_cmdId,
    rects:   finalRects,
    color:   baseCmd.color,
    opacity: baseCmd.opacity ?? HIGHLIGHT_OPACITY,
    comment: '',
  };
}

function _textRectsFromDrag(items, drag) {
  const hit = items.filter(it =>
    it.x < drag.x + drag.w && it.x + it.w > drag.x &&
    it.y < drag.y + drag.h && it.y + it.h > drag.y
  );
  if (!hit.length) return null;

  // Group items into lines: items whose top-y is within 70% of item height → same line
  const lines = [];
  for (const it of hit.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(it.y - last.refY) <= it.h * 0.7) {
      last.items.push(it);
    } else {
      lines.push({ refY: it.y, items: [it] });
    }
  }

  return lines.map(line => {
    const xs = line.items.map(it => it.x);
    const xe = line.items.map(it => it.x + it.w);
    const ys = line.items.map(it => it.y);
    const ye = line.items.map(it => it.y + it.h);
    return {
      x: Math.min(...xs), y: Math.min(...ys),
      w: Math.max(...xe) - Math.min(...xs),
      h: Math.max(...ye) - Math.min(...ys),
    };
  });
}

// Canvas-space position of the marker comment icon.
// renderCommand in drawUI.js uses the same offsets (8, -20) — keep in sync.
function _markerAnchor(cmd) {
  const last = cmd.points[cmd.points.length - 1];
  return { x: last[0] + 8, y: last[1] - 20 };
}

function _hitTestCommentIcon(x, y) {
  // Touch pad=8 gives an effective hit area of 30×30 px (14 visual + 8 on each side).
  const pad  = _isTouchDevice() ? 8 : 3;
  const cmds = getEffectiveCommands();
  for (let i = cmds.length - 1; i >= 0; i--) {
    const c = cmds[i];
    if (c.type === 'highlight' && c.rects && c.comment != null) {
      const last = c.rects[c.rects.length - 1];
      const ix = last.x + last.w + 3, iy = last.y;
      if (x >= ix - pad && x <= ix + 14 + pad && y >= iy - pad && y <= iy + 14 + pad) return c;
    }
    if (c.type === 'marker' && c.comment != null && c.points?.length) {
      const { x: ax, y: ay } = _markerAnchor(c);
      if (x >= ax - pad && x <= ax + 14 + pad && y >= ay - pad && y <= ay + 14 + pad) return c;
    }
  }
  return null;
}

function _openCommentInput(cmd, screenX, screenY) {
  const cur         = getEffectiveCommands().find(c => c.id === cmd.id);
  const initialText = cur?.comment ?? '';
  _showTextInput(screenX, screenY, (text) => {
    if (text === null) return;
    clearRedoForCurrentPage();
    _pushCommand({ type: 'style', targetId: cmd.id, patch: { comment: text } });
    redrawPage();
  });
  _textInput.value = initialText;
}

// ── Highlight hit-test and selection ──────────────────────────

function _hitTestHighlight(x, y) {
  const cmds = getEffectiveCommands();
  const pad  = _isTouchDevice() ? 10 : 4;
  for (let i = cmds.length - 1; i >= 0; i--) {
    const c = cmds[i];
    if (c.type !== 'highlight') continue;
    const rects = c.rects ?? [{ x: c.x, y: c.y, w: c.w, h: c.h }];
    for (const r of rects) {
      if (x >= r.x - pad && x <= r.x + r.w + pad &&
          y >= r.y - pad && y <= r.y + r.h + pad) return c;
    }
  }
  return null;
}

function _selectHighlight(cmd, clientX, clientY) {
  _selectedHighlightId = cmd.id;
  setSelectedHighlightId(cmd.id);
  _showHlToolbar(cmd, clientX, clientY);
  redrawPage();
}

function _dismissHighlightSelection() {
  const had = !!_selectedHighlightId;
  _selectedHighlightId = null;
  setSelectedHighlightId(null);
  if (_hlToolbar) _hlToolbar.style.display = 'none';
  if (had) redrawPage();
}

function _deleteSelectedHighlight() {
  if (!_selectedHighlightId) return;
  clearRedoForCurrentPage();
  _pushCommand({ type: 'delete', targetId: _selectedHighlightId });
  _dismissHighlightSelection();
}

function _showHlToolbar(cmd, clientX, clientY) {
  if (!_hlToolbar) return;
  _hlToolbar.style.visibility = 'hidden';
  _hlToolbar.style.display    = 'flex';
  const ow     = _hlToolbar.offsetWidth;
  const oh     = _hlToolbar.offsetHeight;
  const margin = 8;
  _hlToolbar.style.left       = Math.max(margin, Math.min(clientX, window.innerWidth  - ow - margin)) + 'px';
  _hlToolbar.style.top        = Math.max(margin, Math.min(clientY + 8, window.innerHeight - oh - margin)) + 'px';
  _hlToolbar.style.visibility = '';
  const eff = getEffectiveCommands().find(c => c.id === cmd.id);
  if (eff) {
    const color = eff.color ?? '#facc15';
    if (/^#[0-9a-f]{6}$/i.test(color)) _hlColorPicker.value = color;
  }
}

function _initHlToolbar() {
  _hlToolbar     = document.getElementById('hlSelectToolbar');
  _hlColorPicker = document.getElementById('hlColorPicker');
  const delBtn   = document.getElementById('hlDelete');
  if (!_hlToolbar) return;

  _hlColorPicker.addEventListener('input', () => {
    if (!_selectedHighlightId) return;
    clearRedoForCurrentPage();
    _pushCommand({ type: 'style', targetId: _selectedHighlightId, patch: { color: _hlColorPicker.value } });
    redrawPage();
  });

  delBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); _deleteSelectedHighlight(); });
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
