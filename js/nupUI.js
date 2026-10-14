// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  nupUI.js — Pages per Sheet (N-up): options and a live preview
//
//  Three modes over one engine (js/nupLayout.js):
//    pages    — 2/4/6/9/16 pages per sheet, filling the cell
//    invoices — 2 or 4 documents to an A4 sheet at their real size, an
//               optional binding margin (发票合并打印: e-invoices printed
//               for expense reports)
//    booklet  — pages imposed for printing double-sided and folding in the
//               middle (Search Miss: "Booklet", "Make into a book")
//  Several PDFs make one stack, in list order (multiFile).
//
//  The preview draws the first sheet with the same layout() the worker
//  uses — page numbers in their real cells, the real sheet orientation.
// ============================================================

import { id }               from './utils.js';
import { showToast }        from './ui.js';
import { wasRejectedAsNotPdf } from './files.js';
import { chipGroup, checkbox, group, loadingRow, infoBanner } from './uiComponents.js';
import { loadPdfLib }       from './lazyLibs.js';
import { t }                from './i18n.js';
import { getLang }          from './config.js';
import './nupLayout.js';

const MM = 2.83465;
const PRESETS = {
  pages:    { margin: 18, gutter: 8,  maxScale: Infinity, counts: [2, 4, 6, 9, 16] },
  // real size (never enlarged), as an expense report wants them
  invoices: { margin: 14, gutter: 10, maxScale: 1,        counts: [2, 4] },
  // pages meet at the fold, no gutter; per sheet is always 2 + 2
  booklet:  { margin: 18, gutter: 0,  maxScale: Infinity, counts: [] },
};
const BINDING_PT = 30 * MM;   // the usual 30 mm left strip for punching/gluing

let _mode = 'pages', _perSheet = 2, _paper = 'a4', _orientation = 'auto', _order = 'row';
let _rtl = false, _border = false, _binding = false;
let _pages = [];        // [{ width, height, rotate }] of every selected file's pages
let _gen = 0;

export function getNupParams() {
  const p = PRESETS[_mode];
  return {
    perSheet: _perSheet, paper: _paper, orientation: _orientation, order: _order, rtl: _rtl,
    margin: p.margin, gutter: p.gutter, maxScale: p.maxScale, border: _border,
    marginLeft: _mode === 'invoices' && _binding ? p.margin + BINDING_PT : p.margin,
    booklet: _mode === 'booklet', mode: _mode,
  };
}

export async function initNupOptions(files) {
  const container = id('nupOptions');
  if (!container) return;
  const gen = ++_gen;
  container.innerHTML = loadingRow(t('rsz_loading'));
  container.style.display = 'block';
  if (_pages.length === 0) {
    // Right-to-left scripts read their pages right to left too
    _rtl = ['ar', 'fa', 'he', 'ur'].includes(getLang());
    _applyLinkParams();
  }

  try {
    await loadPdfLib();
    const { PDFDocument } = window.PDFLib;
    const pages = [];
    for (const file of files) {
      const doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
      if (gen !== _gen) return;
      for (const page of doc.getPages()) {
        let box;
        try { box = page.getCropBox(); } catch { box = { width: 595.28, height: 841.89 }; }
        pages.push({ width: box.width, height: box.height, rotate: page.getRotation().angle || 0 });
      }
    }
    if (gen !== _gen) return;
    if (!pages.length) { showToast(t('no_pages_pdf')); container.style.display = 'none'; return; }
    _pages = pages;
    _render(container);
  } catch {
    if (gen !== _gen) return;
    container.style.display = 'none';
    if (await wasRejectedAsNotPdf(files)) return;   // already told: not a PDF
    showToast(t('err_encrypted_pdf'), 6000);         // damaged — never the parser's raw text
  }
}

// Split Manga's "next step" opens this tool as a booklet, bound the way the
// manga reads: ?mode=booklet&rtl=1. Read once, then dropped from the URL so
// a reload or the next file starts from the defaults again.
function _applyLinkParams() {
  const q = new URLSearchParams(location.search);
  if (!q.has('mode') && !q.has('rtl')) return;
  if (PRESETS[q.get('mode')]) _mode = q.get('mode');
  if (q.has('rtl')) _rtl = q.get('rtl') === '1';
  history.replaceState(history.state, '', location.pathname + location.hash);
}

export function hideNupOptions() {
  _gen++;
  const container = id('nupOptions');
  if (container) { container.style.display = 'none'; container.innerHTML = ''; }
  _pages = [];
  _mode = 'pages'; _perSheet = 2; _paper = 'a4'; _orientation = 'auto'; _order = 'row';
  _border = false; _binding = false;
}

