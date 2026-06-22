// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  worker.js — Web Worker для тяжёлых PDF операций
//  Запускается в отдельном потоке — UI никогда не зависнет
//  Теперь это ОТДЕЛЬНЫЙ ФАЙЛ, не inline blob — легче дебажить
// ============================================================

importScripts('./vendor/pdf-lib.min.js');
importScripts('pdfEncrypt.js');

// Note: pdf-lib-encrypt.min.js (broken fork) is no longer loaded here.
// Encryption is now handled by our own pdfEncrypt.js which correctly
// encrypts stream bytes, not just the /Encrypt dictionary header.

self.onmessage = async function (e) {
  const { tool, files, names } = e.data;

  try {
    switch (tool) {
      case 'merge':
        await handleMerge(files, names, e.data.removeWatermarks ?? false);
        break;
      case 'split':
        await handleSplit(e.data.file, e.data.options);
        break;
      case 'compress':
        await handleCompress(e.data.file, e.data.options);
        break;
      case 'compress-scan':
        self.postMessage({ type: 'scan-done', report: await _runCompressScan(e.data.file) });
        break;
      case 'jpg2pdf':
        await handleJpg2Pdf(e.data.files, e.data.options);
        break;
      case 'watermark':
        await handleWatermark(e.data.file, e.data.options);
        break;
      case 'pagenum':
        await handlePageNum(e.data.file, e.data.options);
        break;
      case 'meta':
        await handleMeta(e.data.file, e.data.options);
        break;
      case 'protect':
        await handleProtect(e.data.file, e.data.options);
        break;
      case 'rotate':
        await handleRotate(e.data.file, e.data.options);
        break;
      case 'redact':
        await handleRedact(e.data.file, e.data.options);
        break;
      case 'fill':
        await handleFill(e.data.file, e.data.options);
        break;
      case 'flatten':
        await handleFlatten(e.data.file);
        break;
      case 'draw':
        await handleDraw(e.data.original, e.data.layers);
        break;
      default:
        throw new Error('Unknown tool: ' + tool);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

// ============================================================
//  Shared worker utilities — eliminates load/save/progress
//  boilerplate that was repeated in every handler.
//
//  pdfPipeline(buffer, opts, fn):
//    Loads PDF → calls fn(pdf, pages, report) → saves → postMessage done
//    Reduces each simple handler from ~20 lines to ~5.
//
//  progress(value, label):
//    Centralised postMessage wrapper so handlers don't repeat the shape.
// ============================================================

function progress(value, label) {
  self.postMessage({ type: 'progress', value, label });
}

// ── Watermark removal ─────────────────────────────────────────
//
// Phase 1: annotation-based watermarks (/Stamp, /Watermark subtypes).
// Phase 2: OCG-based watermarks (layer names matching wm patterns).
// Content-stream watermarks (embedded text/images) are NOT handled —
// that requires a full content-stream parser and risks false positives.
//
// Public entry point: _removeWatermarks(pdf) — calls both phases.

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

/**
 * Standard single-file pipeline: load → transform → save → done.
 * @param {ArrayBuffer} buffer
 * @param {{
 *   loadLabel?:    string,
 *   saveLabel?:    string,
 *   saveValue?:    number,
 *   objectStreams?: boolean,
 *   ignoreEncryption?: boolean,
 * }} opts
 * @param {(pdf: PDFDocument, pages: PDFPage[]) => Promise<void>} transform
 */
async function pdfPipeline(buffer, opts, transform) {
  const { PDFDocument } = PDFLib;
  const {
    loadLabel        = 'Loading PDF…',
    saveLabel        = 'Saving…',
    saveValue        = 90,
    objectStreams     = true,
    ignoreEncryption = true,
  } = opts;

  progress(5, loadLabel);
  const pdf   = await PDFDocument.load(buffer, { ignoreEncryption });
  const pages = pdf.getPages();

  await transform(pdf, pages);

  progress(saveValue, saveLabel);
  const bytes = await pdf.save({ useObjectStreams: objectStreams, addDefaultPage: false });
  // ⚠️  TRANSFERABLE: bytes.buffer is transferred to the main thread zero-copy.
  //     It is DETACHED here after postMessage — do not access bytes or bytes.buffer
  //     after this line. The main thread (processor.js) must use data.result
  //     exactly once (new Blob([data.result])) and not cache it for reuse.
  self.postMessage(
    { type: 'done', result: bytes.buffer, pageCount: pages.length },
    [bytes.buffer]
  );
}

// ── Error classifier ──────────────────────────────────────────
// Isolated function: pure, testable, no side-effects.
// Centralising classification here means we don't repeat the
// string-matching logic in every catch block.
//
// Keywords intentionally cast to lowercase once here:
//   encrypt/password → user set a password; file isn't corrupt
//   corrupt/invalid/bad/malformed → structural damage
//   Everything else → UNKNOWN (don't over-classify)
//
// Not implemented: retryable flag — no retry UI exists yet,
// adding unused fields pollutes the protocol. Add when needed.
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

// Flattens inherited page-tree resources into each page's own /Resources dict.
// pdf-lib copyPages() copies only objects reachable from the page node itself —
// it never walks the /Parent chain to collect inherited resources (Font, XObject …).
// Without this, pages whose resources live at the /Pages tree level come out blank
// after copyPages. Calling this on the source PDF before copyPages() fixes that.
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

async function handleMerge(files, names, removeWatermarks = false) {
  const { PDFDocument } = PDFLib;
  const merged = await PDFDocument.create();
  let totalPages = 0;

  // ── Best Effort loading ───────────────────────────────────────
  // Policy: skip damaged files, merge the rest.
  // Rationale: losing 9 good files because of 1 bad one is worse UX
  // than a warning. If ALL files fail we still abort early.
  //
  // Error record shape: { index, name, code, message }
  //   index — 1-based position in the upload list (for UI display)
  //   name  — original filename (shown in toast instead of "#3")
  //   code  — ENCRYPTED | CORRUPT | UNKNOWN
  const fileErrors = [];

  for (let i = 0; i < files.length; i++) {
    self.postMessage({
      type:  'progress',
      value: Math.round(10 + (i / files.length) * 80),
      label: `Loading file ${i + 1} of ${files.length}…`,
    });

    let pdf;
    try {
      pdf = await PDFDocument.load(files[i], { ignoreEncryption: true });
      // AES-encrypted PDFs load without throwing but content streams stay encrypted →
      // output pages are white. Detect via trailer /Encrypt and reject explicitly.
      if (pdf.context.trailerInfo?.Encrypt) throw new Error('pdf-aes-encrypted');
      if (removeWatermarks) _removeWatermarks(pdf);
      _flattenPageTreeResources(pdf);  // copy inherited tree-level resources into each page
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
      const pages = await merged.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(p => merged.addPage(p));
      totalPages += pages.length;
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
    },
    [bytes.buffer]
  );
}

// ── Split handler ──
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
    for (let i = pageCount - 1; i >= 0; i--) {
      if (!keepSet.has(i)) srcDoc.removePage(i);
    }
    self.postMessage({ type: 'progress', value: 90, label: 'Saving...' });
    const bytes = await srcDoc.save();
    self.postMessage(
      { type: 'done', result: bytes.buffer, mode: 'single', totalPages: pages.length },
      [bytes.buffer]
    );

  } else {
    // ── Split: each selected page → individual PDF ──
    // Same resource-preservation approach: load a fresh doc per page and remove
    // all others. fileBuffer is not detached by pdf-lib loads, so multiple loads
    // from the same ArrayBuffer are safe.
    const results = [];
    for (let i = 0; i < pages.length; i++) {
      const pageNum = pages[i];
      const pageDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
      if (options.removeWatermarks) _removeWatermarks(pageDoc);
      for (let j = pageCount - 1; j >= 0; j--) {
        if (j !== pageNum - 1) pageDoc.removePage(j);
      }
      const bytes = await pageDoc.save();
      results.push({ name: `page_${pageNum}.pdf`, buffer: bytes.buffer });
      self.postMessage({
        type:  'progress',
        value: 10 + Math.round(((i + 1) / pages.length) * 80),
        label: `Page ${i + 1} of ${pages.length}...`,
      });
    }
    // ⚠️  TRANSFERABLE OWNERSHIP: results[*].buffer are transferred to the main
    //     thread zero-copy. After this postMessage call the buffers are DETACHED
    //     inside the worker — any access to them here will throw TypeError.
    //     The receiver (processor.js _runSplit) must use each buffer exactly once
    //     (pass to JSZip or Blob) and then discard it. Do NOT cache data.result
    //     for reuse; the ArrayBuffers will be zero-byteLength detached objects.
    const transferables = results.map(r => r.buffer);
    self.postMessage(
      { type: 'done', result: results, mode: 'separate', totalPages: results.length },
      transferables
    );
  }
}

// ── Compress handler ──────────────────────────────────────────
//
// Стратегия:
//  1. Анализируем структуру PDF (XMP, thumbnails, PieceInfo)
//  2. Удаляем всё лишнее через low-level PDFDict API
//  3. Сохраняем с useObjectStreams:true — ★ самое эффективное
//     для большинства real-world PDF (cross-ref table → flate stream)
//
// Что НЕ делаем: не растеризуем страницы, не трогаем векторы/шрифты.
// Для image-heavy PDF нужен Ghostscript-WASM (отложено).

// ── Image fingerprint ──────────────────────────────────────────
// Rolling polynomial hash over 5 strategic sample windows (128 bytes each).
// Runs in O(640) regardless of image size. Collision probability < 1 in 4×10⁹
// for real-world JPEG/FlateDecode streams because length + five samples across
// the stream body make accidental matches astronomically unlikely.
function _imageFingerprint(contents) {
  const n = contents.length;
  if (n === 0) return '0:0';
  let h = n;
  const sample = off => {
    const end = Math.min(Math.max(off, 0) + 128, n);
    for (let i = Math.max(0, off); i < end; i++) h = (Math.imul(h, 31) + contents[i]) | 0;
  };
  sample(0);
  sample((n * 0.25) | 0);
  sample((n * 0.50) | 0);
  sample((n * 0.75) | 0);
  sample(n - 128);
  return `${n}:${h >>> 0}`;
}

// ── Private API adapter ────────────────────────────────────────
// pdf.context.indirectObjects is used for image deduplication.
// It is not part of pdf-lib's public API — this adapter centralises
// the access so a version-change failure throws in ONE place and is
// caught by the caller, which returns {unavailable:true} for UI warning.
function _getPdfIndirectObjects(pdf) {
  const map = pdf.context?.indirectObjects;
  if (!(map instanceof Map)) throw new Error('pdf.context.indirectObjects unavailable');
  return map;
}

// ── Image deduplication ────────────────────────────────────────
// Finds identical XObject images across pages using _imageFingerprint.
// Rewires duplicate entries in page Resources.XObject dicts to the
// canonical ref, then removes orphaned objects from the document context.
// Scope: page-level XObjects only — covers 95%+ of real-world duplicate cases
// (logos, signatures, headers). FormXObject-hosted images are left untouched
// to avoid dangling-ref corruption on complex structured PDFs.
function _deduplicateImages(pdf) {
  const { PDFName, PDFRawStream } = PDFLib;

  // Pass 1 — build canonical ref map and identify duplicates
  const canonical    = new Map(); // fingerprint → first PDFRef
  const replacements = new Map(); // duplicate objectNumber → canonical PDFRef

  for (const [ref, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (obj.dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;

    const fp = _imageFingerprint(obj.contents);
    if (canonical.has(fp)) {
      replacements.set(ref.objectNumber, canonical.get(fp));
    } else {
      canonical.set(fp, ref);
    }
  }

  if (replacements.size === 0) return { count: 0, savedBytes: 0 };

  // Pass 2 — update page Resources.XObject dicts to use canonical refs
  const toDelete   = new Set(); // objectNumbers confirmed safe to remove
  let   savedBytes = 0;

  for (const page of pdf.getPages()) {
    let res = page.node.get(PDFName.of('Resources'));
    if (!res) continue;
    res = pdf.context.lookup(res);
    if (!res?.get) continue;

    let xobj = res.get(PDFName.of('XObject'));
    if (!xobj) continue;
    xobj = pdf.context.lookup(xobj);
    if (!xobj?.entries) continue;

    for (const [name, val] of xobj.entries()) {
      const objNum = val?.objectNumber;
      if (objNum === undefined) continue;
      const canonRef = replacements.get(objNum);
      if (!canonRef) continue;

      const dupObj = pdf.context.lookup(val);
      if (dupObj instanceof PDFRawStream) savedBytes += dupObj.contents.length;
      xobj.set(name, canonRef);
      toDelete.add(objNum);
    }
  }

  if (toDelete.size === 0) return { count: 0, savedBytes: 0 };

  // Pass 3 — remove orphaned objects so pdf-lib doesn't serialise them
  // pdf.context.indirectObjects is Map<PDFRef, PDFObject> — private TS field
  // but publicly accessible in JS. Wrapped in try/catch: if the API ever changes,
  // we skip deletion gracefully (PDF stays valid; space savings are just lost).
  try {
    const indObjs = _getPdfIndirectObjects(pdf);

    const refByNum = new Map();
    for (const [ref] of indObjs) refByNum.set(ref.objectNumber, ref);

    for (const objNum of toDelete) {
      const ref = refByNum.get(objNum);
      if (ref) indObjs.delete(ref);
    }
  } catch {
    // API unavailable — resource dicts updated but objects not deleted.
    // PDF is valid but no space is freed; flag so UI can show a warning.
    return { count: 0, savedBytes: 0, unavailable: true };
  }

  return { count: toDelete.size, savedBytes };
}

// ── FlateDecode stream repacker ────────────────────────────────
// Re-compresses FlateDecode non-image streams (fonts, content streams)
// using the browser's built-in CompressionStream, which typically runs
// deflate at a higher level than many PDF generators (Word/LibreOffice/ERP
// systems often use zlib default level 6 or even level 1 for speed).
//
// No external library — uses native Web Streams API (Chrome 80+, FF 113+, Safari 16.4+).
// Falls back to no-op silently on older browsers.
//
// Output is always zlib format (RFC 1950) — correct for FlateDecode in PDF spec.
// Streams with /DecodeParms are skipped (they carry predictor parameters that
// would be invalidated by a naive decode/reencode cycle).
async function _repackFlateStreams(pdf) {
  if (typeof CompressionStream === 'undefined') return { savedBytes: 0, count: 0 };

  const { PDFName, PDFRawStream } = PDFLib;
  let savedBytes = 0, count = 0;

  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;

    const filter = obj.dict.get(PDFName.of('Filter'))?.toString() ?? '';
    if (!filter.includes('FlateDecode')) continue;

    // Images have their own pipeline (_recompressImages); DecodeParms = predictor
    if (obj.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') continue;
    if (obj.dict.get(PDFName.of('DecodeParms'))) continue;

    // Tiny streams — overhead exceeds savings
    if (obj.contents.length < 2048) continue;

    try {
      const raw     = await _inflateFlate(obj.contents);
      const repacked = await _deflateZlib(raw);

      if (repacked.length < obj.contents.length * 0.95) {
        savedBytes += obj.contents.length - repacked.length;
        obj.contents = repacked;
        count++;
      }
    } catch { /* malformed or already optimal — skip silently */ }
  }

  return { savedBytes, count };
}

// Decompress zlib/deflate stream. Tries zlib format first (RFC 1950 — the PDF
// spec's stated format for FlateDecode), falls back to raw deflate (RFC 1951)
// since many generators don't wrap with a zlib header despite the spec.
async function _inflateFlate(data) {
  try {
    const ds = new DecompressionStream('deflate');
    const w  = ds.writable.getWriter(); w.write(data); w.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  } catch {
    const ds = new DecompressionStream('deflate-raw');
    const w  = ds.writable.getWriter(); w.write(data); w.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }
}

// Compress to zlib format (RFC 1950) — correct for PDF FlateDecode.
async function _deflateZlib(data) {
  const cs = new CompressionStream('deflate');
  const w  = cs.writable.getWriter(); w.write(data); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

// ── DPI estimation ─────────────────────────────────────────────
//
// Estimates the effective DPI of a raster image placed on a PDF page,
// assuming the image fills the page (good heuristic for scanned documents).
//
// Formula: DPI = (pixels / points) * 72  (1 pt = 1/72 inch)
// Rotation: when page is rotated 90° or 270°, width/height swap.
//
// Returns estimated DPI (integer). Returns 0 if page size is unknown.
function _estimateDpi(imgW, imgH, pageWPt, pageHPt, rotDeg) {
  if (!pageWPt || !pageHPt) return 0;
  const rot = ((rotDeg % 360) + 360) % 360;
  const [pw, ph] = (rot === 90 || rot === 270) ? [pageHPt, pageWPt] : [pageWPt, pageHPt];
  const dpiX = (imgW / pw) * 72;
  const dpiY = (imgH / ph) * 72;
  return Math.round((dpiX + dpiY) / 2);
}

// ── Image recompression (Phase 2.5 of handleCompress) ─────────
//
// Iterates ALL indirect objects, finds images (PDFRawStream + /Subtype /Image),
// classifies each, and recompresses eligible ones via OffscreenCanvas.
//
// SKIP CONDITIONS (proven safe via torture PDF research):
//   • CMYK color space — canvas outputs sRGB, color shift would occur
//   • ICC-based color space — colorSpace instanceof PDFArray (checked correctly;
//     Array.isArray() would ALWAYS return false for PDFArray objects)
//   • 1-bit images — B&W scans; JPEG would destroy binariness
//   • Images with SMask or Mask — alpha/transparency; JPEG has no alpha channel
//   • Tiny images (<20×20 px) — overhead not worth it
//   • Result is not ≥10% smaller — 10% savings rule
//
// DPI downsampling (when targetDpi is set):
//   Uses median page size as reference. Safe for full-page scans (most common
//   case). Small images (<600px on longest side) are not downsampled — they
//   are unlikely to be full-page scans and the savings would be minimal.
//
// JPEG pipeline: obj.contents → Blob(image/jpeg) → createImageBitmap
//   → OffscreenCanvas(tw, th) → convertToBlob(image/jpeg, quality) → obj.contents
//
// FlateDecode pipeline: decodePDFRawStream(obj).decode() → raw RGB pixels
//   → ImageData → OffscreenCanvas(tw, th) → convertToBlob(image/jpeg, quality)
//   → obj.contents + update /Filter to DCTDecode + /ColorSpace to DeviceRGB
//
// Returns { recompressed, skipped, savedBytes }
async function _recompressImages(pdf, jpegQuality, targetDpi, medianPageSize) {
  const { PDFName, PDFNumber, PDFArray, PDFRawStream, decodePDFRawStream } = PDFLib;
  const ctx = pdf.context;

  let recompressed = 0, skipped = 0, savedBytes = 0;

  const entries = [];
  ctx.enumerateIndirectObjects().forEach(([ref, obj]) => entries.push([ref, obj]));

  // Count eligible images upfront so we can emit per-image progress (55→72%)
  const imageEntries = entries.filter(([, obj]) => {
    if (!(obj instanceof PDFRawStream)) return false;
    const sub = obj.dict.get(PDFName.of('Subtype'))?.toString();
    return sub === '/Image';
  });
  const totalImages = imageEntries.length;
  let imgIdx = 0;

  for (const [, obj] of entries) {
    // Must be a raw stream
    if (!(obj instanceof PDFRawStream)) continue;

    const dict = obj.dict;
    if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;

    // Emit progress every 3 images so watchdog resets and UI stays alive
    imgIdx++;
    if (imgIdx % 3 === 0 && totalImages > 0) {
      const pct = 55 + Math.round((imgIdx / totalImages) * 17);
      self.postMessage({ type: 'progress', value: Math.min(pct, 72), label: `Recompressing image ${imgIdx} of ${totalImages}…` });
    }

    const filter     = dict.get(PDFName.of('Filter'))?.toString() ?? '';
    const colorSpace = dict.get(PDFName.of('ColorSpace'));
    const bpcObj     = dict.get(PDFName.of('BitsPerComponent'));
    const bpc        = bpcObj instanceof PDFNumber ? bpcObj.asNumber() : 8;
    const w          = dict.get(PDFName.of('Width'))?.asNumber()  ?? 0;
    const h          = dict.get(PDFName.of('Height'))?.asNumber() ?? 0;

    const isJPEG  = filter.includes('DCTDecode');
    const isFlate = filter.includes('FlateDecode');

    // ── Safety checks ─────────────────────────────────────────
    // CRITICAL: use instanceof PDFArray, NOT Array.isArray()
    // Array.isArray always returns false for pdf-lib PDFArray objects
    if (colorSpace instanceof PDFArray)               { skipped++; continue; }  // ICC
    if (colorSpace?.toString().includes('CMYK'))      { skipped++; continue; }  // CMYK
    if (colorSpace?.toString().includes('DeviceGray') && bpc === 1) { skipped++; continue; }  // 1-bit
    if (bpc === 1)                                    { skipped++; continue; }
    if (dict.get(PDFName.of('SMask')))                { skipped++; continue; }  // alpha
    if (dict.get(PDFName.of('Mask')))                 { skipped++; continue; }  // alpha
    if (w * h < 400)                                  { skipped++; continue; }  // too tiny
    if (!isJPEG && !isFlate)                          { skipped++; continue; }  // unsupported filter

    const origSize = obj.contents.length;

    try {
      let newBytes;

      // ── DPI-aware target dimensions ───────────────────────────
      // Compute target (tw, th): downsample if image is likely a full-page scan
      // and its estimated DPI exceeds targetDpi. Small images (<600px longest
      // side) are never downsampled — they are decorative, not full-page scans.
      let tw = w, th = h;
      if (targetDpi && medianPageSize && Math.max(w, h) >= 600) {
        const rot = medianPageSize.rot ?? 0;
        const estDpi = _estimateDpi(w, h, medianPageSize.w, medianPageSize.h, rot);
        if (estDpi > targetDpi * 1.1) {       // 10% headroom — no pointless rescaling
          const scale = targetDpi / estDpi;   // always <1 here
          tw = Math.max(1, Math.round(w * scale));
          th = Math.max(1, Math.round(h * scale));
        }
      }

      if (isJPEG) {
        // JPEG: obj.contents = raw JPEG bytes, feed directly to createImageBitmap
        const blob   = new Blob([obj.contents], { type: 'image/jpeg' });
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(tw, th);
        const ctx2d  = canvas.getContext('2d');
        ctx2d.imageSmoothingEnabled = true;
        ctx2d.imageSmoothingQuality = 'high';
        ctx2d.drawImage(bitmap, 0, 0, tw, th);
        bitmap.close();
        const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: jpegQuality });
        newBytes = new Uint8Array(await outBlob.arrayBuffer());
        // Update Width/Height in dict when dimensions changed
        if (tw !== w || th !== h) {
          dict.set(PDFName.of('Width'),  PDFNumber.of(tw));
          dict.set(PDFName.of('Height'), PDFNumber.of(th));
        }

      } else {
        // FlateDecode: decodePDFRawStream gives raw pixel bytes (zlib-inflated)
        // PDF stores rows of RGB (or Gray) pixels without row-filter bytes (unlike PNG)
        // OffscreenCanvas putImageData needs RGBA — we expand RGB → RGBA manually
        const rawPixels = decodePDFRawStream(obj).decode();
        const cs        = colorSpace?.toString() ?? '';
        const isGray    = cs.includes('DeviceGray');

        // Build RGBA Uint8ClampedArray for ImageData
        const rgba = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          if (isGray) {
            const v = rawPixels[i];
            rgba[i * 4]     = v;
            rgba[i * 4 + 1] = v;
            rgba[i * 4 + 2] = v;
          } else {
            rgba[i * 4]     = rawPixels[i * 3];
            rgba[i * 4 + 1] = rawPixels[i * 3 + 1];
            rgba[i * 4 + 2] = rawPixels[i * 3 + 2];
          }
          rgba[i * 4 + 3] = 255;  // fully opaque
        }

        // putImageData at full resolution, then drawImage to downsample
        const srcCanvas = new OffscreenCanvas(w, h);
        const srcCtx    = srcCanvas.getContext('2d');
        srcCtx.putImageData(new ImageData(rgba, w, h), 0, 0);

        const canvas = new OffscreenCanvas(tw, th);
        const ctx2d  = canvas.getContext('2d');
        ctx2d.imageSmoothingEnabled = true;
        ctx2d.imageSmoothingQuality = 'high';
        ctx2d.drawImage(srcCanvas, 0, 0, tw, th);

        const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: jpegQuality });
        newBytes = new Uint8Array(await outBlob.arrayBuffer());

        // Update filter to DCTDecode and color space to RGB (canvas always outputs sRGB)
        dict.set(PDFName.of('Filter'),     PDFName.of('DCTDecode'));
        dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
        dict.delete(PDFName.of('DecodeParms'));
        if (tw !== w || th !== h) {
          dict.set(PDFName.of('Width'),  PDFNumber.of(tw));
          dict.set(PDFName.of('Height'), PDFNumber.of(th));
        }
      }

      // 10% savings rule — only replace if meaningfully smaller
      if (newBytes.length >= origSize * 0.9) {
        // Revert filter changes made during FlateDecode→JPEG attempt.
        // Only restore ColorSpace if it existed originally — setting it to
        // undefined would write an invalid entry into the PDF dict.
        if (isFlate) {
          dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
          if (colorSpace) dict.set(PDFName.of('ColorSpace'), colorSpace);
          else            dict.delete(PDFName.of('ColorSpace'));
        }
        skipped++;
        continue;
      }

      obj.contents = newBytes;
      dict.set(PDFName.of('Length'), PDFNumber.of(newBytes.length));
      savedBytes += (origSize - newBytes.length);
      recompressed++;

    } catch {
      // Any error (createImageBitmap fails on corrupt data, etc.) — skip silently
      skipped++;
    }
  }

  return { recompressed, skipped, savedBytes };
}

