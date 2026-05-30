// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

// ============================================================
//  drawUI.js — Draw on PDF: canvas management & page navigation
//
//  Архитектурные решения:
//  - Command-based history (не ImageData) — 34 МБ/снапшот → Safari OOM
//  - Per-page Map<pageNum, Command[]> — multi-page без потерь
//  - Overlay PNG поверх оригинала — сохраняем текст, ссылки, шрифты
//  - MAX_DIMENSION = 4096 — guard от крашей на огромных страницах
//  - _renderId — защита от race condition при быстром переключении страниц
//
//  ⚠️  Инвариант мутации: массивы в _pageCommands и _redoStack
//  принадлежат только этому модулю. Внешний код не должен хранить
//  долгосрочные ссылки на них — только читать snapshot через slice().
// ============================================================

import { loadPdfJs }  from './pdf2jpgUI.js';
import { id }         from './utils.js';
import { showToast }  from './ui.js';

// ── Constants ──────────────────────────────────────────────────
const MAX_DIMENSION            = 4096;   // internal: canvas pixel size guard
export const HIGHLIGHT_OPACITY = 0.35;  // shared with drawPointer.js

// ── State ──────────────────────────────────────────────────────
let _pdfJsDoc     = null;
let _currentPage  = 1;
let _originalBuf  = null;        // ArrayBuffer — kept pristine for export
let _renderId     = 0;           // incremented each _renderPage call; stale renders abort

let _pageCommands = new Map();   // Map<pageNum, Command[]>
let _redoStack    = new Map();   // Map<pageNum, Command[]>
let _pageSize     = new Map();   // Map<pageNum, {width, height}> — canvas pixel dims for export

let _activeTool   = 'pen';
let _prevTool     = 'pen';   // tool before eyedropper — for auto-return
let _color        = '#e53e3e';
let _width        = 3;
let _selectedId          = null;   // UI state only — selected text id; never stored as command
let _selectedHighlightId = null;   // UI state only — selected highlight id; never stored as command
let _pageTextCache = new Map(); // Map<pageNum, {x,y,w,h}[]> — canvas-space text rects for smart highlight

// DOM refs — filled by initDraw()
let _pdfCanvas, _drawCanvas, _canvasLoading;
let _pageLabel, _btnPrev, _btnNext, _downloadBtn, _editorShell;

// ── Public API ─────────────────────────────────────────────────

export function initDraw() {
  _pdfCanvas     = id('pdfCanvas');
  _drawCanvas    = id('drawCanvas');
  _canvasLoading = id('canvasLoading');
  _pageLabel     = id('pageLabel');
  _btnPrev       = id('btnPrev');
  _btnNext       = id('btnNext');
  _downloadBtn   = id('downloadPdfBtn');
  _editorShell   = id('editorShell');

  _bindToolbar();
  _bindNavigation();
  _downloadBtn.addEventListener('click', _exportToPdf);
  _initFab();
}

function _initFab() {
  const fab     = id('fabStack');
  const fabUp   = id('fabUp');
  const fabDown = id('fabDown');
  if (!fab) return;

  function _updateEdgeButtons() {
    const scrollY   = window.scrollY;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    fabUp  ?.classList.toggle('fab-edge-hidden', scrollY < 100);
    fabDown?.classList.toggle('fab-edge-hidden', maxScroll > 0 && scrollY > maxScroll - 100);
  }

  // Scroll: hide FAB while scrolling; update edge buttons on every event
  // so ↑/↓ are correct the moment FAB reappears after scroll stops
  let _scrollTimer = 0;
  window.addEventListener('scroll', () => {
    if (!fab.classList.contains('is-hidden')) fab.classList.add('is-hidden');
    _updateEdgeButtons();
    clearTimeout(_scrollTimer);
    _scrollTimer = setTimeout(() => fab.classList.remove('is-hidden'), 600);
  }, { passive: true });

  // Drawing: hide during pointer-on-canvas; restore on release anywhere on window
  _drawCanvas.addEventListener('pointerdown', () => fab.classList.add('is-hidden'));
  window.addEventListener('pointerup',     () => fab.classList.remove('is-hidden'));
  window.addEventListener('pointercancel', () => fab.classList.remove('is-hidden'));

  // ↑ / ↓ smooth-scroll 85% of viewport — feels like reading assist, not teleport
  fabUp  ?.addEventListener('click', () =>
    window.scrollBy({ top: -(window.innerHeight * 0.85), behavior: 'smooth' }));
  fabDown?.addEventListener('click', () =>
    window.scrollBy({ top:   window.innerHeight * 0.85,  behavior: 'smooth' }));

  _updateEdgeButtons();   // set correct initial state
}

