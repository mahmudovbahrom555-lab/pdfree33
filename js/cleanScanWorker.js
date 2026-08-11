// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  cleanScanWorker.js — Dedicated Web Worker for Clean Scan
//  (whiten scanned-document backgrounds)
//
//  Deliberately NOT part of worker.js (off-limits per CLAUDE.md).
//  Two message types, not one — unlike organizeWorker.js/resizeWorker.js's
//  single load→process→save shot, Clean Scan needs pdf.js to render each
//  page, and pdf.js has no working precedent in this codebase for running
//  inside a Worker (every existing worker only ever does pdf-lib/pixel
//  work — pdf.js rendering always stays main-thread here, see ocrUI.js/
//  pdf2jpgUI.js). So js/processor.js's _runCleanScan renders each page on
//  the main thread and sends this worker one ImageBitmap at a time; only
//  the final assembly step needs pdf-lib.
//
//  Message contract:
//    in  → { type: 'processPage', index, bitmap: ImageBitmap, mode: 'clean'|'enhance', strength: 0..1 }
//    out → { type: 'pageDone', index, bytes: ArrayBuffer, format: 'png'|'jpeg', width, height }
//
//    in  → { type: 'assemble', pages: [{index, bytes, format, width, height}], pageSizes: [{width, height}] }
//    out → { type: 'progress', value, label } | { type: 'done', result, pageCount } | { type: 'error', message }
// ============================================================

importScripts('./vendor/pdf-lib.min.js');

