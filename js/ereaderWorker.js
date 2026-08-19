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
//                                                 // global+reconciled on the
//                                                 // main thread
//            columnSplit: {centerFrac: number} | null,  // page-absolute
//                                                 // fraction (not relative to
//                                                 // cropRect) — v2 addition,
//                                                 // see js/ereaderCrop.js's
//                                                 // detectColumnGutter/
//                                                 // reconcileColumnSplit.
//                                                 // When present, this ONE
//                                                 // source page produces TWO
//                                                 // output pages (left column,
//                                                 // then right) — or THREE if
//                                                 // _findHeaderBottom detects
//                                                 // a full-width title/byline
//                                                 // band above the real column
//                                                 // body (header, then left,
//                                                 // then right) — each output
//                                                 // page already independently
//                                                 // "contain"-fit toward the
//                                                 // device ratio — composeWithAspect
//                                                 // on a full page doesn't apply
//                                                 // to a column-width crop.
//            grayscale: boolean, contrast: 0..1, quality: 0..1,
//            outputWidth, outputHeight }          // one fixed size for
//                                                  // every output page (the
//                                                  // target device aspect
//                                                  // ratio)
//    out → { type: 'pageDone', index, pages: [{bytes: ArrayBuffer, format: 'jpeg', width, height}, ...] }
//                                          // 1 entry normally, 2 or 3 when
//                                          // columnSplit produced a
//                                          // left+right pair (optionally
//                                          // preceded by a header page)
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

async function handleProcessPage({ index, bitmap, cropRect, columnSplit, grayscale, contrast, quality, outputWidth, outputHeight }) {
  const srcW = bitmap.width, srcH = bitmap.height;
  const src = new OffscreenCanvas(srcW, srcH);
  src.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const cropSx = cropRect.left * srcW;
  const cropEx = cropRect.right * srcW;
  const sy = Math.round(cropRect.top * srcH);
  const sh = Math.max(1, Math.round((cropRect.bottom - cropRect.top) * srcH));

  const pages = [];
  const transfer = [];

  if (columnSplit) {
    // Split point is clamped inside the crop, and each half must clear a
    // small minimum width — protects a page that doesn't actually have the
    // document's detected gutter (e.g. a full-bleed figure) from collapsing
    // to a near-zero-width sliver; falls back to a single uncut page instead.
    const splitXpx  = Math.min(cropEx - 1, Math.max(cropSx + 1, columnSplit.centerFrac * srcW));
    const minHalfPx = (cropEx - cropSx) * 0.1;
    const leftW  = splitXpx - cropSx;
    const rightW = cropEx - splitXpx;

    if (leftW >= minHalfPx && rightW >= minHalfPx) {
      // A title/byline block spanning the FULL page width (common on a
      // paper's first page, sitting above the real 2-column body) would
      // otherwise get sliced in half at splitXpx — neither resulting page
      // shows the complete title. Found on a real test paper, not a
      // synthetic edge case. _findHeaderBottom looks for where the gutter
      // itself actually starts being reliably blank top-to-bottom; anything
      // above that is real full-width content and gets its own page instead
      // of being split.
      const headerBottom = _findHeaderBottom(src, cropSx, cropEx, sy, sh, splitXpx);

      if (headerBottom !== null) {
        const header    = await _renderSubPage(src, cropSx, sy, cropEx - cropSx, headerBottom - sy, outputWidth, outputHeight, grayscale, contrast, quality);
        const bodySy    = headerBottom;
        const bodySh    = sy + sh - headerBottom;
        const left      = await _renderSubPage(src, cropSx, bodySy, leftW, bodySh, outputWidth, outputHeight, grayscale, contrast, quality);
        const right     = await _renderSubPage(src, splitXpx, bodySy, rightW, bodySh, outputWidth, outputHeight, grayscale, contrast, quality);
        pages.push(header, left, right);
        transfer.push(header.bytes, left.bytes, right.bytes);
      } else {
        const left  = await _renderSubPage(src, cropSx, sy, leftW, sh, outputWidth, outputHeight, grayscale, contrast, quality);
        const right = await _renderSubPage(src, splitXpx, sy, rightW, sh, outputWidth, outputHeight, grayscale, contrast, quality);
        pages.push(left, right);
        transfer.push(left.bytes, right.bytes);
      }
    }
  }

  if (!pages.length) {
    const single = await _renderSubPage(src, cropSx, sy, cropEx - cropSx, sh, outputWidth, outputHeight, grayscale, contrast, quality);
    pages.push(single);
    transfer.push(single.bytes);
  }

  self.postMessage({ type: 'pageDone', index, pages }, transfer);
}