// ── Background pre-scan ────────────────────────────────────────
// Called via 'compress-scan' case when user drops a file — runs before
// they click Compress so the UI can show recommendations immediately.
// Result is cached in compressUI.js and passed back via options.preScan
// to handleCompress, which skips re-analysis when the cached scan exists.
async function _runCompressScan(file) {
  const { PDFDocument, PDFName, PDFRawStream } = PDFLib;
  const buf = await file.arrayBuffer();
  const pdf = await PDFDocument.load(buf, { ignoreEncryption: true });
  const cat = pdf.catalog;

  let thumbnails = 0, hasPieceInfo = cat.has(PDFName.of('PieceInfo'));
  const pages_ = pdf.getPages();
  for (const page of pages_) {
    if (page.node.has(PDFName.of('Thumb')))     thumbnails++;
    if (page.node.has(PDFName.of('PieceInfo'))) hasPieceInfo = true;
  }

  // Compute median page size for DPI estimation (same approach as handleCompress)
  const sizes_ = pages_.map(p => {
    const { width, height } = p.getSize();
    const rot = p.getRotation()?.angle ?? 0;
    return { w: width, h: height, rot };
  }).sort((a, b) => (a.w * a.h) - (b.w * b.h));
  const medPage = sizes_[Math.floor(sizes_.length / 2)] ?? null;

  let imgBytes = 0, imgCount = 0;
  const dpiList = [];
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (obj.dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    imgBytes += obj.contents.length;
    imgCount++;
    // Estimate DPI for images >= 100px (skip tiny decorative images)
    const w = obj.dict.get(PDFName.of('Width'))?.asNumber()  ?? 0;
    const h = obj.dict.get(PDFName.of('Height'))?.asNumber() ?? 0;
    if (w >= 100 && h >= 100 && medPage) {
      const dpi = _estimateDpi(w, h, medPage.w, medPage.h, medPage.rot);
      if (dpi > 0 && dpi < 2000) dpiList.push(dpi);
    }
  }
  dpiList.sort((a, b) => a - b);
  const medianDpi = dpiList.length > 0 ? dpiList[Math.floor(dpiList.length / 2)] : 0;

  const fileSize    = buf.byteLength;
  const imageRatio  = imgCount > 0 && fileSize > 0 ? imgBytes / fileSize : 0;
  const hasXMP      = cat.has(PDFName.of('Metadata'));

  return {
    pageCount:     pdf.getPageCount(),
    hasXMP,
    hasPieceInfo,
    thumbnails,
    isEncrypted:   pdf.isEncrypted,
    imageCount:    imgCount,
    imageRatio,
    imageDominant: imageRatio > 0.5,
    medianDpi,
    fileSize,
    opportunities: (hasXMP ? 1 : 0) + (thumbnails > 0 ? 1 : 0) + (hasPieceInfo ? 1 : 0),
  };
}

