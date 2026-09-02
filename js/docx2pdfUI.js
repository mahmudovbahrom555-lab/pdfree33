// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 PDFree Contributors

import { id } from './utils.js';
import { t } from './i18n.js';

// No async pre-analysis needed (unlike pdf2mdUI.js's page-count read) —
// the actual .docx parsing IS the conversion work itself, done on
// process-click in js/docxToPdfCore.js, not worth duplicating here just
// to show a number. Golden-path: file-select + one click, no config
// (CLAUDE.md's Nielsen #7 rule) — this tool has no meaningful options.

export function getDocx2PdfParams() {
  return {};
}

export function initDocx2PdfOptions(file) {
  const el = id('docx2pdfOptions');
  if (!el) return;

  const name = file.name.length > 35 ? file.name.slice(0, 32) + '…' : file.name;
  el.innerHTML = `
    <div class="compress-info">
      <span class="compress-info__name" title="${_esc(file.name)}">${_esc(name)}</span>
      <span class="compress-info__dot">·</span>
      <span class="compress-info__meta">${t('d2p_output_label')}</span>
    </div>
    <div class="compress-scan compress-scan--ok" role="status" aria-live="polite" style="margin-top:8px">
      ${t('d2p_mode_hint')}
    </div>
  `;
  el.style.display = '';
}

export function hideDocx2PdfOptions() {
  const el = id('docx2pdfOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
}

function _esc(str) {
  const d = document.createElement('div'); d.textContent = str; return d.innerHTML.replace(/"/g, '&quot;');
}
