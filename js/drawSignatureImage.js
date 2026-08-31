// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  drawSignatureImage.js — "Upload a signature image" support for
//  Draw on PDF (js/drawUI.js / js/drawPointer.js).
//
//  A JPG source has no alpha channel at all — placing one straight
//  onto a document would show a solid white/light rectangle around
//  the signature, not just the ink strokes. A PNG "signature scan"
//  from a phone camera very often has the SAME problem despite the
//  format supporting transparency — it just never got a real alpha
//  channel set (every pixel opaque). Converting JPG→PNG alone does
//  NOT fix this — a format change doesn't add missing per-pixel alpha
//  data. What's actually needed is classifying pixels into ink vs.
//  background and making the background transparent.
//
//  Otsu threshold + despeckle ported verbatim from
//  js/scanFilterWorker.js's _applyBw (itself ported from
//  js/cleanScanWorker.js, tuned across 3 real rounds against a real
//  scanned page) — same algorithm, different purpose: there it
//  recolors dark pixels near-black for scan clarity; here it KEEPS the
//  original ink color/tone (a signature may be blue, not black) and
//  makes everything else transparent instead of white.
//
//  Auto-detected, no user-facing toggle: any JPEG always gets
//  background removal (it has no alpha to lose); a PNG only gets it if
//  its alpha channel is uniformly opaque (never had real transparency
//  set) — a PNG with genuine varying alpha is left untouched.
//
//  Runs on the main thread, not a Worker — a signature image is small
//  (downscaled to SIGNATURE_MAX_EDGE below) and this only runs once at
//  upload time, not per-frame/per-interaction, unlike the heavier scan
//  pipelines this project moved off-main-thread after real CPU-
//  throttle measurements. Revisit with a real measurement if this
//  assumption turns out wrong.
// ============================================================

const SIGNATURE_MAX_EDGE = 900; // downscale cap — a signature never needs more detail than this
const MIN_DARK_NEIGHBORS = 3;

// Median-of-histogram Otsu threshold — ported from js/scanFilterWorker.js's
// _otsuThreshold, with one deliberate change: that original builds its
// histogram from the red channel alone, which is a safe approximation there
// because its caller always classifies pixels using that SAME red channel
// (scan input is already near-grayscale, so R stays a reasonable proxy for
// brightness). removeBackground() below classifies pixels by full RGB
// luminance instead (a signature's ink or background can be genuinely
// colored, not just gray) — so the histogram has to be built from that same
// luminance, or the threshold and the classification it's applied to can
// disagree by enough to misfire (confirmed live: a near-black-but-slightly-
// blue ink at luminance 16.14 fell on the wrong side of an R-channel-derived
// threshold of 15, erasing the ink along with the background).
export function otsuThreshold(data) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    hist[Math.round(gray)]++;
  }
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

// Removes isolated "ink" pixels that don't have enough dark neighbors —
// same despeckle logic as js/scanFilterWorker.js's _applyBw, cleans up
// JPEG-compression noise that would otherwise survive as stray opaque
// specks once the background goes transparent.
export function despeckleMask(mask, w, h, minNeighbors = MIN_DARK_NEIGHBORS) {
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
      out[p] = count >= minNeighbors ? 1 : 0;
    }
  }
  return out;
}

// True if `data` (RGBA, stride 4) has any real, meaningful transparency —
// at least one pixel whose alpha differs from the rest. A uniformly-255
// (or uniformly-any-single-value) alpha channel never had real
// transparency set, even in a PNG.
export function hasRealAlpha(data) {
  if (data.length < 4) return false;
  const first = data[3];
  for (let i = 7; i < data.length; i += 4) {
    if (data[i] !== first) return true;
  }
  return false;
}

/**
 * Classifies pixels into ink (dark, kept at original color, fully opaque)
 * vs. background (made fully transparent) via Otsu threshold + despeckle.
 * Mutates `data` (RGBA, stride 4) in place and returns it.
 * @param {Uint8ClampedArray} data
 * @param {number} w
 * @param {number} h
 */
export function removeBackground(data, w, h) {
  const threshold = otsuThreshold(data);
  const n = w * h;
  let mask = new Uint8Array(n); // 1 = ink (keep), 0 = background (make transparent)
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    // Round to match otsuThreshold's own histogram bucketing (Math.round(gray)),
    // and use <= to match its wB/class-B accumulation convention (hist[t] belongs
    // to the "at or below t" class) — comparing a raw float against an integer
    // threshold with strict < silently excludes any pixel whose rounded gray
    // lands exactly on the threshold bucket (confirmed live: real data at
    // gray=16.14 rounds into the threshold-16 bucket for the histogram, but
    // fails a raw `16.14 < 16` check, wrongly dropping it as background).
    mask[p] = Math.round(gray) <= threshold ? 1 : 0;
  }
  mask = despeckleMask(mask, w, h);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    data[i + 3] = mask[p] ? 255 : 0;
  }
  return data;
}

/**
 * Loads a File (PNG or JPEG), auto-strips a light/white background when
 * needed (see header), returns a ready-to-place canvas.
 * @param {File} file
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function loadSignatureImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, SIGNATURE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const imgData = ctx.getImageData(0, 0, w, h);
  const isJpeg = file.type.includes('jpeg') || /\.jpe?g$/i.test(file.name);
  if (isJpeg || !hasRealAlpha(imgData.data)) {
    removeBackground(imgData.data, w, h);
    ctx.putImageData(imgData, 0, 0);
  }

  return canvas;
}
