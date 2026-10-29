// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  tiffDecode.js — a TIFF file → one PNG Blob per page
//
//  Same shape as js/heicDecode.js: jpg2pdfUI.js (thumbnail) and
//  processor.js (conversion) decode before js/worker.js sees the bytes,
//  and share one cached decode. The decode itself runs in
//  js/tiffWorker.js — a 100-page fax TIFF must not freeze the page.
// ============================================================

/**
 * @param {File} file
 * @returns {boolean}
 */
export function isTiffFile(file) {
  const type = (file.type || '').toLowerCase();
  return type === 'image/tiff' || /\.tiff?$/i.test(file.name || '');
}

const _cache = new WeakMap();

/**
 * Every page of a TIFF as a PNG Blob, in file order — null when the file
 * can't be read (damaged, or a compression UTIF.js doesn't know); the
 * caller skips it like an image that failed to load.
 * @param {File} file
 * @returns {Promise<Blob[]|null>}
 */
export function decodeTiffPages(file) {
  if (_cache.has(file)) return _cache.get(file);
  const p = _decode(file);
  _cache.set(file, p);
  return p;
}

async function _decode(file) {
  const buffer = await file.arrayBuffer();
  const worker = new Worker(new URL('./tiffWorker.js', import.meta.url));
  try {
    const res = await new Promise((resolve) => {
      worker.onmessage = e => resolve(e.data);
      worker.onerror   = e => resolve({ error: e.message || 'TIFF worker failed' });
      worker.postMessage({ buffer }, [buffer]);
    });
    if (res.error) console.warn('[tiff]', file.name, res.error);
    return res.pages || null;
  } finally {
    worker.terminate();
  }
}
