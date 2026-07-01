// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

const DB_NAME    = 'pdfree-handoff';
const STORE_NAME = 'files';
const ENTRY_KEY  = 'pending';
const TTL_MS     = 5 * 60 * 1000;

let _db        = null;
let _dbPromise = null;  // shared in-flight promise prevents concurrent open races

function _openDb() {
  if (_db)        return Promise.resolve(_db);
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(STORE_NAME);
    req.onsuccess = e => {
      _db = e.target.result;
      _db.onversionchange = () => { _db.close(); _db = null; };
      _dbPromise = null;
      resolve(_db);
    };
    req.onerror = () => { _dbPromise = null; reject(req.error); };
  });
  return _dbPromise;
}

// Save a result blob for pickup on the next tool page.
// destinationHref: absolute URL of the link the user clicked (stored to prevent
// back-navigation from consuming the entry on the source page).
// No-op if blob is not a PDF (ZIP from split, TXT from OCR extract).
export async function saveHandoff(blob, filename, sourceTool, destinationHref = null) {
  if (!blob || blob.type !== 'application/pdf') return;
  const db = await _openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(
      { blob, filename, sourceTool, destinationHref, expires: Date.now() + TTL_MS },
      ENTRY_KEY
    );
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// Read and delete the pending handoff.
// Returns { blob, filename, sourceTool } or null.
// Only consumes the entry when location.pathname matches the stored destinationHref —
// prevents back-navigation on the source page from silently destroying the entry.
export async function restoreHandoff() {
  let db;
  try { db = await _openDb(); } catch { return null; }

  return new Promise(resolve => {
    const tx    = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const get   = store.get(ENTRY_KEY);
    let   result = null;

    get.onsuccess = () => {
      const e = get.result;
      if (!e) { resolve(null); return; }

      // Expired — delete silently; tx.oncomplete resolves null
      if (e.expires < Date.now()) { store.delete(ENTRY_KEY); return; }

      // Destination mismatch — keep the entry intact for the correct page
      if (e.destinationHref) {
        try {
          const destPath = new URL(e.destinationHref, location.href).pathname.replace(/\/$/, '');
          if (location.pathname.replace(/\/$/, '') !== destPath) { resolve(null); return; }
        } catch { resolve(null); return; }
      }

      // Match — delete and hand back the blob after the transaction commits
      result = { blob: e.blob, filename: e.filename, sourceTool: e.sourceTool };
      store.delete(ENTRY_KEY);
    };

    get.onerror   = () => resolve(null);
    tx.oncomplete = () => resolve(result);   // fires after delete commits
    tx.onabort    = () => resolve(null);
  });
}
