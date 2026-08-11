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
// Sub-threshold pixels get darkened, not a hard drop to 0 — hard
// binarization destroys anti-aliased edges on small text.
//
// Darkening is a gamma curve on each pixel's distance below the threshold,
// not a flat offset — a flat "-30" barely dented faint/thin/anti-aliased
// strokes near the threshold (e.g. a pixel at 180 stayed a washed-out 150,
// the "letters aren't dark enough" bug), while ink that was already near-
// black needed no help at all and got the same treatment for nothing.
// Normalizing each pixel to its fraction of the threshold and raising it to
// gamma>1 pulls faint strokes toward black hard while barely touching ink
// that's already dark — the same asymmetric correction a manual Photoshop
// cleanup gets from pulling the Levels/Curves black-input slider toward the
// midtones after isolating the background.
function _applyClean(canvas, strength) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const base  = _otsuThreshold(d);
  const shift = ((strength ?? 0.5) - 0.5) * 80; // ±40 around the auto baseline
  const t = Math.min(250, Math.max(5, base + shift));
  const gamma   = 2.2;
  const darkCap = 90; // sub-threshold ("text") pixels never render lighter than this
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i];
    if (v >= t) { d[i] = d[i + 1] = d[i + 2] = 255; }
    else {
      const dark = Math.round(((v / t) ** gamma) * darkCap);
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
