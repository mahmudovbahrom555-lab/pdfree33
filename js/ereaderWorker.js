// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  ereaderWorker.js — Dedicated Web Worker for the E-Reader Optimizer
//  (margin auto-crop + grayscale/contrast, rebuilt for a target device
//  aspect ratio — Kindle / Kobo / reMarkable)
//
//  Deliberately NOT part of worker.js (off-limits per CLAUDE.md). Follows
//  cleanScanWorker.js's two-message-type shape (pdf.js has no working
//  in-Worker precedent in this codebase — js/processor.js's _runEreader
//  renders each page on the main thread and samples a subset of pages
//  up front to compute one global crop rect via js/ereaderCrop.js before
//  any worker message is sent).
//
//  Message contract:
//    in  → { type: 'processPage', index, bitmap: ImageBitmap,
//            cropRect: {top,bottom,left,right},  // 0..1 fractions of the
//                                                 // SOURCE bitmap — already
//                                                 // global+reconciled+
//                                                 // aspect-composed on the
//                                                 // main thread
//            grayscale: boolean, contrast: 0..1, quality: 0..1,
//            outputWidth, outputHeight }          // one fixed size for
//                                                  // every page (the target
//                                                  // device aspect ratio)
//    out → { type: 'pageDone', index, bytes: ArrayBuffer, format: 'jpeg', width, height }
//
//    in  → { type: 'assemble', pages: [{index, bytes, format, width, height}],
//            pageSize: {width, height} }  // ONE shared size, not a per-page
//                                          // array like cleanScanWorker's —
//                                          // deliberate: after letterboxing
//                                          // every page to the same device
//                                          // aspect ratio, all output pages
//                                          // ARE the same physical size
//                                          // (that's the point of this tool,
//                                          // unlike Clean Scan which
//                                          // preserves each page's own size)
//    out → { type: 'progress', value, label } | { type: 'done', result, pageCount } | { type: 'error', message }
// ============================================================

importScripts('./vendor/pdf-lib.min.js');

self.onmessage = async (e) => {
  try {
    const { type } = e.data;
    if (type === 'processPage') {
      await handleProcessPage(e.data);
    } else if (type === 'assemble') {
      await handleAssemble(e.data.pages, e.data.pageSize);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

function progress(value, label) {
  self.postMessage({ type: 'progress', value, label });
}

// ── Per-page pixel pipeline ─────────────────────────────────────

async function handleProcessPage({ index, bitmap, cropRect, grayscale, contrast, quality, outputWidth, outputHeight }) {
  const srcW = bitmap.width, srcH = bitmap.height;
  const src = new OffscreenCanvas(srcW, srcH);
  src.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const sx = Math.round(cropRect.left * srcW);
  const sy = Math.round(cropRect.top * srcH);
  const sw = Math.max(1, Math.round((cropRect.right - cropRect.left) * srcW));
  const sh = Math.max(1, Math.round((cropRect.bottom - cropRect.top) * srcH));

  const out = new OffscreenCanvas(outputWidth, outputHeight);
  const octx = out.getContext('2d');
  octx.fillStyle = '#fff';
  octx.fillRect(0, 0, outputWidth, outputHeight);

  // "Contain" fit: scale the cropped region to fit fully inside the fixed
  // output canvas, centered, preserving its aspect ratio. Any residual
  // mismatch between the cropped box's aspect and the device target
  // (composeWithAspect on the main thread already minimized this, but
  // clamping at the page edge can leave some) becomes plain white
  // letterbox/pillarbox margin here — never a crop, never a stretch.
  const scale = Math.min(outputWidth / sw, outputHeight / sh);
  const drawW = sw * scale, drawH = sh * scale;
  const dx = (outputWidth - drawW) / 2, dy = (outputHeight - drawH) / 2;
  octx.drawImage(src, sx, sy, sw, sh, dx, dy, drawW, drawH);

  if (grayscale) _applyGrayscale(octx, outputWidth, outputHeight);
  _applyContrast(octx, outputWidth, outputHeight, contrast ?? 0.5);

  const blob  = await out.convertToBlob({ type: 'image/jpeg', quality: quality ?? 0.85 });
  const bytes = await blob.arrayBuffer();

  self.postMessage(
    { type: 'pageDone', index, bytes, format: 'jpeg', width: outputWidth, height: outputHeight },
    [bytes]
  );
}

// Grayscale — same ITU-R BT.601 weights as cleanScanWorker.js's
// _toGrayscaleCanvas (proven for scanned-page pre-processing in this
// codebase), applied in place on the already-composited output canvas.
function _applyGrayscale(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
}

// Verbatim port of cleanScanWorker.js's _applyEnhance formula — this tool
// is enhance-only by design (no Otsu threshold, no despeckle, no unsharp
// mask; those are scan-restoration steps, out of scope for margin/contrast
// optimization of an already-legible PDF). Applied per-channel so it works
// whether or not grayscale ran first (r===g===b after grayscale, so the
// per-channel math degenerates to the same single curve either way).
function _applyContrast(ctx, w, h, strength) {
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

// ── Final assembly ───────────────────────────────────────────────

async function handleAssemble(pages, pageSize) {
  const { PDFDocument } = self.PDFLib;
  progress(90, 'Assembling PDF…');

  const outDoc = await PDFDocument.create();
  const sorted = [...pages].sort((a, b) => a.index - b.index);
  const size   = pageSize || { width: 612, height: 816 };

  for (const p of sorted) {
    const img  = await outDoc.embedJpg(new Uint8Array(p.bytes));
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
