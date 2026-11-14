// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  watermarkTextRequest.js — text watermarks through the dedicated
//  Unicode-capable worker (watermarkTextWorker.js).
//
//  See watermarkTextWorker.js's own header for the full rationale — this
//  exists because worker.js's handleWatermark() embeds a WinAnsi-only
//  standard font, which can't render Cyrillic/Vietnamese/Turkish text
//  (including the localized default watermark text on ru/vi/tr). Image
//  watermarks don't need any of this and stay on worker.js unchanged —
//  only routed here when options.kind !== 'image'.
// ============================================================
let _watermarkTextWorker = null;
function _ensureWatermarkTextWorker() {
  if (!_watermarkTextWorker) {
    _watermarkTextWorker = new Worker(new URL('./watermarkTextWorker.js', import.meta.url));
  }
  return _watermarkTextWorker;
}

// Fetched once per page load and cached — same file every time, same
// pattern as pdfaAnalyze.js's _loadLiberationFont (LiberationSans-Bold is
// the metric-compatible replacement for the HelveticaBold this feature
// used before, so existing Latin-text watermarks render identically).
// Only fileBuffer goes in postMessage's transfer list below, never this
// cached buffer — an ArrayBuffer put in a transfer list is detached after
// the call, which would silently corrupt every watermark after the first
// if this cache were transferred instead of structure-cloned.
let _liberationSansBoldPromise = null;
function _loadLiberationSansBold() {
  if (!_liberationSansBoldPromise) {
    const url = new URL('./vendor/liberation-fonts/LiberationSans-Bold.ttf', import.meta.url).href;
    _liberationSansBoldPromise = fetch(url).then(r => {
      if (!r.ok) throw new Error(`Failed to load LiberationSans-Bold.ttf (${r.status})`);
      return r.arrayBuffer();
    });
  }
  return _liberationSansBoldPromise;
}

// Low-level request/response round trip for one file — shared by the
// Watermark tool's single-file, batch and personalized-copies paths
// (processor.js) and Quick Edit's personalized copies (quickEditCopies.js).
// One request at a time: each call takes over the worker's onmessage. No watchdog/cancel wiring (unlike
// _postToWorkerForBatch's shared-worker version) — font-embedding +
// drawText is fast enough that a hang here would indicate a real bug, not
// something worth a timeout UX for.
export async function watermarkTextRequest(fileBuffer, options, onProgress) {
  const fontBytes = await _loadLiberationSansBold();
  return new Promise((resolve, reject) => {
    const worker = _ensureWatermarkTextWorker();
    worker.onmessage = (e) => {
      const data = e.data;
      if (data.type === 'progress') { onProgress?.(data.value, data.label); return; }
      if (data.type === 'done')     { resolve(data); return; }
      if (data.type === 'error')    { const err = new Error(data.message); err.code = data.code; err.chars = data.chars; reject(err); return; }
    };
    worker.onerror = (e) => reject(new Error(e.message || 'Worker error'));
    worker.postMessage({ fileBuffer, options, fontBytes }, [fileBuffer]);
  });
}
