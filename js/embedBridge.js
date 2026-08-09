// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  embedBridge.js — relays tool results to the parent window.
//
//  Only loaded on embed/*/index.html pages (inside a cross-origin
//  <iframe> created by embed/sdk.js) — never imported by the main site's
//  app.js/processor.js, so this has zero effect on the ~20 regular tool
//  pages. Hooks the *existing* 'pdfree:success' CustomEvent that
//  processor.js already dispatches for every tool (see _runCompress and
//  friends in js/processor.js) — no changes needed there.
//
//  targetOrigin '*' is deliberate for this open, unauthenticated MVP: the
//  message payload is the visitor's own file going back to their own
//  page, not a secret. Revisit once domain-locked API keys exist.
// ============================================================

window.parent.postMessage({ type: 'pdfree:ready' }, '*');

document.addEventListener('pdfree:success', (e) => {
  const { tool, blob, filename } = e.detail;
  window.parent.postMessage(
    { type: 'pdfree:result', tool, filename, size: blob.size, blob },
    '*'
  );
});
