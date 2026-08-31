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
import { t }          from './i18n.js';

// ── Constants ──────────────────────────────────────────────────
const MAX_DIMENSION            = 4096;   // internal: canvas pixel size guard
export const HIGHLIGHT_OPACITY = 0.35;  // shared with drawPointer.js
export const MARKER_OPACITY    = 0.45;  // shared with drawPointer.js

// ── State ──────────────────────────────────────────────────────
let _pdfJsDoc     = null;
let _currentPage  = 1;
let _originalBuf  = null;        // ArrayBuffer — kept pristine for export
let _renderId     = 0;           // incremented each _renderPage call; stale renders abort
let _loadGen      = 0;           // bumped on every loadPdfFile() call — same shape as the
                                  // stale-init race already found+fixed this session in resize/
                                  // meta/redact/clean-scan: loadPdfFile(file) had no staleness
                                  // guard, so a slow-loading file's stale getDocument() call
                                  // resolving after a newer file's own load could overwrite
                                  // _pdfJsDoc/_originalBuf with the WRONG file — and unlike
                                  // resize/clean-scan, _exportToPdf() reads _originalBuf directly
                                  // (not a fresh per-file read), so this would be the wrong-DATA
                                  // class of bug (matching meta/redact), not just a wrong preview.
                                  // Unlike those, a real live repro (multiple realistic trigger
                                  // attempts: rapid tool-switch-away-and-back mid-load, 4x/6x CPU
                                  // throttle, a 2500-page fixture) did NOT reproduce actual
                                  // corruption here — this tool's own UI has no in-session
                                  // "remove file" affordance the other four tools all expose, and
                                  // pdf.js's getDocument() appears to resolve fast enough in
                                  // practice that the window never stayed open long enough to
                                  // observe. Fixed defensively anyway (same zero-risk pattern,
                                  // real structural gap by inspection) — but disclosed here
                                  // honestly as unconfirmed-by-repro, unlike the other four.

let _pageCommands = new Map();   // Map<pageNum, Command[]>
let _redoStack    = new Map();   // Map<pageNum, Command[]>
let _pageSize     = new Map();   // Map<pageNum, {width, height}> — canvas pixel dims for export

let _activeTool   = 'pen';
let _prevTool     = 'pen';   // tool before eyedropper — for auto-return
let _color        = '#e53e3e';
let _width        = 3;
let _selectedId          = null;   // UI state only — selected text id; never stored as command
let _selectedHighlightId = null;   // UI state only — selected highlight id; never stored as command
let _selectedImageId     = null;   // UI state only — selected signature-image id; never stored as command
let _lassoSelection       = [];    // UI state only — ids selected by the lasso tool; never stored as command
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
  // Captured before any await — see _loadGen's own comment (state block above).
  const gen = ++_loadGen;

  try {
    await loadPdfJs();
  } catch {
    if (gen !== _loadGen) return;
    showToast(t('draw_load_renderer_failed'));
    return;
  }
  if (gen !== _loadGen) return;

  let buf;
  try {
    buf = file._decryptedBuffer ? file._decryptedBuffer.slice(0) : await file.arrayBuffer();
  } catch {
    if (gen !== _loadGen) return;
    showToast(t('draw_read_file_failed'));
    return;
  }
  if (gen !== _loadGen) return;

  const newOriginalBuf = buf.slice(0);   // pristine copy — never mutated

  let newDoc;
  try {
    newDoc = await window.pdfjsLib.getDocument({
      data:              new Uint8Array(buf),
      useSystemFonts:    false,
      verbosity:         0,
      disableJavaScript: true,
    }).promise;
  } catch (err) {
    if (gen !== _loadGen) return;
    showToast(t('draw_open_pdf_failed', { msg: err.message }));
    return;
  }
  if (gen !== _loadGen) return;

  _originalBuf = newOriginalBuf;
  _pdfJsDoc    = newDoc;

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
export function setSelectedImageId(id)      { _selectedImageId = id; }
export function getSelectedImageId()        { return _selectedImageId; }
export function getLassoSelection()         { return _lassoSelection; }
export function setLassoSelection(ids)      { _lassoSelection = ids; }
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
  _loadGen++; // invalidate any in-flight loadPdfFile() call
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
  _selectedImageId     = null;
  _lassoSelection      = [];

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
    if (token === _renderId) showToast(t('draw_render_error', { msg: err.message }));
  } finally {
    if (token === _renderId) _canvasLoading.hidden = true;
  }
}

