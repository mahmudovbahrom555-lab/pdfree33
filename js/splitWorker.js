// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  splitWorker.js — Dedicated Web Worker for Split (separate-files
//  mode) and Extract (single-file mode).
//
//  Deliberately NOT part of worker.js (off-limits per CLAUDE.md).
//  Same pattern as js/organizeWorker.js / js/resizeWorker.js: a
//  standalone classic worker, driven by js/processor.js's
//  _runSplit() on the main thread.
//
//  Forked out of worker.js's own handleSplit() (js/worker.js:613-735)
//  to fix an O(N pages) peak-memory bug: the old shared-worker path
//  built every per-page PDF into one `results[]` array before a single
//  final postMessage, holding N page-buffers in RAM at once — a real
//  user hit an out-of-memory crash this way (error ID SPLIT-7058).
//  This version streams each page back via its OWN postMessage the
//  moment it's ready, so processor.js can feed it straight into JSZip
//  and drop the reference — same "don't accumulate, stream+discard"
//  principle as pdf2jpg's export pipeline (processor.js's own
//  "Memory-efficient streaming pipeline" comment, ~line 1789), just
//  running in a worker instead of on the main thread.
//
//  Message contract:
//   in  → { file: ArrayBuffer, options: {
//             pages: number[], mode: 'single'|'separate',
//             removeWatermarks: boolean } }
//   out (mode:'single', byte-identical to the old shared-worker contract):
//        { type: 'progress', value, label }
//        { type: 'done', result: ArrayBuffer, mode: 'single', totalPages }
//        [ArrayBuffer transferred]
//   out (mode:'separate', NEW streaming contract):
//        { type: 'progress', value, label }
//        { type: 'page', name: string, buffer: ArrayBuffer,
//          index: number, total: number }   [buffer transferred, ONE per page]
//        { type: 'done', mode: 'separate', totalPages }   (no buffers — all
//          already delivered via individual 'page' messages)
//   error (either mode): { type: 'error', message }
//
//  _stripAnnotations/_stripOCGs/_removeWatermarks and
//  _filterOutlinesForSurvivors below are VERBATIM copies of worker.js's
//  own versions (js/worker.js:153-283, 535-612) — same "deliberately
//  duplicated, not imported" approach js/mangaSplitWorker.js and
//  js/resizeWorker.js already use for _flattenPageTreeResources
//  (worker.js is off-limits and this is a separate classic-worker
//  context with no module import). Sync manually if worker.js's
//  versions ever change. _flattenPageTreeResources itself is NOT
//  needed here — confirmed it's only used by handleMerge, never by
//  handleSplit.
//
//  THIS FILE IS THE ONLY LIVE SPLIT/EXTRACT IMPLEMENTATION. worker.js's
//  own handleSplit()/case 'split' (and its private
//  _filterOutlinesForSurvivors) are dead code — processor.js's _runSplit
//  always routes here via _ensureSplitWorker(), never to the shared
//  worker. worker.js is off-limits so that dead copy can't be removed;
//  don't mistake it for a second implementation or "fix" a bug there —
//  it will never run. (dead-code audit, 2026-09-23)
// ============================================================

importScripts('./vendor/pdf-lib.min.js');

