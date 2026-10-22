// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  repairWorker.js — "Try to repair" for a damaged PDF (2026-10-14)
//
//  Offered from the "file is damaged" error. Measured first, not assumed:
//  a plain qpdf rewrite (BentoPDF's Repair) fixed none of the failures our
//  tools actually report — pdf-lib already survives a broken xref or a cut
//  tail by scanning objects. What breaks our tools is narrower:
//    1. the catalog's /Pages pointing at something that isn't the page
//       tree ("catalog.Pages(...).traverse is not a function") — the real
//       root is found among the objects, or a new one built from the pages;
//    2. a page's content stream pdf-lib can't inflate ("Bad encoding in
//       flate stream", "Unknown compression method in flate stream") —
//       embedPage decodes it, so the whole job fails. Typically a stream
//       cut short (a download or save that didn't finish): everything that
//       inflates up to the cut is kept — 87 % of the text for a stream cut
//       at 90 %, measured — the way a viewer still draws that part. Only
//       streams pdf-lib's own decoder rejects are touched; damage it
//       tolerates is left alone (a stricter test would throw away text
//       pdf-lib reads fine).
//    3. a page tree whose /Count entries don't add up (SPLIT-37EA: "Failed
//       to removeLeafNode … 'Count' entries are invalid") — recounted from
//       the real /Kids (js/pageTreeCounts.js).
//  Nothing to fix → null, and the caller keeps the original bytes.
//
//  Message contract:
//    in  → { buffer: ArrayBuffer }
//    out → { type: 'done', result: ArrayBuffer|null, fixes: { pageTree, pageCounts, streams } }
//        | { type: 'error', message }
// ============================================================

importScripts('./vendor/pdf-lib.min.js');
importScripts('./pageTreeCounts.js');

self.onmessage = async (e) => {
  try {
    const { result, fixes } = await repairPdf(e.data.buffer);
    self.postMessage({ type: 'done', result, fixes }, result ? [result] : []);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

// Everything that inflates before the damage. DecompressionStream hands out
// what it decoded so far, then rejects at the bad bytes.
async function inflatePartial(bytes) {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch { /* the damage — keep what came before it */ }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

function pdfLibDecodes(stream) {
  try { self.PDFLib.decodePDFRawStream(stream).decode(); return true; } catch { return false; }
}

function fixPageTree(doc) {
  const { PDFName, PDFDict, PDFPageTree, PDFPageLeaf } = self.PDFLib;
  const ctx = doc.context;
  const current = ctx.lookup(doc.catalog.get(PDFName.of('Pages')));
  if (current instanceof PDFPageTree) return false;

  const objects = ctx.enumerateIndirectObjects();
  const root = objects.find(([, o]) => o instanceof PDFPageTree && !o.get(PDFName.of('Parent')));
  if (root) {
    doc.catalog.set(PDFName.of('Pages'), root[0]);
    return true;
  }
  // no tree at all: one new node holding every page, in object order
  const leaves = objects.filter(([, o]) => o instanceof PDFPageLeaf || (o instanceof PDFDict && o.get(PDFName.of('Type')) === PDFName.of('Page')));
  if (!leaves.length) throw new Error('No pages found in this file');
  const tree = PDFPageTree.withContext(ctx);
  const treeRef = ctx.register(tree);
  for (const [ref, leaf] of leaves) {
    leaf.set(PDFName.of('Parent'), treeRef);
    tree.pushLeaf(ref);
  }
  doc.catalog.set(PDFName.of('Pages'), treeRef);
  return true;
}

// Page content streams and form XObjects — the streams pdf-lib decodes.
function contentStreamRefs(doc) {
  const { PDFName, PDFArray, PDFRef, PDFDict, PDFStream } = self.PDFLib;
  const ctx = doc.context;
  const refs = new Set();
  const add = v => { if (v instanceof PDFRef) refs.add(v); else if (v instanceof PDFArray) v.asArray().forEach(add); };
  for (const page of doc.getPages()) {
    add(page.node.get(PDFName.of('Contents')));
    const xobjects = ctx.lookup(ctx.lookup(page.node.get(PDFName.of('Resources')))?.get?.(PDFName.of('XObject')));
    if (xobjects instanceof PDFDict) {
      for (const [, ref] of xobjects.entries()) {
        const x = ctx.lookup(ref);
        if (ref instanceof PDFRef && x instanceof PDFStream && x.dict.get(PDFName.of('Subtype')) === PDFName.of('Form')) refs.add(ref);
      }
    }
  }
  return [...refs];
}

async function repairPdf(buffer) {
  const { PDFDocument, PDFName, PDFRawStream } = self.PDFLib;
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
  const ctx = doc.context;
  const fixes = { pageTree: fixPageTree(doc), pageCounts: Math.max(0, self.fixPageTreeCounts(doc)), streams: 0 };

  // DecompressionStream: Safari 16.4+. Older ones still get the page-tree
  // fix; a damaged stream is then left as it was rather than emptied.
  const canInflate = typeof DecompressionStream !== 'undefined';
  for (const ref of canInflate ? contentStreamRefs(doc) : []) {
    const stream = ctx.lookup(ref);
    if (!(stream instanceof PDFRawStream) || stream.dict.get(PDFName.of('Filter')) !== PDFName.of('FlateDecode')) continue;
    if (pdfLibDecodes(stream)) continue;
    const bytes = await inflatePartial(stream.contents);
    const dict = stream.dict.clone(ctx);
    dict.delete(PDFName.of('Filter'));
    dict.delete(PDFName.of('DecodeParms'));
    ctx.assign(ref, PDFRawStream.of(dict, bytes));
    fixes.streams++;
  }

  if (!fixes.pageTree && !fixes.pageCounts && !fixes.streams) return { result: null, fixes };
  const saved = await doc.save();
  return { result: saved.buffer, fixes };
}
