// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  scanFilter.js — pixel filter for jpg2pdf's "Scan with Camera" capture
//
//  Pure, plain-<canvas> functions copied from js/cleanScanUI.js's live
//  preview (grayscale → background-estimate → flat-field-correct →
//  median-filter → unsharp-mask → enhance), same duplication precedent
//  js/cleanScanWorker.js already establishes for this exact pipeline
//  (worker needs OffscreenCanvas and can't ES-import; this module needs
//  its own copy for the same reason — no shared import target exists
//  that both a classic Worker and a decoded-photo-on-main-thread flow
//  could both use without adding a third variant). Kept in sync manually
//  with cleanScanUI.js/cleanScanWorker.js if the algorithm ever changes.
//
//  Deliberately 'enhance' mode only (contrast/brightness boost, no Otsu
//  threshold/binarization/despeckle) — matches Clean Scan's non-destructive
//  branch, appropriate for a freshly-captured photo of unknown quality.
//  Output is always grayscale (js/cleanScanWorker.js's own pipeline does
//  this unconditionally too, before either mode branch) — no color mode.
// ============================================================

const BG_LONG_EDGE = 64;
const _STRENGTH = 0.5; // fixed default — no exposed UI control in v1

function _toGrayscaleCanvas(src) {
  const dst = document.createElement('canvas');
  dst.width = src.width; dst.height = src.height;
  const ctx = dst.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, dst.width, dst.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return dst;
}

function _estimateBackground(gray) {
  const w = gray.width, h = gray.height;
  const scale = Math.min(1, BG_LONG_EDGE / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * scale)), sh = Math.max(1, Math.round(h * scale));

  const small = document.createElement('canvas');
  small.width = sw; small.height = sh;
  const sctx = small.getContext('2d');
  sctx.imageSmoothingEnabled = true; sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(gray, 0, 0, sw, sh);

  const bg = document.createElement('canvas');
  bg.width = w; bg.height = h;
  const bctx = bg.getContext('2d');
  bctx.imageSmoothingEnabled = true; bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(small, 0, 0, w, h);
  return bg;
}

function _flatFieldCorrect(gray, bg) {
  const w = gray.width, h = gray.height;
  const gctx = gray.getContext('2d'), bctx = bg.getContext('2d');
  const gImg = gctx.getImageData(0, 0, w, h), bImg = bctx.getImageData(0, 0, w, h);
  const gd = gImg.data, bd = bImg.data;
  for (let i = 0; i < gd.length; i += 4) {
    const bgv = bd[i] < 1 ? 1 : bd[i];
    const v   = Math.min(255, Math.max(0, (gd[i] / bgv) * 255));
    gd[i] = gd[i + 1] = gd[i + 2] = v;
  }
  gctx.putImageData(gImg, 0, 0);
  return gray;
}

// Exported (unlike the rest of this file's canvas-wrapped helpers, which
// need a real DOM <canvas>/getContext('2d') — no polyfill in this project,
// same as Clean Scan itself never having a Node-level pixel test) because
// this one operates on a raw pixel array, not a canvas — genuinely testable
// in plain Node. See tests/scanFilter.test.js.
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

function _applyMedianFilter(gray) {
  const w = gray.width, h = gray.height;
  const ctx = gray.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const med = medianFilterGray(d, w, h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) d[i] = d[i + 1] = d[i + 2] = med[p];
  ctx.putImageData(img, 0, 0);
  return gray;
}

// Exported for the same reason as medianFilterGray above.
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

function _unsharpMask(gray, radius, amount) {
  const w = gray.width, h = gray.height;
  const ctx = gray.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const blurred = boxBlurGray(d, w, h, radius);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const v = d[i] + amount * (d[i] - blurred[p]);
    const c = Math.min(255, Math.max(0, v));
    d[i] = d[i + 1] = d[i + 2] = c;
  }
  ctx.putImageData(img, 0, 0);
  return gray;
}

function _applyEnhance(canvas, strength) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const contrast   = 1 + strength * 1.2;
  const brightness = strength * 40;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i];
    const c = Math.min(255, Math.max(0, (v - 128) * contrast + 128 + brightness));
    d[i] = d[i + 1] = d[i + 2] = c;
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Runs the full clean-scan-style enhance pipeline on a decoded photo and
 * returns a filtered JPEG Blob. `imgEl` can be any CanvasImageSource with
 * natural dimensions (a decoded <img>, an ImageBitmap, ...).
 * @param {CanvasImageSource & {naturalWidth?: number, width?: number}} imgEl
 * @returns {Promise<Blob>}
 */
export function filterScanPhoto(imgEl) {
  const w = imgEl.naturalWidth || imgEl.width;
  const h = imgEl.naturalHeight || imgEl.height;
  const src = document.createElement('canvas');
  src.width = w; src.height = h;
  src.getContext('2d').drawImage(imgEl, 0, 0);

  const gray = _toGrayscaleCanvas(src);
  const bg   = _estimateBackground(gray);
  _flatFieldCorrect(gray, bg);
  _applyMedianFilter(gray);
  _unsharpMask(gray, 2, 2.0);
  _applyEnhance(gray, _STRENGTH);

  return new Promise(res => gray.toBlob(res, 'image/jpeg', 0.87));
}
