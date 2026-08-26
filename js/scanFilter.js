// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  scanFilter.js — pixel filter for Document Scanner's captured/imported
//  photos.
//
//  The actual pixel-processing pipeline (grayscale → background-estimate
//  → flat-field-correct → median-filter → unsharp-mask → enhance) moved
//  to js/scanFilterWorker.js 2026-08-26 — see that file's own header for
//  the real, measured reason (this pipeline alone was ~2.8s of blocking
//  main-thread work per photo on a throttled/weak CPU, contributing to a
//  real "button presses feel slow" report). filterScanPhoto() below keeps
//  the EXACT SAME exported signature/behavior as before this move — every
//  caller (js/scanDocumentUI.js) needed zero changes.
//
//  Deliberately 'enhance' mode only (contrast/brightness boost, no Otsu
//  threshold/binarization/despeckle) — matches Clean Scan's non-destructive
//  branch, appropriate for a freshly-captured photo of unknown quality.
//
//  filterScanPhoto(imgEl, mode) supports 'grayscale' (default, as above)
//  and 'color' — a real competitive gap found 2026-08-22 testing against
//  PDF24's camera scanner, which offers Color/Grayscale/B&W (no B&W here
//  yet — would need Clean Scan's Otsu-threshold/despeckle path ported too,
//  not done in this pass). Color mode reuses the SAME background-estimate
//  step (computed from a grayscale copy — flat-field correction is
//  inherently a luminance/shading concept) but applies the resulting
//  per-pixel shading-correction ratio multiplicatively to each R/G/B
//  channel independently, instead of collapsing to gray — standard
//  technique, fixes uneven lighting/shadow while preserving real color.
//  Median filter + unsharp mask (aimed at printed-text sharpening) are
//  skipped for color mode — appropriate for a mode about preserving
//  photographic content, not maximizing text crispness.
// ============================================================

// Backstop, not the primary fix — js/scanDocumentUI.js's own decode paths
// already cap resolution before calling in here (see its
// MAX_SCAN_LONG_EDGE's comment for the real-device OOM this guards
// against: a raw camera photo — 12-48MP on many phones now, budget
// devices included — flowing uncapped through this multi-pass full-
// resolution filter chain, each pass allocating its own ImageData
// buffer). Kept here too as defense-in-depth for any caller that decodes
// its own source without going through that cap (e.g. a live-camera
// capture canvas).
const MAX_FILTER_LONG_EDGE = 2200;

// Exported (unlike filterScanPhoto's own pipeline, which now runs inside
// js/scanFilterWorker.js and needs a real OffscreenCanvas — no polyfill in
// this project, same as Clean Scan itself never having a Node-level pixel
// test) because these two operate on a raw pixel array, not a canvas —
// genuinely testable in plain Node. See tests/scanFilter.test.js. Kept
// here as the source of truth for the algorithm; js/scanFilterWorker.js
// carries its own copy for the same "classic Worker, no ES modules"
// reason js/cleanScanWorker.js already documents.
export function medianFilterGray(data, w, h) {
  const out = new Uint8ClampedArray(w * h);
  const win = new Uint8Array(9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        const rowBase = ny * w;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          win[n++] = data[(rowBase + nx) * 4];
        }
      }
      for (let a = 1; a < n; a++) {
        const key = win[a];
        let b = a - 1;
        while (b >= 0 && win[b] > key) { win[b + 1] = win[b]; b--; }
        win[b + 1] = key;
      }
      out[y * w + x] = win[n >> 1];
    }
  }
  return out;
}

export function boxBlurGray(data, w, h, radius) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        const rowBase = ny * w;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          sum += data[(rowBase + nx) * 4];
          count++;
        }
      }
      out[y * w + x] = sum / count;
    }
  }
  return out;
}

// ── Worker management — same lazy-singleton + single-shot-request
//    pattern js/processor.js's _ensureCleanScanWorker/
//    _cleanScanWorkerRequest already establish, kept local to this
//    module rather than routed through processor.js: filterScanPhoto()
//    is called from the interactive crop-review flow (js/scanDocumentUI.js),
//    well before processor.js's own pipeline (triggered by the "Save as
//    PDF" button) ever starts — a different lifecycle, no reason to
//    couple them. ──

let _filterWorker = null;
function _ensureFilterWorker() {
  if (!_filterWorker) {
    _filterWorker = new Worker(new URL('./scanFilterWorker.js', import.meta.url));
  }
  return _filterWorker;
}

// One request in flight at a time in practice (scanDocumentUI.js's review
// queue already serializes photos one at a time) — a plain onmessage
// swap per call is enough, no message-id correlation needed.
function _filterWorkerRequest(worker, message, transfer) {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'error') { reject(new Error(d.message)); return; }
      resolve(d);
    };
    worker.onerror = (e) => reject(new Error(e.message || 'Worker error'));
    worker.postMessage(message, transfer);
  });
}

/**
 * Runs the clean-scan-style filter pipeline (js/scanFilterWorker.js, off
 * the main thread) on a decoded photo and returns a filtered JPEG Blob.
 * `imgEl` can be any CanvasImageSource with natural dimensions (a decoded
 * <img>, a canvas, ...).
 * @param {CanvasImageSource & {naturalWidth?: number, width?: number}} imgEl
 * @param {'grayscale'|'color'} [mode='grayscale']
 * @returns {Promise<Blob>}
 */
export async function filterScanPhoto(imgEl, mode = 'grayscale') {
  const rawW = imgEl.naturalWidth || imgEl.width;
  const rawH = imgEl.naturalHeight || imgEl.height;
  const scale = Math.min(1, MAX_FILTER_LONG_EDGE / Math.max(rawW, rawH));
  const w = Math.max(1, Math.round(rawW * scale));
  const h = Math.max(1, Math.round(rawH * scale));

  // createImageBitmap's own resize option replaces the extra main-thread
  // canvas draw the old inline version needed to apply the cap — one less
  // full-size buffer touched on the main thread before handing off.
  const bitmap = await createImageBitmap(imgEl, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  const worker = _ensureFilterWorker();
  const result = await _filterWorkerRequest(worker, { type: 'filterPhoto', bitmap, mode }, [bitmap]);
  return new Blob([result.bytes], { type: 'image/jpeg' });
}