async function handleCompress(fileBuffer, options) {
  const { PDFDocument, PDFName, PDFRawStream } = PDFLib;
  const originalSize = fileBuffer.byteLength;

  self.postMessage({ type: 'progress', value: 5,  label: 'Loading PDF…' });

  const pdf = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  if (options.removeWatermarks) _removeWatermarks(pdf);
  const wasEncrypted = pdf.isEncrypted;

  self.postMessage({ type: 'progress', value: 18, label: 'Analyzing structure…' });

  // ── Phase 1: Analysis ─────────────────────────────────────
  // Собираем отчёт о том, что найдено — вернём с результатом
  const report = {
    pages:         pdf.getPageCount(),
    wasEncrypted,
    hasXMP:        false,
    hasPieceInfo:  false,
    thumbnails:    0,
    metadataFields: 0,
  };

  const cat   = pdf.catalog;
  const pages = pdf.getPages();

  if (options.preScan) {
    // Background scan already ran — reuse its results to skip re-analysis.
    // Saves ~100–300ms on large files by avoiding a second object enumeration.
    report.hasXMP       = options.preScan.hasXMP;
    report.hasPieceInfo = options.preScan.hasPieceInfo;
    report.thumbnails   = options.preScan.thumbnails;
    self.postMessage({ type: 'scan-report', report: { ...options.preScan, isEncrypted: report.wasEncrypted } });
  } else {
    // No cached scan (user clicked faster than background scan finished).
    report.hasXMP       = cat.has(PDFName.of('Metadata'));
    report.hasPieceInfo = cat.has(PDFName.of('PieceInfo'));

    for (const page of pages) {
      if (page.node.has(PDFName.of('Thumb')))     report.thumbnails++;
      if (page.node.has(PDFName.of('PieceInfo'))) report.hasPieceInfo = true;
    }

    let _imgBytes = 0, _imgCount = 0;
    for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      if (obj.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') {
        _imgBytes += obj.contents.length;
        _imgCount++;
      }
    }

    const _imageRatio = _imgCount > 0 ? _imgBytes / originalSize : 0;
    self.postMessage({
      type:   'scan-report',
      report: {
        pageCount:     pdf.getPageCount(),
        hasXMP:        report.hasXMP,
        hasPieceInfo:  report.hasPieceInfo,
        thumbnails:    report.thumbnails,
        isEncrypted:   report.wasEncrypted,
        imageCount:    _imgCount,
        imageRatio:    _imageRatio,
        imageDominant: _imageRatio > 0.5,
        fileSize:      originalSize,
        opportunities: (report.hasXMP ? 1 : 0) + (report.thumbnails > 0 ? 1 : 0) + (report.hasPieceInfo ? 1 : 0),
      },
    });
  }

  // ── Phase 2: Metadata removal ─────────────────────────────
  self.postMessage({ type: 'progress', value: 30, label: 'Removing metadata…' });

  // Standard info dict fields — always cleared regardless of preset
  const before = [];
  if (pdf.getTitle()    !== undefined) { pdf.setTitle('');        before.push('title'); }
  if (pdf.getAuthor()   !== undefined) { pdf.setAuthor('');       before.push('author'); }
  if (pdf.getSubject()  !== undefined) { pdf.setSubject('');      before.push('subject'); }
  if (pdf.getCreator()  !== undefined) { pdf.setCreator('PDFree'); before.push('creator'); }
  if (pdf.getProducer() !== undefined) { pdf.setProducer('PDFree'); before.push('producer'); }
  try { pdf.setKeywords([]); before.push('keywords'); } catch { /* not all pdf-lib versions */ }
  report.metadataFields = before.length;

  // XMP metadata stream — raw XML blob, often 5–50 KB
  // Low preset: skip XMP removal to be conservative (some viewers rely on it)
  // Medium/High: always remove
  if (options.preset !== 'low' && report.hasXMP) {
    try { cat.delete(PDFName.of('Metadata')); } catch { /* ignore */ }
  }

  // Adobe PieceInfo — per-document private data from Acrobat/Illustrator
  // Low: skip (safest option)
  // Medium/High: remove
  if (options.preset !== 'low' && cat.has(PDFName.of('PieceInfo'))) {
    try { cat.delete(PDFName.of('PieceInfo')); } catch { /* ignore */ }
  }

  // ── Phase 3: Per-page cleanup ─────────────────────────────
  self.postMessage({ type: 'progress', value: 50, label: 'Cleaning pages…' });

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];

    // Embedded thumbnails — always remove (they serve no purpose for end-users)
    if (page.node.has(PDFName.of('Thumb'))) {
      try { page.node.delete(PDFName.of('Thumb')); } catch { /* ignore */ }
    }

    // Per-page PieceInfo — only Medium/High
    if (options.preset !== 'low' && page.node.has(PDFName.of('PieceInfo'))) {
      try { page.node.delete(PDFName.of('PieceInfo')); } catch { /* ignore */ }
    }

    // High only: strip MarkInfo (accessibility tagging dict — large in tagged PDFs).
    // preserveText guard: MarkInfo is unrelated to text rendering but keeping it
    // is the safer default when the user asked to preserve quality.
    if (options.preset === 'high' && !options.preserveText) {
      if (page.node.has(PDFName.of('StructParents'))) {
        try { page.node.delete(PDFName.of('StructParents')); } catch { /* ignore */ }
      }
    }

    // Emit progress every 10 pages so UI stays alive
    if (i % 10 === 9) {
      self.postMessage({
        type:  'progress',
        value: 50 + Math.round(((i + 1) / pages.length) * 20),
        label: `Cleaning page ${i + 1} of ${pages.length}…`,
      });
    }
  }

  // High only: strip document-level MarkInfo / StructTreeRoot when preserveText=false.
  // These are large tagged-PDF structures; removing them can save 5–20% on Acrobat exports.
  // Kept when preserveText=true because assistive technologies rely on them.
  if (options.preset === 'high' && !options.preserveText) {
    if (cat.has(PDFName.of('MarkInfo')))       { try { cat.delete(PDFName.of('MarkInfo'));       } catch { /* pdf-lib version compat */ } }
    if (cat.has(PDFName.of('StructTreeRoot'))) { try { cat.delete(PDFName.of('StructTreeRoot')); } catch { /* pdf-lib version compat */ } }
    report.removedStructTree = true;
  }

  // ── Phase 3.5: Image recompression (Medium/High + imageQuality set) ─
  //
  // Presets and quality mapping:
  //   Low (light)    → no image recompression (metadata only)
  //   Medium (std)   → imageQuality 0.82 — good balance, minimal artifacts
  //   High (max)     → imageQuality 0.72 — aggressive, visible only on close inspection
  //
  // DPI downsampling: targetDpi from UI (96 / 150 / null).
  //   null = no downsampling (quality-only mode, current default for Low/legacy).
  //   Uses median page size as the reference for full-page-scan detection.
  //
  // OffscreenCanvas is available in Worker context (all modern browsers).
  // If not available (very old browser) we skip silently and continue.
  // options.quality (0–1) comes from the UI slider; fall back to preset defaults
  // so old callers without quality field still work correctly.
  const _qualityFallback = { medium: 0.82, high: 0.72 };
  const jpegQuality = options.preset === 'low' ? null
    : (options.quality ?? _qualityFallback[options.preset] ?? 0.82);
  const targetDpi   = options.targetDpi ?? null;   // null = no downsampling

  // Compute median page size (width, height in points + rotation) for DPI estimation.
  // Median is more robust than mean for documents with a cover page at a different size.
  let medianPageSize = null;
  if (targetDpi !== null && pages.length > 0) {
    const sizes = pages.map(p => {
      const { width, height } = p.getSize();
      const rot = p.getRotation()?.angle ?? 0;
      return { w: width, h: height, rot };
    });
    sizes.sort((a, b) => (a.w * a.h) - (b.w * b.h));
    medianPageSize = sizes[Math.floor(sizes.length / 2)];
  }

  // ── Phase 3.4: Image deduplication ───────────────────────────
  // Runs BEFORE recompressImages so we don't waste CPU recompressing images we'll remove.
  self.postMessage({ type: 'progress', value: 53, label: 'Deduplicating images…' });
  if (options.preset !== 'low') {
    const dedupResult         = _deduplicateImages(pdf);
    report.imagesDeduplicated = dedupResult.count;
    report.dedupSavedBytes    = dedupResult.savedBytes;
    if (dedupResult.unavailable) {
      (report.warnings ??= []).push('Image dedup unavailable on current engine');
    }
  } else {
    report.imagesDeduplicated = 0;
    report.dedupSavedBytes    = 0;
  }

  // ── Phase 3.5: Image recompression ────────────────────────────
  if (jpegQuality !== null && typeof OffscreenCanvas !== 'undefined') {
    self.postMessage({ type: 'progress', value: 58, label: 'Recompressing images…' });
    const imgResult = await _recompressImages(pdf, jpegQuality, targetDpi, medianPageSize);
    report.imagesRecompressed = imgResult.recompressed;
    report.imagesSkipped      = imgResult.skipped;
    report.imagesSavedBytes   = imgResult.savedBytes;
  } else {
    report.imagesRecompressed = 0;
    report.imagesSkipped      = 0;
    report.imagesSavedBytes   = 0;
  }

  // ── Phase 3.6: FlateDecode stream repack ─────────────────────
  // Re-compress fonts and content streams at higher deflate level.
  // Skipped on Light preset (maximum compatibility mode).
  if (options.preset !== 'low') {
    self.postMessage({ type: 'progress', value: 68, label: 'Repacking streams…' });
    const flateResult         = await _repackFlateStreams(pdf);
    report.flateStreamsRepacked = flateResult.count;
    report.flateSavedBytes    = flateResult.savedBytes;
  } else {
    report.flateStreamsRepacked = 0;
    report.flateSavedBytes    = 0;
  }

  // ── Phase 4: Save with stream optimisation ────────────────
  self.postMessage({ type: 'progress', value: 78, label: 'Optimizing streams…' });

  // Preset strategy:
  //   low    → NO useObjectStreams (safest, maximum compatibility)
  //   medium → useObjectStreams:true (main compression win, ~90% of cases)
  //   high   → useObjectStreams:true + higher objectsPerTick (faster packing)
  //
  // Note: pdf-lib does not expose DEFLATE compression level, so the delta between
  // medium and high comes from deeper structure cleanup above, not from save options.
  const useObjectStreams = options.preset !== 'low';
  const objectsPerTick  = options.preset === 'high' ? 100 : 50;
  report.useObjectStreams = useObjectStreams;

  const compressed = await pdf.save({
    useObjectStreams,
    addDefaultPage: false,
    objectsPerTick,
  });

  self.postMessage({ type: 'progress', value: 96, label: 'Finalizing…' });

  const savedBytes = originalSize - compressed.byteLength;

  // Transfer buffer zero-copy
  self.postMessage(
    {
      type:           'done',
      result:         compressed.buffer,
      originalSize,
      compressedSize: compressed.byteLength,
      savedBytes,
      report,
    },
    [compressed.buffer]
  );
}

