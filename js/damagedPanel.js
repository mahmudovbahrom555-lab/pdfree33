// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  damagedPanel.js — what a tool's options panel shows when it can't open
//  the file it was given (2026-10-14, nightly robustness run).
//
//  Split, Extract and PDF to JPG list a document's pages before anything
//  runs. On a damaged file the list never came, the panel showed the
//  engine's raw message, and the process button — left enabled — answered
//  "Please select at least one page": true, and useless. Now:
//    - not a PDF at all → nothing here: files.js's preflight already said so
//      and removed the file;
//    - damaged → the plain damaged-file text and a "Repair the file" button
//      (js/repairPdf.js); repaired bytes land in file._decryptedBuffer and
//      the panel opens again on them.
// ============================================================

import { esc } from './utils.js';
import { t } from './i18n.js';
import { showToast } from './ui.js';
import { wasRejectedAsNotPdf, isReadable } from './files.js';
import { trackToolError } from './analytics.js';

/**
 * @param {HTMLElement} container the tool's options panel
 * @param {File[]} files
 * @param {() => void} reopen  called after a successful repair
 * @param {string} tool        for the error report a tap on "nothing to repair" opens
 */
export async function showDamaged(container, files, reopen, tool) {
  if (await wasRejectedAsNotPdf(files)) { container.innerHTML = ''; container.style.display = 'none'; return; }
  // pdf.js itself never loaded (the connection dropped before its code arrived,
  // and it wasn't cached yet): the file was never read, so it is not the
  // problem. "This PDF has an unusual or corrupted structure" blamed a good
  // file for it (reproduced on Split offline, 2026-11-11). Say why, try again.
  // The file itself can't be read any more (an Android pick whose permission
  // lapsed, a cloud file not on the device): it may be perfectly fine — say so.
  const unreadable = [];
  for (const f of files) if (f && typeof f.slice === 'function' && !f._decryptedBuffer && !(await isReadable(f))) unreadable.push(f);
  if (unreadable.length) {
    trackToolError(tool, 'file_unreadable');
    container.style.display = '';
    container.innerHTML = `
      <div class="compress-scan compress-scan--found" role="alert">${esc(t('err_file_unreadable', { name: unreadable[0].name }))}</div>`;
    return;
  }
  if (typeof window !== 'undefined' && !window.pdfjsLib) {
    trackToolError(tool, 'pdfjs_load_failed');
    container.style.display = '';
    container.innerHTML = `
      <div class="compress-scan compress-scan--found" role="alert">
        ${esc(t('err_worker_load'))}
        <button type="button" class="split-range__apply" style="margin-top:8px">${esc(t('retry'))}</button>
      </div>`;
    container.querySelector('button').addEventListener('click', () => reopen());
    return;
  }
  container.style.display = '';
  container.innerHTML = `
    <div class="compress-scan compress-scan--found" role="alert">
      ${esc(t('err_encrypted_pdf'))}
      <button type="button" class="split-range__apply" style="margin-top:8px">${esc(t('repair_button'))}</button>
    </div>`;
  const btn = container.querySelector('button');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = t('repair_working');
    const { repairFiles } = await import('./repairPdf.js');
    if (await repairFiles(files)) { reopen(); return; }
    // feedback.js loaded on use: it touches the DOM at import, and this module
    // sits under pdf2jpgUI.js, which Node tests import
    showToast(t('repair_nothing'), 8000, async () => (await import('./feedback.js')).openFeedback('error', { tool, message: t('err_encrypted_pdf') }));
    btn.disabled = false;
    btn.textContent = t('repair_button');
  });
}
