// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  scanFilterWorker.js — Dedicated Web Worker for Document Scanner's
//  photo filter pipeline (grayscale → background-estimate →
//  flat-field-correct → median-filter → unsharp-mask → enhance).
//
//  Moved off the main thread 2026-08-26 after a real, measured finding:
//  on a throttled/weak CPU (6x, proxying a real low-end device), this
//  pipeline alone took ~2.8s of synchronous main-thread work per photo
//  — combined with js/scanGeometry.js's OpenCV corner-detection/warp
//  (still main-thread for now, a separate, harder migration; see that
//  module's own notes), a multi-page scan left the whole page unable to
//  process ANY click (including on unrelated buttons) for 5+ seconds
//  per photo — reported for real as "button presses feel slow."
//
//  Deliberately NOT part of worker.js (off-limits per CLAUDE.md).
//  Single-shot request/response, same style as js/cleanScanWorker.js
//  (this pipeline is in fact the SAME algorithm — js/scanFilter.js's
//  own header has always documented it as "copied from js/cleanScanUI.js's
//  live preview" — this worker is the analogous port for THIS tool,
//  following that file's own proven OffscreenCanvas pattern exactly).
//
//  Message contract:
//    in  → { type: 'filterPhoto', bitmap: ImageBitmap, mode: 'grayscale'|'color' }
//    out → { type: 'filtered', bytes: ArrayBuffer } | { type: 'error', message }
// ============================================================

self.onmessage = async (e) => {
  try {
    if (e.data.type === 'filterPhoto') {
      await handleFilterPhoto(e.data.bitmap, e.data.mode);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

async function handleFilterPhoto(bitmap, mode) {
  const w = bitmap.width, h = bitmap.height;
  const src = new OffscreenCanvas(w, h);
  src.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();

  let blob;
  if (mode === 'color') {
    const gray = _toGrayscaleCanvas(src);
    const bg   = _estimateBackground(gray);
    _flatFieldCorrectColor(src, bg);
    _applyEnhanceColor(src, _STRENGTH);
    blob = await src.convertToBlob({ type: 'image/jpeg', quality: 0.87 });
  } else {
    const gray = _toGrayscaleCanvas(src);
    const bg   = _estimateBackground(gray);
    _flatFieldCorrect(gray, bg);
    _applyMedianFilter(gray);
    _unsharpMask(gray, 2, 2.0);
    _applyEnhance(gray, _STRENGTH);
    blob = await gray.convertToBlob({ type: 'image/jpeg', quality: 0.87 });
  }

  const bytes = await blob.arrayBuffer();
  self.postMessage({ type: 'filtered', bytes }, [bytes]);
}

// ── Pixel pipeline — ported from js/scanFilter.js, OffscreenCanvas
//    instead of a DOM <canvas> (only the canvas-construction call
//    differs; the getImageData/putImageData pixel math is identical
//    and Worker-safe as-is — same porting precedent as
//    js/cleanScanWorker.js). Kept in sync manually if the algorithm
//    ever changes — see js/scanFilter.js's own header for why a shared
//    import isn't possible here (classic Worker, no ES modules). ──

const BG_LONG_EDGE = 64;
const _STRENGTH = 0.5; // fixed default — no exposed UI control in v1

function _toGrayscaleCanvas(src) {
  const dst = new OffscreenCanvas(src.width, src.height);
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

  const small = new OffscreenCanvas(sw, sh);
  const sctx = small.getContext('2d');
  sctx.imageSmoothingEnabled = true; sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(gray, 0, 0, sw, sh);

  const bg = new OffscreenCanvas(w, h);
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

function _medianFilterGray(data, w, h) {
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
  const med = _medianFilterGray(d, w, h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) d[i] = d[i + 1] = d[i + 2] = med[p];
  ctx.putImageData(img, 0, 0);
  return gray;
}

function _boxBlurGray(data, w, h, radius) {
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
  const blurred = _boxBlurGray(d, w, h, radius);
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

function _flatFieldCorrectColor(src, bg) {
  const w = src.width, h = src.height;
  const sctx = src.getContext('2d'), bctx = bg.getContext('2d');
  const sImg = sctx.getImageData(0, 0, w, h), bImg = bctx.getImageData(0, 0, w, h);
  const sd = sImg.data, bd = bImg.data;
  for (let i = 0; i < sd.length; i += 4) {
    const bgv  = bd[i] < 1 ? 1 : bd[i];
    const ratio = 255 / bgv;
    sd[i]     = Math.min(255, Math.max(0, sd[i]     * ratio));
    sd[i + 1] = Math.min(255, Math.max(0, sd[i + 1] * ratio));
    sd[i + 2] = Math.min(255, Math.max(0, sd[i + 2] * ratio));
  }
  sctx.putImageData(sImg, 0, 0);
  return src;
}

function _applyEnhanceColor(canvas, strength) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const contrast   = 1 + strength * 1.2;
  const brightness = strength * 40;
  for (let i = 0; i < d.length; i += 4) {
    d[i]     = Math.min(255, Math.max(0, (d[i]     - 128) * contrast + 128 + brightness));
    d[i + 1] = Math.min(255, Math.max(0, (d[i + 1] - 128) * contrast + 128 + brightness));
    d[i + 2] = Math.min(255, Math.max(0, (d[i + 2] - 128) * contrast + 128 + brightness));
  }
  ctx.putImageData(img, 0, 0);
}
