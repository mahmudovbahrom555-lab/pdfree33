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
//    decryptWithPassword(bytes, password) — Unlock: the typed password in
//    each form a writer may have stored it in (see passwordAttempts)
//
//  What it does NOT do:
//    • Does not modify or load pdf-lib
// ============================================================

// Resolve WASM asset URLs relative to this module's location.
// import.meta.url = https://pdfree.io/js/decryptPdf.js → paths resolve correctly
// regardless of which HTML page (/, /de/, /fr/…) triggered the load.
const _WORKER_URL  = new URL('./qpdfWorker.js', import.meta.url).href;
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
// The tail is 64 KB, not 2: a 332-page Persian book from the cloud corpus
// (2026-10-14) had its trailer's /Encrypt 4.9 KB from the end — missed, so
// it was never decrypted and every pdf-lib tool read ciphertext ("Invalid
// header in flate stream"). 64 KB of latin1 is still nothing to decode.
// The head is 64 KB too, not 1: a linearized ("fast web view") PDF names
// /Encrypt only in its first-page trailer, near the start, and never again
// at the end (qpdf --linearize: byte 471–603 of 816 KB, 2026-10-30). A
// producer writing a longer first section would slip past 1 KB — never
// decrypted, pdf-lib reading ciphertext, "unusual or corrupted structure"
// (EXTRACT-85E1, a homeschool math worksheet; the cause not yet confirmed).
export function looksEncrypted(bytes) {
  const dec = new TextDecoder('latin1');
  const tail = dec.decode(bytes.subarray(Math.max(0, bytes.length - 65536)));
  if (tail.includes('/Encrypt')) return true;
  if (bytes.length > 65536) {
    const head = dec.decode(bytes.subarray(0, 65536));
    if (head.includes('/Encrypt')) return true;
  }
  return false;
}

// One qpdf run with the given --password arguments. Args are passed as an
// array straight to Emscripten's callMain, not through a shell, so any
// character in a password (including "=") is safe.
async function _qpdfRun(bytes, passwordArgs) {
  await _init();

  // the qpdf worker takes the input bytes (transfer) — make an owned copy first
  // so the caller's buffer is not detached by postMessage.
  const input = new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

  try {
    const result = await _send(
      {
        type:    'run',
        inputs:  { 'in.pdf': input },
        args:    ['--decrypt', ...passwordArgs, 'in.pdf', 'out.pdf'],
        outputs: ['out.pdf'],
      },
      [input.buffer]
    );
    return result.outputs['out.pdf'];  // Uint8Array
  } catch (err) {
    // A PDF holding one stream over ~4.5 MB (a large scan or photo) aborted
    // the fixed-heap build used before — "Aborted(OOM)" — whatever the
    // password; reported as "password protected", a teacher's exam sheet with
    // editing restrictions and an empty open password couldn't be converted
    // at all (2026-10-25). Not a password verdict: the caller's to handle.
    if (/Aborted|OOM/.test(String(err?.message ?? ''))) throw new Error('QPDF_OUT_OF_MEMORY', { cause: err });
    return null;  // wrong/missing password → caller decides how to react
  }
}

// The revision (/R) of a Standard security handler's encryption dictionary,
// read in the first and last 64 KB; null when it isn't there in plain text
// (an encryption dictionary inside an object stream).
export function encryptionRevision(bytes) {
  const dec = new TextDecoder('latin1');
  for (const part of [bytes.subarray(Math.max(0, bytes.length - 65536)), bytes.subarray(0, 65536)]) {
    const text = dec.decode(part), std = text.search(/\/Filter\s*\/Standard/);
    if (std < 0) continue;
    const r = text.slice(Math.max(0, std - 600), std + 600).match(/\/R\s+(\d)(?!\s+\d+\s+R)/);
    if (r) return Number(r[1]);
  }
  return null;
}

