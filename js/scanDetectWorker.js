// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  scanDetectWorker.js — Dedicated Web Worker for Document Scanner's
//  LIVE-camera document-quad detection (js/scanCameraUI.js's
//  ~5fps framing-guide loop).
//
//  Moved off the main thread 2026-08-27, found via code review: unlike
//  the one-shot-per-photo filter pipeline already moved to
//  js/scanFilterWorker.js (see that file's own header for the measured
//  reason), this OpenCV Canny/contour-finding detection ran synchronously
//  on the main thread every 200ms for the ENTIRE time the live camera
//  preview stays open — a real, ongoing main-thread cost, not a one-shot
//  one, with the same "button presses feel slow" risk class on a weak
//  device.
//
//  Real technical risk resolved BEFORE building this (not assumed):
//  verified live that OpenCV.js's CDN build actually loads via
//  importScripts() inside a real Worker and that cv.matFromImageData()
//  produces a correctly-shaped Mat from raw ImageData — both confirmed
//  working before writing anything else here.
//
//  Deliberately NOT part of worker.js (off-limits per CLAUDE.md).
//
//  Same detection algorithm as js/scanGeometry.js's detectDocumentQuad —
//  duplicated here rather than shared via import, same "classic Worker,
//  no ES modules" reason js/cleanScanWorker.js/js/scanFilterWorker.js
//  already document for this exact class of duplication. The CALLER
//  (js/scanCameraUI.js) does the downscale-for-detection step itself
//  before sending (cheap canvas draw, keeps the postMessage payload
//  small) and un-scales the returned quad back to full-frame coordinates
//  itself too — this worker only runs the actual Canny/contour pipeline
//  on whatever-size ImageData it's given.
//
//  Message contract:
//    in  → { type: 'detectQuad', data: Uint8ClampedArray, w, h } (transferred)
//    out → { type: 'quadResult', quad: {tl,tr,br,bl}|null } | { type: 'error', message }
// ============================================================

// Started eagerly at worker-script-eval time (not lazily on first
// message) — js/scanCameraUI.js pre-creates this worker as soon as the
// live-camera view opens, specifically so this load has a head start
// before the first real detectQuad request goes out a tick later.
let _cvReady = new Promise((resolve, reject) => {
  self.Module = { onRuntimeInitialized: resolve };
  try {
    importScripts('https://docs.opencv.org/4.9.0/opencv.js');
  } catch (e) {
    reject(e);
  }
});

self.onmessage = async (e) => {
  try {
    if (e.data.type === 'detectQuad') {
      await _cvReady;
      const quad = _detectQuad(e.data.data, e.data.w, e.data.h);
      self.postMessage({ type: 'quadResult', quad });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

// Same Canny/dilate/findContours/approxPolyDP pipeline as
// js/scanGeometry.js's detectDocumentQuad — see that file for the real
// reasoning behind each constant/step. Operates directly on the given
// (already downscaled by the caller) ImageData; does NOT scale the
// result back to full-frame coordinates — that's the caller's job, same
// division of labor js/scanFilterWorker.js already uses (worker does
// the heavy pixel work, caller owns coordinate-space bookkeeping it
// already had to do anyway).
const _MIN_AREA_FRACTION = 0.20;
const _CANNY_LOW  = 75;
const _CANNY_HIGH = 200;

function _detectQuad(data, w, h) {
  const cv = self.cv; // set by importScripts(opencv.js) above — same window.cv-alias pattern js/scanGeometry.js uses, adapted for a worker's self
  const imageData = new ImageData(data, w, h);
  const src     = cv.matFromImageData(imageData);
  const gray    = new cv.Mat();
  const blurred = new cv.Mat();
  const edges   = new cv.Mat();
  const kernel  = cv.Mat.ones(3, 3, cv.CV_8U);
  const dilated = new cv.Mat();
  const contours  = new cv.MatVector();
  const hierarchy = new cv.Mat();

  let result = null;
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, _CANNY_LOW, _CANNY_HIGH);
    cv.dilate(edges, dilated, kernel);
    cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const frameArea = w * h;
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

    if (best) result = _orderQuadPoints(best);
  } finally {
    src.delete(); gray.delete(); blurred.delete(); edges.delete();
    kernel.delete(); dilated.delete(); contours.delete(); hierarchy.delete();
  }
  return result;
}

// Verbatim port of js/scanGeometry.js's orderQuadPoints (pure JS, no cv
// dependency — duplicated for the same reason as the rest of this file).
function _orderQuadPoints(points) {
  const bySum  = [...points].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...points].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  return {
    tl: bySum[0], br: bySum[3],
    tr: byDiff[0], bl: byDiff[3],
  };
}