// Applies a single move/style/delete override into the accumulator maps.
// Shared by _resolveScene's top-level loop and its 'batch' case (lasso multi-select
// move/delete, and marker's multi-line drag-to-mark, each push one 'batch' command
// whose .ops are shaped exactly like a top-level move/style/delete command — same
// field contract, just nested). 'add' ops are handled separately by the caller since
// they inject a brand new command rather than patching an existing one.
function _applyOp(op, deleted, pos, style) {
  if (op.type === 'delete') { deleted.add(op.targetId); return; }
  if (op.type === 'move')   { const { type: _t, targetId, ...coords } = op; pos.set(targetId, coords); return; }
  if (op.type === 'style')  { style.set(op.targetId, { ...style.get(op.targetId), ...op.patch }); }
}

// Resolves the effective scene from raw command history.
// Applies position (move), style (color/size/…), and delete overrides in one pass.
// Fast path when no overrides exist — avoids all allocations on clean pages.
function _resolveScene(cmds) {
  const hasOverrides = cmds.some(
    c => c.type === 'move' || c.type === 'style' || c.type === 'delete' || c.type === 'batch'
  );
  if (!hasOverrides) return cmds;
  const deleted = new Set();
  const pos     = new Map();   // id → coordinate patch ({ x,y } for text; { x1,y1,x2,y2 } for shapes)
  const style   = new Map();   // id → merged patch (last style per id wins, partial ok)
  const added   = [];          // brand-new commands injected by 'batch' add-ops
  cmds.forEach(c => {
    if (c.type === 'batch') {
      c.ops.forEach(op => op.type === 'add' ? added.push(op.cmd) : _applyOp(op, deleted, pos, style));
      return;
    }
    _applyOp(c, deleted, pos, style);
  });
  const resolved = cmds
    .filter(c => c.type !== 'move' && c.type !== 'style' && c.type !== 'delete' && c.type !== 'batch' && !deleted.has(c.id))
    .map(c => {
      const p = pos.get(c.id)   ?? null;
      const s = style.get(c.id) ?? null;
      return (p || s) ? { ...c, ...p, ...s } : c;
    });
  return added.length ? [...resolved, ...added] : resolved;
}

// Returns the delta-shifted position fields for `cmd`, shaped to match exactly
// what _resolveScene's move-merge spreads onto the original command (same
// contract as the existing shape-drag/text-drag move commands). Used both to
// build a lasso group-move's batch ops and to render its live drag preview.
export function computeMovePatch(cmd, dx, dy) {
  switch (cmd.type) {
    case 'text':
    case 'rect':
    case 'oval':
      return { x: cmd.x + dx, y: cmd.y + dy };
    case 'line':
    case 'arrow':
      return { x1: cmd.x1 + dx, y1: cmd.y1 + dy, x2: cmd.x2 + dx, y2: cmd.y2 + dy };
    case 'pen':
    case 'erase':
    case 'marker':
      return { points: cmd.points.map(([x, y]) => [x + dx, y + dy]) };
    case 'highlight':
      return { rects: (cmd.rects ?? [{ x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h }]).map(r => ({ ...r, x: r.x + dx, y: r.y + dy })) };
    case 'image':
      return { x: cmd.x + dx, y: cmd.y + dy };
    default:
      return {};
  }
}

// Bounding box (canvas-space) of a group of commands — used for the lasso
// selection outline and for hit-testing "did this tap land inside the
// current selection" in drawPointer.js. ctx is required only for the 'text'
// case (font metrics via measureText), matching _drawSelectionOutline.
export function computeGroupBounds(cmds, ctx) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const cmd of cmds) {
    const b = _commandBounds(cmd, ctx);
    if (!b) continue;
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0);
    x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  return isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

