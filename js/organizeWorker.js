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
//    in  → { file: ArrayBuffer, options: { pageOrder: [
//              { kind: 'source', originalIndex, rotation } |
//              { kind: 'blank', width, height, rotation: 0 }
//            ] } }
//    out → { type: 'progress', value, label } | { type: 'done', result, pageCount } | { type: 'error', message }
//
//  pageOrder's array ORDER is the output page order; a page simply
//  absent from the array is the "deleted" case — no separate flag
//  needed on the wire. `rotation` is the final absolute angle
//  (0/90/180/270), already resolved client-side (initial doc rotation
//  + user delta), same convention rotateUI.js's getRotateParams() uses.
//  A 'blank' entry has no source page at all (Add Blank Page feature) —
//  width/height are resolved client-side too (organizeUI.js's pageSizeFor()),
//  never guessed here.
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

  const validEntries = pageOrder.filter(p => p.kind === 'blank'
    || (p.kind === 'source' && Number.isInteger(p.originalIndex) && p.originalIndex >= 0 && p.originalIndex < pageCount));
  if (validEntries.length === 0) throw new Error('No pages to keep');

  // copyPages() only copies each page's own /Resources dict — fonts/images
  // that live at an inherited /Pages tree node come out blank without this.
  // Same fix as handleMerge in worker.js; reimplemented here (not imported —
  // worker.js is a separate, off-limits classic-worker context).
  _flattenPageTreeResources(srcDoc);

  progress(40, 'Reordering pages…');
  const outDoc = await PDFDocument.create();

  // Batch-copy every SOURCE entry, in the order it appears, INCLUDING
  // repeats — copyPages() gives each occurrence in `sourceIndices` its own
  // distinct copied object even when the same index appears more than once
  // (this is exactly what already made Duplicate Page work with zero worker
  // changes), so this must stay every real occurrence, never de-duplicated
  // down to unique indices first.
  const sourceIndices = validEntries.filter(p => p.kind === 'source').map(p => p.originalIndex);
  const copiedSourcePages = sourceIndices.length > 0
    ? await outDoc.copyPages(srcDoc, sourceIndices)
    : [];

  // Walk the requested order once, interleaving copied source pages with
  // freshly-created blank ones (Add Blank Page) exactly where each was
  // asked for — `nextCopied` advances only on 'source' entries, so a
  // 'blank' entry never consumes one of the copied pages meant for a
  // later source entry.
  let nextCopied = 0;
  for (const entry of validEntries) {
    let page;
    if (entry.kind === 'blank') {
      page = outDoc.addPage([entry.width > 0 ? entry.width : 612, entry.height > 0 ? entry.height : 792]);
    } else {
      page = copiedSourcePages[nextCopied++];
      outDoc.addPage(page);
    }
    const angle = entry.rotation ?? 0;
    if (angle !== 0) {
      const canonical = ((angle % 360) + 360) % 360;
      page.setRotation(degrees(canonical));
    }
  }

  progress(85, 'Saving…');
  const bytes = await outDoc.save();
  self.postMessage(
    { type: 'done', result: bytes.buffer, pageCount: validEntries.length },
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
