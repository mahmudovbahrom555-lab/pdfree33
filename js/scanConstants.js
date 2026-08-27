// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  scanConstants.js — shared tuning constants for Document Scanner,
//  split into their own tiny module so a real value only needs to be
//  correct in ONE place.
//
//  Found via code review: SCAN_MAX_LONG_EDGE used to be three separate,
//  independently-declared `= 2200` constants (js/scanDocumentUI.js's
//  MAX_SCAN_LONG_EDGE, js/scanCameraUI.js's _CAPTURE_MAX_LONG_EDGE,
//  js/scanFilter.js's MAX_FILTER_LONG_EDGE) with comments cross-
//  referencing each other but no actual shared import — a future
//  tuning pass could update one and silently miss the other two,
//  reintroducing inconsistent resolution behavior across the decode/
//  capture/filter paths the comments all assume stay numerically
//  identical.
// ============================================================

// Long-edge cap applied to every decoded/captured photo before ANY
// geometry or filter processing touches it. Found via a real user
// report: a raw camera photo (many phones now ship 12-48MP main
// sensors — a "budget" device is not exempt, e.g. a Redmi 8's 12MP main
// camera already decodes to ~4000x3000) used to flow completely
// uncapped through this tool's whole pipeline — corner-detection/crop-
// review, js/scanGeometry.js's OpenCV.js perspective warp (cv.imread/
// warpPerspective allocate a full-resolution Mat), and js/scanFilter.js's
// multi-pass grayscale/background-estimate/median-filter/unsharp-mask/
// enhance chain (each pass allocates a new full-size ImageData buffer)
// — all on the main thread (the filter chain itself later moved to
// js/scanFilterWorker.js, but still receives whatever resolution it's
// hand). On a multi-page scan this reliably exhausted the tab's memory
// budget on a real low-RAM device.
// 2200px long edge is comfortably print/OCR quality — ≈190 DPI on an
// A4/Letter page's long edge (297mm ≈ 11.7in × 190dpi ≈ 2223px) — while
// cutting memory for every downstream full-resolution operation by
// 3-10x+ depending on the source camera's real resolution.
export const SCAN_MAX_LONG_EDGE = 2200;
