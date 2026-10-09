// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  ocrGrayscaleWorker.js — Dedicated Web Worker for the OCR engine's
//  per-page grayscale conversion — the fallback when Enhance
//  (js/cleanScanWorker.js) is unavailable — run just before handing a page
//  to Tesseract.js's own recognize() worker. CJK pages used to be Otsu-
//  binarized here instead of Enhanced; Enhance's deskew read Chinese and
//  Japanese phone photos in order (41–69% → 96–99%), so that path is gone.
//
//  Found via the same main-thread-jank audit that fixed Document
//  Scanner's perspective-warp step (js/scanWarpWorker.js, 2026-08-28,
//  commit 956c0fb1) — measured live via Playwright with 4x CPU throttle
//  on a real ~6.3MB scanned PDF page (rendered up to SCRIPT_PROFILE's
//  3000px cap): a 240.2ms main-thread frame gap on the OCR button click,
//  traced to _toGrayscale()'s synchronous full-resolution pixel loop
//  (previously in js/ocrUI.js) running on the main thread before
//  Tesseract's own worker.recognize() call ever started.
//
//  Deliberately NOT part of worker.js (off-limits per CLAUDE.md) and NOT
//  an ES module — classic Worker, no imports, same reasoning
//  js/scanDetectWorker.js / js/scanFilterWorker.js / js/scanWarpWorker.js
//  already document for this class of duplication. Pure pixel math only
//  (no OpenCV, no canvas API needed in-worker) — verbatim port of
//  js/ocrUI.js's _toGrayscale, operating
//  directly on the transferred Uint8ClampedArray instead of a canvas's
//  ImageData. The CALLER (js/ocrUI.js's _toGrayscaleAsync) extracts
//  ImageData from the source canvas and reconstructs an output canvas
//  from the returned pixel buffer — same division of labor as
//  js/scanGeometry.js's warpToRectAsync/scanWarpWorker.js pair.
//
//  Message contract:
//    in  → { type: 'grayscale', data: Uint8ClampedArray, w, h } (data transferred)
//    out → { type: 'grayscaleResult', data: Uint8ClampedArray } (data transferred)
//        | { type: 'error', message }
// ============================================================

self.onmessage = (e) => {
  try {
    if (e.data.type === 'grayscale') {
      const { data } = e.data;
      _grayscaleInPlace(data);
      self.postMessage({ type: 'grayscaleResult', data }, [data.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

// Verbatim port of js/ocrUI.js's _toGrayscale — same ITU-R BT.601
// luminance weights (matches the CSS grayscale filter), operating
// directly on the transferred pixel buffer instead of a fresh canvas.
function _grayscaleInPlace(d) {
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = g;
  }
}
