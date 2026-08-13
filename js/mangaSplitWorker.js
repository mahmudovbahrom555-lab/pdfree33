// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  mangaSplitWorker.js — Dedicated Web Worker for Split Manga Pages
//  (crop a double-page spread into two separate pages, RTL-aware)
//
//  Deliberately NOT part of worker.js (off-limits per CLAUDE.md).
//  Same pattern as js/resizeWorker.js / js/organizeWorker.js: a
//  standalone classic worker, driven by js/processor.js's
//  _runMangaSplit() on the main thread.
//
//  Message contract:
//    in  → { file: ArrayBuffer, options: { rtl: boolean, skipPages: number[] } }
//    out → { type: 'progress', value, label } | { type: 'done', result, pageCount } | { type: 'error', message }
//
//  skipPages holds 0-based indices the user marked "don't split" (covers,
//  single pages mixed into an otherwise all-spreads scan) — those pages
//  are copied through unchanged, same size as the source.
// ============================================================

importScripts('./vendor/pdf-lib.min.js');

self.onmessage = async (e) => {
  try {
    await handleMangaSplit(e.data.file, e.data.options);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

function progress(value, label) {
  self.postMessage({ type: 'progress', value, label });
}

async function handleMangaSplit(fileBuffer, options) {
  const { PDFDocument } = self.PDFLib;
  const { rtl = true, skipPages = [] } = options || {};
  const skip = new Set(skipPages);

  progress(10, 'Loading PDF…');
  const srcDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });

  // embedPage() only sees a page's own /Resources dict — inherited
  // /Pages-tree resources (fonts/images) would otherwise go missing.
  // Same fix as resizeWorker.js/organizeWorker.js.
  _flattenPageTreeResources(srcDoc);

  const outDoc   = await PDFDocument.create();
  const srcPages = srcDoc.getPages();
  if (srcPages.length === 0) throw new Error('PDF has no pages');

  for (let i = 0; i < srcPages.length; i++) {
    const srcPage = srcPages[i];
    const { width: w, height: h } = srcPage.getSize();

    if (skip.has(i)) {
      const [copied] = await outDoc.copyPages(srcDoc, [i]);
      outDoc.addPage(copied);
    } else {
      const midX = w / 2;
      // embedPage's boundingBox clips the source page in its own
      // (untransformed) coordinate space and returns a reusable Form
      // XObject — fully vector-preserving, no rasterization.
      const leftEmbed  = await outDoc.embedPage(srcPage, { left: 0,    right: midX, bottom: 0, top: h });
      const rightEmbed = await outDoc.embedPage(srcPage, { left: midX, right: w,    bottom: 0, top: h });

      // Manga/manhwa reads right-to-left — the right half of the spread
      // is the FIRST page in reading order when rtl is true.
      const halves = rtl ? [rightEmbed, leftEmbed] : [leftEmbed, rightEmbed];
      for (const embed of halves) {
        const newPage = outDoc.addPage([midX, h]);
        newPage.drawPage(embed, { x: 0, y: 0, width: midX, height: h });
      }
    }

    progress(Math.round(((i + 1) / srcPages.length) * 85) + 10, `Splitting page ${i + 1} of ${srcPages.length}...`);
  }

  progress(97, 'Saving…');
  const bytes = await outDoc.save();
  self.postMessage(
    { type: 'done', result: bytes.buffer, pageCount: outDoc.getPageCount() },
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
