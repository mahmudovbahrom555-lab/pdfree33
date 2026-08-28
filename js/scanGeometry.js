// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  scanGeometry.js — document-quad detection + perspective warp
//  for jpg2pdf's live camera scan flow (js/scanCameraUI.js).
//
//  orderQuadPoints/defaultInsetQuad are pure JS, no OpenCV.js
//  dependency — real Node-testable geometry math, see
//  tests/scanGeometry.test.js. detectDocumentQuad/warpToRect need a
//  loaded `cv` (OpenCV.js, lazy-loaded via js/lazyLibs.js's
//  loadOpenCv() only when the camera flow actually opens) and a real
//  canvas — not Node-testable, verified via Playwright instead.
//
//  Every cv.Mat/cv.MatVector created here is explicitly .delete()d —
//  OpenCV.js's WASM heap has no GC, a leaked Mat stays leaked for the
//  page's lifetime.
// ============================================================

// ── Pure geometry (Node-testable) ───────────────────────────────

/**
 * Orders 4 arbitrary points into {tl, tr, br, bl} via the standard
 * sum/diff heuristic — a contour's points aren't returned in a
 * consistent winding order, so this can't just assume input order.
 * @param {{x:number,y:number}[]} points - exactly 4 points
 * @returns {{tl:{x,y}, tr:{x,y}, br:{x,y}, bl:{x,y}}}
 */
export function orderQuadPoints(points) {
  if (points.length !== 4) throw new Error(`orderQuadPoints expects exactly 4 points, got ${points.length}`);
  const bySum  = [...points].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...points].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  return {
    tl: bySum[0],             // smallest x+y
    br: bySum[3],             // largest x+y
    tr: byDiff[0],            // smallest y-x
    bl: byDiff[3],            // largest y-x
  };
}

/**
 * A safe default quad when detection finds nothing usable — a fixed
 * inset from each edge. Always available, always adjustable by the
 * user afterward via the draggable corner handles.
 * @param {number} width
 * @param {number} height
 * @param {number} [marginFraction=0.05]
 * @returns {{tl:{x,y}, tr:{x,y}, br:{x,y}, bl:{x,y}}}
 */
export function defaultInsetQuad(width, height, marginFraction = 0.05) {
  const mx = width * marginFraction;
  const my = height * marginFraction;
  return {
    tl: { x: mx,         y: my          },
    tr: { x: width - mx, y: my          },
    br: { x: width - mx, y: height - my },
    bl: { x: mx,         y: height - my },
  };
}

/** Euclidean distance between two points. */
function _dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Estimates the vertical gutter (spine) position in an already-warped book-
// spread image, as the fraction (0-1) of width from the left edge. Pure
// pixel math on a raw RGBA buffer (stride 4, like scanFilter.js's
// medianFilterGray/clahePlane) — no OpenCV or canvas needed, so it's
// directly Node-testable. See tests/scanGeometry.test.js.
//
// Heuristic (deliberately simple, not ClearScan's full gutter-darkness +
// cross-gutter-luminance-transition + page-texture-non-uniformity scoring —
// that needs live-camera validation this project doesn't have the setup
// for yet): the gutter usually casts a shadow, so it reads as the darkest
// vertical band in the middle portion of the page. Only trusted when that
// dip is meaningfully darker than the surrounding average — a flat/noisy
// band (no real gutter, e.g. a single page mistakenly warped in book mode)
// falls back to `confident: false`, and the caller should default to a
// plain center line rather than trust a spurious detection.
/**
 * @param {Uint8ClampedArray} data RGBA (stride 4) pixel buffer of the
 *   warped spread image.
 * @param {number} w
 * @param {number} h
 * @returns {{xFrac: number, confident: boolean}}
 */