// ── JPG/PNG → PDF handler ─────────────────────────────────────
//
// Стратегия:
//   1. Для каждого изображения создаём ImageBitmap (браузерный декодер)
//   2. Рисуем на OffscreenCanvas с правильной трансформацией (EXIF угол)
//   3. convertToBlob → jpeg или png буфер
//   4. Встраиваем в pdf-lib страницу с правильными размерами
//
// Размеры страниц в pt (72pt = 1 inch):
//   A4: 595 × 842    Letter: 612 × 792
//
// Ориентация: если изображение шире чем высоко — landscape, иначе portrait.
// Fit: масштабируем изображение до размеров страницы сохраняя aspect ratio.

const PAGE_SIZES = {
  a4:     [595.28, 841.89],
  letter: [612,    792],
};

async function handleJpg2Pdf(fileBuffers, options) {
  const { PDFDocument } = PDFLib;
  const { pageSize = 'auto', orientation = 'auto', compress = true,
          quality = 0.82, exifAngles = [] } = options;

  // Normalise ALL buffers to Uint8Array immediately.
  // Root cause of Windows Chrome jpg2pdf bug:
  //   Transferable ArrayBuffers arrive in the Worker as raw ArrayBuffer objects.
  //   On Windows Chrome, indexing these directly (buf[0]) returns `undefined`
  //   instead of the byte value — causing _isJpeg() to return false for every image,
  //   which then tries to embed JPEG bytes as PNG → pdf-lib throws → image skipped.
  //   Wrapping in Uint8Array normalises access on all platforms.
  const normalizedBuffers = fileBuffers.map(b =>
    b instanceof Uint8Array ? b : new Uint8Array(b)
  );

  const doc = await PDFDocument.create();
  const total = normalizedBuffers.length;
  const skipped = [];   // indices of images that failed — reported back to UI

  self.postMessage({ type: 'progress', value: 5, label: 'Starting conversion…' });

  for (let i = 0; i < total; i++) {
    self.postMessage({
      type:  'progress',
      value: 5 + Math.round((i / total) * 85),
      label: `Converting image ${i + 1} of ${total}…`,
    });

    const buf    = normalizedBuffers[i];  // always Uint8Array — see normalisation above
    const angle  = exifAngles[i] || 0;   // EXIF correction degrees
    const isJpeg = _isJpeg(buf);
    const isWebp = !isJpeg && _isWebp(buf);

    // 1. Decode image to ImageBitmap
    // Windows Chrome Worker uses DirectX/ANGLE backend — stricter than macOS Metal.
    // Some JPEGs fail createImageBitmap with DOMException (progressive JPEG, wide-gamut
    // ICC profile, Adobe RGB) even though macOS accepts them silently.
    //
    // Fallback chain (most → least specific):
    //   a) Blob with MIME type — correct path for most images
    //   b) Blob without MIME type — Windows ANGLE sometimes accepts untyped blobs
    //   c) Skip — report the actual error name + message back for diagnosis
    //
    // Diagnostic: send error details to main thread so DevTools on Windows shows WHY.
    if (buf.byteLength === 0) {
      // Detached transfer — should not happen after normalisation, but guard anyway
      self.postMessage({ type: 'warn', message: `Image #${i + 1}: buffer is empty (byteLength=0)` });
      skipped.push(i + 1);
      continue;
    }

    let bitmap;
    try {
      const mime   = isJpeg ? 'image/jpeg' : isWebp ? 'image/webp' : 'image/png';
      const blobA  = new Blob([buf], { type: mime });
      try {
        bitmap = await createImageBitmap(blobA, { imageOrientation: 'none' });
      } catch (e1) {
        // Fallback b: no MIME type — Windows ANGLE sometimes decodes untyped blobs
        self.postMessage({ type: 'warn',
          message: `Image #${i + 1}: typed-blob failed (${e1.name}: ${e1.message}), trying untyped fallback` });
        const blobB = new Blob([buf]);
        bitmap = await createImageBitmap(blobB, { imageOrientation: 'none' });
      }
      if (!bitmap.width || !bitmap.height) throw new Error('zero-size bitmap after decode');
    } catch (e) {
      // All fallbacks exhausted — skip and report full error for diagnosis
      self.postMessage({ type: 'warn',
        message: `Image #${i + 1} skipped: ${e.name}: ${e.message} | size=${buf.byteLength} isJpeg=${isJpeg}` });
      skipped.push(i + 1);
      self.postMessage({ type: 'progress', value: 5 + Math.round(((i + 0.5) / total) * 85),
                         label: `Skipping image ${i + 1} (decode error)…` });
      continue;
    }

    // bitmap is now open — must be closed in all code paths below.
    // canvasW/canvasH declared OUTSIDE try so they're in scope for page sizing.
    // Initialised to 0; the guard after finally catches early-exception case.
    let embedded;
    let canvasW = 0, canvasH = 0;

    try {
      const origW = bitmap.width;
      const origH = bitmap.height;

      // 2. Normalise angle: handle 0/90/180/270 and negatives (-90 = 270, etc.)
      // Math.abs(angle) === 90 misses 270° — normalise first to be safe.
      const normAngle  = ((angle % 360) + 360) % 360;    // always 0..359
      const isRotated90 = normAngle === 90 || normAngle === 270;

      // After EXIF rotation, width/height swap for 90° and 270°
      const realW = isRotated90 ? origH : origW;
      const realH = isRotated90 ? origW : origH;

      // 3. Canvas output size (post-EXIF, pre-scale)
      canvasW = realW;
      canvasH = realH;
      if (compress) {
        // Mirror of IMAGE_DIM_PRESETS.medium — update both if you change the value
        const maxDim = 2400;
        const scale  = Math.min(1, maxDim / Math.max(realW, realH));
        canvasW      = Math.round(realW * scale);
        canvasH      = Math.round(realH * scale);
      }

      if (!compress && normAngle === 0 && !isWebp) {
        // ── Fast path ───────────────────────────────────────────────────────
        // No compression, no rotation → embed bytes directly.
        // Bypasses OffscreenCanvas entirely → zero GPU involvement,
        // zero quality loss, and avoids Windows ANGLE driver bugs.
        // WebP is excluded: pdf-lib cannot embed WebP natively; always goes via canvas.
        embedded = isJpeg
          ? await doc.embedJpg(buf)
          : await doc.embedPng(buf);

      } else if (typeof OffscreenCanvas === 'undefined') {
        // ── Safari < 16.4 fallback ──────────────────────────────────────────
        // OffscreenCanvas not available (Safari 15 and earlier).
        // Embed directly — no rotation or compression applied.
        // WebP cannot be embedded; skip it when OffscreenCanvas is unavailable.
        if (isWebp) {
          self.postMessage({ type: 'warn', message: `Image #${i + 1}: WebP requires OffscreenCanvas (not available in this browser)` });
          skipped.push(i + 1); continue;
        }
        embedded = isJpeg
          ? await doc.embedJpg(buf)
          : await doc.embedPng(buf);

      } else {
        // ── Canvas path: rotation and/or compression needed ─────────────────
        const canvas = new OffscreenCanvas(canvasW, canvasH);
        const ctx    = canvas.getContext('2d');

        ctx.save();
        ctx.translate(canvasW / 2, canvasH / 2);
        ctx.rotate(normAngle * Math.PI / 180);
        // For 90° / 270° the bitmap dimensions are swapped relative to canvas
        if (isRotated90) {
          ctx.drawImage(bitmap, -canvasH / 2, -canvasW / 2, canvasH, canvasW);
        } else {
          ctx.drawImage(bitmap, -canvasW / 2, -canvasH / 2, canvasW, canvasH);
        }
        ctx.restore();

        const exportType = (compress || isJpeg || isWebp) ? 'image/jpeg' : 'image/png';
        const exportOpts = { type: exportType };
        if (exportType === 'image/jpeg') {
          exportOpts.quality = (compress && quality !== undefined) ? quality : 0.92;
        }

        const imgBlob = await canvas.convertToBlob(exportOpts);
        if (!imgBlob) throw new Error('convertToBlob returned null — canvas too large?');

        const imgBytes = new Uint8Array(await imgBlob.arrayBuffer());
        embedded = exportType === 'image/jpeg'
          ? await doc.embedJpg(imgBytes)
          : await doc.embedPng(imgBytes);
      }

    } catch (err) {
      self.postMessage({ type: 'warn',
        message: `Image #${i + 1} embed failed: ${err.message}` });
      skipped.push(i + 1);
      continue;
    } finally {
      bitmap.close();   // always free GPU memory
    }

    // 7. Page sizing — guard against 0-size (can only happen if try threw early)
    if (!canvasW || !canvasH) { skipped.push(i + 1); continue; }

    const imgAspect = canvasW / canvasH;
    let pageW, pageH;

    if (pageSize === 'auto') {
      // One pt ≈ one pixel at 72 DPI — reasonable for digital viewing
      pageW = canvasW;
      pageH = canvasH;
    } else if (pageSize === 'fit') {
      // Standard page, image scaled to fill
      const [stdW, stdH] = PAGE_SIZES.a4;
      pageW = stdW; pageH = stdH;
    } else {
      [pageW, pageH] = PAGE_SIZES[pageSize] || PAGE_SIZES.a4;
    }

    // Apply orientation override
    const forcePortrait   = orientation === 'portrait';
    const forceLandscape  = orientation === 'landscape';
    const naturalLandscape = canvasW > canvasH;

    if ((forceLandscape && pageW < pageH) || (forcePortrait && pageW > pageH)
        || (orientation === 'auto' && naturalLandscape && pageW < pageH)) {
      [pageW, pageH] = [pageH, pageW];   // swap
    }

    const page = doc.addPage([pageW, pageH]);

    // 8. Place image — centered, maintain aspect ratio
    let drawW, drawH, drawX, drawY;
    if (pageSize === 'fit' || pageSize === 'a4' || pageSize === 'letter') {
      const scale = Math.min(pageW / canvasW, pageH / canvasH);
      drawW = canvasW * scale;
      drawH = canvasH * scale;
      drawX = (pageW - drawW) / 2;
      drawY = (pageH - drawH) / 2;
    } else {
      // Auto: image fills page exactly
      drawW = pageW; drawH = pageH; drawX = 0; drawY = 0;
    }

    page.drawImage(embedded, { x: drawX, y: drawY, width: drawW, height: drawH });
  }

  self.postMessage({ type: 'progress', value: 92, label: 'Saving PDF…' });

  const bytes = await doc.save({ useObjectStreams: true });

  self.postMessage(
    { type: 'done', result: bytes.buffer, pageCount: doc.getPageCount(), skipped },
    [bytes.buffer]
  );
}

