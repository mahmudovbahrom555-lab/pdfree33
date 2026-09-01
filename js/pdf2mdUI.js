// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

import { id } from './utils.js';
import { loadPdfJs } from './pdf2jpgUI.js';
import { preprocessPdfBuffer } from './decryptPdf.js';
import { t, tp } from './i18n.js';
import { getFormulaOcr, resetFormulaOcr, formulaOcrToggleHtml, bindFormulaOcr } from './formulaOcrToggle.js';

// ── State ─────────────────────────────────────────────────────────────────────
let _pageCount = 0;
let _loading   = false;

export function getPdf2MdParams() {
  return { pageCount: _pageCount, loading: _loading, enableFormulaOcr: getFormulaOcr() };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function initPdf2MdOptions(file) {
  const el = id('pdf2mdOptions');
  if (!el) return;

  _loading = true;
  el.innerHTML     = `<div class="compress-scan">${t('val_analysing_pdf')}</div>`;
  el.style.display = '';

  try {
    await loadPdfJs();
    const rawBuf = file._decryptedBuffer
      ? file._decryptedBuffer.slice(0)
      : await preprocessPdfBuffer(await file.arrayBuffer());
    const doc = await window.pdfjsLib.getDocument({ isEvalSupported: false,
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
        ${t('p2w_cannot_read', { msg: _esc(err.message) })}
      </div>`;
  }
}

export function hidePdf2MdOptions() {
  const el = id('pdf2mdOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  _pageCount = 0; _loading = false;
  resetFormulaOcr();
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
      <span class="compress-info__meta">${tp(_pageCount, 'split_info_page', 'split_info_pages', { n: _pageCount })} → ${t('p2m_one_markdown_file')}</span>
    </div>

    <div class="compress-scan compress-scan--ok" role="status" aria-live="polite" style="margin-top:8px">
      ${t('p2m_mode_hint')}
    </div>

    <div style="margin-top:10px">${formulaOcrToggleHtml()}</div>
  `;
  bindFormulaOcr();
}

function _esc(str) {
  const d = document.createElement('div'); d.textContent = str; return d.innerHTML.replace(/"/g, '&quot;');
}
