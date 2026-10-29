// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  tiffDecode.js — TIFF detection and the thumbnail of its first page
//
//  Chrome, Edge and Firefox can't decode TIFF, so jpg2pdfUI.js's preview
//  gets the first page as a PNG from js/tiffWorker.js (off the main
//  thread). The PDF itself is built there too — processor.js's
//  _runJpg2PdfTiff.
// ============================================================

/**
 * @param {File} file
 * @returns {boolean}
 */
export function isTiffFile(file) {
  const type = (file.type || '').toLowerCase();
  return type === 'image/tiff' || /\.tiff?$/i.test(file.name || '');
}

const _previews = new WeakMap();

/**
 * The first page as a PNG Blob, or null when the TIFF can't be read.
 * @param {File} file
 * @returns {Promise<Blob|null>}
 */
export function tiffPreview(file) {
  if (!_previews.has(file)) _previews.set(file, _preview(file));
  return _previews.get(file);
}

async function _preview(file) {
  const buffer = await file.arrayBuffer();
  const worker = new Worker(new URL('./tiffWorker.js', import.meta.url));
  try {
    return await new Promise((resolve) => {
      worker.onmessage = e => resolve(e.data.page || null);
      worker.onerror   = () => resolve(null);
      worker.postMessage({ type: 'preview', buffer }, [buffer]);
    });
  } finally {
    worker.terminate();
  }
}
