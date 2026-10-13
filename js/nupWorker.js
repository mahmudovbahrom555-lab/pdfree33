// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  nupWorker.js — Dedicated Web Worker for Pages per Sheet (N-up)
//
//  Deliberately NOT part of worker.js (off-limits per CLAUDE.md). Same
//  pattern as js/resizeWorker.js: a standalone classic worker, driven by
//  js/processor.js's _runNup() on the main thread. The geometry is
//  js/nupLayout.js's; this file only reads the pages and draws them.
//
//  Pages are embedded as vector form XObjects (pdf-lib embedPages +
//  drawPage) — the text stays text, nothing is rasterized.
//
//  Message contract:
//    in  → { files: ArrayBuffer[], options: nupLayout options + border }
//    out → { type: 'progress', value, label }
//        | { type: 'done', result, sheetCount, pageCount }
//        | { type: 'error', message }
// ============================================================

importScripts('./vendor/pdf-lib.min.js', './nupLayout.js');

self.onmessage = async (e) => {
  try {
    await handleNup(e.data.files, e.data.options);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

function progress(value, label) {
  self.postMessage({ type: 'progress', value, label });
}

// Same fallbacks as resizeWorker.js's _safeCropBox: a malformed box array
// (several rounds of merge/edit by different tools) falls back to the
// MediaBox, then to A4, instead of failing the whole file.
function _safeCropBox(page) {
  try { return page.getCropBox(); } catch { /* fall through */ }
  try { return page.getMediaBox(); } catch { /* fall through */ }
  return { x: 0, y: 0, width: 595.28, height: 841.89 };
}

async function handleNup(files, options) {
  const { PDFDocument, rgb, degrees } = self.PDFLib;
  progress(5, 'Loading PDF…');

  // every file's pages, in order — several invoices make one stack
  const sources = [];
  for (const buffer of files) {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    _flattenPageTreeResources(doc);
    for (const page of doc.getPages()) sources.push({ doc, page });
  }
  if (!sources.length) throw new Error('PDF has no pages');

  const infos = sources.map(({ page }) => {
    const box = _safeCropBox(page);
    return { width: box.width, height: box.height, rotate: page.getRotation().angle || 0, box };
  });
  const layout = self.NupLayout.layout(infos, options);

  const out = await PDFDocument.create();
  // One embedding per source page, reused wherever it's drawn. A page with
  // no /Contents (a blank page, legal per the spec) can't be embedded by
  // pdf-lib (MissingPageContentsEmbeddingError) — it's left blank, which
  // is what it is.
  const embedded = new Array(sources.length).fill(null);
  for (let i = 0; i < sources.length; i++) {
    const { page } = sources[i];
    _bakeAnnotationAppearances(page);
    if (!page.node.normalizedEntries().Contents) continue;
    const { x, y, width, height } = infos[i].box;
    // boundingBox = the CropBox: embedPage() would otherwise take the whole
    // MediaBox, bleed and trim marks included (resizeWorker.js's "white
    // frame" bug)
    embedded[i] = await out.embedPage(page, { left: x, bottom: y, right: x + width, top: y + height });
    progress(10 + Math.round((i + 1) / sources.length * 60), `Reading page ${i + 1} of ${sources.length}…`);
  }

  layout.sheets.forEach((sheet, s) => {
    const outPage = out.addPage([layout.width, layout.height]);
    for (const { page, box, draw } of sheet) {
      if (embedded[page]) {
        outPage.drawPage(embedded[page], {
          x: draw.x, y: draw.y, width: draw.width, height: draw.height, rotate: degrees(draw.rotate),
        });
      }
      if (options.border) {
        outPage.drawRectangle({
          x: box.x, y: box.y, width: box.w, height: box.h,
          borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5,
        });
      }
    }
    progress(70 + Math.round((s + 1) / layout.sheets.length * 25), `Sheet ${s + 1} of ${layout.sheets.length}…`);
  });

  progress(97, 'Saving…');
  const bytes = await out.save();
  self.postMessage(
    { type: 'done', result: bytes.buffer, sheetCount: layout.sheets.length, pageCount: sources.length },
    [bytes.buffer]
  );
}

// embedPage() takes only the page's content stream; annotations are drawn
// by the viewer on top of it, so filled-in form values, stamps, signature
// seals (a Chinese e-invoice's red 发票专用章 is often one) and comments
// would vanish from the sheet. Each visible annotation's appearance is
// drawn into the page content first, where the viewer would show it (PDF
// 32000-1 §12.5.5: BBox, turned by the form's /Matrix, mapped onto /Rect).
// An annotation without an appearance (most links) has nothing to draw.
function _bakeAnnotationAppearances(page) {
  const {
    PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFNumber,
    pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
  } = self.PDFLib;
  const ctx = page.doc.context;
  const look = v => (v instanceof PDFRef ? ctx.lookup(v) : v);
  const nums = arr => (arr instanceof PDFArray ? arr.asArray().map(v => look(v)) : [])
    .map(v => (v instanceof PDFNumber ? v.asNumber() : NaN));

  const annots = look(page.node.get(PDFName.of('Annots')));
  if (!(annots instanceof PDFArray)) return;
  for (const item of annots.asArray()) {
    try {
      const annot = look(item);
      if (!(annot instanceof PDFDict)) continue;
      if (annot.get(PDFName.of('Subtype')) === PDFName.of('Popup')) continue;
      const flags = look(annot.get(PDFName.of('F')));
      if (flags instanceof PDFNumber && (flags.asNumber() & (2 | 32))) continue;  // Hidden, NoView
      const ap = look(annot.get(PDFName.of('AP')));
      if (!(ap instanceof PDFDict)) continue;
      // /N is the stream itself, or one per state (a checkbox) chosen by /AS
      let normalRef = ap.get(PDFName.of('N'));
      let normal = look(normalRef);
      if (normal instanceof PDFDict && !(normal instanceof PDFStream)) {
        const state = annot.get(PDFName.of('AS'));
        normalRef = state ? normal.get(state) : undefined;
        normal = look(normalRef);
      }
      if (!(normal instanceof PDFStream)) continue;
      if (!(normalRef instanceof PDFRef)) normalRef = ctx.register(normal);

      const rect = nums(annot.get(PDFName.of('Rect')));
      const bbox = nums(normal.dict.get(PDFName.of('BBox')));
      if (rect.length !== 4 || bbox.length !== 4 || [...rect, ...bbox].some(Number.isNaN)) continue;
      const m = nums(normal.dict.get(PDFName.of('Matrix')));
      const [a, b, c, d, e, f] = m.length === 6 && !m.some(Number.isNaN) ? m : [1, 0, 0, 1, 0, 0];
      const corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]]
        .map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
      const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
      const [bx0, by0, bx1, by1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      const [rx0, rx1] = [Math.min(rect[0], rect[2]), Math.max(rect[0], rect[2])];
      const [ry0, ry1] = [Math.min(rect[1], rect[3]), Math.max(rect[1], rect[3])];
      if (bx1 - bx0 <= 0 || by1 - by0 <= 0) continue;
      const sx = (rx1 - rx0) / (bx1 - bx0), sy = (ry1 - ry0) / (by1 - by0);

      const name = page.node.newXObject('AnnotAP', normalRef);
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(sx, 0, 0, sy, rx0 - sx * bx0, ry0 - sy * by0),
        drawObject(name),
        popGraphicsState(),
      );
    } catch { /* a malformed annotation — leave it out, keep the page */ }
  }
}

// ── Verbatim copy of worker.js's _flattenPageTreeResources ─────────────
// Same as resizeWorker.js and organizeWorker.js: embedPage(), like
// copyPages(), only sees a page's own /Resources — inherited /Pages-tree
// fonts and images would go missing. Duplicated, not imported (worker.js
// is off-limits; a classic worker has no module system). Keep in sync.
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