export async function loadPdfFile(file) {
  try {
    await loadPdfJs();
  } catch {
    showToast('Failed to load PDF renderer. Check your internet connection.');
    return;
  }

  let buf;
  try {
    buf = file._decryptedBuffer ? file._decryptedBuffer.slice(0) : await file.arrayBuffer();
  } catch {
    showToast('Could not read the file.');
    return;
  }

  _originalBuf = buf.slice(0);   // pristine copy — never mutated

  try {
    _pdfJsDoc = await window.pdfjsLib.getDocument({
      data:              new Uint8Array(buf),
      useSystemFonts:    false,
      verbosity:         0,
      disableJavaScript: true,
    }).promise;
  } catch (err) {
    showToast('Failed to open PDF: ' + err.message);
    return;
  }

  _currentPage   = 1;
  _pageCommands  = new Map();
  _redoStack     = new Map();
  _pageSize      = new Map();
  _pageTextCache = new Map();

  _editorShell.hidden        = false;
  id('preEditorArea').hidden = true;
  _downloadBtn.disabled = false;

  await _renderPage(1);
}

// ── Getters (used by pointer-events step 4 and export step 6) ──

export function getActiveTool()      { return _activeTool; }
export function getColor()           { return _color; }
export function getWidth()           { return _width; }
export function getDrawCanvas()      { return _drawCanvas; }
export function getPdfCanvas()       { return _pdfCanvas; }
export function getCurrentPage()     { return _currentPage; }
export function getPageCommandsRef()   { return _pageCommands; }
// Returns commands for current page with move-overrides applied — use for hit-testing and rendering.
export function getEffectiveCommands() { return _resolveScene(_pageCommands.get(_currentPage) ?? []); }
export function setSelectedId(id)           { _selectedId = id; }
export function setSelectedHighlightId(id)  { _selectedHighlightId = id; }
export function getRedoStackRef()    { return _redoStack; }
export function getOriginalBuffer()  { return _originalBuf; }
export function getPageCount()       { return _pdfJsDoc ? _pdfJsDoc.numPages : 0; }
export function redrawPage(overlay = null) { _redrawPage(overlay); }
export function getPageTextCache()   { return _pageTextCache; }

