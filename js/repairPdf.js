// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  repairPdf.js — "Tap to repair it and try again", offered by
//  processor.js's _handleError when a file turns out to be damaged.
//
//  Each selected PDF goes through js/repairWorker.js; a repaired one keeps
//  its new bytes in file._decryptedBuffer — the prepared-bytes slot every
//  runner already reads before the original (see processor.js's
//  "_decryptedBuffer ? … : preprocessPdfBuffer(…)"), so the retry needs no
//  per-tool code. A file with nothing to fix is left exactly as it was.
// ============================================================

let _worker = null;

function _repairOne(buffer) {
  if (!_worker) _worker = new Worker(new URL('./repairWorker.js', import.meta.url));
  return new Promise((resolve, reject) => {
    _worker.onmessage = e => (e.data.type === 'done' ? resolve(e.data) : reject(new Error(e.data.message)));
    _worker.onerror   = e => { _worker = null; reject(new Error(e.message || 'repair worker error')); };
    _worker.postMessage({ buffer }, [buffer]);
  });
}

/**
 * Repairs every PDF in `files` that needs it.
 * @returns {Promise<number>} how many files were changed
 */
export async function repairFiles(files) {
  let repaired = 0;
  for (const f of files) {
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') continue;
    const original = f._decryptedBuffer ? f._decryptedBuffer.slice(0) : await f.arrayBuffer();
    try {
      const { result } = await _repairOne(original);
      if (result) { f._decryptedBuffer = result; repaired++; }
    } catch { /* unreadable even for the repair — left as it was */ }
  }
  return repaired;
}
