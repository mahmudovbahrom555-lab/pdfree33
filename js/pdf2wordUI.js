// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

import { id } from './utils.js';
import { loadPdfJs } from './pdf2jpgUI.js';
import { preprocessPdfBuffer } from './decryptPdf.js';
import { chipGroup, group, loadingRow, row } from './uiComponents.js';

// ── State ─────────────────────────────────────────────────────────────────────
let _file      = null;
let _mode      = 'text';   // 'text' | 'image'
let _dpi       = 150;
let _pageCount = 0;
let _loading   = false;

export function getPdf2WordParams() {
  return { mode: _mode, dpi: _dpi, pageCount: _pageCount, loading: _loading };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function initPdf2WordOptions(file) {
  const el = id('pdf2wordOptions');
  if (!el) return;

  _file    = file;
  _loading = true;
  el.innerHTML   = loadingRow('Analysing PDF…');
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
    _loading   = false;
    _render(file);
  } catch (err) {
    _loading = false;
    el.innerHTML = `<div class="compress-scan compress-scan--found" role="alert">Cannot read PDF: ${_esc(err.message)}</div>`;
  }
}

export function hidePdf2WordOptions() {
  const el = id('pdf2wordOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  _file = null; _mode = 'text'; _dpi = 150; _pageCount = 0; _loading = false;
}

// ── Render ────────────────────────────────────────────────────────────────────

function _render(file) {
  const el = id('pdf2wordOptions');
  if (!el) return;

  const name = file.name.length > 35 ? file.name.slice(0, 32) + '…' : file.name;

  el.innerHTML = `
    <div class="compress-info">
      <span class="compress-info__name" title="${_esc(file.name)}">${name}</span>
      <span class="compress-info__dot">·</span>
      <span class="compress-info__meta">${_pageCount} page${_pageCount !== 1 ? 's' : ''}</span>
    </div>

    ${group('Output mode', chipGroup('p2wMode', [
      { value: 'text',  label: 'Text (editable)' },
      { value: 'image', label: 'Pages as images' },
    ], _mode, 'Conversion mode'))}

    <div id="p2wDpiRow" style="${_mode === 'image' ? '' : 'display:none'}">
      ${group('Resolution', chipGroup('p2wDpi', [
        { value: '72',  label: '72 dpi'  },
        { value: '150', label: '150 dpi' },
        { value: '300', label: '300 dpi' },
      ], String(_dpi), 'Image resolution for page rendering'))}
    </div>

    <div class="compress-scan compress-scan--ok" id="p2wHint" role="status" aria-live="polite">
      ${_hint()}
    </div>
  `;

  el.addEventListener('change', _onChange);
}

function _hint() {
  return _mode === 'text'
    ? '📄 Text mode — readable and editable in Word. Layout may differ for complex PDFs.'
    : '🖼️ Image mode — pixel-perfect visual copy. Text cannot be edited in Word.';
}

function _onChange(e) {
  if (e.target.name === 'p2wMode') {
    _mode = e.target.value;
    const dpiRow = id('p2wDpiRow');
    if (dpiRow) dpiRow.style.display = _mode === 'image' ? '' : 'none';
    const hint = id('p2wHint');
    if (hint) hint.textContent = _hint();
    document.querySelectorAll('[data-name="p2wMode"]').forEach(el => {
      el.classList.toggle('j2p-chip--active', el.dataset.value === _mode);
    });
  }
  if (e.target.name === 'p2wDpi') {
    _dpi = parseInt(e.target.value);
    document.querySelectorAll('[data-name="p2wDpi"]').forEach(el => {
      el.classList.toggle('j2p-chip--active', el.dataset.value === String(_dpi));
    });
  }
}

function _esc(str) {
  const d = document.createElement('div'); d.textContent = str; return d.innerHTML;
}
