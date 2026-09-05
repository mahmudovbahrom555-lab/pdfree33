// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors
//
// ── readUI.js ──────────────────────────────────────────────────────────────
// "Read PDF" — live in-browser reflow reading view. Self-managed tool (see
// SELF_MANAGED_TOOLS in app.js), same shape as compare-pdf: no js/worker.js,
// no runner in the registry, owns its own container end to end. Unlike
// compare, there's nothing to configure before showing a result, so this
// auto-runs the instant a file loads (mirrors pdf2pdfaUI's own precedent —
// #mergeBtn is hidden entirely, not bound).
//
// Reuses pdf2word's own page-data extraction (_p2wBuildPageData) and a new
// sibling of pdf2ppt's _p2pBuildSlideShapes — _rpBuildPageBlocks — which
// applies the exact same heading/list/table/column detectors already proven
// twice (pdf2word, pdf2ppt) but emits plain reading blocks instead of
// PPTX shapes or docx.js objects. See js/processor.js's own comments on
// both functions for the detection heuristics themselves.

import { loadPdfJs } from './pdf2jpgUI.js';
import { id, esc } from './utils.js';
import { _p2wBuildPageData, _rpBuildPageBlocks, _p2pCropCanvasRegion, _setProcessingFlag } from './processor.js';
import { t } from './i18n.js';
import { hideProgress } from './ui.js';

const RENDER_SCALE = 1.5; // matches compareUI's own canvas render scale

let _file        = null;
let _cancelled    = false;
let _resolvePw    = null;
let _fontScale    = 1.15; // starting size — deliberately larger than a normal paragraph default

export function getReadParams() {
  return { hasFile: !!_file };
}

