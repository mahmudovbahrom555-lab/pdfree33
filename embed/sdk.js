// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  embed/sdk.js — PDFree Embed loader (MVP)
//
//  <script src="https://pdfree.io/embed/sdk.js"></script>
//  <div id="my-widget"></div>
//  <script>
//    PDFree.create({
//      container: '#my-widget',
//      onComplete: (result) => console.log(result.filename, result.size),
//    });
//  </script>
//
//  Deliberately minimal: only `tool: 'compress'` exists today (no
//  multi-tool checklist config — no dead code for tools that don't exist
//  yet), no API key / auth (validation-phase MVP, see
//  /Users/murodjon/.claude/plans/crystalline-munching-galaxy.md).
// ============================================================

(function () {
  function create({ container, tool = 'compress', height = 520, onReady, onComplete, onError } = {}) {
    const target = typeof container === 'string' ? document.querySelector(container) : container;
    if (!target) {
      console.error('[PDFree SDK] container not found:', container);
      return null;
    }

    const iframe = document.createElement('iframe');
    iframe.src = `https://pdfree.io/embed/${tool}/`;
    iframe.title = 'PDFree — ' + tool;
    iframe.style.cssText = `width:100%;height:${height}px;border:1px solid #e5e7eb;border-radius:12px;`;
    iframe.setAttribute('allow', '');
    // Defense-in-depth: this iframe's own content is first-party (our own
    // compress tool), but a future XSS bug there shouldn't be able to hijack
    // the EMBEDDER's top-level page or spam popups. allow-scripts +
    // allow-same-origin are both required (the tool's Web Worker needs
    // same-origin script resolution) and, combined, are a well-known
    // sandbox escape-hatch pair on their own — but neither grants
    // top-navigation or popups on its own, so omitting those tokens still
    // blocks exactly that scenario. allow-downloads is required for the
    // real "Download" button on a successful compress.
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-downloads allow-forms');

    window.addEventListener('message', (e) => {
      if (e.source !== iframe.contentWindow) return;
      const data = e.data || {};
      if (data.type === 'pdfree:ready') onReady?.();
      else if (data.type === 'pdfree:result') onComplete?.(data);
      else if (data.type === 'pdfree:error') onError?.(data);
    });

    target.appendChild(iframe);
    return iframe;
  }

  // Introspectable version marker — this file has no versioned URL path
  // (embedders hardcode a single .../embed/sdk.js), so this is the one way
  // to tell, from a bug report or support request, which behavior an
  // embedder is actually running. Bump on any change to the public
  // create()/postMessage contract, not on unrelated internal refactors.
  window.PDFree = { create, version: '1.0.0' };
})();
