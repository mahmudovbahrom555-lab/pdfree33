// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

import { id } from './utils.js';
import { loadPdfJs } from './pdf2jpgUI.js';
import { preprocessPdfBuffer } from './decryptPdf.js';
import { group } from './uiComponents.js';

// ── Constants ─────────────────────────────────────────────────────────────────
// JPEG compression ratio at quality 0.85 over typical PDF content — same
// estimate pdf2wordUI.js uses for its image mode.
const JPEG_RATIO = 12;
const WARN_MB    = 80;
const DANGER_MB  = 200;

// ── State ─────────────────────────────────────────────────────────────────────
let _file      = null;
let _dpi       = 150;
let _pageCount = 0;
let _vpW       = 0;
let _vpH       = 0;
let _loading   = false;

export function getPdf2PptParams() {
  return { dpi: _dpi, pageCount: _pageCount, loading: _loading };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function initPdf2PptOptions(file) {
  const el = id('pdf2pptOptions');
  if (!el) return;

  _file    = file;
  _loading = true;
  el.innerHTML    = '<div class="compress-scan">Analysing PDF…</div>';
  el.style.display = '';

  try {
    await loadPdfJs();
    const rawBuf = file._decryptedBuffer
      ? file._decryptedBuffer.slice(0)
      : await preprocessPdfBuffer(await file.arrayBuffer());
    const doc = await window.pdfjsLib.getDocument({
      data:              new Uint8Array(rawBuf),
      useSystemFonts:    false,
      verbosity:         0,
      disableJavaScript: true,
    }).promise;

    _pageCount = doc.numPages;

    const firstPage = await doc.getPage(1);
    const vp        = firstPage.getViewport({ scale: 1 });
    _vpW = vp.width;
    _vpH = vp.height;
    firstPage.cleanup?.();

    _loading = false;
    _render(file);
  } catch (err) {
    _loading = false;
    el.innerHTML = `
      <div class="compress-scan compress-scan--found" role="alert">
        Cannot read PDF: ${_esc(err.message)}
      </div>`;
  }
}

export function hidePdf2PptOptions() {
  const el = id('pdf2pptOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  _file = null; _dpi = 150; _pageCount = 0; _vpW = 0; _vpH = 0; _loading = false;
}

// ── Size estimation ───────────────────────────────────────────────────────────
function _estimateMB(dpi) {
  if (!_vpW || !_vpH) return null;
  const scale = dpi / 72;
  const w     = _vpW * scale;
  const h     = _vpH * scale;
  return (w * h * 3 / JPEG_RATIO / 1024 / 1024) * _pageCount;
}

// ── Render ────────────────────────────────────────────────────────────────────

function _render(file) {
  const el = id('pdf2pptOptions');
  if (!el) return;

  const name = file.name.length > 35 ? file.name.slice(0, 32) + '…' : file.name;

  el.innerHTML = `
    <div class="compress-info">
      <span class="compress-info__name" title="${_esc(file.name)}">${name}</span>
      <span class="compress-info__dot">·</span>
      <span class="compress-info__meta">${_pageCount} page${_pageCount !== 1 ? 's' : ''} → ${_pageCount} slide${_pageCount !== 1 ? 's' : ''}</span>
    </div>

    ${group('Slide quality', `
      <div class="j2p-chips" role="group" aria-label="Slide image quality">
        ${_dpiChip('72',  'Compact',      '72',  _dpi)}
        ${_dpiChip('150', 'Balanced',     '150', _dpi, true)}
        ${_dpiChip('300', 'High quality', '300', _dpi)}
      </div>
    `)}
    <div id="p2pSizeHint" style="margin-top:8px">${_sizeHintHTML(_dpi)}</div>

    <div class="compress-scan compress-scan--ok" role="status" aria-live="polite" style="margin-top:8px">
      📽️ Each page becomes one full-slide image — a picture, not editable text, since that's the only layout-faithful way to turn an arbitrary PDF page into a slide.
    </div>
  `;

  el.removeEventListener('change', _onChange);
  el.addEventListener('change', _onChange);
}

function _dpiChip(value, label, display, current, recommended = false) {
  const active  = current === parseInt(value) ? ' j2p-chip--active' : '';
  const checked = current === parseInt(value) ? ' checked' : '';
  const badge   = recommended
    ? ' <span style="font-size:10px;opacity:.7;font-weight:600">★</span>'
    : '';
  return `<label class="j2p-chip${active}" data-value="${value}" data-name="p2pDpi">
    <input type="radio" name="p2pDpi" value="${value}"${checked}>
    ${label}${badge} <span style="opacity:.55;font-size:11px">${display} dpi</span>
  </label>`;
}

function _sizeHintHTML(dpi) {
  const mb = _estimateMB(dpi);
  if (!mb) return '';

  const mbStr = mb < 1 ? '<1' : Math.round(mb);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  if (mb >= DANGER_MB) {
    return `<div class="compress-scan compress-scan--found" style="margin:0" role="alert">
      ⚠️ Estimated .pptx: <strong>~${mbStr} MB</strong> — very large. Your browser may run out of memory. Try <strong>Compact</strong> quality.
      ${isSafari ? '<br><small>Safari may close the tab. Chrome or Firefox handle large files better.</small>' : ''}
    </div>`;
  }
  if (mb >= WARN_MB) {
    return `<div class="compress-scan" style="margin:0;background:rgba(200,130,0,.08);border:1px solid rgba(200,130,0,.3);border-radius:8px;padding:10px 12px;font-size:13px;color:var(--text2)">
      📦 Estimated .pptx: <strong>~${mbStr} MB</strong>${isSafari ? ' · Consider <strong>Compact</strong> on Safari' : ''}.
    </div>`;
  }
  return `<div style="font-size:12px;color:var(--text3);padding:4px 0">📦 Estimated .pptx: ~${mbStr} MB</div>`;
}

// ── Events ────────────────────────────────────────────────────────────────────

function _onChange(e) {
  if (e.target.name === 'p2pDpi') {
    _dpi = parseInt(e.target.value);
    document.querySelectorAll('[data-name="p2pDpi"]').forEach(el => {
      el.classList.toggle('j2p-chip--active', el.dataset.value === String(_dpi));
    });
    const sizeHint = id('p2pSizeHint');
    if (sizeHint) sizeHint.innerHTML = _sizeHintHTML(_dpi);
  }
}

function _esc(str) {
  const d = document.createElement('div'); d.textContent = str; return d.innerHTML.replace(/"/g, '&quot;');
}
