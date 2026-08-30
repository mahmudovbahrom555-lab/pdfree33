// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  scanFilterWorker.js — Dedicated Web Worker for Document Scanner's
//  photo filter pipeline (grayscale → background-estimate →
//  flat-field-correct → unsharp-mask → enhance — no median filter for the
//  default Document/grayscale mode, see the comment at its call site for
//  why; 'bw' mode still uses one).
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
//    in  → { type: 'filterPhoto', bitmap: ImageBitmap, mode: 'grayscale'|'color'|'bw'|'original' }
//    out → { type: 'filtered', bytes: ArrayBuffer } | { type: 'error', message }
//
//  'bw' and 'original' added after a live competitor comparison (a
//  scanner app's Original/Photo/Document/B&W tabs) — 'bw' reuses
//  js/cleanScanWorker.js's own proven Otsu-binarize pipeline (see
//  _applyBw below), 'original' skips all processing entirely.
// ============================================================

self.onmessage = async (e) => {
  try {
    if (e.data.type === 'filterPhoto') {
      await handleFilterPhoto(e.data.bitmap, e.data.mode, e.data.adjust);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

// adjust: {brightness, contrast}, both -50..50, 0=baseline — see
// js/scanFilter.js's own JSDoc for the full contract. Ignored for
// 'original' (nothing to adjust — the whole point of that mode).
async function handleFilterPhoto(bitmap, mode, adjust) {
  const w = bitmap.width, h = bitmap.height;
  const src = new OffscreenCanvas(w, h);
  src.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();

  let blob;
  if (mode === 'original') {
    // No processing at all — real competitive gap found comparing against
    // a competitor app's "Original" tab: a user who deliberately wants
    // their untouched photo (e.g. a document with color-coded stamps/
    // highlights the flat-field/grayscale pipeline would otherwise strip)
    // had no way to opt out of every other mode's processing.
    blob = await src.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  } else if (mode === 'color') {
    const gray = _toGrayscaleCanvas(src);
    const bg   = _estimateBackground(gray);
    _flatFieldCorrectColor(src, bg);
    _applyEnhanceColor(src, _STRENGTH, adjust);
    blob = await src.convertToBlob({ type: 'image/jpeg', quality: 0.87 });
  } else if (mode === 'bw') {
    // Real competitive gap found comparing against a competitor app's
    // "Ч/Б" (B&W) toggle — a true binarized scan look, not just a
    // grayscale photo. Reuses js/cleanScanWorker.js's own Otsu-threshold +
    // despeckle + gamma-darken pipeline verbatim (_applyBw below) instead
    // of inventing new constants — that algorithm was already tuned
    // across 3 real rounds against an actual scanned book page before
    // shipping there; no reason to re-derive it from scratch here.
    const gray = _toGrayscaleCanvas(src);
    const bg   = _estimateBackground(gray);
    _flatFieldCorrect(gray, bg);
    _applyMedianFilter(gray);
    _unsharpMask(gray, 2, 2.0);
    _applyBw(gray, _STRENGTH, adjust);
    blob = await gray.convertToBlob({ type: 'image/png' });
  } else {
    // No _applyMedianFilter here (unlike 'bw' above) — a real user photo
    // comparison (a document with two QR codes of different module density)
    // found the 3x3 median filter destroying the finer/denser QR into pure
    // noise while the coarser one survived: an isolated 1-2px dark QR module
    // surrounded by white pixels reads as "noise" to a median filter and
    // gets erased, exactly like camera sensor grain would. Cross-checked
    // against CleanSCAN (github.com/clean-apps/CleanSCAN, a real reference
    // scanner app's native OpenCV pipeline) — its own Document-equivalent
    // mode (getGrayBitmap) is a bare grayscale conversion with NO denoising
    // step at all, and its B&W mode's only cleanup is Otsu thresholding, no
    // median filter either. flatFieldCorrect (shadow/lighting correction,
    // divides against a heavily downscaled 64px background estimate) and
    // unsharpMask (edge-enhancing, the opposite direction from a median
    // filter) don't share this failure mode — only the median filter step
    // targeted fine-detail-sized features specifically. Verified live: the
    // same real photo now decodes/renders the previously-destroyed QR code
    // correctly. 'bw' mode above keeps its own median-filter pre-pass —
    // out of scope here, and _applyBw already does its own dedicated
    // despeckle step, so it isn't relying on this one for its only cleanup.
    const gray = _toGrayscaleCanvas(src);
    const bg   = _estimateBackground(gray);
    _flatFieldCorrect(gray, bg);
    _unsharpMask(gray, 2, 2.0);
    _applyEnhance(gray, _STRENGTH, adjust);
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
// Fixed baseline strength — the real brightness/contrast knob is now the
// user-facing adjust param (js/scanDocumentUI.js's Brightness/Contrast
// sliders, -50..50 each), layered on TOP of this constant rather than
// replacing it — 0 on both sliders must reproduce exactly what shipped
// before they existed.
const _STRENGTH = 0.5;

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

// Shared by _applyEnhance/_applyEnhanceColor — adjust.contrast scales the
// strength-derived contrast multiplicatively (±50 ≈ ±50% swing around
// whatever _STRENGTH already produces), adjust.brightness adds directly
// in the same 0-255 units strength's own brightness term already uses.
// Both are 0 by default, reproducing the exact pre-slider baseline.
function _computeContrastBrightness(strength, adjust) {
  const contrast   = (1 + strength * 1.2) * (1 + (adjust?.contrast ?? 0) / 100);
  const brightness = strength * 40 + (adjust?.brightness ?? 0);
  return { contrast, brightness };
}

function _applyEnhance(canvas, strength, adjust) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const { contrast, brightness } = _computeContrastBrightness(strength, adjust);
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

function _applyEnhanceColor(canvas, strength, adjust) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const { contrast, brightness } = _computeContrastBrightness(strength, adjust);
  for (let i = 0; i < d.length; i += 4) {
    d[i]     = Math.min(255, Math.max(0, (d[i]     - 128) * contrast + 128 + brightness));
    d[i + 1] = Math.min(255, Math.max(0, (d[i + 1] - 128) * contrast + 128 + brightness));
    d[i + 2] = Math.min(255, Math.max(0, (d[i + 2] - 128) * contrast + 128 + brightness));
  }
  ctx.putImageData(img, 0, 0);
}

// ── B&W (Otsu binarize + despeckle) — verbatim port of
//    js/cleanScanWorker.js's own _otsuThreshold/_despeckleMask/_applyClean
//    (same "classic Worker, no ES modules" duplication this file's own
//    header already explains for its other pixel functions). Kept in
//    sync manually if that algorithm ever changes; not re-derived or
//    re-tuned here — see that file's own extensive comments for the real
//    reasoning behind gamma=3.0/darkCap=20/minDarkNeighbors=3, each
//    settled via multiple rounds of testing against a real scanned page. ──

function _otsuThreshold(data) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < data.length; i += 4) hist[data[i]]++;
  const total = data.length / 4;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0, sumB = 0, varMax = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) ** 2;
    if (varBetween > varMax) { varMax = varBetween; threshold = t; }
  }
  return threshold;
}