function _commandBounds(cmd, ctx) {
  switch (cmd.type) {
    case 'pen': case 'erase': case 'marker': {
      const xs = cmd.points.map(p => p[0]), ys = cmd.points.map(p => p[1]);
      return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    }
    case 'line': case 'arrow':
      return {
        x0: Math.min(cmd.x1, cmd.x2), y0: Math.min(cmd.y1, cmd.y2),
        x1: Math.max(cmd.x1, cmd.x2), y1: Math.max(cmd.y1, cmd.y2),
      };
    case 'rect':
      return { x0: cmd.x, y0: cmd.y, x1: cmd.x + cmd.w, y1: cmd.y + cmd.h };
    case 'oval':
      return {
        x0: cmd.x - Math.abs(cmd.rx), y0: cmd.y - Math.abs(cmd.ry),
        x1: cmd.x + Math.abs(cmd.rx), y1: cmd.y + Math.abs(cmd.ry),
      };
    case 'highlight': {
      const rects = cmd.rects ?? [{ x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h }];
      return {
        x0: Math.min(...rects.map(r => r.x)),         y0: Math.min(...rects.map(r => r.y)),
        x1: Math.max(...rects.map(r => r.x + r.w)),    y1: Math.max(...rects.map(r => r.y + r.h)),
      };
    }
    case 'text': {
      if (!ctx) return null;
      const size  = cmd.size ?? 16;
      const lines = (cmd.text ?? '').replace(/\n+$/, '').split('\n');
      ctx.save();
      ctx.font = `${cmd.fontWeight ?? 'normal'} ${size}px ${cmd.fontFamily ?? 'system-ui, sans-serif'}`;
      const widths = lines.map(l => ctx.measureText(l).width);
      ctx.restore();
      const w = widths.length ? Math.max(...widths) : 0;
      const h = size * 1.25 * lines.length;
      return { x0: cmd.x, y0: cmd.y, x1: cmd.x + w, y1: cmd.y + h };
    }
    case 'image':
      return { x0: cmd.x, y0: cmd.y, x1: cmd.x + cmd.w, y1: cmd.y + cmd.h };
    default:
      return null;
  }
}

// Signature-image resize + delete handles — bottom-right resize, top-left
// delete (mobile has no Delete key, unlike the existing keyboard-only
// delete for text/lasso selections). Both sized to this project's own
// 24px WCAG 2.5.8 tap-target minimum (established for scan-document's crop
// handles). Exported so drawPointer.js's hit-testing uses the EXACT same
// geometry the render side draws, rather than a second, easy-to-drift copy.
export const IMAGE_HANDLE_SIZE = 24;

export function getImageHandleRect(cmd) {
  const s = IMAGE_HANDLE_SIZE;
  return { x: cmd.x + cmd.w - s / 2, y: cmd.y + cmd.h - s / 2, size: s };
}

export function getImageDeleteRect(cmd) {
  const s = IMAGE_HANDLE_SIZE;
  return { x: cmd.x - s / 2, y: cmd.y - s / 2, size: s };
}

