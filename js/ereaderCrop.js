// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  ereaderCrop.js — Pure margin-detection / crop-reconciliation math
//  for the E-Reader Optimizer tool.
//
//  A real ES module (not worker-embedded), unlike cleanScanWorker.js's
//  pixel functions which have to be hand-duplicated into cleanScanUI.js
//  because classic Workers can't `import`. This module is imported
//  directly by both js/ereaderUI.js (live preview) and js/processor.js
//  (_runEreader) — same "shared pure module" precedent as
//  js/pageSelectorUtils.js, imported by js/extractUI.js.
//
//  All rects are expressed as fractions of the page (0..1), not pixels,
//  so they compose cleanly across pages of different point sizes.
// ============================================================

// ── Per-page content bounding box ───────────────────────────────

const DEFAULT_TOLERANCE     = 12;    // ink if luminance < 255 - tolerance
const DEFAULT_DENSITY_FLOOR = 0.003; // row/col needs >=0.3% ink pixels to count as content
const MIN_DENSITY_PIXELS    = 3;     // ...but never fewer than 3 pixels — rejects single-speck noise on tiny previews

/**
 * Scan RGBA pixel data for the bounding box of non-white content.
 * Uses row/column ink-density projections (not a full flood-fill / connected-
 * component scan) — cheap enough to run per-page on a downsampled canvas.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba - RGBA pixel data, length = width*height*4
 * @param {number} width
 * @param {number} height
 * @param {{tolerance?: number, densityFloor?: number}} [opts]
 * @returns {{top:number, bottom:number, left:number, right:number}} page-fraction bbox.
 *   A blank/all-white page returns the full page ({top:0,left:0,bottom:1,right:1}) —
 *   the safe "don't crop" outcome, since there's no content to bound.
 */
export function contentBBox(rgba, width, height, opts = {}) {
  const tolerance   = opts.tolerance ?? DEFAULT_TOLERANCE;
  const threshold   = 255 - tolerance;
  const rowInk      = new Uint32Array(height);
  const colInk      = new Uint32Array(width);

  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      const i = (rowBase + x) * 4;
      const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      if (lum < threshold) { rowInk[y]++; colInk[x]++; }
    }
  }

  const densityFloor = opts.densityFloor ?? DEFAULT_DENSITY_FLOOR;
  const rowFloor = Math.max(MIN_DENSITY_PIXELS, Math.round(width * densityFloor));
  const colFloor = Math.max(MIN_DENSITY_PIXELS, Math.round(height * densityFloor));

  let top = -1, bottom = -1, left = -1, right = -1;
  for (let y = 0; y < height; y++) { if (rowInk[y] >= rowFloor) { top = y; break; } }
  for (let y = height - 1; y >= 0; y--) { if (rowInk[y] >= rowFloor) { bottom = y + 1; break; } }
  for (let x = 0; x < width; x++) { if (colInk[x] >= colFloor) { left = x; break; } }
  for (let x = width - 1; x >= 0; x--) { if (colInk[x] >= colFloor) { right = x + 1; break; } }

  if (top < 0 || left < 0) return { top: 0, bottom: 1, left: 0, right: 1 };

  return { top: top / height, bottom: bottom / height, left: left / width, right: right / width };
}

// ── Global reconciliation across sampled pages ──────────────────

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Reconcile per-page bboxes into a single global crop rect via the
 * per-edge median — resists both a stray full-bleed page (which would
 * wreck a union: it would force near-zero crop everywhere) and a stray
 * near-blank page (which would wreck an intersection: it would force an
 * oversized box that clips real content on every normal page).
 *
 * @param {Array<{top:number,bottom:number,left:number,right:number}>} bboxes
 * @returns {{top:number,bottom:number,left:number,right:number}}
 */