export function detectSpineX(data, w, h) {
  // Sample the vertical middle band — avoids header/footer noise (running
  // titles, page numbers) that doesn't reflect the actual gutter position.
  const y0 = Math.round(h * 0.3), y1 = Math.round(h * 0.7);
  const bandH = Math.max(1, y1 - y0);

  const colLum = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = y0; y < y1; y++) {
      const idx = (y * w + x) * 4;
      sum += 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    }
    colLum[x] = sum / bandH;
  }

  // Search the middle 60% of columns — the gutter is rarely near the outer
  // edges, and excluding them avoids the page's own outer-edge shadow (from
  // the perspective warp/lighting falloff) being mistaken for the gutter.
  const x0 = Math.round(w * 0.2), x1 = Math.round(w * 0.8);
  let minX = Math.round(w / 2), minVal = Infinity, avgVal = 0;
  for (let x = x0; x < x1; x++) {
    if (colLum[x] < minVal) { minVal = colLum[x]; minX = x; }
    avgVal += colLum[x];
  }
  avgVal /= Math.max(1, x1 - x0);

  const confident = (avgVal - minVal) > 15; // real dip vs. flat/noisy band
  return { xFrac: minX / w, confident };
}

// ── OpenCV.js-dependent (browser only) ──────────────────────────

// Exported (unlike _MIN_AREA_FRACTION/_CANNY_LOW/_CANNY_HIGH below, which
// stay private) — js/scanCameraUI.js's live-tracking loop needs the SAME
// value to downscale a frame before sending it to js/scanDetectWorker.js,
// which runs the Canny/contour pipeline directly on whatever size it's
// given rather than downscaling itself. One shared constant, not two
// independently-tuned copies — same reasoning as js/scanConstants.js's
// SCAN_MAX_LONG_EDGE consolidation.
export const DETECT_LONG_EDGE = 800;  // downsample for detection only — mirrors processor.js's _EREADER_BBOX_EDGE pattern
const _MIN_AREA_FRACTION  = 0.20; // reject contours smaller than 20% of the frame — too small to plausibly be "the document"
const _CANNY_LOW          = 75;
const _CANNY_HIGH         = 200;

/**
 * Detects the largest plausible 4-corner document quad in a captured
 * frame. Runs on a downscaled copy for speed, returns coordinates
 * already scaled back to the source canvas's own resolution.
 * @param {HTMLCanvasElement} sourceCanvas - the full-resolution capture
 * @returns {{tl,tr,br,bl}|null} null if no confident quad was found —
 *   caller should fall back to defaultInsetQuad in that case.
 */
export function detectDocumentQuad(sourceCanvas) {
  const cv = window.cv;
  const scale = Math.min(1, DETECT_LONG_EDGE / Math.max(sourceCanvas.width, sourceCanvas.height));
  const dw = Math.max(1, Math.round(sourceCanvas.width  * scale));
  const dh = Math.max(1, Math.round(sourceCanvas.height * scale));

  const small = document.createElement('canvas');
  small.width = dw; small.height = dh;
  small.getContext('2d').drawImage(sourceCanvas, 0, 0, dw, dh);

  const src     = cv.imread(small);
  const gray    = new cv.Mat();
  const blurred = new cv.Mat();
  const edges   = new cv.Mat();
  const kernel  = cv.Mat.ones(3, 3, cv.CV_8U);
  const dilated = new cv.Mat();
  const contours   = new cv.MatVector();
  const hierarchy  = new cv.Mat();

  let result = null;
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, _CANNY_LOW, _CANNY_HIGH);
    cv.dilate(edges, dilated, kernel);
    cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const frameArea = dw * dh;
    let best = null, bestArea = 0;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      if (area < frameArea * _MIN_AREA_FRACTION || area <= bestArea) { contour.delete(); continue; }

      const approx = new cv.Mat();
      const perimeter = cv.arcLength(contour, true);
      cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);

      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const points = [];
        for (let p = 0; p < 4; p++) points.push({ x: approx.data32S[p * 2], y: approx.data32S[p * 2 + 1] });
        best = points;
        bestArea = area;
      }
      approx.delete();
      contour.delete();
    }

    if (best) {
      const ordered = orderQuadPoints(best);
      const inv = 1 / scale;
      result = {
        tl: { x: ordered.tl.x * inv, y: ordered.tl.y * inv },
        tr: { x: ordered.tr.x * inv, y: ordered.tr.y * inv },
        br: { x: ordered.br.x * inv, y: ordered.br.y * inv },
        bl: { x: ordered.bl.x * inv, y: ordered.bl.y * inv },
      };
    }
  } finally {
    src.delete(); gray.delete(); blurred.delete(); edges.delete();
    kernel.delete(); dilated.delete(); contours.delete(); hierarchy.delete();
  }
  return result;
}

