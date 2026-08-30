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

// ── Crop-review "rotate view" geometry (Node-testable) ──────────
//
// A tall portrait photo, reviewed on a narrow phone screen, renders small
// if displayed at its natural orientation — real user report (Redmi 8):
// couldn't grab the top/bottom corner handles at all on some photos simply
// because the whole crop shrank to fit the available height, leaving very
// little room to work with. js/scanCameraUI.js addresses this by
// optionally displaying the working image (and its corner-handle overlay)
// CSS-rotated -90° inside a wrapper sized to use the AVAILABLE BOX's
// larger dimension — same "rotate the interaction surface to fit a
// portrait screen" trick js/fillUI.js's signature pad already uses for
// its own drawing canvas. The underlying `_quad`/`_capturedCanvas` never
// rotate — only this display/interaction layer needs the math below.

/**
 * Decides whether displaying an image ROTATED -90° would make better use
 * of an available box than displaying it at its natural orientation, and
 * returns the resulting scale (CSS px per original image px) either way.
 * @param {number} imgW - original (unrotated) image width
 * @param {number} imgH - original (unrotated) image height
 * @param {number} boxW - available display box width
 * @param {number} boxH - available display box height
 * @param {number} [rotateBenefitThreshold=1.15] - only rotate if it yields
 *   a meaningfully bigger result (avoids flip-flopping near parity)
 * @returns {{rotated: boolean, scale: number}}
 */
export function chooseCropViewLayout(imgW, imgH, boxW, boxH, rotateBenefitThreshold = 1.15) {
  const unrotatedScale = Math.min(boxW / imgW, boxH / imgH);
  const rotatedScale   = Math.min(boxW / imgH, boxH / imgW);
  const rotated = rotatedScale > unrotatedScale * rotateBenefitThreshold;
  return { rotated, scale: rotated ? rotatedScale : unrotatedScale };
}

/**
 * Maps a point in ORIGINAL image coordinate space to its position relative
 * to the top-left corner of a wrapper that displays that image CSS-rotated
 * -90° (`transform: rotate(-90deg)`) at the given scale — i.e. the wrapper's
 * own (pre-rotation) box is sized `imgW*scale` × `imgH*scale`, and this
 * returns where (x,y) ends up once rotated into view.
 * @param {number} x, y - point in original image space
 * @param {number} imgW - original image width (the axis the rotation pivots against)
 * @param {number} scale - CSS px per original image px
 * @returns {{x:number, y:number}}
 */
export function rotatedViewPoint(x, y, imgW, scale) {
  return { x: y * scale, y: (imgW - x) * scale };
}

/**
 * Inverse of rotatedViewPoint — converts a screen position (relative to the
 * same rotated wrapper's top-left corner) back to original image space.
 * @param {number} sx, sy - position relative to the rotated wrapper's top-left
 * @param {number} imgW - original image width
 * @param {number} scale - CSS px per original image px
 * @returns {{x:number, y:number}}
 */
