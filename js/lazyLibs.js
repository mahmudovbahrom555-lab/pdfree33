// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Lazy script loader — loads CDN libraries on demand (not on page load).
// Handles both SPA (home page preloads them) and direct landing (no preload).

// Subresource Integrity, sitewide: every loader below pins `integrity` (sha384)
// alongside its URL. CSP's script-src allowlists these CDN domains, but that
// only restricts WHERE a script may load from — it does nothing to stop a
// compromised CDN from serving different bytes at an already-allowlisted URL,
// which would then run with full access to whatever file the user is
// currently processing (this app's core "never uploads" privacy promise
// protects the network path, not a compromised script's DOM access). SRI
// closes that gap: the browser refuses to execute anything that doesn't hash
// to the exact bytes pinned here. Every hash below was computed by curling
// the real, exact pinned-version URL and hashing the response — not copied
// from an unverified source.

import { t } from './i18n.js';

const _promises = {};

function _load(key, url, integrity) {
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
    if (integrity) { s.integrity = integrity; s.crossOrigin = 'anonymous'; }
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
  return _load(
    'pdfLib',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',
    'sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI',
  );
}

export function loadJSZip() {
  if (window.JSZip) return Promise.resolve();
  return _load(
    'jsZip',
    'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG',
  );
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
  // jsdelivr and unpkg both mirror the same npm tarball for a pinned version —
  // verified byte-identical (same sha384) at the time this hash was computed,
  // so both fallback URLs share one integrity value.
  const DOCX_SRI = 'sha384-4xaIisuLEy2lo2HkB2C4rEf7v8jbTb2kuogX6TkuEt9feTWKBSFSOzsqNNbV+sKh';
  const CDNS = [
    'https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js',
    'https://unpkg.com/docx@8.5.0/build/index.umd.js',
  ];
  for (const url of CDNS) {
    try {
      await new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${url}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src         = url;
        s.integrity   = DOCX_SRI;
        s.crossOrigin = 'anonymous';
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
  // Same jsdelivr/unpkg byte-identical verification as docx above.
  const EXCELJS_SRI = 'sha384-Pqp51FUN2/qzfxZxBCtF0stpc9ONI6MYZpVqmo8m20SoaQCzf+arZvACkLkirlPz';
  const CDNS = [
    'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js',
    'https://unpkg.com/exceljs@4.4.0/dist/exceljs.min.js',
  ];
  for (const url of CDNS) {
    try {
      await new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${url}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src         = url;
        s.integrity   = EXCELJS_SRI;
        s.crossOrigin = 'anonymous';
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
  // Same jsdelivr/unpkg byte-identical verification as docx/exceljs above.
  const PPTXGENJS_SRI = 'sha384-MKtHyQQnXtUFOKSavqQmtt5Qvk6cGeMJekOw28rk1RHMaEeFU5t0sG2KxvlG4Zue';
  const CDNS = [
    'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.min.js',
    'https://unpkg.com/pptxgenjs@3.12.0/dist/pptxgen.min.js',
  ];
  for (const url of CDNS) {
    try {
      await new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${url}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src         = url;
        s.integrity   = PPTXGENJS_SRI;
        s.crossOrigin = 'anonymous';
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
const OPENCV_SRI = 'sha384-zJHzYPWolUG4i2tYEdlq9VcmS1lGtE2r0o3EtIM+dGvmHjm0tC/DY1V1h+qSGXj9';

export function loadOpenCv() {
  if (window.cv?.Mat) return Promise.resolve();
  if (_promises['openCv']) return _promises['openCv'];

  _promises['openCv'] = new Promise((resolve, reject) => {
    window.Module = {
      onRuntimeInitialized: resolve,
    };
    const s = document.createElement('script');
    s.src         = OPENCV_URL;
    s.integrity   = OPENCV_SRI;
    s.crossOrigin = 'anonymous';
    s.onerror = () => reject(new Error('Failed to load openCv from CDN'));
    document.head.appendChild(s);
  }).catch(err => {
    delete _promises['openCv']; // allow a later call to actually retry
    delete window.Module;
    throw err;
  });
  return _promises['openCv'];
}

// @huggingface/transformers — generic loader for this project's two
// opt-in, client-side ML features: js/formulaOcr.js (pdf2md's Formula
// OCR, Texo/FormulaNet) and js/redactNer.js (Redact's AI Name
// Detection, bert-base-NER), both ONNX Runtime Web/WASM via the same
// library, just different models loaded by their own callers. Neither
// is ever loaded until its own opt-in toggle/button fires. Different
// from every other loader here: this CDN build ships real ESM named
// exports (verified directly via a live Playwright test — models
// loaded and ran correctly through this exact import), so a plain
// dynamic import() is used instead of the <script> tag + window-global
// pattern the other (UMD-style) libraries above need.
//
// Pinned to an exact version (was a floating `@3` major-version tag until
// this security pass — resolved to 3.8.1 at the time, verified via
// jsdelivr's own resolve API) for the same "never a moving latest alias"
// reason as every other loader here, and because a floating tag can't be
// integrity-checked at all (the bytes it serves are expected to change).
// KNOWN LIMITATION, not fixed here: native `<script integrity>` doesn't
// apply to dynamic import() — there's no standard SRI mechanism for ESM
// imports in browsers today, so this one URL is pinned-by-version but not
// hash-verified like the others. Lower baseline exposure than the others
// since both features gating this are opt-in, not loaded by default.
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

export function loadTransformersJs() {
  if (_promises['transformersJs']) return _promises['transformersJs'];
  _promises['transformersJs'] = import(/* webpackIgnore: true */ TRANSFORMERS_URL).catch(err => {
    delete _promises['transformersJs']; // allow a later call to actually retry
    throw new Error(`Failed to load ML engine: ${err.message}`);
  });
  return _promises['transformersJs'];
}
