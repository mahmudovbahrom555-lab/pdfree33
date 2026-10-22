// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  pageTreeCounts.js — each /Pages node's /Count recomputed from the
//  pages its own /Kids hold (SPLIT-37EA, 2026-10-22).
//
//  pdf-lib finds pages by walking /Kids, but removePage() finds the one to
//  remove by the nodes' /Count: a file whose intermediate node says /Count 5
//  for 3 pages opens with every page and then fails at the first removal
//  past it ("Failed to removeLeafNode … one or more 'Count' entries are
//  invalid"). Viewers never read /Count, so the file looks fine to its owner.
//  Recounted bottom-up from the real /Kids, the tree keeps its shape, its
//  page order and what pages inherit from their nodes (MediaBox, Resources,
//  Rotate) — only the counts change. A structure that isn't a tree (a node
//  or page reached twice, a kid that is neither, a reference that doesn't
//  resolve) is left exactly as it was: no count would make it right.
//
//  Classic-worker script (importScripts after pdf-lib): defines
//  self.fixPageTreeCounts(doc) → how many nodes were recounted, 0 when all
//  were right, -1 when the tree isn't one.
// ============================================================

self.fixPageTreeCounts = function fixPageTreeCounts(doc) {
  const { PDFName, PDFNumber, PDFRef, PDFPageTree, PDFPageLeaf } = self.PDFLib;
  const ctx = doc.context;
  const COUNT = PDFName.of('Count');
  const seen = new Set();
  const counts = [];                       // [node, its real page count]
  const walk = (ref, depth) => {
    if (!(ref instanceof PDFRef) || seen.has(ref.tag) || depth > 64) throw new Error('not a tree');
    seen.add(ref.tag);
    const node = ctx.lookup(ref);
    if (node instanceof PDFPageLeaf) return 1;
    if (!(node instanceof PDFPageTree)) throw new Error('not a tree');
    let n = 0;
    for (const kid of node.Kids().asArray()) n += walk(kid, depth + 1);
    counts.push([node, n]);
    return n;
  };
  try {
    walk(doc.catalog.get(PDFName.of('Pages')), 0);
  } catch {
    return -1;
  }
  let fixed = 0;
  for (const [node, n] of counts) {
    const said = node.lookup(COUNT);
    if (said instanceof PDFNumber && said.asNumber() === n) continue;
    node.set(COUNT, PDFNumber.of(n));
    fixed++;
  }
  return fixed;
};
