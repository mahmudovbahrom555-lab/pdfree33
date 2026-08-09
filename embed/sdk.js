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

  window.PDFree = { create };
})();