// Called by eyedropper after picking — updates color and syncs picker UI
export function setColor(hex) {
  _color = hex;
  const cp = id('colorPicker');
  if (cp && /^#[0-9a-f]{6}$/i.test(hex)) cp.value = hex;
}

// Returns to the tool that was active before eyedropper was selected
export function activatePrevTool() {
  _activeTool = _prevTool;
  _drawCanvas.dataset.drawTool = _prevTool;
  document.querySelectorAll('.tool-btn[data-draw-tool]').forEach(btn => {
    btn.setAttribute('aria-pressed', btn.dataset.drawTool === _prevTool ? 'true' : 'false');
  });
}

// Called by pointer-events module on pointerdown — new stroke invalidates redo history
export function clearRedoForCurrentPage() {
  _redoStack.set(_currentPage, []);
}

export function undo() { _undo(); }
export function redo() { _redo(); }

// Called by toolRegistrations hide() — resets all state when switching away from draw-pdf.
// toolRegistrations also calls resetPointer() from drawPointer.js (avoids circular import).
export function resetDraw() {
  _pdfJsDoc      = null;
  _currentPage   = 1;
  _originalBuf   = null;
  _renderId      = 0;
  _pageCommands  = new Map();
  _redoStack     = new Map();
  _pageSize      = new Map();
  _pageTextCache = new Map();
  _activeTool          = 'pen';
  _color               = '#e53e3e';
  _width               = 3;
  _selectedHighlightId = null;

  // Clear canvas bitmaps — setting width=0 resets the bitmap and hints GC to release memory
  for (const canvas of [_pdfCanvas, _drawCanvas]) {
    if (!canvas) continue;
    canvas.width  = 0;
    canvas.height = 0;
  }

  // Sync toolbar UI: reset tool buttons, color picker, width slider
  if (_drawCanvas) {
    document.querySelectorAll('.tool-btn[data-draw-tool]').forEach(btn => {
      btn.setAttribute('aria-pressed', btn.dataset.drawTool === 'pen' ? 'true' : 'false');
    });
    _drawCanvas.dataset.drawTool = 'pen';
    const cp = id('colorPicker'); if (cp) cp.value = '#e53e3e';
    const ws = id('widthSlider'); if (ws) ws.value = '3';
  }

  // Reset layout
  if (_editorShell)  _editorShell.hidden = true;
  if (_downloadBtn)  _downloadBtn.disabled = true;
  if (_pageLabel)    _pageLabel.textContent = '1 / 1';
  if (_btnPrev)      _btnPrev.disabled = true;
  if (_btnNext)      _btnNext.disabled = true;
  const preEditorArea = id('preEditorArea');
  if (preEditorArea) preEditorArea.hidden = false;
}

// ── Page rendering ─────────────────────────────────────────────

async function _renderPage(pageNum) {
  // Buttons disabled here prevent nav spam during render;
  // re-enabled at the end of _updateNavUI() only for the winning token.
  _canvasLoading.hidden = false;
  _btnPrev.disabled     = true;
  _btnNext.disabled     = true;

  const token = ++_renderId;   // stale renders detect token mismatch and abort

  try {
    const page   = await _pdfJsDoc.getPage(pageNum);
    if (token !== _renderId) return;   // user switched page while we awaited getPage

    const outputScale = window.devicePixelRatio || 1;
    const baseVp      = page.getViewport({ scale: 1 });

    // Normalize Rotate:180 — some PDFs carry this metadata; combined with
    // Telegram Android WebView's GPU compositor it causes pages to render
    // upside-down. Other angles (0, 90, 270) are passed through unchanged.
    const rotation = baseVp.rotation === 180 ? 0 : baseVp.rotation;

    // cssScale: layout scale (CSS px). outputScale: DPR for sharp pixels.
    const areaW  = Math.max(320, (id('canvasArea')?.clientWidth || 800) - 32);
    let cssScale = areaW / baseVp.width;

    // Guard: cap cssScale so canvas never exceeds MAX_DIMENSION at output resolution
    const maxCss = MAX_DIMENSION / (Math.max(baseVp.width, baseVp.height) * outputScale);
    if (cssScale > maxCss) cssScale = maxCss;

    const cssW = Math.round(baseVp.width  * cssScale);
    const cssH = Math.round(baseVp.height * cssScale);

    // Uniform pixel scale — preserves aspect ratio under MAX_DIMENSION cap
    const pixelScale = Math.min(outputScale, MAX_DIMENSION / cssW, MAX_DIMENSION / cssH);

    // Bake pixelScale into the viewport instead of renderContext.transform.
    // renderContext.transform calls ctx.transform() inside pdf.js — Telegram
    // Android WebView's GPU compositor can double-apply this matrix, flipping
    // the page. Viewport-scale is handled purely by pdf.js internals and is
    // stable across all WebView versions.
    const viewport = page.getViewport({ scale: cssScale * pixelScale, rotation });

    // Derive canvas bitmap dimensions from viewport — correct for all rotation
    // angles (90°/270° swap width and height; computing from baseVp.width would
    // give wrong dims and shift annotation coordinates).
    const pxW = Math.round(viewport.width);
    const pxH = Math.round(viewport.height);

    for (const canvas of [_pdfCanvas, _drawCanvas]) {
      canvas.width        = pxW;
      canvas.height       = pxH;
      canvas.style.width  = `${Math.round(viewport.width  / pixelScale)}px`;
      canvas.style.height = `${Math.round(viewport.height / pixelScale)}px`;
    }

    const ctx = _pdfCanvas.getContext('2d');
    // Reset to identity — guards against stale transform matrix from canvas
    // recycling in Android WebView (different purpose from DPR scaling).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pxW, pxH);

    // Note: renderTask.cancel() is not called on abort — pdf.js task runs to
    // completion in background. Acceptable for MVP; add cancel() if heavy PDFs
    // cause measurable lag during fast page switching.
    await page.render({ canvasContext: ctx, viewport }).promise;

    if (token !== _renderId) return;   // page switched while we were rendering

    _currentPage = pageNum;
    _pageSize.set(pageNum, { width: pxW, height: pxH });

    // Text layer cache for smart highlight — pre-transform to canvas coords so
    // no viewport reference is needed later. Scanned/image PDFs have no text items.
    try {
      const tc = await page.getTextContent();
      if (token === _renderId) {
        const vscale = viewport.scale;
        _pageTextCache.set(pageNum,
          tc.items
            .filter(it => it.str.trim() && it.width > 0)
            .map(it => {
              const [,,,, tx, ty] = window.pdfjsLib.Util.transform(viewport.transform, it.transform);
              return { x: tx, y: ty - it.height * vscale, w: it.width * vscale, h: it.height * vscale };
            })
        );
      }
    } catch { /* text layer unavailable — smart highlight falls back to rect */ }

    if (token !== _renderId) return;
    _redrawPage();
    _updateNavUI();

  } catch (err) {
    if (token === _renderId) showToast('Render error: ' + err.message);
  } finally {
    if (token === _renderId) _canvasLoading.hidden = true;
  }
}

// Resolves the effective scene from raw command history.
// Applies position (move), style (color/size/…), and delete overrides in one pass.
// Fast path when no overrides exist — avoids all allocations on clean pages.
function _resolveScene(cmds) {
  const hasOverrides = cmds.some(
    c => c.type === 'move' || c.type === 'style' || c.type === 'delete'
  );
  if (!hasOverrides) return cmds;
  const deleted = new Set();
  const pos     = new Map();   // id → coordinate patch ({ x,y } for text; { x1,y1,x2,y2 } for shapes)
  const style   = new Map();   // id → merged patch (last style per id wins, partial ok)
  cmds.forEach(c => {
    if (c.type === 'delete') { deleted.add(c.targetId); return; }
    if (c.type === 'move')   { const { type: _t, targetId, ...coords } = c; pos.set(targetId, coords); return; }
    if (c.type === 'style')  { style.set(c.targetId, { ...style.get(c.targetId), ...c.patch }); }
  });
  return cmds
    .filter(c => c.type !== 'move' && c.type !== 'style' && c.type !== 'delete' && !deleted.has(c.id))
    .map(c => {
      const p = pos.get(c.id)   ?? null;
      const s = style.get(c.id) ?? null;
      return (p || s) ? { ...c, ...p, ...s } : c;
    });
}

// Draws a dashed border around every rect of a selected highlight command.
function _drawHighlightSelectionOutline(ctx, cmd) {
  const rects = cmd.rects ?? [{ x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h }];
  ctx.save();
  ctx.strokeStyle = '#2D7A4F';
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([5, 3]);
  const pad = 3;
  for (const r of rects) {
    ctx.beginPath();
    ctx.roundRect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2, 2);
    ctx.stroke();
  }
  ctx.restore();
}

