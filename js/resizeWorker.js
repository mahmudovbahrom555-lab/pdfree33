// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  resizeWorker.js — Dedicated Web Worker for Resize PDF
//  (fit/fill/actual-size every page onto a target paper size)
//
//  Deliberately NOT part of worker.js (off-limits per CLAUDE.md).
//  Same pattern as js/organizeWorker.js / js/pdfaWorker.js: a
//  standalone classic worker, driven by js/processor.js's
//  _runResize() on the main thread.
//
//  Message contract:
//    in  → { file: ArrayBuffer, options: { targetSize, mode, marginPt, orientation } }
//    out → { type: 'progress', value, label } | { type: 'done', result, pageCount } | { type: 'error', message }
// ============================================================

importScripts('./vendor/pdf-lib.min.js');

// A4/Letter pt values match worker.js's handleJpg2Pdf PAGE_SIZES exactly —
// kept consistent, not reinvented. A3/A5/Legal added for real, distinct
// demand (A3 drawings/posters, A5 flyers/booklets, Legal US forms).
const PAGE_SIZES = {
  a0:     [2383.94, 3370.40],
  a1:     [1683.78, 2383.94],
  a2:     [1190.55, 1683.78],
  a3:     [841.89, 1190.55],
  a4:     [595.28, 841.89],
  a5:     [419.53, 595.28],
  a6:     [297.64, 419.53],
  letter: [612, 792],
  legal:  [612, 1008],
};

self.onmessage = async (e) => {
  try {
    await handleResize(e.data.file, e.data.options);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

function progress(value, label) {
  self.postMessage({ type: 'progress', value, label });
}

// getCropBox()/getMediaBox() call pdf-lib's PDFArray.asRectangle(), which
// throws PDFArrayIsNotRectangleError if the box array isn't exactly 4
// elements, or a type error if an element isn't a real number — a
// realistic failure mode for a PDF that's been through several rounds of
// merge/edit by different tools (this exact bug class was found via a
// user report on a "2_merged_merged_merged.pdf" — a file already known to
// carry cumulative structural risk). Falls back to MediaBox, then to a
// fixed A4 rectangle at the origin, rather than letting the whole resize
// fail for one page's malformed box.
function _safeCropBox(page) {
  try { return page.getCropBox(); } catch { /* fall through */ }
  try { return page.getMediaBox(); } catch { /* fall through */ }
  return { x: 0, y: 0, width: PAGE_SIZES.a4[0], height: PAGE_SIZES.a4[1] };
}

async function handleResize(fileBuffer, options) {
  const { PDFDocument } = self.PDFLib;
  const { targetSize = 'a4', mode = 'fit', marginPt = 28, orientation = 'auto', customSizePt } = options || {};
  // customSizePt (from resizeUI.js's "Custom" chip) wins when present —
  // targetSize stays 'custom' as a marker, the real [w,h] pair rides here.
  const baseSize = customSizePt || PAGE_SIZES[targetSize] || PAGE_SIZES.a4;

  progress(10, 'Loading PDF…');
  const srcDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });

  // embedPage(), like copyPages(), only sees a page's own /Resources dict —
  // inherited /Pages-tree resources (fonts/images) would otherwise go
  // missing. Same fix as organizeWorker.js.
  _flattenPageTreeResources(srcDoc);

  const outDoc   = await PDFDocument.create();
  const srcPages = srcDoc.getPages();
  if (srcPages.length === 0) throw new Error('PDF has no pages');

  for (let i = 0; i < srcPages.length; i++) {
    const srcPage = srcPages[i];
    // CropBox, not getSize()/MediaBox: a print-ready PDF (this tool's own
    // namesake use case) commonly has a MediaBox larger than its CropBox —
    // bleed/trim margins from Illustrator/InDesign exports. Fitting against
    // the bigger bleed-inclusive MediaBox scales the real (smaller) visible
    // content down and insets it — the exact reported "white frame" bug.
    // getCropBox() transparently falls back to MediaBox when CropBox is
    // unset (pdf-lib's own documented default), so this is a strict
    // superset fix — zero behavior change for the common case. Wrapped in
    // _safeCropBox() for a malformed box array — see its own comment.
    const { x: cropX, y: cropY, width: origW, height: origH } = _safeCropBox(srcPage);
    const [w, h] = _resolveTargetSize(baseSize, origW, origH, orientation);

    const availW = Math.max(1, w - marginPt * 2);
    const availH = Math.max(1, h - marginPt * 2);
    const { scale, x, y } = _fitRect(origW, origH, availW, availH, mode);

    const newPage = outDoc.addPage([w, h]);
    // A page with zero draw calls (e.g. one inserted by Merge's "Insert
    // Blank Pages" option — mergeWorker.js's addPage([w,h]) with nothing
    // drawn, deliberately) has no /Contents entry at all — legal per the
    // PDF spec (renders as blank either way), but pdf-lib's embedPage()
    // unconditionally throws MissingPageContentsEmbeddingError
    // ("Can't embed page with missing Contents") for it. Real user report:
    // a 186-page multi-merge PDF hit this exact error. Nothing to embed or
    // draw for a genuinely blank source page — the already-correctly-sized
    // blank newPage IS the correct resized output.
    if (srcPage.node.normalizedEntries().Contents) {
      // boundingBox clips the embed to exactly the CropBox rectangle —
      // without this, embedPage() defaults to the full MediaBox regardless
      // of the (now-correct) scale computed above, so the bleed area would
      // still leak into the output even with the right size numbers.
      const embedded = await outDoc.embedPage(srcPage, {
        left: cropX, bottom: cropY, right: cropX + origW, top: cropY + origH,
      });
      newPage.drawPage(embedded, {
        x: marginPt + x,
        y: marginPt + y,
        width: origW * scale,
        height: origH * scale,
      });
    }

    progress(Math.round(((i + 1) / srcPages.length) * 85) + 10, `Resizing page ${i + 1} of ${srcPages.length}...`);
  }

  progress(97, 'Saving…');
  const bytes = await outDoc.save();
  self.postMessage(
    { type: 'done', result: bytes.buffer, pageCount: srcPages.length },
    [bytes.buffer]
  );
}