export function reconcileGlobalCrop(bboxes) {
  if (!bboxes.length) return { top: 0, bottom: 1, left: 0, right: 1 };
  return {
    top:    median(bboxes.map(b => b.top)),
    bottom: median(bboxes.map(b => b.bottom)),
    left:   median(bboxes.map(b => b.left)),
    right:  median(bboxes.map(b => b.right)),
  };
}

// ── Padding ────────────────────────────────────────────────────

const DEFAULT_PADDING_FRACTION = 0.02;

/**
 * Expand a crop rect by a small fixed padding so text doesn't sit flush
 * against the new page edge. Clamped to the page bounds.
 *
 * @param {{top:number,bottom:number,left:number,right:number}} bbox
 * @param {number} [paddingFraction]
 */
export function padBBox(bbox, paddingFraction = DEFAULT_PADDING_FRACTION) {
  return {
    top:    Math.max(0, bbox.top - paddingFraction),
    bottom: Math.min(1, bbox.bottom + paddingFraction),
    left:   Math.max(0, bbox.left - paddingFraction),
    right:  Math.min(1, bbox.right + paddingFraction),
  };
}

// ── Aspect-ratio composition ─────────────────────────────────────

/**
 * Expand a crop rect toward a target device aspect ratio (width/height),
 * never shrinking it — crop-further-to-fit risks clipping content on
 * pages the sample didn't fully represent; padding never does. If the
 * page's own edges are reached before the ratio is hit, the rect is
 * clamped there and the caller's final render step (a "contain" fit
 * into the output canvas) absorbs the residual mismatch as letterbox/
 * pillarbox padding — no further math needed here for that case.
 *
 * @param {{top:number,bottom:number,left:number,right:number}} cropRect - page fractions
 * @param {number} pageWidthPt
 * @param {number} pageHeightPt
 * @param {number} targetAspect - width / height
 */
export function composeWithAspect(cropRect, pageWidthPt, pageHeightPt, targetAspect) {
  const boxWpt = (cropRect.right - cropRect.left) * pageWidthPt;
  const boxHpt = (cropRect.bottom - cropRect.top) * pageHeightPt;
  if (boxWpt <= 0 || boxHpt <= 0) return { ...cropRect };

  const boxAspect = boxWpt / boxHpt;
  let { top, bottom, left, right } = cropRect;

  if (boxAspect > targetAspect) {
    // Too wide relative to target — grow height.
    const desiredHpt = boxWpt / targetAspect;
    const extraFrac  = ((desiredHpt - boxHpt) / 2) / pageHeightPt;
    top    = Math.max(0, top - extraFrac);
    bottom = Math.min(1, bottom + extraFrac);
  } else if (boxAspect < targetAspect) {
    // Too narrow relative to target — grow width.
    const desiredWpt = boxHpt * targetAspect;
    const extraFrac  = ((desiredWpt - boxWpt) / 2) / pageWidthPt;
    left  = Math.max(0, left - extraFrac);
    right = Math.min(1, right + extraFrac);
  }

  return { top, bottom, left, right };
}

// ── 2-column gutter detection ────────────────────────────────────
//
// v2 addition, gated on real signal: a Reddit thread pasted by the user
// specifically recommended k2pdfopt for this exact case (2-column academic
// PDFs unreadable on small screens) — the one thing v1's plain crop+resize
// doesn't handle. Detection is pixel-based (this module never sees text
// runs, only rendered bitmaps), and deliberately global-per-document, not
// per-page — same "one decision, applied uniformly" pattern as the crop
// rect and device-aspect composition above, not a per-page adaptive
// system. That's a real, accepted trade-off: an occasional full-bleed
// figure page on an otherwise 2-column document will still get split
// down the middle. The Auto/Off toggle in the UI is the escape hatch.

const GUTTER_BAND_START     = 0.25; // only search the central 25%-75% of the
const GUTTER_BAND_END       = 0.75; // crop width — rejects a paragraph indent
                                     // or ordinary side margin from ever being
                                     // mistaken for an inter-column gutter