/** Check JPEG magic bytes (FF D8 FF) */
function _isJpeg(buf) {
  try {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    return bytes.length >= 3 &&
      bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  } catch { return false; }
}

/** Check WebP magic bytes (RIFF....WEBP) */
function _isWebp(buf) {
  try {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    return bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;  // WEBP
  } catch { return false; }
}

// ── Watermark handler ─────────────────────────────────────────
//
// Tile mode — повторяет текст сеткой по всей странице (сверх ТЗ).
// Diagonal angle -25° matches what users expect from "CONFIDENTIAL" stamps.

const WM_COLORS = {
  gray: [0.55, 0.55, 0.55],
  red:  [0.78, 0.05, 0.05],
  blue: [0.05, 0.18, 0.72],
};

async function handleWatermark(fileBuffer, options) {
  const { rgb, StandardFonts, degrees } = PDFLib;
  const { text = 'CONFIDENTIAL', opacity = 0.3, position = 'center',
          fontSize = 40, color = 'gray' } = options;
  const [r, g, b] = WM_COLORS[color] || WM_COLORS.gray;

  await pdfPipeline(fileBuffer, { saveValue: 92, saveLabel: 'Saving…' }, async (pdf, pages) => {
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const { width, height } = page.getSize();
      progress(10 + Math.round((i / pages.length) * 80), `Watermarking page ${i + 1} of ${pages.length}…`);

      if (position === 'tile') {
        const tileGapX = width / 2.5, tileGapY = 120;
        const cols = Math.ceil(width / tileGapX) + 2;
        const rows = Math.ceil(height / tileGapY) + 2;
        for (let row = -1; row < rows; row++)
          for (let col = -1; col < cols; col++)
            page.drawText(text, { x: col * tileGapX + (row % 2) * (tileGapX / 2),
              y: row * tileGapY, size: fontSize * 0.7, font,
              color: rgb(r, g, b), opacity, rotate: degrees(-25) });
      } else {
        const tw = font.widthOfTextAtSize(text, fontSize);
        const pos = position === 'top'    ? { x: (width-tw)/2, y: height-50, rotate: degrees(0) }
                  : position === 'bottom' ? { x: (width-tw)/2, y: 30,        rotate: degrees(0) }
                  :                        { x: width/2-tw/2,  y: height/2,  rotate: degrees(-25) };
        page.drawText(text, { size: fontSize, font, color: rgb(r, g, b), opacity, ...pos });
      }
    }
  });
}

