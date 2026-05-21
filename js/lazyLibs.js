// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Lazy script loader — loads CDN libraries on demand (not on page load).
// Handles both SPA (home page preloads them) and direct landing (no preload).

const _promises = {};

function _load(key, url) {
  if (_promises[key]) return _promises[key];
  _promises[key] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload  = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${key} from CDN`));
    document.head.appendChild(s);
  });
  return _promises[key];
}

export function loadPdfLib() {
  if (window.PDFLib) return Promise.resolve();
  return _load('pdfLib', 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js');
}

export function loadJSZip() {
  if (window.JSZip) return Promise.resolve();
  return _load('jsZip', 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
}