// A password typed with a code page: its bytes, or null when a character
// isn't in it. The table is the browser's own decoder turned around (every
// one- and two-byte sequence decoded, the first one kept): on every character
// both encode, it agrees with Windows' cp936, cp932 and cp1251 (Python's
// codecs, all of the BMP, 2026-10-30). ASCII is itself.
const _codePages = {};
function _codePageBytes(password, label) {
  let map = _codePages[label];
  if (!map) {
    const dec = new TextDecoder(label, { fatal: true });
    map = _codePages[label] = new Map();
    const put = seq => {
      let ch;
      try { ch = dec.decode(new Uint8Array(seq)); } catch { return; }
      if ([...ch].length === 1 && !map.has(ch)) map.set(ch, seq);
    };
    for (let a = 0x80; a < 0x100; a++) put([a]);
    if (label !== 'windows-1251') for (let a = 0x81; a < 0xff; a++) for (let b = 0x40; b < 0xff; b++) put([a, b]);
  }
  const out = [];
  for (const ch of password) {
    const seq = ch < '\x80' ? [ch.charCodeAt(0)] : map.get(ch);
    if (!seq) return null;
    out.push(...seq);
  }
  return out;
}

const _hex = bytes => bytes.map(b => b.toString(16).padStart(2, '0')).join('');

// The --password arguments to try for a typed password, in order. A password
// outside ASCII turns into bytes differently in each writer (2026-10-30,
// tests/fixtures/unlock): AES-256 (R5/R6) takes UTF-8 — and only that is
// tried there; for the older handlers qpdf and Acrobat-like writers take
// PDFDoc where they can (qpdf's own reading of a UTF-8 password), our Protect
// truncates each character to a byte (pdfEncrypt.js's _padPwd), LibreOffice
// 26.2 writes "?" for each character outside Latin-1, and old Windows and
// WPS-style writers the system code page (GBK, Shift-JIS, CP1251). Unlock
// took only the truncated form: every non-Latin password was "incorrect",
// AES-256 and our own Protect's files included. A wrong password opens none
// of them; forms giving the same bytes are run once, so an ASCII password
// is one run, as before.
export function passwordAttempts(password, revision) {
  const attempts = [[`--password=${password}`]];
  if (revision >= 5) return attempts;
  const seen = new Set([_hex([...new TextEncoder().encode(password)])]);
  const forms = [
    Array.from({ length: password.length }, (_, i) => password.charCodeAt(i) & 0xff),
    [...password].map(ch => (ch.codePointAt(0) < 0x100 ? ch.codePointAt(0) : 0x3f)),
    _codePageBytes(password, 'gbk'),
    _codePageBytes(password, 'shift_jis'),
    _codePageBytes(password, 'windows-1251'),
  ];
  for (const bytes of forms) {
    if (!bytes) continue;
    const hex = _hex(bytes);
    if (seen.has(hex)) continue;
    seen.add(hex);
    attempts.push(['--password-mode=hex-bytes', `--password=${hex}`]);
  }
  return attempts;
}

/**
 * Tries to strip owner-only encryption from a PDF.
 * Equivalent to: pikepdf.open(path, password='')
 *
 * @param {Uint8Array} bytes - Raw PDF bytes
 * @returns {Promise<Uint8Array|null>}
 *   Decrypted bytes on success, null if a real user password is required.
 *   Throws QPDF_OUT_OF_MEMORY when qpdf ran out of memory (see _qpdfRun).
 */
export async function decryptOwnerOnly(bytes) {
  return _qpdfRun(bytes, ['--password=']);
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
  for (const args of passwordAttempts(password, encryptionRevision(bytes))) {
    const out = await _qpdfRun(bytes, args);
    if (out) return out;
  }
  return null;
}

/**
 * Pre-processes a PDF ArrayBuffer before sending to worker.js:
 *   1. Fast /Encrypt heuristic — skip non-encrypted files immediately.
 *   2. QPDF decrypt with empty password → owner-only PDFs open transparently.
 *   3. If QPDF fails (real user password) → return original buffer unchanged.
 *      Nothing downstream throws for it (pdf-lib loads use ignoreEncryption)
 *      — such files are stopped before processing by app.js's password
 *      guard (files.js sets file._needsPassword).
 *
 * @param {ArrayBuffer} buffer
 * @returns {Promise<ArrayBuffer>} Clean (decrypted or original) ArrayBuffer
 */
export async function preprocessPdfBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  if (!looksEncrypted(bytes)) return buffer;  // fast path — 99% of PDFs

  // out of memory: the file as it is — pdf.js opens it itself when it needs no
  // password; tools that need it decrypted were stopped before (app.js)
  const decrypted = await decryptOwnerOnly(bytes).catch(err => {
    if (err.message === 'QPDF_OUT_OF_MEMORY') return null;
    throw err;
  });
  return decrypted ? decrypted.buffer : buffer;
}
