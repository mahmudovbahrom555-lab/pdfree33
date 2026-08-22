// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  glossaryWorker.js — Dedicated Web Worker for Document Glossary
//  (writes Highlight+Popup annotations for matched dictionary terms)
//
//  Deliberately NOT part of worker.js (off-limits per CLAUDE.md). Same
//  pattern as js/organizeWorker.js/js/resizeWorker.js: a standalone
//  classic worker, driven by js/processor.js's _runGlossary() on the
//  main thread — which does the pdf.js text-search on the MAIN thread
//  first (this worker only ever touches pdf-lib, never pdf.js).
//
//  WHY text search never happens in this worker, confirmed empirically
//  (not a style choice): pdf.js 3.11.174's getDocument() tries to spawn
//  its own nested Worker when called from inside an already-running
//  Worker, and its fallback path for when that fails ("fake worker")
//  itself calls `document`, which doesn't exist here — throws
//  `Setting up fake worker failed: "document is not defined"` even with
//  disableWorker:true. Verified via a real Playwright run against this
//  exact pdf.js build before writing this file — see
//  gsc_crawled_not_indexed_2026_08 / project memory for the throwaway
//  prototype that found this. Splitting the work this way (search on
//  main thread, write on worker) isn't a novel idea either — it's the
//  same shape js/worker.js's handleRedact already uses in production
//  (redactUI.js finds matches on the main thread, the worker only draws).
//
//  Message contract:
//    in  → { file: ArrayBuffer, options: { matches: [{pageIndex, definition, boxes:[{x,y,w,h}]}] } }
//    out → { type: 'progress', value, label } | { type: 'done', result, annotationCount } | { type: 'error', message }
//
//  `boxes` (plural) per match, not a single box — a matched term can be
//  split across 2+ pdf.js text items (kerning/font-run boundaries are
//  common, verified against a real split-term PDF before writing this;
//  a single-item term is just the boxes.length === 1 case). Each match
//  becomes ONE Highlight annotation whose QuadPoints contains one quad
//  per box — exactly what PDF's QuadPoints array is designed for.
// ============================================================

importScripts('./vendor/pdf-lib.min.js');

self.onmessage = async (e) => {
  try {
    await handleGlossary(e.data.file, e.data.options);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

function progress(value, label) {
  self.postMessage({ type: 'progress', value, label });
}

function _boundingRect(boxes) {
  const minX = Math.min(...boxes.map(b => b.x));
  const minY = Math.min(...boxes.map(b => b.y));
  const maxX = Math.max(...boxes.map(b => b.x + b.w));
  const maxY = Math.max(...boxes.map(b => b.y + b.h));
  return [minX, minY, maxX, maxY];
}

// PDFHexString.fromText (UTF-16BE + BOM), NOT PDFString.of — PDFString
// uses PDFDocEncoding (effectively Latin-1) and silently mangles anything
// outside that range. Confirmed empirically: a plain curly apostrophe
// already corrupted; real dictionary text with diacritics/non-Latin
// scripts (the actual target use case here) would be far worse. Verified
// round-trip correct for Devanagari + em dash + curly apostrophe via an
// independent parser (pypdf, not pdf-lib) before writing this.
function _addHighlightWithPopup(pdf, page, match) {
  const { PDFName, PDFHexString } = self.PDFLib;
  const rect = _boundingRect(match.boxes);

  const quadPoints = [];
  for (const b of match.boxes) {
    quadPoints.push(b.x, b.y + b.h, b.x + b.w, b.y + b.h, b.x, b.y, b.x + b.w, b.y);
  }

  const highlightDict = pdf.context.obj({
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: rect,
    QuadPoints: quadPoints,
    C: [1, 0.92, 0.4],
    CA: 0.4,
    Contents: PDFHexString.fromText(match.definition),
    T: PDFHexString.fromText('PDFree Glossary'),
  });
  const highlightRef = pdf.context.register(highlightDict);

  const popupDict = pdf.context.obj({
    Type: 'Annot',
    Subtype: 'Popup',
    Rect: [rect[2] + 10, rect[1], rect[2] + 220, rect[1] + 80],
    Parent: highlightRef,
    Open: false,
  });
  const popupRef = pdf.context.register(popupDict);
  highlightDict.set(PDFName.of('Popup'), popupRef);

  const existing = page.node.get(PDFName.of('Annots'));
  const annots = existing ? pdf.context.lookup(existing) : pdf.context.obj([]);
  annots.push(highlightRef);
  annots.push(popupRef);
  page.node.set(PDFName.of('Annots'), annots);
}

async function handleGlossary(fileBuffer, options) {
  const { PDFDocument } = self.PDFLib;
  const { matches = [] } = options || {};

  if (matches.length === 0) throw new Error('No glossary terms matched — nothing to annotate');

  progress(20, 'Loading PDF…');
  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const pageCount = pdfDoc.getPageCount();

  progress(40, 'Adding annotations…');
  let written = 0;
  for (const match of matches) {
    if (match.pageIndex < 0 || match.pageIndex >= pageCount) continue; // defensive — stale index, skip rather than throw
    const page = pdfDoc.getPage(match.pageIndex);
    _addHighlightWithPopup(pdfDoc, page, match);
    written++;
  }

  progress(85, 'Saving…');
  const bytes = await pdfDoc.save();
  self.postMessage(
    { type: 'done', result: bytes.buffer, annotationCount: written },
    [bytes.buffer]
  );
}