function _render(container) {
  const counts = PRESETS[_mode].counts;
  const booklet = _mode === 'booklet';
  if (counts.length && !counts.includes(_perSheet)) _perSheet = counts[0];
  container.innerHTML = `
    ${group(t('nup_mode'), chipGroup('nupMode', [
      { value: 'pages', label: t('nup_mode_pages') },
      { value: 'invoices', label: t('nup_mode_invoices') },
      { value: 'booklet', label: t('nup_mode_booklet') },
    ], _mode, t('nup_mode')))}
    ${_mode === 'invoices' ? infoBanner(t('nup_invoice_hint')) : ''}
    ${booklet ? infoBanner(t('nup_booklet_hint')) : ''}
    ${counts.length ? group(t('nup_per_sheet'), chipGroup('nupPerSheet', counts.map(n => ({ value: String(n), label: String(n) })), String(_perSheet), t('nup_per_sheet'))) : ''}
    ${group(t('rsz_paper_size'), chipGroup('nupPaper', [
      { value: 'a4', label: 'A4' }, { value: 'a3', label: 'A3' }, { value: 'letter', label: 'Letter' },
    ], _paper, t('rsz_paper_size')))}
    ${booklet ? '' : group(t('rsz_orientation'), chipGroup('nupOrientation', [
      { value: 'auto', label: t('j2p_orient_auto') },
      { value: 'portrait', label: t('j2p_orient_portrait') },
      { value: 'landscape', label: t('j2p_orient_landscape') },
    ], _orientation, t('rsz_orientation')))}
    ${booklet ? '' : group(t('nup_order'), chipGroup('nupOrder', [
      { value: 'row', label: t('nup_order_row') },
      { value: 'column', label: t('nup_order_column') },
    ], _order, t('nup_order')))}
    ${checkbox({ id: 'nupRtl', checked: _rtl, title: t('nup_rtl'), subtitle: t(booklet ? 'nup_booklet_rtl_sub' : 'nup_rtl_sub') })}
    ${checkbox({ id: 'nupBorder', checked: _border, title: t('nup_border') })}
    ${_mode === 'invoices' ? checkbox({ id: 'nupBinding', checked: _binding, title: t('nup_binding'), subtitle: t('nup_binding_sub') }) : ''}
    <div id="nupPreview" style="display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:14px;"></div>
    ${infoBanner(t('rsz_banner'))}`;

  container.querySelectorAll('input[type=radio]').forEach(input => input.addEventListener('change', () => {
    const v = input.value;
    if (input.name === 'nupMode') {
      _mode = v;
      _perSheet = PRESETS[v].counts[0] ?? _perSheet;
      // a booklet is always side by side on its sheet
      if (v === 'booklet') _orientation = 'auto';
      _border = false;
      _render(container);
      return;
    }
    if (input.name === 'nupPerSheet') _perSheet = Number(v);
    else if (input.name === 'nupPaper') _paper = v;
    else if (input.name === 'nupOrientation') _orientation = v;
    else if (input.name === 'nupOrder') _order = v;
    container.querySelectorAll(`label[data-name="${input.name}"]`).forEach(l =>
      l.classList.toggle('j2p-chip--active', l.dataset.value === v));
    _renderPreview();
  }));
  for (const [elId, set] of [
    ['nupRtl', v => { _rtl = v; }], ['nupBorder', v => { _border = v; }], ['nupBinding', v => { _binding = v; }],
  ]) {
    id(elId)?.addEventListener('change', e => { set(e.target.checked); _renderPreview(); });
  }
  _renderPreview();
}

// The first sheet as the worker will lay it out: page numbers in their
// cells — for a booklet both sides of the first sheet of paper (the cover
// spread and its back), since that is what the fold depends on.
function _renderPreview() {
  const el = id('nupPreview');
  if (!el || !_pages.length) return;
  let l;
  try { l = self.NupLayout.layout(_pages, getNupParams()); } catch { el.innerHTML = ''; return; }
  const booklet = _mode === 'booklet';
  const W = booklet ? 160 : 200, s = W / Math.max(l.width, l.height);
  const w = l.width * s, h = l.height * s;
  const sides = l.sheets.slice(0, booklet ? 2 : 1).map(sheet => _sheetSvg(sheet, w, h, s)).join('');
  const summary = booklet
    ? t('nup_booklet_summary', { pages: _pages.length, sheets: l.sheets.length / 2 })
    : t('nup_summary', { pages: _pages.length, sheets: l.sheets.length });
  el.innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;">${sides}</div>
    <div style="font-size:13px;color:var(--text2);">${summary}</div>`;
}

function _sheetSvg(sheet, w, h, s) {
  const boxes = sheet.map(({ page, box }) => {
    const x = box.x * s, y = h - (box.y + box.h) * s, bw = box.w * s, bh = box.h * s;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="var(--surface)" stroke="var(--border)"/>
      <text x="${(x + bw / 2).toFixed(1)}" y="${(y + bh / 2 + 5).toFixed(1)}" text-anchor="middle" font-size="14" fill="var(--text2)">${page + 1}</text>`;
  }).join('');
  const strip = _mode === 'invoices' && _binding
    ? `<line x1="${(BINDING_PT * s).toFixed(1)}" y1="4" x2="${(BINDING_PT * s).toFixed(1)}" y2="${(h - 4).toFixed(1)}" stroke="var(--border)" stroke-dasharray="3 3"/>`
    : _mode === 'booklet'   // the fold
      ? `<line x1="${(w / 2).toFixed(1)}" y1="2" x2="${(w / 2).toFixed(1)}" y2="${(h - 2).toFixed(1)}" stroke="var(--text3)" stroke-dasharray="3 3"/>` : '';
  return `
    <svg width="${w.toFixed(0)}" height="${h.toFixed(0)}" viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" role="img" aria-label="${t('nup_preview_alt')}">
      <rect x="0.5" y="0.5" width="${(w - 1).toFixed(1)}" height="${(h - 1).toFixed(1)}" fill="var(--bg)" stroke="var(--text3)"/>
      ${strip}${boxes}
    </svg>`;
}