const GUTTER_INK_THRESHOLD  = 0.01; // column counts as "gutter" if <1% ink
const GUTTER_MIN_WIDTH_FRAC = 0.015; // must be at least 1.5% of crop width —
                                      // rejects single-pixel noise gaps

/**
 * Look for a vertical whitespace gutter within the central band of a
 * page's content area — the signature of a genuine 2-column layout, as
 * opposed to a single column with ordinary margins.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {{top:number,bottom:number,left:number,right:number}} cropRect - page-fraction content bbox for THIS page
 * @param {{tolerance?: number}} [opts]
 * @returns {{hasGutter:boolean, centerFrac:number|null}} centerFrac is a
 *   page-fraction X position (not relative to cropRect), or null if no
 *   gutter was found.
 */
export function detectColumnGutter(rgba, width, height, cropRect, opts = {}) {
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  const threshold = 255 - tolerance;

  const y0 = Math.max(0, Math.round(cropRect.top * height));
  const y1 = Math.min(height, Math.round(cropRect.bottom * height));
  const x0 = Math.max(0, Math.round(cropRect.left * width));
  const x1 = Math.min(width, Math.round(cropRect.right * width));
  const cropWidth = x1 - x0;
  if (cropWidth <= 0 || y1 <= y0) return { hasGutter: false, centerFrac: null };

  const bandX0 = x0 + Math.round(cropWidth * GUTTER_BAND_START);
  const bandX1 = x0 + Math.round(cropWidth * GUTTER_BAND_END);
  const rowCount = y1 - y0;

  // Column ink counts, restricted to the crop's own row range — same
  // projection technique as contentBBox, just scoped to the central band.
  const colInk = new Uint32Array(bandX1 - bandX0);
  for (let y = y0; y < y1; y++) {
    const rowBase = y * width;
    for (let x = bandX0; x < bandX1; x++) {
      const i = (rowBase + x) * 4;
      const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      if (lum < threshold) colInk[x - bandX0]++;
    }
  }

  const inkFloor = Math.max(1, Math.round(rowCount * GUTTER_INK_THRESHOLD));
  const minGutterPx = Math.max(1, Math.round(cropWidth * GUTTER_MIN_WIDTH_FRAC));

  // Widest contiguous run of near-blank columns within the band.
  let bestStart = -1, bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= colInk.length; i++) {
    const isBlank = i < colInk.length && colInk[i] <= inkFloor;
    if (isBlank) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      const len = i - runStart;
      if (len > bestLen) { bestLen = len; bestStart = runStart; }
      runStart = -1;
    }
  }

  if (bestLen < minGutterPx) return { hasGutter: false, centerFrac: null };

  const gutterCenterPx = bandX0 + bestStart + bestLen / 2;
  return { hasGutter: true, centerFrac: gutterCenterPx / width };
}

const DEFAULT_COLUMN_THRESHOLD = 0.6; // fraction of sampled pages needing a
                                       // detected gutter before treating the
                                       // whole document as 2-column

/**
 * Reconcile per-page gutter detections into one document-level decision.
 *
 * @param {Array<{hasGutter:boolean, centerFrac:number|null}>} gutters
 * @param {{threshold?: number}} [opts]
 * @returns {{enabled:boolean, centerFrac:number|null}}
 */
export function reconcileColumnSplit(gutters, opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_COLUMN_THRESHOLD;
  if (!gutters.length) return { enabled: false, centerFrac: null };

  const withGutter = gutters.filter(g => g.hasGutter);
  if (withGutter.length / gutters.length < threshold) {
    return { enabled: false, centerFrac: null };
  }
  return { enabled: true, centerFrac: median(withGutter.map(g => g.centerFrac)) };
}

// ── Device presets ────────────────────────────────────────────

export const DEVICE_PRESETS = {
  kindle:     { aspect: 3 / 4 },
  remarkable: { aspect: 4 / 5 },
  kobo:       { aspect: 3 / 4 },
};
