// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  organizeWorker.js — Dedicated Web Worker for Organize PDF
//  (reorder + delete + rotate pages into a new document)
//
//  Deliberately NOT part of worker.js (off-limits per CLAUDE.md).
//  Same pattern as js/pdfaWorker.js: a standalone classic worker,
//  driven by js/processor.js's _runOrganize() on the main thread.
//
//  Message contract (mirrors js/worker.js's handlers, so processor.js
//  can reuse the same progress/done/error handling shape):
//    in  → { file: ArrayBuffer, options: { pageOrder: [{originalIndex, rotation}] } }
//    out → { type: 'progress', value, label } | { type: 'done', result, pageCount } | { type: 'error', message }
//
//  pageOrder's array ORDER is the output page order; a page simply
//  absent from the array is the "deleted" case — no separate flag
//  needed on the wire. `rotation` is the final absolute angle
//  (0/90/180/270), already resolved client-side (initial doc rotation
//  + user delta), same convention rotateUI.js's getRotateParams() uses.
// ============================================================

importScripts('./vendor/pdf-lib.min.js');

self.onmessage = async (e) => {
  try {
    await handleOrganize(e.data.file, e.data.options);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

function progress(value, label) {
  self.postMessage({ type: 'progress', value, label });
}

async function handleOrganize(fileBuffer, options) {
  const { PDFDocument, degrees } = self.PDFLib;
  const { pageOrder = [] } = options || {};

  progress(10, 'Loading PDF…');
  const srcDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const pageCount = srcDoc.getPageCount();

  const indices = pageOrder
    .map(p => p.originalIndex)
    .filter(i => Number.isInteger(i) && i >= 0 && i < pageCount);
  if (indices.length === 0) throw new Error('No pages to keep');

  // copyPages() only copies each page's own /Resources dict — fonts/images
  // that live at an inherited /Pages tree node come out blank without this.
  // Same fix as handleMerge in worker.js; reimplemented here (not imported —
  // worker.js is a separate, off-limits classic-worker context).
  _flattenPageTreeResources(srcDoc);

  progress(40, 'Reordering pages…');
  const outDoc  = await PDFDocument.create();
  const copied  = await outDoc.copyPages(srcDoc, indices); // accepts ANY order/duplication in `indices`
  copied.forEach((page, i) => {
    outDoc.addPage(page);
    const angle = pageOrder[i]?.rotation ?? 0;
    if (angle !== 0) {
      const canonical = ((angle % 360) + 360) % 360;
      page.setRotation(degrees(canonical));
    }
  });

  progress(85, 'Saving…');
  const bytes = await outDoc.save();
  self.postMessage(
    { type: 'done', result: bytes.buffer, pageCount: copied.length },
    [bytes.buffer]
  );
}

// ── Verbatim copy of worker.js's _flattenPageTreeResources ─────────────
// Deliberately duplicated, not imported (worker.js is off-limits and this
// is a separate classic-worker context with no module system). Keep in
// sync manually if worker.js's version ever changes.
function _flattenPageTreeResources(pdf) {
  const { PDFName, PDFRef } = self.PDFLib;
  const ctx = pdf.context;
  const INHERITABLE = ['Font', 'XObject', 'ExtGState', 'ColorSpace', 'Pattern', 'Shading'];

  function res(val) {
    if (val == null) return null;
    try { return val instanceof PDFRef ? ctx.lookup(val) : val; } catch { return null; }
  }

  for (let i = 0; i < pdf.getPageCount(); i++) {
    const node = pdf.getPage(i).node;

    const dicts = [];
    const own = res(node.get(PDFName.of('Resources')));
    if (own) dicts.push(own);

    const seen = new Set();
    let parentVal = node.get(PDFName.of('Parent'));
    while (parentVal) {
      const key = String(parentVal);
      if (seen.has(key)) break;
      seen.add(key);
      const parent = res(parentVal);
      if (!parent) break;
      const parentRes = res(parent.get(PDFName.of('Resources')));
      if (parentRes) dicts.push(parentRes);
      parentVal = parent.get(PDFName.of('Parent'));
    }

    if (dicts.length <= 1) continue;

    let pageRes = res(node.get(PDFName.of('Resources')));
    if (!pageRes) {
      pageRes = ctx.obj({});
      node.set(PDFName.of('Resources'), pageRes);
    }

    for (const typeName of INHERITABLE) {
      const key = PDFName.of(typeName);
      let pageSection = res(pageRes.get(key));

      for (let j = 1; j < dicts.length; j++) {
        const inherited = res(dicts[j].get(key));
        if (!inherited) continue;

        if (!pageSection) {
          pageRes.set(key, dicts[j].get(key));
          pageSection = inherited;
        } else {
          try {
            for (const [k, v] of inherited.entries()) {
              if (!pageSection.get(k)) pageSection.set(k, v);
            }
          } catch { /* non-dict resource (e.g. ProcSet array) — skip */ }
        }
      }
    }
  }
}