export function unrotatedImagePoint(sx, sy, imgW, scale) {
  return { x: imgW - sy / scale, y: sx / scale };
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
// Reject contours filling nearly the whole frame. Found via a real user
// photo (document on a textured carpet, with a clothes rack + knee also in
// frame): the CLAHE + low Canny thresholds + wide 9x9 CLOSE kernel above
// (tuned for recovering genuinely weak low-contrast document edges) also
// makes background texture noise (carpet pattern, wrinkled fabric, skin)
// generate enough edges to CLOSE into one giant blob spanning nearly the
// entire frame — which then wins the "largest 4-point convex contour"
// selection outright over the real, smaller document contour, since area
// alone was the only ranking signal. A document photographed with visible
// margin — the entire reason this crop-review flow exists — never
// legitimately spans edge-to-edge, so a contour this large is background
// noise, not the document.
const _MAX_AREA_FRACTION  = 0.92;
// Lowered from the old fixed (75,200) after a live stress test (pale
// document on a similarly light, textured background — the real failure
// shape a user reported live) showed detection silently falling all the
// way back to defaultInsetQuad: the old thresholds required a stronger
// gradient than a genuinely low-contrast document/background boundary
// ever produces, CLAHE-enhanced or not.
//
// The textbook "auto Canny" technique (scale thresholds around the
// image's own median PIXEL INTENSITY) was tried first and made this
// specific failure WORSE, not better — confirmed via direct instrumentation
// (median=191 on the stress photo → thresholds ~128/254 → zero edge pixels
// detected at all). That heuristic silently assumes median intensity
// correlates with typical GRADIENT magnitude, which breaks down exactly
// for a bright, low-contrast image like this one: pixel values run high
// even though the actual edge strength between paper and background is
// small. Simple lower fixed thresholds, combined with CLAHE actually
// strengthening the real gradient beforehand, is what worked in practice —
// confirmed by re-detecting the stress photo's true quad almost exactly
// (within ~3px of the drawn corners after scaling back up).
const _CANNY_LOW  = 30;
const _CANNY_HIGH = 90;

// Median of a single-channel 8-bit Mat's pixel values, via a 256-bin
// histogram (O(n), fast enough for a one-shot call on an at-most-800px
// downscaled frame) — feeds the auto-Canny threshold below. Not exported;
// only meaningful paired with this file's own detection pipeline.
function _medianGray(mat) {
  const hist = new Uint32Array(256);
  const data = mat.data;
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  const half = data.length / 2;
  let cum = 0;
  for (let v = 0; v < 256; v++) {
    cum += hist[v];
    if (cum >= half) return v;
  }
  return 128;
}

// Reconstructs a RotatedRect's 4 corners from OpenCV.js's
// {center,size,angle} return shape — hand-rolled rather than assuming
// cv.RotatedRect/cv.boxPoints exists in the WASM build actually shipped,
// since that's a real difference from desktop cv2 this project can't
// verify without a live browser test anyway. Standard rotation formula,
// same one this project already uses elsewhere for point math.
function _rotatedRectPoints({ center, size, angle }) {
  const rad = angle * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const w2 = size.width / 2, h2 = size.height / 2;
  return [
    { x: -w2, y: -h2 }, { x: w2, y: -h2 }, { x: w2, y: h2 }, { x: -w2, y: h2 },
  ].map(p => ({
    x: center.x + p.x * cos - p.y * sin,
    y: center.y + p.x * sin + p.y * cos,
  }));
}

// Rejects 4-point candidates whose corners deviate too far from 90° —
// `cosine` here is the (absolute) cosine of the angle at one corner between
// its two adjacent edges: near 0 means close to a right angle, near 1 means
// a degenerate sliver. Threshold (0.3, ≈corners within roughly 73°-107°) is
// OpenCV's own long-standing constant from its classic square-detection
// sample — CleanSCAN's (github.com/clean-apps/CleanSCAN) native getPoints()
// uses the identical check. A genuine document photo's corners are rarely
// exactly 90° (perspective), but a real quad rarely deviates this far — a
// noisy/degenerate contour usually does. This check would likely have
// caught scandoc_falsepositive_fullframe_crop_2026_08's false-positive
// full-frame contour too, via a different signal than the extent-ratio
// fix that actually shipped for it — kept as a second, independent guard.
const _MAX_CORNER_COSINE = 0.3;

function _quadMaxCornerCosine(pts) {
  let maxCosine = 0;
  for (let i = 0; i < 4; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % 4], p2 = pts[(i + 3) % 4];
    const dx1 = p1.x - p0.x, dy1 = p1.y - p0.y;
    const dx2 = p2.x - p0.x, dy2 = p2.y - p0.y;
    const cosine = Math.abs((dx1 * dx2 + dy1 * dy2) /
      (Math.sqrt((dx1 * dx1 + dy1 * dy1) * (dx2 * dx2 + dy2 * dy2)) + 1e-10));
    if (cosine > maxCosine) maxCosine = cosine;
  }
  return maxCosine;
}

