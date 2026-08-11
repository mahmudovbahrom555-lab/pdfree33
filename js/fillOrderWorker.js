// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  fillOrderWorker.js — Dedicated Web Worker for Fill PDF Form's
//  custom Tab-order feature.
//
//  Deliberately NOT part of worker.js (off-limits per CLAUDE.md).
//  Same pattern as js/organizeWorker.js/js/resizeWorker.js: a standalone
//  classic worker, driven by js/processor.js's _runFillOrder() on the
//  main thread.
//
//  Runs BEFORE js/worker.js's handleFill(): reorders the physical
//  /Annots widget order (+ sets page /Tabs) on the ORIGINAL, unfilled
//  bytes, then processor.js feeds the result into the existing fill
//  pipeline unchanged. Must run before, not after — handleFill's default
//  flatten() deletes the AcroForm/widget dicts entirely, so there's
//  nothing left to reorder afterward. This worker never touches field
//  values, fonts, flatten, or signatures — purely structural.
//
//  Message contract (mirrors js/worker.js's handlers, so processor.js
//  can reuse the same progress/done/error handling shape):
//    in  → { file: ArrayBuffer, options: { mode: 'auto'|'manual', fieldOrder?: string[] } }
//    out → { type: 'progress', value, label } | { type: 'done', result } | { type: 'error', message }
//
//  mode 'auto'   — no fieldOrder needed; sorts each page's fields by
//                  visual position (top-to-bottom, left-to-right),
//                  rotation-aware.
//  mode 'manual' — fieldOrder is the user's full desired field-NAME
//                  order; per page, only the subset present in
//                  fieldOrder is reordered, everything else (fields not
//                  included, non-widget annotations) is left untouched.
// ============================================================

importScripts('./vendor/pdf-lib.min.js');

self.onmessage = async (e) => {
  try {
    await handleFillOrder(e.data.file, e.data.options);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

function progress(value, label) {
  self.postMessage({ type: 'progress', value, label });
}

async function handleFillOrder(fileBuffer, options) {
  const { PDFDocument, PDFName, PDFRef } = self.PDFLib;
  const { mode = 'auto', fieldOrder = [] } = options || {};

  progress(10, 'Loading PDF…');
  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const ctx = pdfDoc.context;

  // Field identity for a widget dict comes from ITS OWN /T, walking up
  // /Parent if absent (merged field+widget dicts have /T inline; Kids-based
  // ones need the parent chain) — the same resolution order every PDF
  // reader actually uses. Deliberately NOT sourced from
  // form.getFields()/acroField.Kids(): confirmed via real-world testing
  // that on some PDFs (notably ones already processed once by pdf-lib,
  // e.g. a form re-opened after a previous save) the AcroForm field tree's
  // Kids refs and the physical refs actually sitting in a page's /Annots
  // array are NOT the same PDFRef instances — matching via Kids silently
  // found zero matches, so nothing got reordered and /Tabs never got set.
  // Reading identity directly off each page's own /Annots entries makes
  // ref agreement a certainty by construction.
  function fieldNameOf(dict) {
    const seen = new Set();
    let node = dict;
    while (node) {
      const t = node.get(PDFName.of('T'));
      if (t) return t.decodeText ? t.decodeText() : String(t);
      const parent = node.get(PDFName.of('Parent'));
      if (!parent) return null;
      const key = String(parent);
      if (seen.has(key)) return null;
      seen.add(key);
      node = parent instanceof PDFRef ? ctx.lookup(parent) : parent;
    }
    return null;
  }

  function rectOf(dict) {
    const r = dict.get(PDFName.of('Rect'));
    const arr = r && (r.asArray ? r.asArray() : null);
    if (!arr || arr.length < 4) return null;
    const [x1, y1, x2, y2] = arr.map(v => (v.asNumber ? v.asNumber() : Number(v)));
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
  }

  const nameRank = mode === 'manual'
    ? new Map(fieldOrder.map((n, i) => [n, i]))
    : null;

  progress(55, 'Reordering tab order…');

  for (const page of pdfDoc.getPages()) {
    const annots = page.node.Annots ? page.node.Annots() : undefined;
    if (!annots) continue;

    const entries = annots.asArray();
    const rotation = _normalizeRotation(page.node.Rotate ? page.node.Rotate() : undefined);

    const orderableIdx = [];
    const sortKey       = []; // parallel to orderableIdx: rank (manual) or [vKey,hKey] (auto)
    entries.forEach((ref, i) => {
      if (!(ref instanceof PDFRef)) return;
      const dict = ctx.lookup(ref);
      if (!dict) return;
      const name = fieldNameOf(dict);
      if (!name) return; // not a field widget (e.g. a Link/Text annotation)

      if (mode === 'manual') {
        if (!nameRank.has(name)) return;
        orderableIdx.push(i);
        sortKey.push(nameRank.get(name));
      } else {
        const rect = rectOf(dict);
        if (!rect) return;
        orderableIdx.push(i);
        sortKey.push(_rotatedSortKeys(rect, rotation));
      }
    });
    if (orderableIdx.length < 2) continue;

    const sorted = orderableIdx
      .map((i, k) => ({ ref: entries[i], key: sortKey[k] }))
      .sort((a, b) => mode === 'manual'
        ? a.key - b.key
        : (a.key[0] - b.key[0]) || (a.key[1] - b.key[1]))
      .map(e => e.ref);

    orderableIdx.forEach((i, k) => annots.set(i, sorted[k]));
    // /A ("annotations array order", PDF 2.0) is the only /Tabs value that
    // guarantees readers respect the physical reorder above — /R or /C
    // (common Acrobat defaults) make readers recompute order from widget
    // geometry and silently ignore it. Always overwrite when reordering.
    page.node.set(PDFName.of('Tabs'), PDFName.of('A'));
  }

  progress(90, 'Saving…');
  const bytes = await pdfDoc.save({ useObjectStreams: true, addDefaultPage: false });
  self.postMessage({ type: 'done', result: bytes.buffer }, [bytes.buffer]);
}

function _normalizeRotation(deg) {
  return ((Number(deg) || 0) % 360 + 360) % 360;
}

// Sort keys such that ascending [vertical, horizontal] yields visual
// top-to-bottom, left-to-right order AS DISPLAYED, accounting for the
// page's /Rotate. Rect coordinates are always in unrotated page space.
function _rotatedSortKeys(rect, rotationDeg) {
  const cx = rect.x + rect.width  / 2;
  const cy = rect.y + rect.height / 2;
  switch (rotationDeg) {
    case 90:  return [cx, cy];
    case 180: return [cy, -cx];
    case 270: return [-cx, -cy];
    default:  return [-cy, cx]; // 0
  }
}
