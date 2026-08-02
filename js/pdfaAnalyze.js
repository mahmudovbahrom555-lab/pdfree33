// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  pdfaAnalyze.js — Main-thread coordinator for PDF/A analysis
//
//  Architecture:
//    • Main-thread only (not for use inside worker.js)
//    • Communicates with js/pdfaWorker.js via postMessage
//    • Same request/response pattern as decryptPdf.js + qpdf worker
// ============================================================

const _WORKER_URL = new URL('./pdfaWorker.js', import.meta.url).href;

let _worker      = null;
let _nextId      = 1;
const _pending   = new Map();

function _ensureWorker() {
  if (_worker) return;
  _worker = new Worker(_WORKER_URL);

  _worker.onmessage = (e) => {
    const msg   = e.data || {};
    const entry = _pending.get(msg.id);
    if (!entry) return;
    _pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else        entry.reject(new Error(msg.message || 'PDF/A analysis failed'));
  };

  _worker.onerror = (e) => {
    const err = new Error(e.message || 'PDF/A worker error');
    _pending.forEach(entry => entry.reject(err));
    _pending.clear();
    _worker = null;
  };
}

/**
 * Analyze a PDF file's PDF/A-2b readiness. Read-only — does not modify
 * or return a new file.
 * @param {File} file
 * @returns {Promise<{pageCount:number, encrypted:boolean, missingFonts:string[], forbidden:string[], compliant:boolean}>}
 */
export async function analyzePdfA(file) {
  _ensureWorker();
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const id = _nextId++;
    _pending.set(id, { resolve, reject });
    try {
      _worker.postMessage({ id, fileBytes }, [fileBytes.buffer]);
    } catch (err) {
      _pending.delete(id);
      reject(err);
    }
  });
}