// Detect a full-width header band sitting above the real 2-column body, by
// probing a thin vertical strip centered on the split point: real column
// body rows have the gutter genuinely blank (that's what made splitXpx get
// detected in the first place), but a full-width title/byline row has ink
// running straight through where the gutter would be. Walk down from the
// crop's own top and find where a SUSTAINED run of gutter-blank rows
// begins — not just one blank row, so a stray gap between the title and
// the abstract heading can't be mistaken for the real column start.
// Returns an absolute source-pixel Y, or null if no header band is found
// (the common case — most pages are body-only, gutter blank from the top).
const _HEADER_PROBE_FRAC    = 0.01; // half-width of the probe strip, as a fraction of crop width
const _HEADER_INK_TOLERANCE = 12;   // same "ink" definition as ereaderCrop.js's contentBBox
const _HEADER_MIN_RUN_FRAC  = 0.03; // minimum consecutive blank rows to trust as "body started"
const _HEADER_MIN_RUN_PX    = 20;
const _HEADER_MAX_FRAC      = 0.5;  // never treat more than half the page as "header" — a false
                                     // positive here is far more costly (destroys real content)
                                     // than occasionally missing a genuine header band

function _findHeaderBottom(src, cropSx, cropEx, sy, sh, splitXpx) {
  const cropWidth = cropEx - cropSx;
  const probeHalf = Math.max(2, Math.round(cropWidth * _HEADER_PROBE_FRAC));
  const px0 = Math.max(cropSx, Math.round(splitXpx - probeHalf));
  const px1 = Math.min(cropEx, Math.max(px0 + 1, Math.round(splitXpx + probeHalf)));
  const probeWidth = px1 - px0;
  if (probeWidth <= 0 || sh <= 0) return null;

  const ctx = src.getContext('2d');
  const { data } = ctx.getImageData(px0, sy, probeWidth, sh);
  const threshold = 255 - _HEADER_INK_TOLERANCE;

  const rowHasInk = new Uint8Array(sh);
  for (let row = 0; row < sh; row++) {
    const rowBase = row * probeWidth;
    for (let x = 0; x < probeWidth; x++) {
      const i = (rowBase + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum < threshold) { rowHasInk[row] = 1; break; }
    }
  }

  const minRun = Math.max(_HEADER_MIN_RUN_PX, Math.round(sh * _HEADER_MIN_RUN_FRAC));
  let blankRun = 0;
  for (let row = 0; row < sh; row++) {
    if (rowHasInk[row]) { blankRun = 0; continue; }
    blankRun++;
    if (blankRun >= minRun) {
      const headerBottom = row - minRun + 1;
      if (headerBottom <= 0) return null; // gutter already blank from the top — no header
      if (headerBottom > sh * _HEADER_MAX_FRAC) return null; // implausibly large, don't trust it
      return sy + headerBottom;
    }
  }
  return null; // gutter never reliably clears — can't confirm a body start, leave unsplit-header behavior
}

// Crop one source rect (in source-bitmap pixels), "contain" fit it into the
// fixed output canvas, apply grayscale/contrast, encode JPEG. Shared by both
// the normal single-page path and each half of a column split.
async function _renderSubPage(src, sx, sy, sw, sh, outputWidth, outputHeight, grayscale, contrast, quality) {
  sw = Math.max(1, Math.round(sw));
  sh = Math.max(1, Math.round(sh));
  sx = Math.round(sx);

  const out = new OffscreenCanvas(outputWidth, outputHeight);
  const octx = out.getContext('2d');
  octx.fillStyle = '#fff';
  octx.fillRect(0, 0, outputWidth, outputHeight);

  // "Contain" fit: scale the cropped region to fit fully inside the fixed
  // output canvas, centered, preserving its aspect ratio. Any residual
  // mismatch between the cropped box's aspect and the device target
  // (composeWithAspect on the main thread already minimized this for the
  // non-split case, but clamping at the page edge can leave some — and a
  // column half never goes through composeWithAspect at all) becomes plain
  // white letterbox/pillarbox margin here — never a crop, never a stretch.
  const scale = Math.min(outputWidth / sw, outputHeight / sh);
  const drawW = sw * scale, drawH = sh * scale;
  const dx = (outputWidth - drawW) / 2, dy = (outputHeight - drawH) / 2;
  octx.drawImage(src, sx, sy, sw, sh, dx, dy, drawW, drawH);

  if (grayscale) _applyGrayscale(octx, outputWidth, outputHeight);
  _applyContrast(octx, outputWidth, outputHeight, contrast ?? 0.5);

  const blob  = await out.convertToBlob({ type: 'image/jpeg', quality: quality ?? 0.85 });
  const bytes = await blob.arrayBuffer();
  return { bytes, format: 'jpeg', width: outputWidth, height: outputHeight };
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
