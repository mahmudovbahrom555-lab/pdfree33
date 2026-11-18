// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  ocrDownloads.js — the bytes the OCR engines read for their models
//  (Tesseract's, PP-OCR's; over the network, or from the browser's cache on a
//  later visit), for the progress label.
//
//  On a scan, the language detection downloads the models it probes with
//  before anything else on the screen moves — ~60 MB the first time for a
//  Chinese page. Two people in China left PDF→Word at "Finding the text's
//  language… 10 %", after 70 s and after 20 min (Tool Leave, 2026-11-18); at
//  400 KB/s that step took 58 s with the bar standing still.
// ============================================================

const _listeners = new Set();
let _total = 0;

// fn(bytes downloaded so far, all engines together); returns the unsubscribe
export function onOcrDownload(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function ocrDownloaded(bytes) {
  if (!(bytes > 0)) return;
  _total += bytes;
  for (const fn of _listeners) fn(_total);
}
