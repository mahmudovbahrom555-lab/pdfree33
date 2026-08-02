// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  pdf2pdfaUI.js — "Check PDF/A compliance" (analysis only)
//
//  Self-managed tool (see SELF_MANAGED_TOOLS in app.js): no runner,
//  no doProcess. Analysis runs automatically as soon as a file is
//  selected. The generic mergeBtn is hidden entirely — this tool
//  drives its own "Convert" button and download link instead of
//  the standard successCard flow, since it's a read-mostly report
//  UI, not a file-in/file-out form.
//
//  Unlike other tools, this one has no dedicated "#pdf2pdfaOptions"
//  container in any of the 14 homepage HTML files or the standalone
//  tool-page template — it creates its own, inserted right before
//  #mergeBtn (same insertion technique as the search-candidates list
//  in app.js). This avoids having to touch every locale's index.html
//  for what is, for now, an English-only MVP tool (see config.js).
//
//  Phase 2: conversion writes an ICC OutputIntent + XMP metadata via
//  pdfaWorker.js. The worker independently re-checks compliance
//  before writing anything, so a stale report in this UI can't
//  produce a silently-broken output file.
// ============================================================

import { id, esc } from './utils.js';
import { analyzePdfA, convertToPdfA } from './pdfaAnalyze.js';
import { selectedFiles } from './files.js';

// files.js only dispatches 'pdfree:file-removed' when files remain after the
// removal (deliberately — see commit 63de885, scoped to the "stale file[0]
// reference" bug). Removing the LAST file fires no event at all, so without
// this observer the report from the just-removed file (and the hidden
// mergeBtn) would stay stranded on screen. A fresh file drop afterwards
// recovers fine either way; this just covers the in-between empty state.
// Scoped to #fileList (not shared files.js) to keep the fix local to this
// tool rather than widening a deliberately-narrow shared event contract.
let _emptyObserver = null;
function _watchForEmpty() {
  const list = id('fileList');
  if (!list || _emptyObserver) return;
  _emptyObserver = new MutationObserver(() => {
    if (selectedFiles.length === 0) hidePdf2PdfaOptions();
  });
  _emptyObserver.observe(list, { childList: true });
}
function _unwatch() {
  _emptyObserver?.disconnect();
  _emptyObserver = null;
}

let _file = null;
let _gen  = 0; // guards against a stale analysis resolving after a newer file was dropped

function _ensureContainer() {
  let c = id('pdf2pdfaOptions');
  if (c) return c;
  const btn = id('mergeBtn');
  if (!btn) return null;
  c = document.createElement('div');
  c.id = 'pdf2pdfaOptions';
  c.className = 'j2p-options';
  c.setAttribute('aria-label', 'PDF/A compliance report');
  btn.insertAdjacentElement('beforebegin', c);
  return c;
}

export async function initPdf2PdfaOptions(file) {
  const c = _ensureContainer();
  if (!c) return;
  c.style.display = '';
  _file = file;
  _watchForEmpty();

  const btn = id('mergeBtn');
  if (btn) btn.style.display = 'none';

  const myGen = ++_gen;
  c.innerHTML = _loadingHtml();

  let result;
  try {
    result = await analyzePdfA(file);
  } catch (err) {
    if (myGen !== _gen) return;
    c.innerHTML = _errorHtml(err?.message);
    return;
  }
  if (myGen !== _gen) return;
  c.innerHTML = _reportHtml(result);
  _bindConvertBtn(myGen);
}

function _bindConvertBtn(myGen) {
  const btn = id('pdf2pdfaConvertBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!_file || myGen !== _gen) return;
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Converting…';

    let result;
    try {
      result = await convertToPdfA(_file);
    } catch (err) {
      if (myGen !== _gen) return;
      btn.disabled = false;
      btn.textContent = originalLabel;
      const statusEl = id('pdf2pdfaConvertStatus');
      if (statusEl) statusEl.textContent = 'Conversion failed' + (err?.message ? ': ' + err.message : '.');
      return;
    }
    if (myGen !== _gen) return;

    if (result.blocked) {
      // Worker's own re-check disagreed with what this UI showed (e.g. the
      // file changed on disk between analyze and convert) — re-render the
      // fresh report rather than silently failing.
      const c = id('pdf2pdfaOptions');
      if (c) { c.innerHTML = _reportHtml(result.report); _bindConvertBtn(myGen); }
      return;
    }

    _triggerDownload(_file, result.fileBytes);
    btn.disabled = false;
    btn.textContent = originalLabel;
    const statusEl = id('pdf2pdfaConvertStatus');
    if (statusEl) {
      statusEl.textContent = result.audit.passed
        ? '✓ Converted — self-check confirmed the OutputIntent and XMP markers in the downloaded file.'
        : '⚠ Converted, but the self-check could not confirm all markers in the output file — verify with a dedicated PDF/A validator before relying on this file.';
    }
  });
}

