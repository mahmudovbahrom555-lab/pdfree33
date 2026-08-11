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
  const form   = pdfDoc.getForm();
  const fields = form.getFields();

  progress(30, 'Reading fields…');

  // refInfo: PDFRef → { fieldName, widget } for every widget annotation
  // belonging to a fillable field (radio groups contribute one entry per
  // button, all sharing the same fieldName).
  const refInfo = new Map();
  for (const field of fields) {
    let name;
    try { name = field.getName(); } catch { continue; }

    const acroField = field.acroField;
    const widgets    = acroField.getWidgets();
    const kids       = acroField.Kids ? acroField.Kids() : undefined;
    const refs       = kids
      ? kids.asArray().filter(o => o instanceof PDFRef)
      : [acroField.ref];

    widgets.forEach((widget, i) => {
      const ref = refs[i];
      if (ref instanceof PDFRef) refInfo.set(ref, { fieldName: name, widget });
    });
  }

  const nameRank = mode === 'manual'
    ? new Map(fieldOrder.map((n, i) => [n, i]))
    : null;

  progress(55, 'Reordering tab order…');

  for (const page of pdfDoc.getPages()) {
    const annots = page.node.Annots ? page.node.Annots() : undefined;
    if (!annots) continue;

    const entries = annots.asArray();
    const orderableIdx = [];
    entries.forEach((ref, i) => {
      if (!(ref instanceof PDFRef)) return;
      const info = refInfo.get(ref);
      if (!info) return;
      if (mode === 'manual' && !nameRank.has(info.fieldName)) return;
      orderableIdx.push(i);
    });
    if (orderableIdx.length < 2) continue;

    let sorted;
    if (mode === 'manual') {
      sorted = orderableIdx
        .map(i => entries[i])
        .sort((a, b) => nameRank.get(refInfo.get(a).fieldName) - nameRank.get(refInfo.get(b).fieldName));
    } else {
      const rotation = _normalizeRotation(page.node.Rotate ? page.node.Rotate() : undefined);
      sorted = orderableIdx
        .map(i => {
          const ref  = entries[i];
          const rect = refInfo.get(ref).widget.getRectangle();
          return { ref, keys: _rotatedSortKeys(rect, rotation) };
        })
        .sort((a, b) => (a.keys[0] - b.keys[0]) || (a.keys[1] - b.keys[1]))
        .map(e => e.ref);
    }

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