self.onmessage = async (e) => {
  try {
    const { type } = e.data;
    if (type === 'processPage') {
      await handleProcessPage(e.data.index, e.data.bitmap, e.data.mode, e.data.strength);
    } else if (type === 'assemble') {
      await handleAssemble(e.data.pages, e.data.pageSizes);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

function progress(value, label) {
  self.postMessage({ type: 'progress', value, label });
}

// ── Per-page pixel pipeline ─────────────────────────────────────

async function handleProcessPage(index, bitmap, mode, strength) {
  const w = bitmap.width, h = bitmap.height;
  const src = new OffscreenCanvas(w, h);
  src.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const gray = _toGrayscaleCanvas(src);
  const bg   = _estimateBackground(gray);
  _flatFieldCorrect(gray, bg);
  _applyMedianFilter(gray);
  _unsharpMask(gray, 2, 2.0);

  if (mode === 'enhance') _applyEnhance(gray, strength);
  else _applyClean(gray, strength);

  const format = mode === 'enhance' ? 'jpeg' : 'png';
  const blob   = mode === 'enhance'
    ? await gray.convertToBlob({ type: 'image/jpeg', quality: 0.87 })
    : await gray.convertToBlob({ type: 'image/png' });
  const bytes  = await blob.arrayBuffer();

  self.postMessage({ type: 'pageDone', index, bytes, format, width: w, height: h }, [bytes]);
}

// Grayscale — same ITU-R BT.601 weights as js/ocrUI.js's _toGrayscale
// (proven for scanned-page OCR pre-processing), ported from a DOM <canvas>
// to OffscreenCanvas — only the canvas-construction call differs, the
// getImageData/putImageData pixel math is identical and Worker-safe as-is.
function _toGrayscaleCanvas(srcCanvas) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const dst = new OffscreenCanvas(w, h);
  const ctx = dst.getContext('2d');
  ctx.drawImage(srcCanvas, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return dst;
}

// Flat-field background estimate: downsample to a small buffer (canvas's
// built-in image smoothing acts as a cheap low-pass filter — no explicit
// Gaussian blur needed) then upsample back to full size. This slowly-
// varying result approximates the page's own uneven illumination/shadow
// (e.g. the darker gutter near a book's spine), cheaply enough to run
// live in a browser — the practical middle ground between a single global
// threshold (too weak for uneven lighting) and full local-window adaptive
// binarization (Sauvola et al — accurate but expensive; left for a future
// version if this approximation proves insufficient on real scans).
const _BG_LONG_EDGE = 64;

function _estimateBackground(grayCanvas) {
  const w = grayCanvas.width, h = grayCanvas.height;
  const scale  = Math.min(1, _BG_LONG_EDGE / Math.max(w, h));
  const smallW = Math.max(1, Math.round(w * scale));
  const smallH = Math.max(1, Math.round(h * scale));

  const small = new OffscreenCanvas(smallW, smallH);
  const sctx  = small.getContext('2d');
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(grayCanvas, 0, 0, smallW, smallH);

  const bg   = new OffscreenCanvas(w, h);
  const bctx = bg.getContext('2d');
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(small, 0, 0, w, h);
  return bg;
}

// Flat-fielding (division correction), the standard photography/microscopy
// technique for uneven illumination: divide the actual pixel by the
// estimated local background and renormalize to white. Mutates and
// returns `grayCanvas` in place.
function _flatFieldCorrect(grayCanvas, bgCanvas) {
  const w = grayCanvas.width, h = grayCanvas.height;
  const gctx = grayCanvas.getContext('2d');
  const bctx = bgCanvas.getContext('2d');
  const gImg = gctx.getImageData(0, 0, w, h);
  const bImg = bctx.getImageData(0, 0, w, h);
  const gd = gImg.data, bd = bImg.data;
  for (let i = 0; i < gd.length; i += 4) {
    const bg = bd[i] < 1 ? 1 : bd[i];
    const v  = Math.min(255, Math.max(0, (gd[i] / bg) * 255));
    gd[i] = gd[i + 1] = gd[i + 2] = v;
  }
  gctx.putImageData(gImg, 0, 0);
  return grayCanvas;
}

// Median filter (3x3) — must run BEFORE the unsharp mask below, not after.
// Sharpening amplifies whatever high-frequency signal is already there,
// noise included: a single isolated dust/grain pixel gets its neighbors
// pulled darker too by the unsharp pass (a box blur average always leans
// slightly toward its darkest neighbor), turning a 1px speck into a small
// connected blob that then survives _despeckleMask's "has a dark neighbor"
// check. A median filter is the standard fix for exactly this class of
// noise — unlike a mean/box blur it doesn't soften real edges, it just
// replaces outlier pixels (which is what isolated noise is) with their
// neighborhood's median value. Denoise, then sharpen — never the reverse.
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

function _applyMedianFilter(grayCanvas) {
  const w = grayCanvas.width, h = grayCanvas.height;
  const ctx = grayCanvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const med = _medianFilterGray(d, w, h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) d[i] = d[i + 1] = d[i + 2] = med[p];
  ctx.putImageData(img, 0, 0);
  return grayCanvas;
}

// Unsharp mask — local contrast boost so soft/anti-aliased text edges read
// as crisp instead of blurred, independent of the darkening curve below
// (that curve only remaps a pixel's own intensity; it can't sharpen an
// edge that's genuinely soft across several pixels). This is the standard
// manual Photoshop fix for exactly this — duplicate the layer, Filter >
// Other > High Pass at a small radius, set that layer's blend mode to
// Linear Light. Both steps reduce to closed-form pixel math:
//   High Pass(r)   = (original − blur(original, r)) + 128
//   Linear Light   = base + 2×blend − 255
// Substituting one into the other collapses to the classic unsharp-mask
// formula, so that's what's implemented directly rather than emulating
// two separate filter/blend passes:
//   result = original + amount × (original − blur(original, r))
// radius=2 matches the small radius that tutorial uses (this needs to
// sharpen text-stroke edges, not undo the large-radius background-
// illumination blur above); amount=2 matches what Linear Light's ×2 term
// actually contributes.
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

function _unsharpMask(grayCanvas, radius, amount) {
  const w = grayCanvas.width, h = grayCanvas.height;
  const ctx = grayCanvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const blurred = _boxBlurGray(d, w, h, radius);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const v = d[i] + amount * (d[i] - blurred[p]);
    const c = Math.min(255, Math.max(0, v));
    d[i] = d[i + 1] = d[i + 2] = c;
  }
  ctx.putImageData(img, 0, 0);
  return grayCanvas;
}

// Otsu's method — verbatim port of js/ocrUI.js's _otsuThreshold (already
// proven in production for scanned-page binarization there). Maximizes
// between-class variance from a 256-bin histogram to find a page-adaptive
// cutoff, rather than a single fixed value that works for one scan and
// not the next.
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

// Clean (Hard) mode: threshold the flat-field-corrected image. The
// Strength slider (0..1, default 0.5) nudges the Otsu-computed baseline
// rather than making the user pick a raw 0–255 number from scratch.
//
// Darkening is a gamma curve on each pixel's distance below the threshold,
// not a flat offset or a hard 0/255 split — real-world feedback (across
// three rounds against an actual scanned book page, not just a synthetic
// test) settled on gamma=3/darkCap=20: sub-threshold pixels now land in a
// narrow near-black band (0–20) instead of a genuinely graduated one, i.e.
// close to hard binarization but keeping a sliver of range so the very
// faintest classified-as-text edge pixels aren't bit-identical to solid
// ink. Earlier, gentler curves (flat "-30", then gamma=2.2/darkCap=90,
// then gamma=2.4/darkCap=45) were each an improvement but still read as
// "gray, not dark enough" once tested on real text instead of a synthetic
// gradient — same asymmetric correction a manual Photoshop cleanup gets
// from pulling the Levels/Curves black-input slider hard toward the
// midtones after isolating the background, just pulled further than the
// first two attempts.
const _CLEAN_GAMMA    = 3.0;
const _CLEAN_DARK_CAP = 20; // sub-threshold ("text") pixels never render lighter than this

// Despeckle: drop dark pixels with no dark neighbor before darkening them.
// Scanner dust and halftone/JPEG grain that survives the threshold as
// "text" shows up as isolated 1px specks; real ink strokes are always at
// least a couple of connected pixels wide at the render scales this tool
// uses (2–3x). A pixel with zero dark 8-neighbors is specifically the
// former, never the latter — clearing it removes the residual fleck noise
// on the whitened background without ever eroding real, if thin, strokes.
function _despeckleMask(mask, w, h) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const p = row + x;
      if (!mask[p]) continue;
      let hasNeighbor = false;
      for (let dy = -1; dy <= 1 && !hasNeighbor; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        const nrow = ny * w;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          if (mask[nrow + nx]) { hasNeighbor = true; break; }
        }
      }
      out[p] = hasNeighbor ? 1 : 0;
    }
  }
  return out;
}

