// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Lazy script loader — loads CDN libraries on demand (not on page load).
// Handles both SPA (home page preloads them) and direct landing (no preload).

import { t } from './i18n.js';

const _promises = {};

function _load(key, url) {
  if (_promises[key]) return _promises[key];
  // Real bug found during the 2026-08-20/21 Lazy-Load audit: a rejected
  // promise used to stay cached in _promises[key] FOREVER — one transient
  // CDN hiccup (network blip, momentary CDN outage) permanently broke this
  // loader for the rest of the page session, since every later call just
  // returned the same already-rejected promise instead of trying again.
  // loadDocx/loadExcelJs/loadPptxGenJs below already clear their cache on
  // failure; this shared helper (used by loadPdfLib/loadJSZip) didn't.
  _promises[key] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload  = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${key} from CDN`));
    document.head.appendChild(s);
  }).catch(err => {
    delete _promises[key]; // allow a later call to actually retry, not replay this same failure
    throw err;
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

// docx uses a two-URL fallback chain (jsdelivr → unpkg).
// If the first CDN is down/slow, the second is tried automatically.
// On total failure the cached promise is cleared so the NEXT user
// action retries from scratch rather than hitting a dead cached promise.
export function loadDocx() {
  if (window.docx) return Promise.resolve();
  if (_promises['docx']) return _promises['docx'];

  _promises['docx'] = _loadDocxWithFallback().catch(err => {
    delete _promises['docx'];  // allow retry on next call
    throw err;
  });
  return _promises['docx'];
}

async function _loadDocxWithFallback() {
  const CDNS = [
    'https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js',
    'https://unpkg.com/docx@8.5.0/build/index.umd.js',
  ];
  for (const url of CDNS) {
    try {
      await new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${url}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src     = url;
        s.onload  = resolve;
        s.onerror = () => reject(new Error(`CDN unavailable: ${url}`));
        document.head.appendChild(s);
      });
      if (window.docx) return;
    } catch (_) { /* try next */ }
  }
  throw new Error(t('err_cdn_lib_unavailable', { lib: 'Word' }));
}

// Same two-URL fallback pattern as loadDocx() — see comment above.
export function loadExcelJs() {
  if (window.ExcelJS) return Promise.resolve();
  if (_promises['excelJs']) return _promises['excelJs'];

  _promises['excelJs'] = _loadExcelJsWithFallback().catch(err => {
    delete _promises['excelJs'];
    throw err;
  });
  return _promises['excelJs'];
}

async function _loadExcelJsWithFallback() {
  const CDNS = [
    'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js',
    'https://unpkg.com/exceljs@4.4.0/dist/exceljs.min.js',
  ];
  for (const url of CDNS) {
    try {
      await new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${url}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src     = url;
        s.onload  = resolve;
        s.onerror = () => reject(new Error(`CDN unavailable: ${url}`));
        document.head.appendChild(s);
      });
      if (window.ExcelJS) return;
    } catch (_) { /* try next */ }
  }
  throw new Error(t('err_cdn_lib_unavailable', { lib: 'Excel' }));
}

// Same two-URL fallback pattern as loadDocx()/loadExcelJs() — see comment above
// loadDocx(). Unlike those two, pptxgenjs's browser build does NOT bundle its
// own JSZip — it expects window.JSZip to already exist, so loadJSZip() (already
// used elsewhere for merge/split zip output) runs first as a prerequisite.
export function loadPptxGenJs() {
  if (window.PptxGenJS) return Promise.resolve();
  if (_promises['pptxGenJs']) return _promises['pptxGenJs'];

  _promises['pptxGenJs'] = _loadPptxGenJsWithFallback().catch(err => {
    delete _promises['pptxGenJs'];
    throw err;
  });
  return _promises['pptxGenJs'];
}

async function _loadPptxGenJsWithFallback() {
  await loadJSZip();
  const CDNS = [
    'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.min.js',
    'https://unpkg.com/pptxgenjs@3.12.0/dist/pptxgen.min.js',
  ];
  for (const url of CDNS) {
    try {
      await new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${url}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src     = url;
        s.onload  = resolve;
        s.onerror = () => reject(new Error(`CDN unavailable: ${url}`));
        document.head.appendChild(s);
      });
      if (window.PptxGenJS) return;
    } catch (_) { /* try next */ }
  }
  throw new Error(t('err_cdn_lib_unavailable', { lib: 'PowerPoint' }));
}

// OpenCV.js — used by js/scanGeometry.js for the jpg2pdf live-camera
// scan flow (document-quad detection + perspective warp). Only ever
// loaded when that flow actually opens — costs nothing for every
// other page/tool. Pinned version (verified live via curl before
// adding: https://docs.opencv.org/4.9.0/opencv.js returns 200,
// ~9.8MB; 4.10.0 404s) — same "never a moving latest alias" policy as
// every other CDN lib in this file.
//
// Different from every other loader here: OpenCV's Emscripten runtime
// checks for a PRE-EXISTING global `Module` object with an
// onRuntimeInitialized callback — the <script> tag's own `onload`
// firing only means the JS downloaded, not that the WASM runtime has
// actually finished initializing (cv.Mat/cv.Canny/etc. would still be
// unavailable). `Module` must be set up BEFORE the script is created.
const OPENCV_URL = 'https://docs.opencv.org/4.9.0/opencv.js';

export function loadOpenCv() {
  if (window.cv?.Mat) return Promise.resolve();
  if (_promises['openCv']) return _promises['openCv'];

  _promises['openCv'] = new Promise((resolve, reject) => {
    window.Module = {
      onRuntimeInitialized: resolve,
    };
    const s = document.createElement('script');
    s.src     = OPENCV_URL;
    s.onerror = () => reject(new Error('Failed to load openCv from CDN'));
    document.head.appendChild(s);
  }).catch(err => {
    delete _promises['openCv']; // allow a later call to actually retry
    delete window.Module;
    throw err;
  });
  return _promises['openCv'];
}