// Draws a dashed selection outline around a text command using its effective bounds.
// Always uses accent color — ignores text color to avoid invisible outlines on light text.
function _drawSelectionOutline(ctx, cmd) {
  const size   = cmd.size ?? 16;
  const lines  = (cmd.text ?? '').replace(/\n+$/, '').split('\n');
  ctx.save();
  ctx.font     = `${cmd.fontWeight ?? 'normal'} ${size}px ${cmd.fontFamily ?? 'system-ui, sans-serif'}`;
  const widths = lines.map(l => ctx.measureText(l).width);
  const w      = widths.length ? Math.max(...widths) : 0;
  const h      = size * 1.25 * lines.length;
  const pad    = 5;
  ctx.strokeStyle = '#2D7A4F';
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([5, 3]);
  ctx.beginPath();
  ctx.roundRect(cmd.x - pad, cmd.y - pad, w + pad * 2, h + pad * 2, 3);
  ctx.stroke();
  ctx.restore();
}

// Clears draw canvas and replays all commands for the current page.
// overlay — optional in-progress command rendered after history (live preview).
// Render order: annotations → selection outline → live interaction overlay.
function _redrawPage(overlay = null) {
  const ctx    = _drawCanvas.getContext('2d');
  ctx.clearRect(0, 0, _drawCanvas.width, _drawCanvas.height);
  const cmds   = _resolveScene(_pageCommands.get(_currentPage) ?? []);
  // During drag: skip the dragged command, re-render below at new position
  const dragId = (overlay?.type === 'text-drag' || overlay?.type === 'shape-drag')
    ? overlay.cmd.id : null;
  for (const cmd of cmds) {
    if (cmd.id === dragId) continue;
    renderCommand(ctx, cmd);
  }
  // Selection outline — after annotations, before live interaction
  if (_selectedId) {
    const sel = cmds.find(c => c.id === _selectedId);
    if (sel) _drawSelectionOutline(ctx, sel);
  }
  if (_selectedHighlightId) {
    const sel = cmds.find(c => c.id === _selectedHighlightId);
    if (sel) _drawHighlightSelectionOutline(ctx, sel);
  }
  if (overlay) {
    if (overlay.type === 'text-drag') {
      renderCommand(ctx, { ...overlay.cmd, x: overlay.x, y: overlay.y });
    } else if (overlay.type === 'shape-drag') {
      const { cmd, dx = 0, dy = 0 } = overlay;
      renderCommand(ctx, { ...cmd, x1: cmd.x1 + dx, y1: cmd.y1 + dy, x2: cmd.x2 + dx, y2: cmd.y2 + dy });
    } else {
      renderCommand(ctx, overlay);
    }
  }
}