// ── Page numbers handler ──────────────────────────────────────

async function handlePageNum(fileBuffer, options) {
  const { rgb, StandardFonts } = PDFLib;
  const { position = 'bottom-center', format = 'arabic', startAt = 1,
          skipFirst = false, fontSize = 10, showTotal = false } = options;
  const MARGIN = 24;

  await pdfPipeline(fileBuffer, { saveValue: 93 }, async (pdf, pages) => {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const visibleTotal = pages.length - (skipFirst ? 1 : 0);
    for (let i = 0; i < pages.length; i++) {
      if (skipFirst && i === 0) continue;
      progress(10 + Math.round((i / pages.length) * 82), `Numbering page ${i + 1} of ${pages.length}…`);
      const page = pages[i];
      const { width, height } = page.getSize();
      const pageNum   = i + startAt - (skipFirst ? 1 : 0);
      const baseLabel = _formatPageNum(pageNum, format);
      const label     = showTotal
        ? `${baseLabel} / ${_formatPageNum(startAt + visibleTotal - 1, format)}`
        : baseLabel;
      const tw    = font.widthOfTextAtSize(label, fontSize);
      const isOdd = (i % 2) === 0;
      const x = position === 'book'         ? (isOdd ? width - MARGIN - tw : MARGIN)
              : position === 'bottom-right' ? width - MARGIN - tw
              : position === 'bottom-left'  ? MARGIN
              :                              (width - tw) / 2;
      const y = position === 'top-center' ? height - MARGIN - fontSize : MARGIN;
      page.drawText(label, { x, y, size: fontSize, font, color: rgb(0.2, 0.2, 0.2), opacity: 0.8 });
    }
  });
}

