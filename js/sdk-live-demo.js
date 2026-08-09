// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// sdk-live-demo.js — boots the live PDFree.create() widget on /pdf-sdk/.
// External file (not inline) because that page's CSP has no 'unsafe-inline'
// in script-src.
(function () {
  document.addEventListener('DOMContentLoaded', function () {
    if (!window.PDFree) return;
    window.PDFree.create({
      container: '#pdfree-live-demo',
      onComplete: function (r) {
        var el = document.getElementById('liveDemoStatus');
        if (el) el.textContent = 'Compressed "' + r.filename + '" — ' + (r.size / 1024).toFixed(0) + ' KB, entirely in your browser.';
      }
    });
  });
})();