export function hideReadOptions() {
  _cancelled = true;
  if (_resolvePw) { _resolvePw(null); _resolvePw = null; }
  const el = id('readOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  const btn = id('mergeBtn');
  if (btn) btn.style.display = '';
  _file = null;
  _setProcessingFlag(false);
}

export async function initReadOptions(file) {
  const el = id('readOptions');
  if (!el) return;
  el.style.display = '';
  _file      = file;
  _cancelled = false;

  const btn = id('mergeBtn');
  if (btn) btn.style.display = 'none';

  el.innerHTML = _loadingHtml();
  try {
    await _runRead(el);
  } catch (err) {
    if (_cancelled) return;
    el.innerHTML = _errorHtml(err?.message);
  }
}

// ── Main pipeline ────────────────────────────────────────────────────────

async function _runRead(container) {
  await loadPdfJs();
  if (_cancelled) return;

  const buf = await _file.arrayBuffer();
  const pdfDoc = await new Promise((resolve, reject) => {
    const task = window.pdfjsLib.getDocument({
      isEvalSupported: false,
      data:              new Uint8Array(buf),
      verbosity:         0,
      disableJavaScript: true,
      onPassword: (updateCallback, reason) => {
        _promptPassword(_file?.name || '', reason,
          pw => updateCallback(pw),
          ()  => { _cancelled = true; task.destroy(); reject(new Error('cancelled')); }
        );
      },
    });
    task.promise.then(resolve).catch(err => {
      if (_cancelled) { reject(new Error('cancelled')); return; }
      reject(err);
    });
  });
  if (_cancelled) return;

  // _p2wBuildPageData()/its per-page loop gate on isProcessing (normally
  // only ever true inside doProcess()'s own orchestration) — this tool
  // never calls doProcess() at all, so it must flip the flag itself.
  _setProcessingFlag(true);
  let pageData, median, repeatTextSet, repeatPatternSet;
  try {
    ({ pageData, median, repeatTextSet, repeatPatternSet } = await _p2wBuildPageData(pdfDoc));
  } finally {
    _setProcessingFlag(false);
  }
  if (_cancelled) return;

  const perPage = pageData.map(page => _rpBuildPageBlocks(page, median, repeatTextSet, repeatPatternSet));
  const anyText = perPage.some(p => p.blocks.length > 0);

  if (!anyText) {
    container.innerHTML = _emptyStateHtml();
    pdfDoc.destroy();
    hideProgress();
    return;
  }

  _renderShell(container);
  const contentEl = container.querySelector('#readContent');

  for (let i = 0; i < perPage.length; i++) {
    if (_cancelled) { pdfDoc.destroy(); return; }
    const { blocks } = perPage[i];
    if (!blocks.length) continue;

    // Only pages with an actual image block pay the canvas-render cost —
    // same lazy-render-only-when-needed optimization pdf2word's own
    // _p2wRenderAllVisuals uses, not a redundant render for every page.
    let canvas = null, pageHeightPt = pageData[i].pageH;
    if (blocks.some(b => b.type === 'image')) {
      const page = await pdfDoc.getPage(i + 1);
      const vp   = page.getViewport({ scale: RENDER_SCALE });
      canvas = document.createElement('canvas');
      canvas.width  = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    }

    for (const block of blocks) {
      contentEl.insertAdjacentHTML('beforeend', _blockHtml(block, canvas, RENDER_SCALE, pageHeightPt));
    }
    if (canvas) { canvas.width = 0; canvas.height = 0; }

    // Yield so the browser can paint what's already rendered — same idiom
    // compareUI's own per-page loop uses.
    await new Promise(r => setTimeout(r, 0));
  }

  pdfDoc.destroy();
  // _p2wBuildPageData()'s own internal setProgress() calls leave the shared
  // progress bar showing its last "Reading page N/M…" label indefinitely —
  // clear it now that the whole reading view has actually finished
  // rendering, not just the extraction pass.
  hideProgress();
}

// ── Password prompt (mirrors compareUI's own, same container-repaint shape) ─

function _promptPassword(filename, reason, onSubmit, onCancel) {
  const container = id('readOptions');
  if (!container) { onCancel(); return; }
  const isRetry   = reason === 2;
  const shortName = filename.length > 32 ? filename.slice(0, 29) + '…' : filename;

  container.innerHTML = `
    <div style="padding:24px 20px;border:1px solid var(--border);border-radius:12px;
      background:var(--surface);max-width:380px;margin:0 auto;text-align:center;">
      <div style="font-size:28px;margin-bottom:10px;">🔒</div>
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:var(--text);">${esc(t('read_password_title'))}</p>
      <p style="margin:0 0 16px;font-size:12px;color:var(--text2);word-break:break-all;">${esc(shortName)}</p>
      ${isRetry ? `
        <div style="margin:0 0 14px;padding:8px 10px;background:#fef2f2;
          border:1px solid #fecaca;border-radius:6px;font-size:13px;color:#dc2626;">
          ${esc(t('read_password_retry'))}
        </div>` : ''}
      <input id="readPwInput" type="password" placeholder="${esc(t('read_password_placeholder'))}" autocomplete="current-password"
        style="width:100%;box-sizing:border-box;padding:9px 12px;margin-bottom:12px;
          border:1px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit;
          background:var(--bg);color:var(--text);outline:none;text-align:left;">
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="readPwCancel" type="button" style="padding:8px 16px;border:1px solid var(--border);
          border-radius:8px;background:var(--bg);color:var(--text);font-size:13px;font-weight:600;
          cursor:pointer;font-family:inherit;">${esc(t('read_cancel'))}</button>
        <button id="readPwOpen" type="button" style="padding:8px 16px;border:none;border-radius:8px;
          background:var(--green);color:#fff;font-size:13px;font-weight:600;
          cursor:pointer;font-family:inherit;">${esc(t('read_password_open'))}</button>
      </div>
    </div>`;

  const input = container.querySelector('#readPwInput');
  input.focus();
  const submit = () => { const pw = input.value; if (!pw) { input.focus(); return; } onSubmit(pw); };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  container.querySelector('#readPwOpen').addEventListener('click', submit);
  container.querySelector('#readPwCancel').addEventListener('click', onCancel);
}

// ── Reading-view shell + controls ───────────────────────────────────────────

function _renderShell(container) {
  container.innerHTML = `
    <div id="readView" style="max-width:640px;margin:0 auto;">
      <div style="position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;
        padding:10px 4px;margin-bottom:8px;background:var(--bg);border-bottom:1px solid var(--border);">
        <label for="readFontSlider" style="font-size:12px;color:var(--text2);white-space:nowrap;">${esc(t('read_font_size'))}</label>
        <input id="readFontSlider" type="range" min="0.85" max="2" step="0.05" value="${_fontScale}"
          style="flex:1;min-height:44px;">
      </div>
      <div id="readContent" style="font-size:${_fontScale}rem;line-height:1.6;color:var(--text);
        padding:4px 4px 40px;word-wrap:break-word;overflow-wrap:break-word;"></div>
    </div>`;

  container.querySelector('#readFontSlider').addEventListener('input', e => {
    _fontScale = parseFloat(e.target.value);
    const contentEl = container.querySelector('#readContent');
    if (contentEl) contentEl.style.fontSize = `${_fontScale}rem`;
  });
}

// ── Block → HTML ─────────────────────────────────────────────────────────

function _blockHtml(block, canvas, scale, pageHeightPt) {
  const styleFor = (bold, italic) =>
    `${bold ? 'font-weight:700;' : ''}${italic ? 'font-style:italic;' : ''}`;

  switch (block.type) {
    case 'heading':
      return `<h2 style="margin:1.2em 0 .5em;font-size:1.3em;line-height:1.3;${styleFor(block.bold, block.italic)}">${esc(block.text)}</h2>`;

    case 'list-item':
      // Numbered items already carry their own marker text ("1.", "2.5.1.")
      // — no extra bullet glyph needed. Bullet/lettered items had their
      // marker stripped in js/processor.js, so they get a CSS bullet here.
      return `<div style="display:flex;gap:.5em;margin:.4em 0;padding-left:.2em;">
        ${block.ordinal === 'number' ? '' : '<span aria-hidden="true">•</span>'}
        <span style="${styleFor(block.bold, block.italic)}">${esc(block.text)}</span>
      </div>`;

    case 'paragraph':
      return `<p style="margin:0 0 1em;${styleFor(block.bold, block.italic)}">${esc(block.text)}</p>`;

    case 'table': {
      const rows = block.rows.map(row => `<tr>${
        row.map(cell => `<td colspan="${cell.span}" style="border:1px solid var(--border);padding:6px 8px;
          ${cell.bold ? 'font-weight:700;' : ''}vertical-align:top;">${esc(cell.text)}</td>`).join('')
      }</tr>`).join('');
      return `<div style="overflow-x:auto;margin:1em 0;">
        <table style="border-collapse:collapse;width:100%;font-size:.85em;">${rows}</table>
      </div>`;
    }

    case 'image': {
      if (!canvas || !block.region) return '';
      const { x0, x1, y0, y1 } = block.region;
      const xPx = Math.round(x0 * scale);
      const yPx = Math.round((pageHeightPt - y0) * scale);
      const wPx = Math.round((x1 - x0) * scale);
      const hPx = Math.round((y0 - y1) * scale);
      const dataUrl = _p2pCropCanvasRegion(canvas, xPx, yPx, wPx, hPx);
      if (!dataUrl) return '';
      return `<div style="margin:1em 0;text-align:center;">
        <img src="${dataUrl}" alt="" style="max-width:100%;height:auto;border-radius:4px;">
      </div>`;
    }

    default:
      return '';
  }
}

// ── Empty / loading / error states ──────────────────────────────────────────

function _loadingHtml() {
  return `<div style="padding:14px 16px;border:1px solid var(--border);border-radius:10px;
    background:var(--surface);font-size:13px;color:var(--text2);">${esc(t('read_loading'))}</div>`;
}

function _emptyStateHtml() {
  return `<div style="padding:20px 18px;border:1px solid var(--border);border-radius:10px;
    background:var(--surface);text-align:center;">
    <div style="font-size:28px;margin-bottom:8px;">📄</div>
    <p style="margin:0 0 10px;font-size:14px;color:var(--text);font-weight:600;">${esc(t('read_no_text_title'))}</p>
    <p style="margin:0 0 14px;font-size:13px;color:var(--text2);">${esc(t('read_no_text_desc'))}</p>
    <a href="/ocr-pdf/" style="display:inline-block;padding:9px 18px;border-radius:8px;
      background:var(--green);color:#fff;font-size:13px;font-weight:600;text-decoration:none;">${esc(t('read_try_ocr'))}</a>
  </div>`;
}

function _errorHtml(msg) {
  return `<div style="padding:14px 16px;border:1px solid var(--border);border-radius:10px;
    background:var(--surface);font-size:13px;color:var(--text2);">
    ${esc(t('read_error'))}${msg ? `<br><span style="color:var(--text3);font-size:12px;">${esc(msg)}</span>` : ''}
  </div>`;
}
