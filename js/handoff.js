// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// handoff.js — Blob passthrough between tool pages via IndexedDB
//
// When a user finishes one tool and clicks a cross-sell link, the result
// PDF blob is saved here before navigation. The destination page restores
// it on load and feeds it directly into the drop zone — no re-upload needed.
//
// Design decisions:
//   - Single entry (key='pending'): one active handoff at a time
//   - TTL 5 min: auto-expires if user navigates away without using it
//   - PDF-only: ZIP (split) and TXT (OCR extract) are not passed through
//   - IDB errors always fall back to normal navigation (non-fatal)

const DB_NAME    = 'pdfree-handoff';
const STORE_NAME = 'files';
const ENTRY_KEY  = 'pending';
const TTL_MS     = 5 * 60 * 1000;

let _db = null;

function _openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(STORE_NAME);
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = () => reject(req.error);
  });
}

// Save a result blob for pickup on the next tool page.
// No-op if blob is not a PDF (ZIP from split, TXT from OCR extract).
export async function saveHandoff(blob, filename, sourceTool) {
  if (!blob || blob.type !== 'application/pdf') return;
  const db = await _openDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(
      { blob, filename, sourceTool, expires: Date.now() + TTL_MS },
      ENTRY_KEY
    );
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// Read and immediately delete the pending handoff.
// Returns { blob, filename, sourceTool } or null (expired / not found / IDB error).
export async function restoreHandoff() {
  let db;
  try { db = await _openDb(); } catch { return null; }

  return new Promise(resolve => {
    const tx    = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const get   = store.get(ENTRY_KEY);
    get.onsuccess = () => {
      const entry = get.result;
      if (!entry) { resolve(null); return; }
      store.delete(ENTRY_KEY);          // single-use: clear immediately
      if (entry.expires < Date.now()) { resolve(null); return; }
      resolve({ blob: entry.blob, filename: entry.filename, sourceTool: entry.sourceTool });
    };
    get.onerror = () => resolve(null);  // IDB read error → fall back gracefully
  });
}