self.onmessage = async (e) => {
  try {
    await handleSplit(e.data.file, e.data.options);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

// ── Watermark removal (verbatim copy of worker.js:153-283) ─────────────

function _stripAnnotations(pdf) {
  const { PDFName, PDFArray, PDFRef } = PDFLib;
  const ctx = pdf.context;

  for (const page of pdf.getPages()) {
    const annotsVal = page.node.get(PDFName.of('Annots'));
    if (!annotsVal) continue;

    // /Annots may be a direct array or an indirect reference — resolve both
    const annots = annotsVal instanceof PDFRef ? ctx.lookup(annotsVal) : annotsVal;
    if (!(annots instanceof PDFArray)) continue;

    const kept = [];
    for (let i = 0; i < annots.size(); i++) {
      const itemRef = annots.get(i);
      const item    = itemRef instanceof PDFRef ? ctx.lookup(itemRef) : itemRef;

      // If annotation is unreadable, keep it (safe default)
      const subtype = item?.get?.(PDFName.of('Subtype'))?.toString() ?? '';
      if (subtype !== '/Stamp' && subtype !== '/Watermark') {
        kept.push(itemRef);
      }
    }

    if (kept.length === annots.size()) continue;  // nothing matched, skip

    if (kept.length === 0) {
      page.node.delete(PDFName.of('Annots'));
    } else {
      const newAnnots = PDFArray.withContext(ctx);
      kept.forEach(ref => newAnnots.push(ref));
      page.node.set(PDFName.of('Annots'), newAnnots);
    }
  }
}

// Phase 2: disable OCGs (Optional Content Groups / layers) whose /Name
// matches common watermark patterns. Modifies /OCProperties/D/OFF in the
// catalog — never touches page content streams. Returns count disabled.
function _stripOCGs(pdf) {
  const { PDFName, PDFArray, PDFRef, PDFDict, PDFString, PDFHexString } = PDFLib;
  const ctx = pdf.context;

  const WM_NAMES = /watermark|wm\b|stamp|draft|confidential|background|bg\b|overlay|sample|do.not.copy/i;

  const ocpVal = pdf.catalog.get(PDFName.of('OCProperties'));
  if (!ocpVal) return 0;
  const ocp = ocpVal instanceof PDFRef ? ctx.lookup(ocpVal) : ocpVal;
  if (!(ocp instanceof PDFDict)) return 0;

  const ocgsVal = ocp.get(PDFName.of('OCGs'));
  if (!ocgsVal) return 0;
  const ocgs = ocgsVal instanceof PDFRef ? ctx.lookup(ocgsVal) : ocgsVal;
  if (!(ocgs instanceof PDFArray)) return 0;

  // Collect refs of OCGs whose name matches watermark patterns
  const toOff = [];
  for (let i = 0; i < ocgs.size(); i++) {
    const ref = ocgs.get(i);
    const ocg = ref instanceof PDFRef ? ctx.lookup(ref) : ref;
    if (!(ocg instanceof PDFDict)) continue;

    const nameObj = ocg.get(PDFName.of('Name'));
    let name = '';
    if (nameObj instanceof PDFString || nameObj instanceof PDFHexString) {
      name = nameObj.decodeText();
    }
    if (WM_NAMES.test(name)) toOff.push(ref);
  }
  if (toOff.length === 0) return 0;

  // Get default view dictionary /D
  const dVal = ocp.get(PDFName.of('D'));
  if (!dVal) return 0;
  const d = dVal instanceof PDFRef ? ctx.lookup(dVal) : dVal;
  if (!(d instanceof PDFDict)) return 0;

  const toOffNums = new Set(toOff.map(r => r instanceof PDFRef ? r.objectNumber : -1));
  const baseState = d.get(PDFName.of('BaseState'))?.toString() ?? '/ON';

  // Helper: rebuild /ON array excluding toOff targets
  const _filterOn = () => {
    const onVal = d.get(PDFName.of('ON'));
    if (!onVal) return;
    const on = onVal instanceof PDFRef ? ctx.lookup(onVal) : onVal;
    if (!(on instanceof PDFArray)) return;
    const kept = PDFArray.withContext(ctx);
    for (let i = 0; i < on.size(); i++) {
      const r = on.get(i);
      if (!toOffNums.has(r instanceof PDFRef ? r.objectNumber : -1)) kept.push(r);
    }
    d.set(PDFName.of('ON'), kept);
  };

  if (baseState === '/OFF') {
    // Default is OFF — just remove targets from /ON so they stay hidden
    _filterOn();
  } else {
    // Default is ON — push targets into /OFF and remove from /ON
    let offArray;
    const offVal = d.get(PDFName.of('OFF'));
    if (offVal) {
      const existing = offVal instanceof PDFRef ? ctx.lookup(offVal) : offVal;
      offArray = existing instanceof PDFArray ? existing : PDFArray.withContext(ctx);
    } else {
      offArray = PDFArray.withContext(ctx);
      d.set(PDFName.of('OFF'), offArray);
    }

    const alreadyOff = new Set();
    for (let i = 0; i < offArray.size(); i++) {
      const r = offArray.get(i);
      if (r instanceof PDFRef) alreadyOff.add(r.objectNumber);
    }
    for (const ref of toOff) {
      if (ref instanceof PDFRef && !alreadyOff.has(ref.objectNumber)) {
        offArray.push(ref);
        alreadyOff.add(ref.objectNumber);
      }
    }
    _filterOn();
  }

  return toOff.length;
}

// Combined entry point called by all handlers
function _removeWatermarks(pdf) {
  _stripAnnotations(pdf);
  _stripOCGs(pdf);
}

// ── Bookmark-preserving Outlines filter (verbatim copy of worker.js:502-612) ──
// Used by handleSplit below instead of unconditionally deleting /Outlines
// whenever pages are removed (see that fix's own history: dangling bookmarks
// pointing at excluded pages leaked their full content, since removePage()
// only unlinks a page from /Pages — the page object itself, and anything
// still referencing it from elsewhere in the catalog like /Outlines, is
// untouched and still resolves).
//
// This keeps whichever bookmarks still point at a SURVIVING page, dropping
// only the ones that pointed at excluded pages — matches Smallpdf's observed
// behavior (competitor comparison, 2026-09), a real UX improvement over
// blanket-deleting every bookmark just because SOME page was removed.
//
// No page-index renumbering is needed: a PDF /Dest array's first element is
// a direct object reference to the target page dictionary, not an ordinal
// index — removePage() never reassigns a surviving page's object identity,
// only its position in the /Pages tree, so a kept page's bookmark reference
// is still exactly correct regardless of where that page ends up.
//
// Deliberately scoped, fail-closed: only handles the two destination shapes
// pdf-lib itself and virtually every real-world PDF generator use — a direct
// /Dest array, or a /GoTo action's /D array. Named destinations (resolved via
// the catalog's /Names/Dests tree) and any other action type (/GoToR, /URI,
// …) are NOT resolved here — if a bookmark's target page can't be proven to
// survive, it's dropped rather than kept, matching the original fix's own
// priority: losing a benign bookmark is an acceptable cost, leaking excluded
// content through an unhandled destination shape is not.
//
// Also doesn't promote orphaned grandchildren: if a bookmark's OWN target
// page was removed, its entire subtree is dropped too, even if some
// descendant bookmark pointed at a surviving page — a real but rare shape
// (a removed section's own heading bookmark with a kept sub-bookmark inside
// it), not handled to keep this correct and reviewable rather than exhaustive.
function _filterOutlinesForSurvivors(doc, survivingRefTags) {
  const { PDFName, PDFDict, PDFArray, PDFRef, PDFNumber } = PDFLib;
  const outlinesObj = doc.catalog.get(PDFName.of('Outlines'));
  if (!outlinesObj) return; // no bookmarks at all — nothing to do

  const outlinesDict = doc.context.lookup(outlinesObj, PDFDict);
  if (!outlinesDict) return;

  function destPageRef(itemDict) {
    let destArr = itemDict.lookupMaybe(PDFName.of('Dest'), PDFArray);
    if (!destArr) {
      const action = itemDict.lookupMaybe(PDFName.of('A'), PDFDict);
      destArr = action?.lookupMaybe(PDFName.of('D'), PDFArray);
    }
    if (!destArr || destArr.size() === 0) return null;
    const first = destArr.get(0);
    return first instanceof PDFRef ? first : null;
  }

  // Prunes the sibling chain starting at `firstRef` (mutating items in place
  // to relink around dropped siblings/children). Returns the new
  // { first, last, count } for this level, or null if nothing survived.
  function prune(firstRef) {
    let curRef = firstRef;
    let newFirst = null, newLast = null, count = 0;
    while (curRef) {
      const item    = doc.context.lookup(curRef, PDFDict);
      const nextRef = item.get(PDFName.of('Next'));

      const childFirstRef = item.get(PDFName.of('First'));
      let childResult = null;
      if (childFirstRef) {
        childResult = prune(childFirstRef);
        if (childResult) {
          item.set(PDFName.of('First'), childResult.first);
          item.set(PDFName.of('Last'), childResult.last);
          item.set(PDFName.of('Count'), PDFNumber.of(childResult.count));
        } else {
          item.delete(PDFName.of('First'));
          item.delete(PDFName.of('Last'));
          item.delete(PDFName.of('Count'));
        }
      }

      const pageRef = destPageRef(item);
      if (pageRef && survivingRefTags.has(pageRef.tag)) {
        if (newFirst === null) {
          item.delete(PDFName.of('Prev'));
        } else {
          item.set(PDFName.of('Prev'), newLast);
          doc.context.lookup(newLast, PDFDict).set(PDFName.of('Next'), curRef);
        }
        newFirst = newFirst ?? curRef;
        newLast  = curRef;
        count   += 1 + (childResult ? childResult.count : 0);
      }
      // else: drop this item — its Next is simply never followed into the
      // new chain, and (since it's now unreachable from the catalog) neither
      // is whatever remained of its own already-pruned subtree.

      curRef = nextRef;
    }
    if (newLast !== null) doc.context.lookup(newLast, PDFDict).delete(PDFName.of('Next'));
    return newFirst ? { first: newFirst, last: newLast, count } : null;
  }

  const firstRef = outlinesDict.get(PDFName.of('First'));
  const result    = firstRef ? prune(firstRef) : null;

  if (result) {
    outlinesDict.set(PDFName.of('First'), result.first);
    outlinesDict.set(PDFName.of('Last'), result.last);
    outlinesDict.set(PDFName.of('Count'), PDFNumber.of(result.count));
  } else {
    doc.catalog.delete(PDFName.of('Outlines'));
  }
}

// ── Split handler ────────────────────────────────────────────────────
// 'single' branch is a verbatim copy of worker.js:630-685 (unchanged wire
// shape). 'separate' branch is worker.js:693-716's same per-page algorithm,
// but streams each page back via its own postMessage instead of
// accumulating into one results[] array — see this file's header comment
// for the memory-fix rationale.

async function handleSplit(fileBuffer, options) {
  const { PDFDocument } = PDFLib;

  // Measure page count before consuming fileBuffer in any load call.
  // We peek via a temporary load; fileBuffer itself is not detached by pdf-lib.
  const peekDoc   = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  // AES-encrypted PDFs load without throwing (ignoreEncryption bypasses the header check)
  // but their content streams remain encrypted → saved output has white/blank pages.
  if (peekDoc.context.trailerInfo?.Encrypt) throw new Error('pdf-aes-encrypted');
  const pageCount = peekDoc.getPageCount();

  // Filter to pages that actually exist in the document
  const pages = (options.pages || []).filter(p => p >= 1 && p <= pageCount);
  if (pages.length === 0) throw new Error('No valid pages selected');

  self.postMessage({ type: 'progress', value: 5, label: 'Loading PDF...' });

  if (options.mode === 'single') {
    // ── Extract: keep only selected pages, preserve all shared resources ──
    // pdf-lib copyPages() misses inherited page-tree resources (fonts, XObjects
    // referenced at the /Pages node level), producing blank pages for many PDFs.
    // removePage() operates within the same document context so all inherited
    // resources remain reachable by the kept pages.
    const srcDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
    if (options.removeWatermarks) _removeWatermarks(srcDoc);
    const keepSet = new Set(pages.map(p => p - 1)); // convert to 0-indexed
    // Captured BEFORE removePage() — page object identity (and therefore a
    // bookmark's /Dest reference to it) is unaffected by removal, only the
    // /Pages tree linkage changes, so these refs stay valid for the filter
    // below regardless of the pages' new ordinal positions.
    const survivingRefTags = new Set();
    const pagesBeforeRemoval = srcDoc.getPages();
    for (const idx of keepSet) survivingRefTags.add(pagesBeforeRemoval[idx].ref.tag);
    // Captured BEFORE removal for the same reason as survivingRefTags above —
    // these PDFPage objects stay valid (same doc, same underlying refs) no
    // matter what removePage() does below, and this is the sequence Extract's
    // "reverse page order" option (and any future out-of-order selection)
    // actually needs in the output.
    const orderedPageObjs = pages.map(p => pagesBeforeRemoval[p - 1]);
    for (let i = pageCount - 1; i >= 0; i--) {
      if (!keepSet.has(i)) srcDoc.removePage(i);
    }
    // removePage() only removes pages, it never reorders the survivors — they
    // stay in their original relative order regardless of what sequence
    // `pages` was given in. That's correct for a plain subset extraction, but
    // silently ignores the "reverse" option and any other non-ascending
    // selection. Only pay for a reorder pass when the requested order and the
    // now-ascending survivor order actually differ (the common case — no
    // reverse, ascending pick — needs none).
    const needsReorder = pages.some((p, i) => i > 0 && p <= pages[i - 1]);
    if (needsReorder) {
      for (let i = srcDoc.getPageCount() - 1; i >= 0; i--) srcDoc.removePage(i);
      for (const pageObj of orderedPageObjs) srcDoc.addPage(pageObj);
    }
    // removePage() only unlinks a page from the /Pages tree — the source
    // document's /Outlines (bookmarks) still reference the removed pages by
    // object ref, and those refs still resolve (pdf-lib's save() doesn't
    // garbage-collect objects reachable from ANY part of the catalog, not
    // just /Pages). Left alone, the exported file both shows dangling
    // bookmarks pointing outside the visible page range AND keeps the
    // "removed" pages' full content recoverable through them — a real
    // content-retention bug for the common case of extracting a subset to
    // deliberately exclude other pages before sharing. Filtering /Outlines
    // down to only the bookmarks whose target page survived (see
    // _filterOutlinesForSurvivors's own header comment) closes the same leak
    // while preserving navigation for the pages that are actually still here.
    if (pages.length < pageCount) _filterOutlinesForSurvivors(srcDoc, survivingRefTags);
    self.postMessage({ type: 'progress', value: 90, label: 'Saving...' });
    const bytes = await srcDoc.save();
    self.postMessage(
      { type: 'done', result: bytes.buffer, mode: 'single', totalPages: pages.length },
      [bytes.buffer]
    );

  } else {
    // ── Split: each selected page → individual PDF, streamed back one at a
    // time (the fix — see this file's header comment). Same resource-
    // preservation approach as 'single': load a fresh doc per page and
    // remove all others. fileBuffer is not detached by pdf-lib loads, so
    // multiple loads from the same ArrayBuffer are safe.
    for (let i = 0; i < pages.length; i++) {
      const pageNum = pages[i];
      const pageDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
      if (options.removeWatermarks) _removeWatermarks(pageDoc);
      // Captured BEFORE removePage() — pdf-lib's getPages() is backed by a
      // cache that removePage() never invalidates (only insert/add paths do,
      // confirmed by reading pdf-lib's own source), so reading it AFTER the
      // removal loop below would silently return the stale pre-removal
      // array every time, always resolving to the wrong (original index 0)
      // page. Matches the same "capture refs before mutating" approach the
      // 'single' branch above already uses for this exact reason.
      const survivingRefTag = pageDoc.getPages()[pageNum - 1].ref.tag;
      for (let j = pageCount - 1; j >= 0; j--) {
        if (j !== pageNum - 1) pageDoc.removePage(j);
      }
      // Same dangling-bookmark/content-retention fix as the 'single' branch
      // above — every per-page split here removes all but 1 page, so this is
      // unconditional whenever the source had more than 1 page. Only one page
      // object survives per output, so the surviving set is just that page's
      // own ref — any bookmark that was pointing at THIS specific page (there
      // may be more than one) is kept, everything else dropped.
      if (pageCount > 1) _filterOutlinesForSurvivors(pageDoc, new Set([survivingRefTag]));
      const bytes = await pageDoc.save();
      // THE FIX: send this page immediately and let its buffer be transferred
      // (detached, freed) rather than accumulating into an array that would
      // hold all N pages' bytes in memory simultaneously until the loop ends.
      self.postMessage(
        { type: 'page', name: `page_${pageNum}.pdf`, buffer: bytes.buffer, index: i, total: pages.length },
        [bytes.buffer]
      );
      self.postMessage({
        type:  'progress',
        value: 10 + Math.round(((i + 1) / pages.length) * 80),
        label: `Page ${i + 1} of ${pages.length}...`,
      });
    }
    self.postMessage({ type: 'done', mode: 'separate', totalPages: pages.length });
  }
}
