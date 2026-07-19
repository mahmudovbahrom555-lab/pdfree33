// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

import { id } from './utils.js';
import { loadPdfJs } from './pdf2jpgUI.js';
import { preprocessPdfBuffer } from './decryptPdf.js';

// ── State ─────────────────────────────────────────────────────────────────────
let _pageCount = 0;
let _loading   = false;

export function getPdf2MdParams() {
  return { pageCount: _pageCount, loading: _loading };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function initPdf2MdOptions(file) {
  const el = id('pdf2mdOptions');
  if (!el) return;

  _loading = true;
  el.innerHTML     = '<div class="compress-scan">Analysing PDF…</div>';
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
    el.innerHTML = `
      <div class="compress-scan compress-scan--found" role="alert">
        Cannot read PDF: ${_esc(err.message)}
      </div>`;
  }
}

export function hidePdf2MdOptions() {
  const el = id('pdf2mdOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  _pageCount = 0; _loading = false;
}

// ── Render ────────────────────────────────────────────────────────────────────

function _render(file) {
  const el = id('pdf2mdOptions');
  if (!el) return;

  const name = file.name.length > 35 ? file.name.slice(0, 32) + '…' : file.name;

  el.innerHTML = `
    <div class="compress-info">
      <span class="compress-info__name" title="${_esc(file.name)}">${name}</span>
      <span class="compress-info__dot">·</span>
      <span class="compress-info__meta">${_pageCount} page${_pageCount !== 1 ? 's' : ''} → 1 Markdown file</span>
    </div>

    <div class="compress-scan compress-scan--ok" role="status" aria-live="polite" style="margin-top:8px">
      📝 Headings, bullet/numbered lists and bold/italic text are detected automatically. Tables and images aren't converted — try PDF to Excel or PDF to Word for those.
    </div>
  `;
}

function _esc(str) {
  const d = document.createElement('div'); d.textContent = str; return d.innerHTML.replace(/"/g, '&quot;');
}