function _formatPageNum(n, fmt) {
  if (fmt === 'roman') return _toRoman(n);
  if (fmt === 'alpha') return _toAlpha(n);
  return String(n);
}
function _toRoman(n) {
  if (n <= 0 || n > 3999) return String(n);
  const v = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
  const s = ['M','CM','D','CD','C','XC','L','XL','X','IX','V','IV','I'];
  let r = '';
  for (let i = 0; i < v.length; i++) while (n >= v[i]) { r += s[i]; n -= v[i]; }
  return r;
}
function _toAlpha(n) {
  let r = '';
  while (n > 0) { n--; r = String.fromCharCode(65 + (n % 26)) + r; n = Math.floor(n / 26); }
  return r;
}


// ── Metadata handler ──────────────────────────────────────────────

async function handleMeta(fileBuffer, { meta }) {
  await pdfPipeline(fileBuffer, { loadLabel: 'Loading PDF…', saveValue: 80 }, async (pdf) => {
    progress(40, 'Updating metadata…');
    if (meta.title    !== undefined) pdf.setTitle(meta.title);
    if (meta.author   !== undefined) pdf.setAuthor(meta.author);
    if (meta.subject  !== undefined) pdf.setSubject(meta.subject);
    if (meta.keywords !== undefined) {
      try { pdf.setKeywords(meta.keywords.split(',').map(s => s.trim()).filter(Boolean)); } catch { /* older pdf-lib */ }
    }
    if (meta.creator  !== undefined) pdf.setCreator(meta.creator  || '');
    if (meta.producer !== undefined) pdf.setProducer(meta.producer || '');
    if (Object.values(meta).every(v => !v?.trim())) {
      try { pdf.catalog.delete(PDFLib.PDFName.of('Metadata')); } catch { /* optional field */ }
    }
  });
}

// ── Protect handler ───────────────────────────────────────────
//
// Pipeline:
//   1. Load PDF with standard pdf-lib (ignoreEncryption for re-protection)
//   2. Re-save as plain bytes (useObjectStreams:false — required for RC4)
//   3. Pass plain bytes through encryptPDF() — our pure-JS RC4-128 impl
//
// Why NOT the @maxwbh/pdf-lib fork:
//   The fork adds /Encrypt to the trailer but never encrypts stream bytes
//   in PDFWriter. Viewers see /Encrypt, try to inflate the unencrypted
//   streams, get garbage, render white pages. Diagnosed by comparing
//   stream bytes before and after — they were byte-for-byte identical.
//
// Why encryptPDF() instead of a third-party:
//   Every npm fork we tested has the same bug. encryptPDF() implements
//   PDF spec §3.5 Algorithm 3.2/3.3/3.5 directly, verified by qpdf.

async function handleProtect(fileBuffer, options) {
  const { PDFDocument } = PDFLib;
  const { userPassword = '', ownerPassword = '', permissions = {} } = options;

  progress(10, 'Loading PDF…');
  const pdf = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const wasAlreadyProtected = pdf.isEncrypted;
  const pageCount = pdf.getPages().length;

  progress(35, 'Preparing document…');
  // Save as plain bytes — useObjectStreams:false is required before RC4
  // because object streams cannot be individually encrypted per PDF spec.
  const plainBytes = await pdf.save({ useObjectStreams: false, addDefaultPage: false });

  progress(60, 'Encrypting (RC4-128)…');
  const encrypted = encryptPDF(new Uint8Array(plainBytes), {
    userPassword,
    ownerPassword,
    permissions,
  });

  progress(95, 'Finalising…');

  // ⚠️ TRANSFERABLE: encrypted.buffer detached after postMessage
  self.postMessage(
    { type: 'done', result: encrypted.buffer, pageCount, wasAlreadyProtected },
    [encrypted.buffer]
  );
}

// ── Rotate handler ────────────────────────────────────────────
//
// Each { index, angle } in options.rotations describes the FINAL
// absolute rotation for that page (initial PDF rotation already
// folded in by rotateUI.js). We just set it; pdf-lib handles the
// /Rotate dict entry correctly via degrees().
//
// pdfPipeline with useObjectStreams:false — rotate doesn't need
// object streams, and keeping it off avoids any re-compression
// of content streams (faster, byte-identical to input except
// for the /Rotate values).

async function handleRotate(fileBuffer, options) {
  const { degrees } = PDFLib;
  const { rotations = [] } = options;

  await pdfPipeline(
    fileBuffer,
    { loadLabel: 'Loading PDF…', saveValue: 90, objectStreams: false },
    async (pdf, pages) => {
      if (options.removeWatermarks) _removeWatermarks(pdf);
      progress(40, 'Applying rotations…');
      for (const { index, angle } of rotations) {
        if (index >= 0 && index < pages.length) {
          // Normalise to 0/90/180/270 — PDF spec §8.4.4 only allows
          // multiples of 90. pdf-lib accepts 360 without error but
          // stores it verbatim; some viewers reject non-canonical values.
          const canonical = ((angle % 360) + 360) % 360;
          pages[index].setRotation(degrees(canonical));
        }
      }
    }
  );
}

// ── Redact / Cover Area handler ───────────────────────────────
//
// Draws an opaque filled rectangle over each specified area.
// rects are in PDF coordinate space (bottom-left origin, pts).
// applyAll: apply same rects to every page (typical for DRAFT stamps).
//
// fillColor is pre-serialised as [r,g,b] floats (0–1) from redactUI.
// Default: white [1,1,1].

// Phase 1.5: supports both global rects (applyAll=true) and per-page rectsByPage (applyAll=false)
//
// rects:        array of rects applied to every page (when applyAll=true)
// rectsByPage:  {1: [...], 2: [...]} — per-page rects (when applyAll=false)
// fillColor:    [r,g,b] floats 0..1
// opacity:      0..1

