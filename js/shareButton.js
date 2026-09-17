// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  shareButton.js — #shareBtn (Web Share API "Send") wiring
//
//  Extracted out of app.js's own _handleSuccess() into its own module
//  specifically so the 4 self-managed tools (ocr/compare/pdf2pdfa/read —
//  see SELF_MANAGED_TOOLS in app.js) can wire the same button too: those
//  tools bypass _handleSuccess() entirely (their own download UI, own
//  success events) and never got a Share button before this existed.
//  A plain `import { wireShareButton } from './app.js'` from any of those
//  4 files would create a real circular import (app.js already imports
//  toolRegistrations.js, which imports every one of those 4 tool UI
//  modules) — this file has no dependency back on app.js/toolRegistrations.js,
//  so every caller can import it directly with no cycle.
//
//  Icon-only button (no visible text label) — see css/components.css's
//  .share-btn rule for the sizing/contrast rationale.
// ============================================================

import { id } from './utils.js';
import { t } from './i18n.js';

// This module's OWN copy of "what to share" — deliberately separate from
// app.js's own _resultBlob/_resultFilename (which back ITS "Download
// again"/handoff flow, unused by the 4 self-managed tools). Two variables
// with a similar name in two files, not a bug — they track genuinely
// different things for genuinely different call sites.
let _resultBlob     = null;
let _resultFilename = 'document.pdf';

const _SHARE_ICON      = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>';
const _SHARE_ICON_SENT = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

// Real bug found+fixed 2026-09 (share_button_wrong_mime_probe_bug): every
// PDFree tool outputs a PDF, but pdf2word/pdf2excel/pdf2ppt/pdf2md output
// .docx/.xlsx/.pptx/.md, and canShare()'s shareable-type allowlist is not
// guaranteed to match across formats (Windows' native share sheet in
// particular filters by installed share targets per file type). Probing
// with the wrong type let the button appear on a browser that can share
// PDFs but not the tool's real output type — always probe with the REAL
// blob/filename, never a hardcoded guess.
function _canShareFiles(blob, filename) {
  if (!navigator.share || !navigator.canShare) return false;
  try {
    const testFile = new File([new Uint8Array(1)], filename || 'test.pdf', {
      type: (blob && blob.type) || 'application/pdf',
    });
    return navigator.canShare({ files: [testFile] });
  } catch { return false; }
}

async function _doShare(shareBtn) {
  if (!_resultBlob) return;

  try {
    const file = new File([_resultBlob], _resultFilename, {
      type: _resultBlob.type || 'application/pdf',
    });
    await navigator.share({ files: [file] });

    // User completed the share (didn't cancel) — icon-only button, so the
    // confirmation is a checkmark icon (not text) to match, with the
    // accessible name updated to match for screen-reader users.
    if (shareBtn) {
      shareBtn.disabled = true;
      shareBtn.innerHTML = _SHARE_ICON_SENT;
      shareBtn.setAttribute('aria-label', t('sent'));
      shareBtn.title = t('sent');
    }

  } catch (err) {
    // AbortError = user dismissed the share sheet — do nothing
    if (err.name !== 'AbortError') console.warn('[PDFree] Share failed:', err.message);
  }
}

/**
 * Wires a share button for a given result blob — shown only where the Web
 * Share API can actually share files of this MIME type. Call from any
 * tool's own success path once a real output blob + filename exist.
 * @param {Blob} blob
 * @param {string} filename
 * @param {string} [buttonId] defaults to the shared '#shareBtn' inside
 *   #successCard (every tool using the standard success flow). Pass a
 *   different id for a tool with its own custom completion UI outside
 *   #successCard (e.g. pdf2pdfa's own report/convert flow) — the button
 *   still needs to exist in the DOM already (a plain
 *   `<button class="share-btn">` is enough; this only wires behavior).
 */
export function wireShareButton(blob, filename, buttonId = 'shareBtn') {
  _resultBlob     = blob;
  _resultFilename = filename;
  const shareBtn = id(buttonId);
  if (!shareBtn) return;
  if (_canShareFiles(blob, filename)) {
    shareBtn.style.display = 'inline-flex';
    shareBtn.disabled      = false;
    shareBtn.innerHTML     = _SHARE_ICON;
    shareBtn.onclick       = () => _doShare(shareBtn);
    // No visible label (icon-only) — a native title tooltip is the only
    // on-hover/long-press signal for what this specific circle does, which
    // matters more than usual here: the page can also show a completely
    // different, separately-labeled "Share this tool" referral button
    // (shares a link to the TOOL, not the file — see app.js's own header
    // comment on that feature) in the same view. Two unlabeled-looking
    // "share" affordances side by side read as a duplicate/confusing UI —
    // a real user report — even though they do genuinely different things.
    if (!shareBtn.title) shareBtn.title = shareBtn.getAttribute('aria-label') || 'Send file via device apps';
  } else {
    shareBtn.style.display = 'none';
  }
}

/** Hides the share button and clears this module's blob reference (nothing left to share). */
export function resetShareButton(buttonId = 'shareBtn') {
  _resultBlob     = null;
  _resultFilename = 'document.pdf';
  const shareBtn = id(buttonId);
  if (shareBtn) shareBtn.style.display = 'none';
}