// mode 'fit'    = Math.min(1, availW/srcW, availH/srcH) — whole page visible, may letterbox,
//                 never enlarges past 100% (default)
// mode 'fill'   = Math.max(availW/srcW, availH/srcH)    — fills target, may crop edges (intentional),
//                 may enlarge past 100%
// mode 'actual' = 1                                      — no scaling, just centered on the new paper
//
// Every page is fit against its OWN origW/origH — a source PDF mixing
// Letter and A4 pages still converges correctly to a uniform output paper
// size, page by page. x/y returned are offsets from the margin box's
// bottom-left corner, not the page edge.
//
// Identical arithmetic is duplicated client-side in resizeUI.js for the
// live preview — same precedent as _flattenPageTreeResources: small, pure,
// worth keeping in sync manually.
function _fitRect(srcW, srcH, availW, availH, mode) {
  let scale;
  if (mode === 'fill') {
    scale = Math.max(availW / srcW, availH / srcH);
  } else if (mode === 'actual') {
    scale = 1;
  } else {
    // 'fit' never enlarges — a source page already smaller than the target
    // paper stays at its own size, centered, rather than being blown up to
    // fill the page. Only 'fill' is allowed to scale past 100%.
    scale = Math.min(1, availW / srcW, availH / srcH);
  }
  const scaledW = srcW * scale;
  const scaledH = srcH * scale;
  const x = (availW - scaledW) / 2;
  const y = (availH - scaledH) / 2;
  return { scale, x, y };
}

// orientation: 'auto' matches the target page's orientation to the source
// page's own (landscape source → landscape target), so a landscape
// spreadsheet printout doesn't get force-fit into a portrait frame at a
// tiny scale. 'portrait'/'landscape' force the frame regardless of source.
function _resolveTargetSize([baseW, baseH], origW, origH, orientation) {
  const portraitFrame = [Math.min(baseW, baseH), Math.max(baseW, baseH)];
  const landscapeFrame = [portraitFrame[1], portraitFrame[0]];

  if (orientation === 'portrait') return portraitFrame;
  if (orientation === 'landscape') return landscapeFrame;
  return origW > origH ? landscapeFrame : portraitFrame;
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
