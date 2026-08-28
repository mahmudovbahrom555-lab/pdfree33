// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  glossaryWorker.js — Dedicated Web Worker for Document Glossary
//  (matches dictionary terms, writes Highlight+Popup annotations)
//
//  Deliberately NOT part of worker.js (off-limits per CLAUDE.md). Same
//  pattern as js/organizeWorker.js/js/resizeWorker.js: a standalone
//  classic worker, driven by js/processor.js's _runGlossary() on the
//  main thread — which does the pdf.js text EXTRACTION on the MAIN
//  thread first (this worker never touches pdf.js, only pdf-lib + plain
//  data). Text extraction (getPage/getTextContent) has to stay on the
//  main thread; term MATCHING doesn't, and moved here — see below.
//
//  WHY pdf.js extraction never happens in this worker, confirmed
//  empirically (not a style choice): pdf.js 3.11.174's getDocument()
//  tries to spawn its own nested Worker when called from inside an
//  already-running Worker, and its fallback path for when that fails
//  ("fake worker") itself calls `document`, which doesn't exist here —
//  throws `Setting up fake worker failed: "document is not defined"`
//  even with disableWorker:true. Verified via a real Playwright run
//  against this exact pdf.js build before writing this file — see
//  gsc_crawled_not_indexed_2026_08 / project memory for the throwaway
//  prototype that found this.
//
//  WHY term matching (_findGlossaryMatches below) moved here from
//  processor.js: it has zero pdf.js dependency — it only touches the
//  plain {str, transform, width} objects pdf.js already extracted — so
//  unlike extraction it was never main-thread-only, just never moved.
//  A real Playwright measurement (4x CPU throttle, 200 pages of
//  worst-case repeated-vocabulary text, rAF-heartbeat methodology — same
//  audit pass that found scan-document's warpToRect main-thread block)
//  found a 211ms single-frame gap when this ran synchronously on the
//  main thread inside _runGlossary(). Moved here instead of staying
//  main-thread, same fix shape as the scan-document case.
//
//  Message contract:
//    in  → { file: ArrayBuffer, options: { pageItemsByPage: [[{str,transform,width}, ...], ...], dictionary: [{term, definition}, ...] } }
//    out → { type: 'progress', value, label }
//        | { type: 'done', result, annotationCount, matchCount, truncated }
//        | { type: 'error', message } | { type: 'error', code: 'no_matches' }
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

// Defensive cap, not a routine limit — real-world testing (500 pages,
// 35,000 matches, 70,000 annotation objects) completed correctly in ~10s
// with no memory/UI issues, so this only guards against a genuinely
// pathological input (e.g. a 1-2 letter "term" that matches thousands of
// times across a huge document), not realistic large documents like the
// actual target use case (a long scripture text).
const _GLOSSARY_MAX_MATCHES = 20000;

// Groups pdf.js text items by baseline (same y, within tolerance), then
// matches each dictionary term against the CONCATENATED line text rather
// than per-item — a term split across two items (a real, common case:
// kerning/font-run boundaries, verified against a real generated PDF, not
// hypothetical) would otherwise be silently missed entirely, not just
// mis-positioned. A match's boxes[] can be >1 when it spans an item
// boundary — turned into one Highlight annotation with one QuadPoints
// quad per box below, which is exactly what QuadPoints is for. Does NOT
// handle a term split across two lines (word wrap/hyphen at line end) —
// a real, known, narrower gap, left for later.
function _findGlossaryMatches(pageItemsByPage, dictionary, yTolerance = 2) {
  const terms = dictionary.map(d => ({
    ...d,
    re: new RegExp(`\\b${d.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'giu'),
  }));
  const matches = [];

  pageItemsByPage.forEach((items, pageIndex) => {
    const lines = [];
    // Fast path: check the most-recently-created line before falling back to
    // the full scan. pdf.js emits items in roughly reading order, so
    // consecutive items usually belong to the same line as the previous one
    // — this is the exact same lines.find() semantics as a fallback (never
    // skipped, never changes which line an item lands in), just short-
    // circuited for the common case. Verified byte-identical output against
    // the plain linear scan on both sequential and adversarial (interleaved
    // two-column) synthetic inputs; ~3x faster on a realistic dense page.
    let _lastLine = null;
    for (const item of items) {
      if (!item.str) continue;
      const ty = item.transform[5];
      let line = (_lastLine && Math.abs(_lastLine.y - ty) <= yTolerance)
        ? _lastLine
        : lines.find(l => Math.abs(l.y - ty) <= yTolerance);
      if (!line) { line = { y: ty, items: [] }; lines.push(line); }
      line.items.push(item);
      _lastLine = line;
    }
    for (const line of lines) line.items.sort((a, b) => a.transform[4] - b.transform[4]);

    for (const line of lines) {
      let lineText = '';
      const charToItem = [];
      for (const item of line.items) {
        const start = lineText.length;
        lineText += item.str;
        for (let i = 0; i < item.str.length; i++) charToItem[start + i] = item;
      }

      for (const { term, definition, re } of terms) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(lineText)) !== null) {
          const matchStart = m.index;
          const matchEnd   = m.index + m[0].length;
          const boxes = [];
          let i = matchStart;
          while (i < matchEnd) {
            const item = charToItem[i];
            if (!item) { i++; continue; }
            let j = i;
            while (j < matchEnd && charToItem[j] === item) j++;
            const itemStartInLine = charToItem.indexOf(item);
            const [, , , scaleY, tx] = item.transform;
            const charW = item.width / (item.str.length || 1);
            const offsetInItem = i - itemStartInLine;
            const lenInItem    = j - i;
            const h = Math.max(Math.abs(scaleY) * 1.2, 4);
            boxes.push({
              x: tx + offsetInItem * charW,
              y: item.transform[5] - h * 0.1,
              w: Math.max(lenInItem * charW, 2),
              h,
            });
            i = j;
          }
          if (boxes.length) matches.push({ pageIndex, definition, boxes, term, matchedText: m[0] });
        }
      }
    }
  });

  return matches;
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
  const { pageItemsByPage = [], dictionary = [] } = options || {};

  progress(15, 'Searching…');
  let matches = _findGlossaryMatches(pageItemsByPage, dictionary);
  if (matches.length === 0) {
    self.postMessage({ type: 'error', code: 'no_matches' });
    return;
  }
  const truncated = matches.length > _GLOSSARY_MAX_MATCHES;
  if (truncated) matches = matches.slice(0, _GLOSSARY_MAX_MATCHES);

  progress(35, 'Loading PDF…');
  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const pageCount = pdfDoc.getPageCount();

  progress(50, 'Adding annotations…');
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
    { type: 'done', result: bytes.buffer, annotationCount: written, matchCount: matches.length, truncated },
    [bytes.buffer]
  );
}
