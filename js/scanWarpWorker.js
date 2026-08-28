// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  scanWarpWorker.js — Dedicated Web Worker for Document Scanner's
//  perspective-warp step (the "Use this crop" confirm action in
//  js/scanCameraUI.js / the auto-crop batch path in js/scanDocumentUI.js).
//
//  Moved off the main thread 2026-08-28, found via a real user report
//  ("Use this crop feels very slow") — measured live via Playwright with
//  4x CPU throttle on a full-resolution (SCAN_MAX_LONG_EDGE-capped) test
//  photo: a single 368ms main-thread frame gap on confirm-click. Same
//  "button presses feel slow" risk class already fixed for this tool's
//  OTHER two OpenCV-heavy steps — js/scanDetectWorker.js (live-camera
//  quad detection) and js/scanFilterWorker.js (the enhance/filter
//  pipeline) — this was the one remaining synchronous OpenCV call left
//  on the main thread in the whole scan flow.
//
//  Deliberately NOT part of worker.js (off-limits per CLAUDE.md).
//
//  Same warpPerspective math as js/scanGeometry.js's warpToRect —
//  duplicated here rather than shared via import, same "classic Worker,
//  no ES modules" reason js/scanDetectWorker.js/js/scanFilterWorker.js
//  already document for this exact class of duplication. The CALLER
//  (js/scanGeometry.js's warpToRectAsync) extracts ImageData from the
//  source canvas and reconstructs the output canvas from the returned
//  pixel buffer — this worker only runs the actual warpPerspective call
//  on whatever ImageData it's given, same division of labor as
//  scanDetectWorker.js.
//
//  Message contract:
//    in  → { type: 'warp', data: Uint8ClampedArray, w, h, quad: {tl,tr,br,bl} } (data transferred)
//    out → { type: 'warpResult', data: Uint8ClampedArray, outW, outH } (data transferred, ok:true)
//        | { type: 'error', message }
// ============================================================

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
    if (e.data.type === 'warp') {
      await _cvReady;
      const { data, outW, outH } = _warp(e.data.data, e.data.w, e.data.h, e.data.quad);
      self.postMessage({ type: 'warpResult', data, outW, outH }, [data.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

function _dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Verbatim port of js/scanGeometry.js's warpToRect, adapted for raw
// ImageData in/out instead of a canvas — see that file for the real
// reasoning behind each step. The Math.max(1, ...) output-size guard is
// the same fix already applied there for a near-coincident dragged quad.
function _warp(data, w, h, quad) {
  const cv = self.cv; // set by importScripts(opencv.js) above — same self.cv-alias pattern js/scanDetectWorker.js uses
  const outW = Math.max(1, Math.round(Math.max(_dist(quad.tl, quad.tr), _dist(quad.bl, quad.br))));
  const outH = Math.max(1, Math.round(Math.max(_dist(quad.tl, quad.bl), _dist(quad.tr, quad.br))));

  const imageData = new ImageData(data, w, h);
  const src = cv.matFromImageData(imageData);
  const dst = new cv.Mat();
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    quad.tl.x, quad.tl.y, quad.tr.x, quad.tr.y, quad.br.x, quad.br.y, quad.bl.x, quad.bl.y,
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, outW, 0, outW, outH, 0, outH,
  ]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);

  let outData;
  try {
    cv.warpPerspective(src, dst, M, new cv.Size(outW, outH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());
    // dst is RGBA (4 channels) from matFromImageData's own source — copy
    // into a fresh Uint8ClampedArray so the buffer is safely transferable
    // (dst.data is a view into OpenCV's WASM heap, not itself transferable).
    outData = new Uint8ClampedArray(dst.data);
  } finally {
    src.delete(); dst.delete(); srcTri.delete(); dstTri.delete(); M.delete();
  }
  return { data: outData, outW, outH };
}
