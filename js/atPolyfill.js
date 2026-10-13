// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// .at() for arrays, strings and typed arrays where the browser lacks it
// (Chrome < 92, Safari < 15.4). pdf.js 3.11 calls it — 11 times in pdf.min.js,
// 34 in vendor/pdf.worker.min.js — and on such a browser Split and Manga
// Split failed with "t.at is not a function" (13 times in three days,
// Analytics Engine, 2026-10-13). Loaded before pdf.js on the page
// (pdf2jpgUI.js) and in its worker (pdfWorkerShim.js); a plain script, so
// both an ES import and importScripts can load it.
(function () {
  function at(n) {
    let i = Math.trunc(n) || 0;
    if (i < 0) i += this.length;
    return i < 0 || i >= this.length ? undefined : this[i];
  }
  for (const C of [Array, String, Object.getPrototypeOf(Int8Array)]) {
    if (C && C.prototype && !C.prototype.at) {
      Object.defineProperty(C.prototype, 'at', { value: at, writable: true, configurable: true });
    }
  }
})();