function _triggerDownload(sourceFile, fileBytes) {
  const blob = new Blob([fileBytes], { type: 'application/pdf' });
  const url  = URL.createObjectURL(blob);
  const name = sourceFile.name.replace(/\.pdf$/i, '') + '-pdfa.pdf';
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function hidePdf2PdfaOptions() {
  _gen++; // invalidate any in-flight analysis
  _file = null;
  _unwatch();
  const c = id('pdf2pdfaOptions');
  if (c) { c.style.display = 'none'; c.innerHTML = ''; }
  const btn = id('mergeBtn');
  if (btn) btn.style.display = '';
}

function _loadingHtml() {
  return `<div style="padding:14px 0;color:var(--text2);font-size:14px;">Analyzing PDF/A-2b compliance…</div>`;
}

function _errorHtml(message) {
  return `<div style="padding:12px 14px;background:var(--red-light,#fdecea);border:1px solid rgba(200,40,40,.2);
    border-radius:10px;color:var(--red,#c0392b);font-size:13px;">
    Could not analyze this file${message ? ': ' + esc(message) : '.'}
  </div>`;
}

function _row(ok, label, detail) {
  const icon  = ok ? '✓' : '✗';
  const color = ok ? 'var(--green,#2d7a4f)' : 'var(--red,#c0392b)';
  return `<div style="display:flex;gap:8px;align-items:flex-start;padding:6px 0;font-size:13px;">
    <span style="color:${color};font-weight:700;flex-shrink:0;">${icon}</span>
    <span style="color:var(--text);">${esc(label)}${detail ? `<br><span style="color:var(--text2);font-size:12px;">${detail}</span>` : ''}</span>
  </div>`;
}

function _reportHtml(r) {
  const rows = [];

  rows.push(_row(!r.encrypted, 'No password / encryption',
    r.encrypted ? 'Remove the password first, then re-check.' : null));

  rows.push(_row(r.missingFonts.length === 0, 'All fonts embedded',
    r.missingFonts.length
      ? `Not embedded: ${r.missingFonts.slice(0, 5).map(esc).join(', ')}${r.missingFonts.length > 5 ? '…' : ''}`
      : null));

  const forbiddenLabels = { openAction: 'a document open action', aa: 'document-level actions', javascript: 'embedded JavaScript' };
  rows.push(_row(r.forbidden.length === 0, 'No interactive actions or scripts',
    r.forbidden.length
      ? `Found: ${r.forbidden.map(k => forbiddenLabels[k] || k).join(', ')}`
      : null));

  rows.push(_row(!r.hasLzw, 'No LZW-compressed streams',
    r.hasLzw ? 'PDF/A does not permit the LZWDecode filter.' : null));

  const verdict = r.compliant
    ? `<div style="margin-top:10px;padding:10px 14px;background:var(--green-light);border:1px solid rgba(45,122,79,.18);
        border-radius:10px;color:var(--green);font-size:13px;font-weight:600;">
        ✓ This PDF meets the structural requirements for PDF/A-2b.
      </div>
      <button id="pdf2pdfaConvertBtn" type="button" style="margin-top:10px;padding:10px 18px;background:var(--green,#2d7a4f);
        color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;">
        📐 Convert to PDF/A-2b
      </button>
      <div id="pdf2pdfaConvertStatus" style="margin-top:8px;font-size:12px;color:var(--text2);"></div>`
    : `<div style="margin-top:10px;padding:10px 14px;background:var(--yellow-light,#fef8e7);border:1px solid rgba(202,138,4,.25);
        border-radius:10px;color:#8a6d1a;font-size:13px;font-weight:600;">
        This PDF is not PDF/A-2b compliant yet — see the issues above.
      </div>`;

  return `<div style="padding:10px 0 4px;">
    ${rows.join('')}
    ${verdict}
    <p style="margin:12px 0 0;font-size:11px;color:var(--text2);line-height:1.5;">
      This is a self-check of the structural requirements most likely to fail, run entirely in your browser.
      It is not a substitute for a full ISO 19005 validator (e.g. veraPDF) for legally mandated archiving.
    </p>
  </div>`;
}
