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
const _ICC_URL    = new URL('./vendor/sRGB2014.icc', import.meta.url).href;

let _worker      = null;
let _nextId      = 1;
const _pending   = new Map();
let _iccPromise  = null;

// Fetched once per page load and cached — the ICC bytes are the same for
// every conversion (see js/vendor/SOURCE.txt for provenance).
function _loadIcc() {
  if (!_iccPromise) {
    _iccPromise = fetch(_ICC_URL).then(r => {
      if (!r.ok) throw new Error('Failed to load color profile (' + r.status + ')');
      return r.arrayBuffer();
    });
  }
  return _iccPromise;
}

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

/**
 * Convert a PDF to PDF/A-2b. The worker independently re-runs the same
 * blocking checks analyzePdfA() does — a caller skipping the analyze step
 * (or acting on a stale report) can't produce a silently-broken "PDF/A".
 * @param {File} file
 * @returns {Promise<
 *   {blocked:true, report:object} |
 *   {blocked:false, fileBytes:Uint8Array, audit:{outputIntentPresent:boolean, xmpPresent:boolean, notEncrypted:boolean, passed:boolean}}
 * >}
 */
export async function convertToPdfA(file) {
  _ensureWorker();
  const [fileBytes, iccBuffer] = await Promise.all([
    file.arrayBuffer().then(b => new Uint8Array(b)),
    _loadIcc(),
  ]);
  const iccBytes = new Uint8Array(iccBuffer);
  return new Promise((resolve, reject) => {
    const id = _nextId++;
    _pending.set(id, { resolve, reject });
    try {
      _worker.postMessage({ id, type: 'convert', fileBytes, iccBytes }, [fileBytes.buffer]);
    } catch (err) {
      _pending.delete(id);
      reject(err);
    }
  });
}