function _applyClean(canvas, strength) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const base  = _otsuThreshold(d);
  const shift = ((strength ?? 0.5) - 0.5) * 80; // ±40 around the auto baseline
  const t = Math.min(250, Math.max(5, base + shift));

  const n = w * h;
  let mask = new Uint8Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) mask[p] = d[i] < t ? 1 : 0;
  mask = _despeckleMask(mask, w, h);

  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (!mask[p]) { d[i] = d[i + 1] = d[i + 2] = 255; }
    else {
      const v = d[i];
      const dark = Math.round(((v / t) ** _CLEAN_GAMMA) * _CLEAN_DARK_CAP);
      d[i] = d[i + 1] = d[i + 2] = dark;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Enhance (Soft) mode: brightness/contrast, no binarization — keeps
// stamps, signatures, and photos on the page recognizable.
function _applyEnhance(canvas, strength) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const s = strength ?? 0.5;
  const contrast   = 1 + s * 1.2;
  const brightness = s * 40;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i];
    const c = Math.min(255, Math.max(0, (v - 128) * contrast + 128 + brightness));
    d[i] = d[i + 1] = d[i + 2] = c;
  }
  ctx.putImageData(img, 0, 0);
}

// ── Final assembly ───────────────────────────────────────────────

async function handleAssemble(pages, pageSizes) {
  const { PDFDocument } = self.PDFLib;
  progress(90, 'Assembling PDF…');

  const outDoc = await PDFDocument.create();
  const sorted = [...pages].sort((a, b) => a.index - b.index);

  for (let i = 0; i < sorted.length; i++) {
    const p    = sorted[i];
    const size = pageSizes[i] || { width: 595.28, height: 841.89 };
    const img  = p.format === 'jpeg'
      ? await outDoc.embedJpg(new Uint8Array(p.bytes))
      : await outDoc.embedPng(new Uint8Array(p.bytes));
    const page = outDoc.addPage([size.width, size.height]);
    page.drawImage(img, { x: 0, y: 0, width: size.width, height: size.height });
  }

  progress(97, 'Saving…');
  const bytes = await outDoc.save();
  self.postMessage(
    { type: 'done', result: bytes.buffer, pageCount: sorted.length },
    [bytes.buffer]
  );
}