const _BW_GAMMA          = 3.0;
const _BW_DARK_CAP       = 20;
const _BW_MIN_DARK_NEIGHBORS = 3;

function _despeckleMask(mask, w, h, minDarkNeighbors) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!mask[p]) continue;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        const nrow = ny * w;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          if (mask[nrow + nx]) count++;
        }
      }
      out[p] = count >= minDarkNeighbors ? 1 : 0;
    }
  }
  return out;
}

function _applyBw(canvas, strength, adjust) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const base = _otsuThreshold(d);
  // Brightness slider shifts the Otsu threshold — INVERTED (raising
  // brightness must make the output lighter/less ink, but the mask test
  // below is d[i]<t, so a HIGHER t classifies MORE pixels as dark).
  // ±50 maps to a ∓40 shift, comparable magnitude to the pre-existing
  // ±40 strength-only swing this replaces at adjust=0.
  const shift = ((strength ?? 0.5) - 0.5) * 80 - (adjust?.brightness ?? 0) * 0.8;
  const t = Math.min(250, Math.max(5, base + shift));
  // Contrast slider adjusts how dark classified-as-ink pixels render —
  // higher contrast = lower darkCap = blacker text, same direction a
  // real contrast increase has on any other mode.
  const darkCap = Math.min(60, Math.max(0, _BW_DARK_CAP - (adjust?.contrast ?? 0) * 0.3));

  const n = w * h;
  let mask = new Uint8Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) mask[p] = d[i] < t ? 1 : 0;
  mask = _despeckleMask(mask, w, h, _BW_MIN_DARK_NEIGHBORS);

  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (!mask[p]) { d[i] = d[i + 1] = d[i + 2] = 255; }
    else {
      const v = d[i];
      const dark = Math.round(((v / t) ** _BW_GAMMA) * darkCap);
      d[i] = d[i + 1] = d[i + 2] = dark;
    }
  }
  ctx.putImageData(img, 0, 0);
}
