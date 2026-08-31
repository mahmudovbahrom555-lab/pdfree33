// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  mergeWorker.js — Dedicated Web Worker for Merge PDF
//
//  Deliberately NOT part of worker.js (off-limits per CLAUDE.md).
//  Forked from worker.js's own handleMerge — same pattern as
//  js/organizeWorker.js/js/resizeWorker.js/js/glossaryWorker.js.
//  _classifyError/_flattenPageTreeResources/_stripAnnotations/
//  _stripOCGs/_removeWatermarks below are duplicated from
//  worker.js, not imported — worker.js is a separate, off-limits
//  classic-worker context, same rationale organizeWorker.js's own
//  copy of _flattenPageTreeResources already documents.
//
//  Message contract (mirrors js/worker.js's merge handler, so
//  processor.js's onmessage plumbing needs no shape changes):
//    in  → { files: ArrayBuffer[], names: string[], removeWatermarks,
//            createBookmarks, insertBlankPages }
//    out → { type: 'progress', value, label }
//        | { type: 'done', result, totalPages, fileErrors, mergedCount, pageCounts }
//        | { type: 'error', message }
// ============================================================

importScripts('./vendor/pdf-lib.min.js');

self.onmessage = async (e) => {
  try {
    const { files, names, removeWatermarks, createBookmarks, insertBlankPages } = e.data;
    await handleMerge(files, names, removeWatermarks, createBookmarks, insertBlankPages);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

// ── Watermark removal (duplicated from worker.js — see file header) ──

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

function _removeWatermarks(pdf) {
  _stripAnnotations(pdf);
  _stripOCGs(pdf);
}

function _classifyError(err) {
  const msg = (err?.message || String(err)).toLowerCase();
  if (msg.includes('encrypt') || msg.includes('password')) return 'ENCRYPTED';
  // pdf-lib throws this when AES-encrypted objects can't be parsed without the owner password.
  // ignoreEncryption:true bypasses the header check but not actual AES decryption —
  // so encrypted content streams parse as garbage → "PDFDict, but got undefined".
  if (msg.includes('pdfdict') || msg.includes('expected instance')) return 'ENCRYPTED';
  if (msg.includes('corrupt') || msg.includes('invalid')  ||
      msg.includes('bad')     || msg.includes('malformed') ||
      msg.includes('header')  || msg.includes('parse'))     return 'CORRUPT';
  return 'UNKNOWN';
}

function _flattenPageTreeResources(pdf) {
  const { PDFName, PDFRef } = PDFLib;
  const ctx = pdf.context;
  const INHERITABLE = ['Font', 'XObject', 'ExtGState', 'ColorSpace', 'Pattern', 'Shading'];

  function res(val) {
    if (val == null) return null;
    try { return val instanceof PDFRef ? ctx.lookup(val) : val; } catch { return null; }
  }

  for (let i = 0; i < pdf.getPageCount(); i++) {
    const node = pdf.getPage(i).node;

    // Walk up to root collecting resource dicts; page's own is index 0 (highest priority)
    const dicts = [];
    const own = res(node.get(PDFName.of('Resources')));
    if (own) dicts.push(own);

    const seen = new Set();
    let parentVal = node.get(PDFName.of('Parent'));
    while (parentVal) {
      const key = String(parentVal);
      if (seen.has(key)) break;  // cycle guard
      seen.add(key);
      const parent = res(parentVal);
      if (!parent) break;
      const parentRes = res(parent.get(PDFName.of('Resources')));
      if (parentRes) dicts.push(parentRes);
      parentVal = parent.get(PDFName.of('Parent'));
    }

    if (dicts.length <= 1) continue;  // no inherited resources — nothing to do

    // Ensure page has its own /Resources dict
    let pageRes = res(node.get(PDFName.of('Resources')));
    if (!pageRes) {
      pageRes = ctx.obj({});
      node.set(PDFName.of('Resources'), pageRes);
    }

    // Merge parent resources into page (page entries take priority, j=0 is page)
    for (const typeName of INHERITABLE) {
      const key = PDFName.of(typeName);
      let pageSection = res(pageRes.get(key));

      for (let j = 1; j < dicts.length; j++) {
        const inherited = res(dicts[j].get(key));
        if (!inherited) continue;

        if (!pageSection) {
          // Page has no entry for this type — borrow the parent's value directly
          pageRes.set(key, dicts[j].get(key));
          pageSection = inherited;
        } else {
          // Merge: add entries from inherited that the page doesn't already have
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

// ── Bookmarks (new — no prior art in this codebase for /Outlines) ────
//
// pdf-lib 1.17.1 has no high-level outline API — build the tree by hand.
// One flat, single-level entry per source file (no nesting): a root
// /Outlines dict, one Outline Item dict per file wired via /First,/Last
// on the root and /Next,/Prev,/Parent on each item, each item's /Dest
// pointing at that file's first merged page with an explicit-destination
// array [pageRef, /Fit]. Titles go through PDFHexString (UTF-16BE) since
// filenames can contain any locale's characters, not just Latin-1 —
// matches the same PDFHexString.fromText() convention js/glossaryWorker.js
// already uses for its own annotation /Contents and /T strings.
function _addBookmarks(pdfDoc, entries) {
  if (entries.length === 0) return;
  const { PDFName, PDFHexString } = PDFLib;
  const ctx = pdfDoc.context;

  const itemRefs = entries.map(entry => {
    const page = pdfDoc.getPage(entry.pageIndex);
    const dict = ctx.obj({
      Title: PDFHexString.fromText(entry.title),
      Dest:  ctx.obj([page.ref, PDFName.of('Fit')]),
    });
    return ctx.register(dict);
  });

  itemRefs.forEach((ref, i) => {
    const dict = ctx.lookup(ref);
    if (i > 0)                        dict.set(PDFName.of('Prev'), itemRefs[i - 1]);
    if (i < itemRefs.length - 1)      dict.set(PDFName.of('Next'), itemRefs[i + 1]);
  });

  const rootRef = ctx.register(ctx.obj({
    Type:  PDFName.of('Outlines'),
    First: itemRefs[0],
    Last:  itemRefs[itemRefs.length - 1],
    Count: itemRefs.length,
  }));
  itemRefs.forEach(ref => ctx.lookup(ref).set(PDFName.of('Parent'), rootRef));

  pdfDoc.catalog.set(PDFName.of('Outlines'), rootRef);
}

// ── Merge handler ──────────────────────────────────────────────

async function handleMerge(files, names, removeWatermarks = false, createBookmarks = false, insertBlankPages = 'none') {
  const { PDFDocument } = PDFLib;
  const merged = await PDFDocument.create();
  let totalPages = 0;
  const pageCounts = [];
  const bookmarkEntries = []; // { title, pageIndex } — pageIndex is in the MERGED doc

  // ── Best Effort loading ───────────────────────────────────────
  // Policy: skip damaged files, merge the rest (same as worker.js's
  // handleMerge — losing 9 good files because of 1 bad one is worse
  // UX than a warning; abort only if ALL files fail).
  const fileErrors = [];

  // Page count of the last SUCCESSFULLY merged file — used to decide
  // whether to insert a blank page before the NEXT successful file.
  // Tracking this instead of "is this the last item in the loop" avoids
  // leaving a dangling trailing blank page when a later file fails to load.
  let prevPageCount = null;

  for (let i = 0; i < files.length; i++) {
    self.postMessage({
      type:  'progress',
      value: Math.round(10 + (i / files.length) * 80),
      label: `Loading file ${i + 1} of ${files.length}…`,
    });

    let pdf;
    try {
      pdf = await PDFDocument.load(files[i], { ignoreEncryption: true });
      if (pdf.context.trailerInfo?.Encrypt) throw new Error('pdf-aes-encrypted');
      if (removeWatermarks) _removeWatermarks(pdf);
      _flattenPageTreeResources(pdf);
    } catch (err) {
      fileErrors.push({
        index:   i + 1,
        name:    names?.[i] ?? `file${i + 1}.pdf`,
        code:    _classifyError(err),
        message: err?.message || String(err),
      });
      continue;
    }

    try {
      const sourcePageCount = pdf.getPageCount();

      if (insertBlankPages !== 'none' && prevPageCount !== null) {
        const shouldInsert = insertBlankPages === 'always' ||
          (insertBlankPages === 'odd' && prevPageCount % 2 === 1);
        if (shouldInsert) {
          const lastPage = merged.getPage(merged.getPageCount() - 1);
          const { width, height } = lastPage.getSize();
          merged.addPage([width, height]); // deliberately no drawing — a true blank page
          totalPages += 1;
        }
      }

      const firstMergedIndex = merged.getPageCount();
      const pages = await merged.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(p => merged.addPage(p));
      totalPages += pages.length;
      pageCounts.push({ name: names?.[i] ?? `file${i+1}.pdf`, pages: pages.length });

      if (createBookmarks) {
        bookmarkEntries.push({
          title:     (names?.[i] ?? `file${i + 1}`).replace(/\.pdf$/i, ''),
          pageIndex: firstMergedIndex,
        });
      }
      prevPageCount = sourcePageCount;
    } catch (err) {
      // copyPages can fail on PDFs with unsupported features (Type3 fonts, etc.)
      fileErrors.push({
        index:   i + 1,
        name:    names?.[i] ?? `file${i + 1}.pdf`,
        code:    'CORRUPT',
        message: err?.message || String(err),
      });
    }
  }

  if (totalPages === 0) {
    const summary = fileErrors.map(e => `${e.name} (${e.code})`).join(', ');
    throw new Error(`All files failed to load: ${summary}`);
  }

  if (createBookmarks && bookmarkEntries.length > 0) {
    _addBookmarks(merged, bookmarkEntries);
  }

  self.postMessage({ type: 'progress', value: 95, label: 'Saving…' });
  const bytes = await merged.save();

  // ⚠️  TRANSFERABLE: bytes.buffer transferred to main thread — DETACHED after this line.
  self.postMessage(
    {
      type:        'done',
      result:      bytes.buffer,
      totalPages,
      fileErrors:  fileErrors.length > 0 ? fileErrors : null,
      mergedCount: files.length - fileErrors.length,
      pageCounts,
    },
    [bytes.buffer]
  );
}