/**
 * Perspective-warps the quad region of sourceCanvas into a clean
 * axis-aligned rectangle, sized from the quad's own measured edge
 * lengths (preserves the document's real aspect ratio).
 * @param {HTMLCanvasElement} sourceCanvas
 * @param {{tl,tr,br,bl}} quad - full-resolution coordinates (same
 *   space as sourceCanvas), e.g. from detectDocumentQuad or user drag
 * @returns {HTMLCanvasElement} a new canvas containing the warped result
 */
export function warpToRect(sourceCanvas, quad) {
  const cv = window.cv;
  // Clamped to a minimum of 1 — same guard _capture() (scanCameraUI.js)
  // and the book-split logic in _startSpineAdjust already apply to their
  // own size computations. Found missing here via code review: a user
  // dragging the quad's corners into near-coincidence (all four handles
  // bunched together) rounds outW/outH to 0, and
  // cv.warpPerspective(..., new cv.Size(0, outH), ...) throws inside
  // OpenCV.js — caught by _confirm()'s try/catch (surfaces
  // scan_cam_processing_failed, modal stays open to retry), so this was
  // recoverable rather than a crash, but avoidable.
  const outW = Math.max(1, Math.round(Math.max(_dist(quad.tl, quad.tr), _dist(quad.bl, quad.br))));
  const outH = Math.max(1, Math.round(Math.max(_dist(quad.tl, quad.bl), _dist(quad.tr, quad.br))));

  const src = cv.imread(sourceCanvas);
  const dst = new cv.Mat();
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    quad.tl.x, quad.tl.y, quad.tr.x, quad.tr.y, quad.br.x, quad.br.y, quad.bl.x, quad.bl.y,
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, outW, 0, outW, outH, 0, outH,
  ]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW; outCanvas.height = outH;
  try {
    cv.warpPerspective(src, dst, M, new cv.Size(outW, outH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());
    cv.imshow(outCanvas, dst);
  } finally {
    src.delete(); dst.delete(); srcTri.delete(); dstTri.delete(); M.delete();
  }
  return outCanvas;
}

// ── Worker-offloaded warp (preferred entry point for real callers) ──
//
// warpToRect() above stays as the synchronous reference implementation
// (kept for clarity/potential future Node testing once cv gets a
// headless build), but every real caller should use warpToRectAsync()
// instead — warpPerspective on a full SCAN_MAX_LONG_EDGE-capped (2200px)
// frame is real, measurable main-thread work. Found via a real user
// report ("Use this crop feels very slow") and confirmed with a live
// Playwright measurement at 4x CPU throttle: a single 368ms main-thread
// frame gap on confirm-click. Same class of fix already applied to this
// tool's other two OpenCV-heavy steps (js/scanDetectWorker.js,
// js/scanFilterWorker.js) — this was the one still running synchronously.
//
// Same lazy-singleton + single-shot-request pattern js/scanFilter.js's
// _ensureFilterWorker/_filterWorkerRequest already establish. Centralized
// here (not in each caller) since both js/scanCameraUI.js and
// js/scanDocumentUI.js call warpToRect.
let _warpWorker = null;
function _ensureWarpWorker() {
  if (!_warpWorker) {
    _warpWorker = new Worker(new URL('./scanWarpWorker.js', import.meta.url));
  }
  return _warpWorker;
}

/**
 * Same contract as warpToRect(), but runs the actual warpPerspective call
 * in a Worker instead of blocking the main thread.
 * @param {HTMLCanvasElement} sourceCanvas
 * @param {{tl,tr,br,bl}} quad
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function warpToRectAsync(sourceCanvas, quad) {
  const w = sourceCanvas.width, h = sourceCanvas.height;
  const imageData = sourceCanvas.getContext('2d').getImageData(0, 0, w, h);
  const worker = _ensureWarpWorker();

  const result = await new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'error') { reject(new Error(d.message)); return; }
      resolve(d);
    };
    worker.onerror = (e) => reject(new Error(e.message || 'Worker error'));
    worker.postMessage(
      { type: 'warp', data: imageData.data, w, h, quad },
      [imageData.data.buffer]
    );
  });

  const outCanvas = document.createElement('canvas');
  outCanvas.width = result.outW;
  outCanvas.height = result.outH;
  outCanvas.getContext('2d').putImageData(
    new ImageData(result.data, result.outW, result.outH), 0, 0
  );
  return outCanvas;
}
