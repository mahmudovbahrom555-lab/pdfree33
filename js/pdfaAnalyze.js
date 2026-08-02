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

const _WORKER_URL   = new URL('./pdfaWorker.js', import.meta.url).href;
const _ICC_URL      = new URL('./vendor/sRGB2014.icc', import.meta.url).href;
const _LIBERATION_DIR = new URL('./vendor/liberation-fonts/', import.meta.url).href;

let _worker      = null;
let _nextId      = 1;
const _pending   = new Map();
let _iccPromise  = null;
const _liberationCache = new Map(); // filename -> ArrayBuffer promise

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

// Mirrors pdfaWorker.js's classifyStandardFont() — kept in sync deliberately
// duplicated (main thread vs worker context, can't share a module easily
// between an ES module and a classic-worker importScripts file). Only used
// here to decide WHICH of the 12 Liberation files to fetch; the worker does
// its own full, authoritative classification + metric verification — this
// copy being wrong in some edge case would at worst fetch an unneeded file
// or miss one (causing that specific font to fail verification and the
// whole conversion to refuse, same as not opting in at all), never produce
// an unsafe result.
function _classifyStandardFont(baseFont) {
  const name = baseFont.toLowerCase();
  let family = null;
  if (/helvetica|arial/.test(name)) family = 'Sans';
  else if (/times/.test(name)) family = 'Serif';
  else if (/courier/.test(name)) family = 'Mono';
  else return null;
  const bold = /bold/.test(name);
  const italic = /italic|oblique/.test(name);
  const style = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
  return `Liberation${family}-${style}.ttf`;
}

function _loadLiberationFont(filename) {
  if (!_liberationCache.has(filename)) {
    _liberationCache.set(filename, fetch(_LIBERATION_DIR + filename).then(r => {
      if (!r.ok) throw new Error(`Failed to load ${filename} (${r.status})`);
      return r.arrayBuffer();
    }));
  }
  return _liberationCache.get(filename);
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
 * @param {object} [options]
 * @param {boolean} [options.substituteFonts] — opt-in: try replacing
 *   unembedded standard-14 fonts (Helvetica/Times/Courier families only)
 *   with metric-compatible Liberation fonts. The worker verifies each
 *   font's actual metrics before ever using this — see pdfaWorker.js.
 * @param {string[]} [options.fontNames] — the report's substitutableFonts
 *   list, used only to decide which of the 12 Liberation files to fetch.
 * @returns {Promise<
 *   {blocked:true, report:object, substitutionFailed?:string[]} |
 *   {blocked:false, fileBytes:Uint8Array, audit:object, conformance:string, substitution:string[]|null}
 * >}
 */
export async function convertToPdfA(file, options = {}) {
  _ensureWorker();
  const { substituteFonts = false, fontNames = [] } = options;

  const neededFiles = substituteFonts
    ? Array.from(new Set(fontNames.map(_classifyStandardFont).filter(Boolean)))
    : [];

  const [fileBytes, iccBuffer, ...liberationBuffers] = await Promise.all([
    file.arrayBuffer().then(b => new Uint8Array(b)),
    _loadIcc(),
    ...neededFiles.map(_loadLiberationFont),
  ]);
  const iccBytes = new Uint8Array(iccBuffer);
  const liberationFonts = {};
  neededFiles.forEach((filename, i) => {
    liberationFonts[filename] = new Uint8Array(liberationBuffers[i]);
  });

  return new Promise((resolve, reject) => {
    const id = _nextId++;
    _pending.set(id, { resolve, reject });
    try {
      _worker.postMessage(
        { id, type: 'convert', fileBytes, iccBytes, substituteFonts, liberationFonts },
        [fileBytes.buffer],
      );
    } catch (err) {
      _pending.delete(id);
      reject(err);
    }
  });
}