// Returns black or white depending on background luminance (W3C approximation).
// Input type="color" always produces #rrggbb; falls back to white for unexpected formats.
function _contrastText(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return '#ffffff';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 128 ? '#000000' : '#ffffff';
}

// ── Command renderer ───────────────────────────────────────────
// Exported so step 6 can replay commands on an OffscreenCanvas during PDF export.

export function renderCommand(ctx, cmd) {
  ctx.save();
  ctx.strokeStyle = cmd.color ?? '#e53e3e';
  ctx.fillStyle   = cmd.color ?? '#e53e3e';
  ctx.lineWidth   = cmd.width ?? 3;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';

  switch (cmd.type) {
    case 'pen': {
      if (cmd.points.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(cmd.points[0][0], cmd.points[0][1]);
      for (let i = 1; i < cmd.points.length; i++) {
        ctx.lineTo(cmd.points[i][0], cmd.points[i][1]);
      }
      ctx.stroke();
      break;
    }
    case 'marker': {
      if (cmd.points.length < 2) break;
      ctx.globalAlpha = cmd.opacity ?? 0.45;
      ctx.beginPath();
      ctx.moveTo(cmd.points[0][0], cmd.points[0][1]);
      for (let i = 1; i < cmd.points.length; i++) {
        ctx.lineTo(cmd.points[i][0], cmd.points[i][1]);
      }
      ctx.stroke();
      break;
    }
    case 'arrow': {
      const dx   = cmd.x2 - cmd.x1, dy = cmd.y2 - cmd.y1;
      const dist = Math.hypot(dx, dy);
      if (dist < 5) break;
      const angle = Math.atan2(dy, dx);
      const head  = Math.max(12, cmd.width * 4);
      // Circle radius at (x1,y1) for numbered arrows
      const r = cmd.number != null ? Math.max(10, cmd.width * 3.5) : 0;
      // Clamp offset to (dist-2) so the line never starts past the arrowhead on very short arrows
      const lineOffset = r > 0 ? Math.min(r, dist - 2) : 0;
      const lineX1 = cmd.x1 + lineOffset * Math.cos(angle);
      const lineY1 = cmd.y1 + lineOffset * Math.sin(angle);
      ctx.beginPath();
      ctx.moveTo(lineX1, lineY1);
      ctx.lineTo(cmd.x2, cmd.y2);
      ctx.moveTo(cmd.x2, cmd.y2);
      ctx.lineTo(cmd.x2 - head * Math.cos(angle - Math.PI / 6),
                 cmd.y2 - head * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(cmd.x2, cmd.y2);
      ctx.lineTo(cmd.x2 - head * Math.cos(angle + Math.PI / 6),
                 cmd.y2 - head * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
      if (r > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cmd.x1, cmd.y1, r, 0, Math.PI * 2);
        ctx.fillStyle = cmd.color ?? '#e53e3e';
        ctx.fill();
        ctx.font          = `bold ${Math.round(r * 1.2)}px system-ui, sans-serif`;
        ctx.fillStyle     = _contrastText(cmd.color ?? '#e53e3e');
        ctx.textAlign     = 'center';
        ctx.textBaseline  = 'middle';
        ctx.fillText(String(cmd.number), cmd.x1, cmd.y1);
        ctx.restore();
      }
      break;
    }
    case 'line': {
      ctx.beginPath();
      ctx.moveTo(cmd.x1, cmd.y1);
      ctx.lineTo(cmd.x2, cmd.y2);
      ctx.stroke();
      break;
    }
    case 'rect': {
      ctx.strokeRect(cmd.x, cmd.y, cmd.w, cmd.h);
      break;
    }
    case 'oval': {
      ctx.beginPath();
      ctx.ellipse(cmd.x, cmd.y, Math.abs(cmd.rx), Math.abs(cmd.ry), 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'text': {
      if (!cmd.text?.trim()) break;
      ctx.save();
      const size   = cmd.size ?? 16;
      const weight = cmd.fontWeight ?? 'normal';
      const family = cmd.fontFamily ?? 'system-ui, sans-serif';
      ctx.font         = `${weight} ${size}px ${family}`;
      ctx.fillStyle    = cmd.color ?? '#000';
      ctx.textBaseline = 'top';    // text starts FROM click point, not below
      ctx.textAlign    = 'left';   // explicit — prevents inherited canvas state
      const lineHeight = size * 1.25;
      cmd.text.replace(/\n+$/, '').split('\n').forEach((line, i) => {
        ctx.fillText(line, cmd.x, cmd.y + i * lineHeight);
      });
      ctx.restore();
      break;
    }
    case 'highlight': {
      ctx.save();
      ctx.globalAlpha = cmd.opacity ?? HIGHLIGHT_OPACITY;
      ctx.fillStyle   = cmd.color ?? '#facc15';
      if (cmd.rects) {
        for (const r of cmd.rects) ctx.fillRect(r.x, r.y, r.w, r.h);
      } else {
        ctx.fillRect(cmd.x, cmd.y, cmd.w, cmd.h);
      }
      // Comment icon — only on new-format highlights (cmd.comment != null)
      if (cmd.rects && cmd.comment != null) {
        const last = cmd.rects[cmd.rects.length - 1];
        const ix   = last.x + last.w + 3;
        const iy   = last.y;
        ctx.globalAlpha  = 1;
        ctx.fillStyle    = cmd.comment ? '#2D7A4F' : 'rgba(130,130,130,0.55)';
        ctx.strokeStyle  = '#fff';
        ctx.lineWidth    = 1;
        ctx.beginPath();
        ctx.roundRect(ix, iy, 14, 14, 3);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle    = '#fff';
        ctx.font         = 'bold 9px system-ui, sans-serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('✎', ix + 7, iy + 7);
      }
      ctx.restore();
      break;
    }
    case 'erase': {
      // Whiteout: opaque white stroke covers both annotations and PDF content.
      // Outer ctx.save()/restore() handles state cleanup — no nested pair needed.
      ctx.strokeStyle = '#ffffff';
      if (cmd.points.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(cmd.points[0][0], cmd.points[0][1]);
      for (let i = 1; i < cmd.points.length; i++) {
        ctx.lineTo(cmd.points[i][0], cmd.points[i][1]);
      }
      ctx.stroke();
      break;
    }
    default: break;
  }

  ctx.restore();
}

// ── Toolbar bindings ───────────────────────────────────────────

function _bindToolbar() {
  const toolBtns = document.querySelectorAll('.tool-btn[data-draw-tool]');
  toolBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.drawTool;
      if (next === 'eye' && _activeTool !== 'eye') {
        _prevTool = _activeTool;
      }
      _activeTool = next;
      toolBtns.forEach(b => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
      _drawCanvas.dataset.drawTool = _activeTool;
    });
  });

  id('colorPicker').addEventListener('input', e => { _color = e.target.value; });
  id('widthSlider').addEventListener('input', e => { _width = Number(e.target.value); });

  id('btnUndo').addEventListener('click',  _undo);
  id('btnRedo').addEventListener('click',  _redo);
  id('btnClear').addEventListener('click', _clearPage);
}

// ── Navigation ─────────────────────────────────────────────────

function _bindNavigation() {
  _btnPrev.addEventListener('click', () => {
    if (_currentPage > 1) _renderPage(_currentPage - 1);
  });
  _btnNext.addEventListener('click', () => {
    if (_pdfJsDoc && _currentPage < _pdfJsDoc.numPages) _renderPage(_currentPage + 1);
  });
}

function _updateNavUI() {
  const total = _pdfJsDoc.numPages;
  _pageLabel.textContent = `${_currentPage} / ${total}`;
  _btnPrev.disabled = _currentPage <= 1;
  _btnNext.disabled = _currentPage >= total;
}

// ── Undo / Redo / Clear ────────────────────────────────────────

function _undo() {
  const cmds = _pageCommands.get(_currentPage) ?? [];
  if (!cmds.length) return;
  const undone = cmds.pop();
  _pageCommands.set(_currentPage, cmds);
  const stack = _redoStack.get(_currentPage) ?? [];
  stack.push(undone);
  _redoStack.set(_currentPage, stack);
  _redrawPage();
}

function _redo() {
  const stack = _redoStack.get(_currentPage) ?? [];
  if (!stack.length) return;
  const cmd  = stack.pop();
  _redoStack.set(_currentPage, stack);
  const cmds = _pageCommands.get(_currentPage) ?? [];
  cmds.push(cmd);
  _pageCommands.set(_currentPage, cmds);
  _redrawPage();
}

function _clearPage() {
  _pageCommands.set(_currentPage, []);
  _redoStack.set(_currentPage, []);   // clear is not undoable
  _redrawPage();
}

// ── Export ─────────────────────────────────────────────────────

async function _exportToPdf() {
  if (!_pdfJsDoc || !_originalBuf) return;

  const btn         = _downloadBtn;
  const originalText = btn.textContent;
  btn.disabled      = true;
  btn.textContent   = 'Exporting…';

  try {
    const total  = _pdfJsDoc.numPages;
    const layers = [];

    for (let i = 1; i <= total; i++) {
      const cmds = _pageCommands.get(i);
      if (!cmds || cmds.length === 0) { layers.push(null); continue; }
      const size = _pageSize.get(i);
      if (!size) { layers.push(null); continue; }
      layers.push(await _renderLayerToPng(cmds, size.width, size.height));
    }

    if (layers.every(l => l === null)) {
      showToast('No annotations to save. Draw something first.');
      return;
    }

    // Snapshot of pristine buffer — safe to transfer to worker
    const original     = _originalBuf.slice(0);
    const transferable = [original, ...layers.filter(Boolean)];

    const resultBuf = await _runExportWorker(original, layers, transferable);

    const blob = new Blob([resultBuf], { type: 'application/pdf' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'annotated.pdf';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);

  } catch (err) {
    showToast('Export failed: ' + err.message);
  } finally {
    btn.disabled    = false;
    btn.textContent = originalText;
  }
}

async function _renderLayerToPng(cmds, w, h) {
  const effective = _resolveScene(cmds);   // resolve move-overrides before export
  if (typeof OffscreenCanvas !== 'undefined') {
    const off = new OffscreenCanvas(w, h);
    const ctx = off.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    effective.forEach(cmd => renderCommand(ctx, cmd));
    const blob = await off.convertToBlob({ type: 'image/png' });
    return blob.arrayBuffer();
  }
  // DOM canvas fallback for Safari < 16.4
  return new Promise((resolve, reject) => {
    const tmp = document.createElement('canvas');
    tmp.width  = w;
    tmp.height = h;
    const ctx  = tmp.getContext('2d');
    if (!ctx) { reject(new Error('2D context unavailable')); return; }
    effective.forEach(cmd => renderCommand(ctx, cmd));
    tmp.toBlob(b => {
      if (!b) { reject(new Error('PNG export failed')); return; }
      b.arrayBuffer().then(resolve, reject);
    }, 'image/png');
  });
}

function _runExportWorker(original, layers, transferable) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./worker.js', import.meta.url));
    w.onmessage = (e) => {
      if (e.data.type === 'done')  { resolve(e.data.result); w.terminate(); }
      if (e.data.type === 'error') { reject(new Error(e.data.message)); w.terminate(); }
    };
    w.onerror = (err) => { reject(new Error(err.message || 'Worker error')); w.terminate(); };
    w.postMessage({ tool: 'draw', original, layers }, transferable);
  });
}
