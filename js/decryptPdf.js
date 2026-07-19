// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  decryptPdf.js — Owner-only PDF decryption via QPDF WASM
//
//  Architecture:
//    • Main-thread only (not for use inside worker.js)
//    • Communicates with js/vendor/qpdf/worker.js via postMessage
//    • Lazy init: WASM loads only on first encrypted PDF
//    • The worker itself uses importScripts (classic worker context)
//
//  What it does:
//    decryptOwnerOnly(bytes) tries qpdf --decrypt --password=
//    → success: returns decrypted Uint8Array (owner-only PDF, empty user password)
//    → null:    real user password required — caller shows ENCRYPTED error
//
//  What it does NOT do:
//    • Does not handle AES-256 with a real user password
//    • Does not modify or load pdf-lib
// ============================================================

// Resolve WASM asset URLs relative to this module's location.
// import.meta.url = https://pdfree.io/js/decryptPdf.js → paths resolve correctly
// regardless of which HTML page (/, /de/, /fr/…) triggered the load.
const _WORKER_URL  = new URL('./vendor/qpdf/worker.js',   import.meta.url).href;
const _QPDF_JS_URL = new URL('./vendor/qpdf/lib/qpdf.js', import.meta.url).href;
const _WASM_URL    = new URL('./vendor/qpdf/lib/qpdf.wasm', import.meta.url).href;

let _worker      = null;
let _initPromise = null;
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
    if (msg.ok) entry.resolve(msg);
    else        entry.reject(new Error(msg.message || 'qpdf failed'));
  };

  _worker.onerror = (e) => {
    const err = new Error(e.message || 'qpdf worker error');
    _pending.forEach(entry => entry.reject(err));
    _pending.clear();
    // Reset so next call retries worker creation
    _worker      = null;
    _initPromise = null;
  };
}

function _send(msg, transfer = []) {
  const id  = String(_nextId++);
  msg.id    = id;
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    _worker.postMessage(msg, transfer);
  });
}

async function _init() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    _ensureWorker();
    await _send({ type: 'init', qpdfJsUrl: _QPDF_JS_URL, wasmUrl: _WASM_URL });
  })();
  return _initPromise;
}

/**
 * Scans PDF bytes for /Encrypt keyword (fast heuristic, no full parse).
 * Checks the trailer area (last 2 KB) where /Encrypt almost always lives,
 * plus the first 1 KB as a safety net for xref-stream PDFs.
 * latin1 encoding ensures binary bytes pass through unchanged.
 */
function _looksEncrypted(bytes) {
  const dec  = new TextDecoder('latin1');
  const tail = dec.decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
  if (tail.includes('/Encrypt')) return true;
  if (bytes.length > 2048) {
    const head = dec.decode(bytes.subarray(0, Math.min(1024, bytes.length)));
    if (head.includes('/Encrypt')) return true;
  }
  return false;
}

/**
 * Runs `qpdf --decrypt --password=<password>` against raw PDF bytes.
 * Shared by decryptOwnerOnly() (empty password) and decryptWithPassword()
 * (user-supplied password) — same WASM call, only the password differs.
 * Args are passed as an array straight to Emscripten's callMain, not through
 * a shell, so arbitrary characters in `password` (including "=") are safe.
 *
 * @param {Uint8Array} bytes
 * @param {string} password
 * @returns {Promise<Uint8Array|null>} Decrypted bytes on success, null on failure.
 */
async function _qpdfDecrypt(bytes, password) {
  await _init();

  // qpdf-run worker transfers input bytes — make an owned copy first
  // so the caller's buffer is not detached by postMessage.
  const input = new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

  try {
    const result = await _send(
      {
        type:    'run',
        inputs:  { 'in.pdf': input },
        args:    ['--decrypt', `--password=${password}`, 'in.pdf', 'out.pdf'],
        outputs: ['out.pdf'],
      },
      [input.buffer]
    );
    return result.outputs['out.pdf'];  // Uint8Array
  } catch {
    return null;  // wrong/missing password → caller decides how to react
  }
}

/**
 * Tries to strip owner-only encryption from a PDF.
 * Equivalent to: pikepdf.open(path, password='')
 *
 * @param {Uint8Array} bytes - Raw PDF bytes
 * @returns {Promise<Uint8Array|null>}
 *   Decrypted bytes on success, null if a real user password is required.
 */
export async function decryptOwnerOnly(bytes) {
  return _qpdfDecrypt(bytes, '');
}

/**
 * Decrypts a PDF using a real, user-supplied open password — for the
 * Unlock PDF tool. Unlike decryptOwnerOnly(), a null result here typically
 * means the password was simply wrong, not that decryption is impossible.
 *
 * @param {Uint8Array} bytes - Raw PDF bytes
 * @param {string} password - User-entered password
 * @returns {Promise<Uint8Array|null>} Decrypted bytes on success, null on wrong password.
 */
export async function decryptWithPassword(bytes, password) {
  return _qpdfDecrypt(bytes, password);
}

/**
 * Pre-processes a PDF ArrayBuffer before sending to worker.js:
 *   1. Fast /Encrypt heuristic — skip non-encrypted files immediately.
 *   2. QPDF decrypt with empty password → owner-only PDFs open transparently.
 *   3. If QPDF fails (real user password) → return original buffer unchanged.
 *      worker.js will then throw ENCRYPTED and the UI will show the error.
 *
 * @param {ArrayBuffer} buffer
 * @returns {Promise<ArrayBuffer>} Clean (decrypted or original) ArrayBuffer
 */
export async function preprocessPdfBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  if (!_looksEncrypted(bytes)) return buffer;  // fast path — 99% of PDFs

  const decrypted = await decryptOwnerOnly(bytes);
  return decrypted ? decrypted.buffer : buffer;
}