// Runs the shared blur→Canny→morph-close→contour pipeline on a single
// already-CLAHE-enhanced channel (true grayscale, or one raw color channel
// — see detectDocumentQuad's per-channel fallback below) and returns the
// best {points, area} found in it, or null. Factored out so the per-channel
// fallback can reuse the EXACT same detection logic (including the area-
// fraction/extent-ratio/corner-angle guards) instead of a second, easier-
// to-drift-out-of-sync copy.
function _findQuadInChannel(enhanced, dw, dh, cv) {
  const blurred = new cv.Mat();
  const edges   = new cv.Mat();
  const morphKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
  const closed    = new cv.Mat();
  const contours  = new cv.MatVector();
  const hierarchy = new cv.Mat();

  let best = null, bestArea = 0;
  let fallbackContour = null, fallbackArea = 0; // largest big-enough contour, any shape
  try {
    cv.GaussianBlur(enhanced, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, _CANNY_LOW, _CANNY_HIGH);

    // Morphological CLOSE (dilate then erode) instead of a bare dilate —
    // bridges small gaps where a real document edge briefly drops below
    // the Canny threshold (a partially-broken contour never reaches
    // findContours as one closed shape), while still shrinking back down
    // afterward instead of permanently thickening every edge. Kernel size
    // (9x9, up from an initial 5x5) matters more than it might look —
    // found via live testing across several low-contrast stress photos
    // that a 5x5 kernel reliably fixed some but not all of them: the
    // surviving failures had genuinely MORE fragmented edges (same total
    // edge-pixel count, just broken into more, smaller disconnected
    // pieces depending on the exact noise realization) that needed a
    // wider bridge to reconnect into one contour.
    cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, morphKernel);
    cv.findContours(closed, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const frameArea = dw * dh;
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      if (area < frameArea * _MIN_AREA_FRACTION || area > frameArea * _MAX_AREA_FRACTION) { contour.delete(); continue; }

      if (area > fallbackArea) {
        fallbackContour?.delete();
        fallbackArea = area;
        fallbackContour = contour.clone();
      }

      if (area <= bestArea) { contour.delete(); continue; }

      const approx = new cv.Mat();
      const perimeter = cv.arcLength(contour, true);
      cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);

      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const points = [];
        for (let p = 0; p < 4; p++) points.push({ x: approx.data32S[p * 2], y: approx.data32S[p * 2 + 1] });
        if (_quadMaxCornerCosine(points) < _MAX_CORNER_COSINE) {
          best = points;
          bestArea = area;
        }
      }
      approx.delete();
      contour.delete();
    }

    // Fallback: no cleanly-4-cornered contour found (a real edge can come
    // back as 5-6 points from a corner-rounding artifact, or slightly
    // non-convex from noise) but a single big, plausible blob still
    // dominates the frame — its minAreaRect is a reasonable approximate
    // quad, strictly better than the OLD behavior here (silently giving up
    // to defaultInsetQuad, which ignores the document's real position
    // entirely). Only used when the primary, more reliable path found
    // nothing, so this can only improve on today's fallback, never regress
    // a case that already worked.
    if (!best && fallbackContour) {
      const rect = cv.minAreaRect(fallbackContour);
      const rectArea = rect.size.width * rect.size.height;
      // A real document's contour (even if not cleanly 4-cornered — corner
      // rounding, slight noise) fills most of its own minimal bounding
      // rotated rect. A sparse/diagonal background-noise blob (e.g. a
      // clothes-rack bar or carpet texture running corner-to-corner) can
      // pass the frame-area checks above (its own contourArea stays modest)
      // while its bounding rect still balloons out to nearly the whole
      // frame — found via a real user photo where a 29%-of-frame contour
      // produced a ~100%-of-frame minAreaRect (extent ratio ~0.29). Below
      // this extent threshold, the blob's shape is too unlike a filled
      // rectangle to trust as an approximate document quad.
      if (rectArea > 0 && fallbackArea / rectArea >= 0.5) {
        best = _rotatedRectPoints(rect);
        bestArea = fallbackArea;
      }
    }
    fallbackContour?.delete();
  } finally {
    blurred.delete(); edges.delete(); morphKernel.delete();
    closed.delete(); contours.delete(); hierarchy.delete();
  }
  return best ? { points: best, area: bestArea } : null;
}

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

  const src      = cv.imread(small);
  const gray     = new cv.Mat();
  const enhanced = new cv.Mat();
  const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));

  let found = null;
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    // Pulls apart a low-contrast document/background boundary (e.g. a pale
    // document on a similarly light, textured surface) BEFORE edge
    // detection — found via a live stress test to be the single biggest
    // real gap in this pipeline; a fixed downstream Canny threshold can't
    // recover an edge that's simply too weak in the source image.
    clahe.apply(gray, enhanced);
    found = _findQuadInChannel(enhanced, dw, dh, cv);

    // Per-channel fallback — only pays this extra ~3x detection cost when
    // the fast, common-case grayscale pass above found nothing (a case
    // that would otherwise already fall through to the honest-but-
    // unhelpful defaultInsetQuad, so the extra latency is a reasonable
    // trade for a real chance at detection). Real robustness gap found
    // analyzing CleanSCAN's (github.com/clean-apps/CleanSCAN) own
    // getPoints(): grayscale conversion (0.299R+0.587G+0.114B) can wash
    // out an edge that's genuinely visible in one raw color channel — e.g.
    // a bluish/yellowish document against a background of similar
    // luminance but different hue. Splits into R/G/B and retries the same
    // (CLAHE-enhanced, unlike the reference's raw-channel approach — kept
    // for consistency with the low-contrast fix above, which is cheap at
    // this downscaled size) pipeline on each, keeping whichever channel
    // yields the largest valid quad.
    if (!found) {
      const channels = new cv.MatVector();
      cv.split(src, channels);
      try {
        for (let c = 0; c < 3; c++) {
          const channelMat = channels.get(c);
          const channelEnhanced = new cv.Mat();
          clahe.apply(channelMat, channelEnhanced);
          const candidate = _findQuadInChannel(channelEnhanced, dw, dh, cv);
          channelMat.delete();
          channelEnhanced.delete();
          if (candidate && (!found || candidate.area > found.area)) found = candidate;
        }
      } finally {
        channels.delete();
      }
    }
  } finally {
    src.delete(); gray.delete(); enhanced.delete(); clahe.delete();
  }

  if (!found) return null;
  const ordered = orderQuadPoints(found.points);
  const inv = 1 / scale;
  return {
    tl: { x: ordered.tl.x * inv, y: ordered.tl.y * inv },
    tr: { x: ordered.tr.x * inv, y: ordered.tr.y * inv },
    br: { x: ordered.br.x * inv, y: ordered.br.y * inv },
    bl: { x: ordered.bl.x * inv, y: ordered.bl.y * inv },
  };
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