// Dashed outline + resize/delete handles around a selected signature-image command.
function _drawImageSelection(ctx, cmd) {
  ctx.save();
  ctx.strokeStyle = '#2D7A4F';
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([5, 3]);
  ctx.beginPath();
  ctx.roundRect(cmd.x, cmd.y, cmd.w, cmd.h, 2);
  ctx.stroke();
  ctx.restore();

  const h = getImageHandleRect(cmd);
  ctx.save();
  ctx.fillStyle   = '#2D7A4F';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth   = 2;
  ctx.beginPath();
  ctx.roundRect(h.x, h.y, h.size, h.size, 4);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  const d = getImageDeleteRect(cmd);
  ctx.save();
  ctx.fillStyle   = '#e53e3e';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth   = 2;
  ctx.beginPath();
  ctx.roundRect(d.x, d.y, d.size, d.size, 4);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth   = 1.5;
  ctx.lineCap     = 'round';
  const pad = d.size * 0.28;
  ctx.beginPath();
  ctx.moveTo(d.x + pad, d.y + pad);
  ctx.lineTo(d.x + d.size - pad, d.y + d.size - pad);
  ctx.moveTo(d.x + d.size - pad, d.y + pad);
  ctx.lineTo(d.x + pad, d.y + d.size - pad);
  ctx.stroke();
  ctx.restore();
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

// Dashed outline around the union bounding box of a group of commands —
// used for the lasso tool's multi-select outline (both the settled selection
// and its live drag preview).
function _drawGroupSelectionOutline(ctx, cmds) {
  const b = computeGroupBounds(cmds, ctx);
  if (!b) return;
  ctx.save();
  ctx.strokeStyle = '#2D7A4F';
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([5, 3]);
  const pad = 6;
  ctx.beginPath();
  ctx.roundRect(b.x0 - pad, b.y0 - pad, (b.x1 - b.x0) + pad * 2, (b.y1 - b.y0) + pad * 2, 4);
  ctx.stroke();
  ctx.restore();
}

// In-progress lasso loop — dashed path following the pointer, closed back to start.
function _drawLassoPath(ctx, points) {
  if (points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = '#2D7A4F';
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.closePath();
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
  // During drag: skip the dragged command(s), re-rendered below at their new position
  const dragIds =
    (overlay?.type === 'text-drag' || overlay?.type === 'shape-drag') ? new Set([overlay.cmd.id]) :
    (overlay?.type === 'image-drag' || overlay?.type === 'image-resize') ? new Set([overlay.cmd.id]) :
    overlay?.type === 'lasso-drag'                                    ? new Set(overlay.ids) :
    null;
  for (const cmd of cmds) {
    if (dragIds?.has(cmd.id)) continue;
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
  if (_selectedImageId && overlay?.type !== 'image-drag' && overlay?.type !== 'image-resize') {
    const sel = cmds.find(c => c.id === _selectedImageId);
    if (sel) _drawImageSelection(ctx, sel);
  }
  if (_lassoSelection.length && overlay?.type !== 'lasso-drag') {
    const selCmds = cmds.filter(c => _lassoSelection.includes(c.id));
    if (selCmds.length) _drawGroupSelectionOutline(ctx, selCmds);
  }
  if (overlay) {
    if (overlay.type === 'text-drag') {
      renderCommand(ctx, { ...overlay.cmd, x: overlay.x, y: overlay.y });
    } else if (overlay.type === 'shape-drag') {
      const { cmd, dx = 0, dy = 0 } = overlay;
      renderCommand(ctx, { ...cmd, x1: cmd.x1 + dx, y1: cmd.y1 + dy, x2: cmd.x2 + dx, y2: cmd.y2 + dy });
    } else if (overlay.type === 'lasso') {
      _drawLassoPath(ctx, overlay.points);
    } else if (overlay.type === 'lasso-drag') {
      const { ids, dx = 0, dy = 0 } = overlay;
      const shifted = cmds.filter(c => ids.includes(c.id)).map(c => ({ ...c, ...computeMovePatch(c, dx, dy) }));
      for (const c of shifted) renderCommand(ctx, c);
      if (shifted.length) _drawGroupSelectionOutline(ctx, shifted);
    } else if (overlay.type === 'marker-smart-drag') {
      ctx.save();
      ctx.strokeStyle = overlay.color ?? '#e53e3e';
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(overlay.x, overlay.y, overlay.w, overlay.h);
      ctx.restore();
    } else if (overlay.type === 'image-drag') {
      const { cmd, dx = 0, dy = 0, guides } = overlay;
      const moved = { ...cmd, x: cmd.x + dx, y: cmd.y + dy };
      renderCommand(ctx, moved);
      _drawImageSelection(ctx, moved);
      if (guides) _drawSmartGuides(ctx, guides);
    } else if (overlay.type === 'image-resize') {
      const { cmd, w, h, guides } = overlay;
      const resized = { ...cmd, w, h };
      renderCommand(ctx, resized);
      _drawImageSelection(ctx, resized);
      if (guides) _drawSmartGuides(ctx, guides);
    } else {
      renderCommand(ctx, overlay);
    }
  }
}

// Smart-guide lines shown while dragging/resizing a signature image — a
// thin line appears when the moved/resized object's edge or center lines
// up with the page's own center or another layer's bounds (see
// js/drawPointer.js's _computeSmartGuides for the geometry). `guides` is
// { h: number[] (canvas Y positions), v: number[] (canvas X positions) }.
function _drawSmartGuides(ctx, guides) {
  if (!guides.h?.length && !guides.v?.length) return;
  ctx.save();
  ctx.strokeStyle = '#e53e3e';
  ctx.lineWidth   = 1;
  ctx.setLineDash([4, 4]);
  for (const y of guides.h ?? []) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(ctx.canvas.width, y);
    ctx.stroke();
  }
  for (const x of guides.v ?? []) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ctx.canvas.height);
    ctx.stroke();
  }
  ctx.restore();
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
      const pts = cmd.points;
      if (pts.length < 2) break;
      ctx.globalAlpha = cmd.opacity ?? MARKER_OPACITY;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      if (pts.length === 2) {
        ctx.lineTo(pts[1][0], pts[1][1]);
      } else {
        // Midpoint quadratic Bezier — same algorithm as signature pad,
        // adapted for batch replay. Each recorded point is a control point;
        // the path passes through the midpoints between them.
        for (let i = 0; i < pts.length - 1; i++) {
          const midX = (pts[i][0] + pts[i + 1][0]) / 2;
          const midY = (pts[i][1] + pts[i + 1][1]) / 2;
          ctx.quadraticCurveTo(pts[i][0], pts[i][1], midX, midY);
        }
        ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      }
      ctx.stroke();
      // Comment icon — offsets (8, -20) must match _markerAnchor() in drawPointer.js
      if (cmd.comment != null) {
        const last = pts[pts.length - 1];
        const ax = last[0] + 8, ay = last[1] - 20;
        ctx.globalAlpha  = 1;
        ctx.fillStyle    = cmd.comment ? '#2D7A4F' : 'rgba(130,130,130,0.55)';
        ctx.strokeStyle  = '#fff';
        ctx.lineWidth    = 1;
        ctx.beginPath();
        ctx.roundRect(ax, ay, 14, 14, 3);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle    = '#fff';
        ctx.font         = 'bold 9px system-ui, sans-serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('✎', ax + 7, ay + 7);
      }
      break;
    }
    case 'arrow': {
      const dx   = cmd.x2 - cmd.x1, dy = cmd.y2 - cmd.y1;
      const dist = Math.hypot(dx, dy);
      if (dist < 5) break;
      const angle = Math.atan2(dy, dx);
      const head  = Math.max(14, cmd.width * 5);

      // Circle radius at (x1,y1) for numbered arrows (legacy — only when number stored)
      const r = cmd.number != null ? Math.max(10, cmd.width * 3.5) : 0;
      const lineOffset = r > 0 ? Math.min(r, dist - 2) : 0;
      const lineX1 = cmd.x1 + lineOffset * Math.cos(angle);
      const lineY1 = cmd.y1 + lineOffset * Math.sin(angle);

      // Arrowhead: filled triangle — tip at (x2,y2), two base corners at ±30°
      const hx1 = cmd.x2 - head * Math.cos(angle - Math.PI / 6);
      const hy1 = cmd.y2 - head * Math.sin(angle - Math.PI / 6);
      const hx2 = cmd.x2 - head * Math.cos(angle + Math.PI / 6);
      const hy2 = cmd.y2 - head * Math.sin(angle + Math.PI / 6);

      // Shaft ends at base of triangle so it doesn't protrude through the filled head
      const lineX2 = cmd.x2 - head * Math.cos(angle);
      const lineY2 = cmd.y2 - head * Math.sin(angle);

      ctx.beginPath();
      ctx.moveTo(lineX1, lineY1);
      ctx.lineTo(lineX2, lineY2);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(cmd.x2, cmd.y2);
      ctx.lineTo(hx1, hy1);
      ctx.lineTo(hx2, hy2);
      ctx.closePath();
      ctx.fill();

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
    case 'image': {
      // A user-uploaded signature image (js/drawSignatureImage.js already
      // stripped its background if needed) — placed/moved/resized like any
      // other shape via cmd.x/y/w/h, but rendered as a bitmap, not a path.
      if (cmd.bitmap) ctx.drawImage(cmd.bitmap, cmd.x, cmd.y, cmd.w, cmd.h);
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
  btn.textContent   = t('draw_exporting');

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
      showToast(t('draw_no_annotations'));
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
    showToast(t('draw_export_failed', { msg: err.message }));
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
    if (!ctx) throw new Error(t('draw_2d_context_unavailable'));
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
    if (!ctx) { reject(new Error(t('draw_2d_context_unavailable'))); return; }
    effective.forEach(cmd => renderCommand(ctx, cmd));
    tmp.toBlob(b => {
      if (!b) { reject(new Error(t('draw_png_export_failed'))); return; }
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
    w.onerror = (err) => { reject(new Error(err.message || t('draw_worker_error'))); w.terminate(); };
    w.postMessage({ tool: 'draw', original, layers }, transferable);
  });
}