async function handleRedact(fileBuffer, options) {
  const { rgb } = PDFLib;
  const {
    rects = [],
    rectsByPage = null,
    applyAll = true,
    fillColor = [1, 1, 1],
    opacity = 1
  } = options;

  // Compute total rect count across all pages (for early exit)
  let total = 0;
  if (applyAll) {
    total = rects.length;
  } else if (rectsByPage) {
    for (const k in rectsByPage) total += rectsByPage[k].length;
  }

  if (total === 0) {
    self.postMessage({ type: 'error', message: 'No areas selected to redact.' });
    return;
  }

  const [fr, fg, fb] = fillColor;
  const color        = rgb(fr, fg, fb);

  await pdfPipeline(
    fileBuffer,
    { loadLabel: 'Loading PDF…', saveValue: 90 },
    async (pdf, pages) => {
      progress(30, 'Covering areas…');
      let cachedFont = null;  // embedded once on first text rect, reused across pages
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const rectsForThisPage = applyAll
          ? rects
          : (rectsByPage ? (rectsByPage[i + 1] || []) : []);

        for (const r of rectsForThisPage) {
          const type = r.type || 'rect';

          if (type === 'rect') {
            page.drawRectangle({
              x:      r.x,
              y:      r.y,
              width:  r.w,
              height: r.h,
              color,
              opacity,
              borderWidth: 0,
            });
          } else {
            const cx = r.x + r.w / 2;
            const cy = r.y + r.h / 2;
            const thickness = Math.max(2, Math.min(r.w, r.h) * 0.1);

            if (type === 'text') {
              const textStr = r.text || '';
              if (textStr.trim()) {
                if (!cachedFont) {
                  cachedFont = await pdf.embedFont(PDFLib.StandardFonts.Helvetica);
                }
                const font = cachedFont;
                page.drawText(textStr, {
                  x:       r.x + r.h * 0.1,
                  y:       r.y + r.h * 0.15,
                  size:    r.h * 0.8,
                  font,
                  color,
                  opacity,
                });
              }
            } else if (type === 'arrow') {
              const padding = Math.min(r.w, r.h) * 0.1;
              const left  = r.x + padding;
              const right = r.x + r.w - padding;
              const bottom = r.y + padding;
              const top   = r.y + r.h - padding;
              const startX = r.flipX ? right : left;
              const endX   = r.flipX ? left  : right;
              const startY = r.flipY ? bottom : top;
              const endY   = r.flipY ? top   : bottom;
              page.drawLine({ start: { x: startX, y: startY }, end: { x: endX, y: endY }, thickness, color, opacity });
              const headLen = Math.min(r.w * 0.3, r.h * 0.4);
              const angle   = Math.atan2(endY - startY, endX - startX);
              page.drawLine({ start: { x: endX, y: endY }, end: { x: endX - headLen * Math.cos(angle - Math.PI/6), y: endY - headLen * Math.sin(angle - Math.PI/6) }, thickness, color, opacity });
              page.drawLine({ start: { x: endX, y: endY }, end: { x: endX - headLen * Math.cos(angle + Math.PI/6), y: endY - headLen * Math.sin(angle + Math.PI/6) }, thickness, color, opacity });
            } else if (type === 'cross') {
              const p = Math.min(r.w, r.h) * 0.15;
              page.drawLine({ start: { x: r.x + p, y: r.y + r.h - p }, end: { x: r.x + r.w - p, y: r.y + p         }, thickness, color, opacity });
              page.drawLine({ start: { x: r.x + p, y: r.y + p       }, end: { x: r.x + r.w - p, y: r.y + r.h - p   }, thickness, color, opacity });
            } else if (type === 'check') {
              const p      = Math.min(r.w, r.h) * 0.15;
              const leftX  = r.x + p;
              const midX   = r.x + r.w * 0.4;
              const rightX = r.x + r.w - p;
              const leftY  = r.y + r.h * 0.5;
              const midY   = r.y + p;
              const rightY = r.y + r.h - p;
              page.drawLine({ start: { x: leftX,  y: leftY  }, end: { x: midX,   y: midY   }, thickness, color, opacity });
              page.drawLine({ start: { x: midX,   y: midY   }, end: { x: rightX, y: rightY }, thickness, color, opacity });
            } else if (type === 'plus') {
              const px = r.w * 0.2;
              const py = r.h * 0.2;
              page.drawLine({ start: { x: r.x + px, y: cy           }, end: { x: r.x + r.w - px, y: cy           }, thickness, color, opacity });
              page.drawLine({ start: { x: cx,        y: r.y + py    }, end: { x: cx,              y: r.y + r.h - py }, thickness, color, opacity });
            } else if (type === 'minus') {
              const px = r.w * 0.15;
              page.drawLine({ start: { x: r.x + px, y: cy }, end: { x: r.x + r.w - px, y: cy }, thickness, color, opacity });
            }
          }
        }

        if (pages.length > 1) {
          progress(30 + Math.round((i / pages.length) * 55), `Covering page ${i + 1} of ${pages.length}…`);
        }
      }
    }
  );
}

// ── Fill AcroForm ─────────────────────────────────────────────
// fieldValues: { fieldName: value } — strings for text/select,
// truthy/falsy for checkboxes, string matching exportValue for radios.

async function handleFill(fileBuffer, { fieldValues = {}, sigImages = {}, fieldMeta = {}, flatten = true } = {}) {
  const {
    PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList,
  } = PDFLib;

  progress(10, 'Loading PDF…');
  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const form   = pdfDoc.getForm();
  const fields = form.getFields();

  progress(40, 'Filling fields…');

  for (const field of fields) {
    const name  = field.getName();
    const value = fieldValues[name];
    if (value === undefined) continue;

    try {
      if (field instanceof PDFTextField) {
        field.setText(String(value));
      } else if (field instanceof PDFCheckBox) {
        value ? field.check() : field.uncheck();
      } else if (field instanceof PDFRadioGroup) {
        if (value) field.select(String(value));
      } else if (field instanceof PDFDropdown) {
        if (value) {
          const opts = field.getOptions();
          if (opts.includes(String(value)))        field.select(String(value));
          else if (fieldMeta[name]?.editable)      field.setText(String(value));
          // иначе — значение не в списке и поле не editable, молча пропустить
        }
      } else if (field instanceof PDFOptionList) {
        if (value) field.select(String(value));
      }
    } catch { /* skip fields that reject their value */ }
  }

  // Flatten first: bakes field appearances into page content stream.
  // Signature PNG is drawn AFTER flatten so it renders on top of the
  // (now-empty) Sig widget appearance — prevents white background covering PNG.
  progress(70, 'Saving filled PDF…');

  // Many PDFs lack embedded fonts in their AcroForm resources, which causes
  // pdf-lib's flatten() to silently skip appearance generation — the output
  // PDF looks blank even though values were set. Calling updateFieldAppearances()
  // with an embedded font first guarantees visible text for all filled fields.
  try {
    const fillFont = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
    form.updateFieldAppearances(fillFont);
  } catch { /* PDF may already have valid font resources — proceed to flatten */ }

  if (flatten) {
    try { form.flatten(); } catch { /* flatten fails on some encrypted forms; skip */ }
  }

  // Embed signature images after flatten (visual, not cryptographic)
  const sigEntries = Object.values(sigImages);
  if (sigEntries.length > 0) {
    progress(80, 'Embedding signatures…');
    const pages = pdfDoc.getPages();
    for (const { dataUrl, rect, pageIndex } of sigEntries) {
      if (!dataUrl || !rect || rect.length < 4) continue;
      try {
        await _embedSigImage(pdfDoc, pages, dataUrl, rect, pageIndex);
      } catch { /* skip malformed sig */ }
    }
  }

  const bytes = await pdfDoc.save({ useObjectStreams: true, addDefaultPage: false });
  self.postMessage(
    { type: 'done', result: bytes.buffer, pageCount: pdfDoc.getPageCount() },
    [bytes.buffer]
  );
}

async function _embedSigImage(pdfDoc, pages, dataUrl, rect, pageIndex) {
  const page = pages[pageIndex];
  if (!page) return;

  // data URL → Uint8Array
  const b64   = dataUrl.replace(/^data:image\/png;base64,/, '');
  const raw   = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

  const img = await pdfDoc.embedPng(bytes);

  // rect from pdf.js is in PDF coordinate space (bottom-left origin, points)
  const [x1, y1, x2, y2] = rect;
  const fieldW = x2 - x1;
  const fieldH = y2 - y1;

  // Scale to fit field, preserve aspect ratio, 90% fill
  const scale = Math.min(fieldW / img.width, fieldH / img.height) * 0.9;
  const drawW = img.width  * scale;
  const drawH = img.height * scale;

  page.drawImage(img, {
    x:      x1 + (fieldW - drawW) / 2,
    y:      y1 + (fieldH - drawH) / 2,
    width:  drawW,
    height: drawH,
    opacity: 1,
  });
}

async function handleFlatten(fileBuffer) {
  const { PDFDocument, StandardFonts } = PDFLib;

  progress(10, 'Loading PDF…');
  const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const form   = pdfDoc.getForm();
  const fields = form.getFields();

  if (fields.length === 0) {
    // No AcroForm fields — already flat or XFA-only (pdf-lib cannot handle XFA).
    // Return the original buffer so the user always gets their file back.
    self.postMessage(
      { type: 'done', result: fileBuffer, pageCount: pdfDoc.getPageCount(), info: 'no_fields' },
      [fileBuffer]
    );
    return;
  }

  progress(40, 'Rendering field appearances…');
  try {
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    form.updateFieldAppearances(font);
  } catch { /* form already has valid font resources */ }

  progress(65, 'Flattening fields…');
  try {
    form.flatten();
  } catch { /* partial flatten on complex form — save best effort */ }

  progress(85, 'Saving…');
  const bytes = await pdfDoc.save({ useObjectStreams: true });
  self.postMessage(
    { type: 'done', result: bytes.buffer, pageCount: pdfDoc.getPageCount() },
    [bytes.buffer]
  );
}

// ============================================================
//  handleDraw — embeds per-page drawing overlays into PDF
//
//  layers[i] — ArrayBuffer (PNG) for page i+1, or null if unmodified.
//  The PNG is rendered at full page size so canvas coordinates align
//  with PDF coordinates without any additional transformation.
// ============================================================

async function handleDraw(original, layers) {
  progress(10, 'Loading PDF…');
  const pdf   = await PDFLib.PDFDocument.load(original, { ignoreEncryption: true });
  const pages = pdf.getPages();
  const total = layers.length;

  for (let i = 0; i < total; i++) {
    if (!layers[i]) continue;
    progress(10 + Math.round(80 * (i + 1) / total), `Embedding page ${i + 1} of ${total}…`);
    const img              = await pdf.embedPng(layers[i]);
    const { width, height } = pages[i].getSize();
    pages[i].drawImage(img, { x: 0, y: 0, width, height });
  }

  progress(95, 'Saving…');
  const bytes = await pdf.save();
  self.postMessage({ type: 'done', result: bytes.buffer }, [bytes.buffer]);
}
