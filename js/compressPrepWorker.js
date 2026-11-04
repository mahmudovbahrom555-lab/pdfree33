// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  compressPrepWorker.js — lossless pre-pass for Compress PDF.
//
//  Deliberately NOT part of worker.js (off-limits per CLAUDE.md). Same
//  pattern as js/splitWorker.js / js/resizeWorker.js: a standalone
//  classic worker driven by js/processor.js, run BEFORE the shared
//  worker's handleCompress.
//
//  Why: worker.js's _recompressImages only handles images that are
//  already JPEG- or Flate-encoded; an image stored with NO /Filter (raw
//  pixels) is skipped as "unsupported", and _repackFlateStreams only
//  touches streams that are already Flate. So an uncompressed image —
//  the easiest possible win — left the file untouched on every preset:
//  a real 6.3 MB scan (1275×1650 RGB, no filter) compressed 6.31 → 6.31
//  MB even on Maximum. Here such an image is Flate-encoded losslessly
//  (identical pixels once decoded).
//
//  Also: an image whose /Width, /Height or /BitsPerComponent is given by
//  reference ("/Width 10 0 R" — legal, written by some scanners) made
//  handleCompress fail outright on dict.get(…)?.asNumber() (worker.js,
//  off-limits). Those values are resolved to plain numbers here first —
//  the same values, so the PDF means exactly the same. Found by the
//  nightly robustness run (a real scanned PDF, 2026-10-14).
//
//  Only raw images handleCompress will then skip untouched qualify — those
//  whose resolved /ColorSpace is an array (ICC, Indexed…); see the guard in
//  _encodeRawImages for why plain DeviceRGB/DeviceGray ones must stay raw.
//  Encoding happens only when Flate saves at least 10%. If nothing
//  qualifies, the ORIGINAL buffer is returned as-is — no re-save.
//
//  And (Standard/Maximum — `stripXmp`): XMP metadata on objects other than
//  the catalog. handleCompress removes only the catalog's /Metadata;
//  InDesign and Photoshop put XMP on each placed image too — editing history,
//  often unfiltered: 12.2 of 29.5 MB left in a Maximum output, 826 streams in
//  another (large real PDFs, 2026-11-04). The keys AND the streams go —
//  pdf-lib writes unreferenced objects, so dropping the key alone saves
//  nothing. Nothing on the page depends on XMP. Then every object no longer
//  reachable from the trailer goes too: the two 5.5 MB XMP streams of that
//  first file were referenced by nothing at all (left by earlier edits),
//  invisible to any reader, but pdf-lib writes every object it parsed.
//
//  Message contract:
//   in  → { file: ArrayBuffer, stripXmp: boolean }             [transferred]
//   out → { type: 'done', result: ArrayBuffer, encoded: number, resolved: number, xmp: number } [transferred]
//         result is the original buffer when nothing was changed.
//         Any failure also answers 'done' with the original buffer and
//         encoded: 0 — this pass must never block a compression.
// ============================================================

importScripts('./vendor/pdf-lib.min.js');

self.onmessage = async (e) => {
  const buffer = e.data.file;
  let out = { result: buffer, encoded: 0, resolved: 0, xmp: 0 };
  try {
    out = await _encodeRawImages(buffer, !!e.data.stripXmp);
  } catch { /* fall through with the original buffer */ }
  self.postMessage({ type: 'done', ...out }, [out.result]);
};

// Cheap byte scan run before the full parse: does any image XObject dict lack
// a /Filter? Parsing costs scale with object count, not bytes — a 1500-page
// text PDF (67k objects, no images) cost ~4 s here for nothing. Stream dicts
// can't live inside compressed object streams, so every image dict is plain
// text in the file. Wrong in either direction is safe: a false "yes" just
// costs the parse (the old behaviour), a false "no" only forgoes savings.
const _IMAGE = [0x2f, 0x49, 0x6d, 0x61, 0x67, 0x65]; // "/Image"
const _DELIM = new Set([0x20, 0x0a, 0x0d, 0x09, 0x0c, 0x00, 0x2f, 0x3e, 0x3c, 0x5b, 0x5d, 0x28, 0x29, 0x25]);
const _WINDOW = 2048;

function _mayHaveRawImage(bytes) {
  const n = bytes.length;
  for (let i = bytes.indexOf(0x2f); i !== -1 && i <= n - 7; i = bytes.indexOf(0x2f, i + 1)) {
    let hit = true;
    for (let k = 1; k < 6; k++) if (bytes[i + k] !== _IMAGE[k]) { hit = false; break; }
    if (!hit || !_DELIM.has(bytes[i + 6])) continue; // skip /ImageB /ImageC /ImageI (ProcSet)
    // The dict around the hit: back to its "<<", forward to "stream"
    const from = Math.max(0, i - _WINDOW), to = Math.min(n, i + _WINDOW);
    const text  = String.fromCharCode.apply(null, bytes.subarray(from, to));
    const start = text.lastIndexOf('<<', i - from);
    const end   = text.indexOf('stream', i - from);
    if (start === -1 || end === -1) return true; // can't tell — let the parse decide
    if (!text.slice(start, end).includes('/Filter')) return true;
  }
  return false;
}

// Same cheap scan for "/Width 10 0 R" (or /Height, /BitsPerComponent): a
// size given by reference. Text-level, so a false "yes" only costs a parse.
const _DIM_REF = /\/(?:Width|Height|BitsPerComponent)\s+\d+\s+\d+\s+R\b/;
function _mayHaveIndirectDims(bytes) {
  // decoded piecewise (no 100 MB string for a big file), overlapping so a
  // match across a chunk edge isn't lost; TextDecoder, not
  // String.fromCharCode.apply — a 1 MB argument list overflows the stack
  const CHUNK = 1 << 20, latin1 = new TextDecoder('latin1');
  for (let i = 0; i < bytes.length; i += CHUNK - 64) {
    if (_DIM_REF.test(latin1.decode(bytes.subarray(i, Math.min(bytes.length, i + CHUNK))))) return true;
  }
  return false;
}

// Plain numbers for an image's /Width, /Height, /BitsPerComponent given by
// reference. Returns how many dicts changed.
function _resolveImageDims(pdf) {
  const { PDFName, PDFRawStream, PDFRef, PDFNumber } = PDFLib;
  let changed = 0;
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    let touched = false;
    for (const key of ['Width', 'Height', 'BitsPerComponent']) {
      const v = dict.get(PDFName.of(key));
      if (!(v instanceof PDFRef)) continue;
      const num = pdf.context.lookup(v);
      if (num instanceof PDFNumber) { dict.set(PDFName.of(key), num); touched = true; }
    }
    if (touched) changed++;
  }
  return changed;
}

// Cheap scan: "/Metadata n 0 R" twice or more in the file's plain text — the
// catalog's and another object's (a reference: the XMP stream's own
// "/Type /Metadata" isn't one). Image dicts are stream dicts, never in
// object streams, so an image's XMP is always seen; a false "no" (the
// catalog's key compressed away) only forgoes savings.
const _METADATA = /\/Metadata\s+\d+\s+\d+\s+R\b/g;
function _mayHaveObjectXmp(bytes) {
  const CHUNK = 1 << 20, latin1 = new TextDecoder('latin1');
  let seen = 0;
  for (let i = 0; i < bytes.length; i += CHUNK - 64) {
    const part = latin1.decode(bytes.subarray(i, Math.min(bytes.length, i + CHUNK)));
    // a match in the 64-byte overlap is seen twice — counted only in the chunk it starts in
    for (const m of part.matchAll(_METADATA)) if (i === 0 || m.index >= 64) seen++;
    if (seen >= 2) return true;
  }
  return false;
}

// Removes /Metadata from every object but the catalog, then every object
// the trailer no longer reaches. Returns how many XMP keys were removed.
function _stripObjectXmp(pdf) {
  const { PDFName, PDFDict, PDFArray, PDFRawStream, PDFRef } = PDFLib;
  const key = PDFName.of('Metadata');
  const catalogXmp = pdf.catalog.get(key);
  const gone = new Set();
  // at any depth: InDesign hangs a placed image's XMP on the marked-content
  // properties inside a page's /Resources (/Properties /MC0 << /Metadata … >>)
  const strip = (v, top) => {
    const dict = v instanceof PDFRawStream ? v.dict : v;
    if (dict instanceof PDFDict) {
      if (!top && dict.has(key)) {
        const ref = dict.get(key);
        dict.delete(key);
        if (ref instanceof PDFRef && ref !== catalogXmp) gone.add(ref);
      }
      for (const [, x] of dict.entries()) if (!(x instanceof PDFRef)) strip(x, false);
    } else if (v instanceof PDFArray) {
      for (const x of v.asArray()) if (!(x instanceof PDFRef)) strip(x, false);
    }
  };
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (obj === pdf.catalog) {   // its own XMP stays (handleCompress's, by preset) — its nested dicts don't
      for (const [, x] of obj.entries()) if (!(x instanceof PDFRef)) strip(x, false);
      continue;
    }
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Type'))?.toString() === '/Metadata') continue;
    strip(obj, false);
  }
  for (const ref of gone) pdf.context.delete(ref);
  _dropUnreachable(pdf);
  return gone.size;
}

// Deletes every indirect object the trailer (Root, Info, Encrypt) doesn't
// reach — nothing a reader can show depends on one.
function _dropUnreachable(pdf) {
  const { PDFRef, PDFDict, PDFArray, PDFRawStream } = PDFLib;
  const ctx = pdf.context, seen = new Set(), todo = [];
  const visit = v => {
    if (v instanceof PDFRef) { if (!seen.has(v)) { seen.add(v); todo.push(ctx.lookup(v)); } }
    else if (v instanceof PDFDict) for (const [, x] of v.entries()) visit(x);
    else if (v instanceof PDFArray) for (const x of v.asArray()) visit(x);
    else if (v instanceof PDFRawStream) visit(v.dict);
  };
  const { Root, Info, Encrypt } = ctx.trailerInfo;
  [Root, Info, Encrypt].forEach(visit);
  while (todo.length) visit(todo.pop());
  let dropped = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref)) { ctx.delete(ref); dropped++; }
  return dropped;
}

async function _encodeRawImages(buffer, stripXmp = false) {
  const { PDFDocument, PDFName, PDFRawStream, PDFArray, PDFRef, ParseSpeeds } = PDFLib;
  const bytesIn = new Uint8Array(buffer);
  const rawImages = _mayHaveRawImage(bytesIn), dimRefs = _mayHaveIndirectDims(bytesIn);
  const objectXmp = stripXmp && _mayHaveObjectXmp(bytesIn);
  if (!rawImages && !dimRefs && !objectXmp) return { result: buffer, encoded: 0, resolved: 0, xmp: 0 };
  // No yielding while parsing or writing: pdf-lib pauses every 100 objects
  // (load) and 50 (save) to keep a page responsive, but this is a worker and
  // each pause is a timer — on ~14,000 objects that alone cost seconds. The
  // bytes written are identical; only the pauses go.
  const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false, parseSpeed: ParseSpeeds.Fastest });
  // Still-encrypted stream bytes are ciphertext: Flate-encoding them would
  // make a reader decrypt compressed bytes. Ciphertext happens not to
  // compress (so the 10% rule below already rejects it), but don't deflate
  // megabytes of it just to find that out.
  if (pdf.isEncrypted) return { result: buffer, encoded: 0, resolved: 0, xmp: 0 };

  const resolved = dimRefs ? _resolveImageDims(pdf) : 0;
  const xmp = objectXmp ? _stripObjectXmp(pdf) : 0;
  let encoded = 0;
  for (const [ref, obj] of rawImages ? pdf.context.enumerateIndirectObjects() : []) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    if (dict.has(PDFName.of('Filter'))) continue;

    // Only images handleCompress will then LEAVE ALONE: its first guard skips
    // any Flate image whose resolved /ColorSpace is a PDFArray (ICC, Indexed,
    // Separation…), so this lossless encoding is exactly what ships. Plain
    // DeviceRGB/DeviceGray raw images stay raw, as before this pass existed.
    // History: the first version also encoded those, and handleCompress
    // (before its own 2026-09-29 revert/colour-space fix) turned them into
    // striped garbage in production. That fix makes them safe to hand over
    // now, but widening this pass is a separate, deliberately untaken step.
    let cs = dict.get(PDFName.of('ColorSpace'));
    if (cs instanceof PDFRef) cs = pdf.context.lookup(cs);
    if (!(cs instanceof PDFArray)) continue;

    const raw = obj.contents;
    const deflated = pdf.context.flateStream(raw).contents;
    if (deflated.length >= raw.length * 0.9) continue;

    dict.set(PDFName.of('ColorSpace'), cs); // resolved, so handleCompress's array guard sees it
    dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    dict.delete(PDFName.of('DecodeParms')); // only meaningful alongside a filter
    pdf.context.assign(ref, PDFRawStream.of(dict, deflated));
    encoded++;
  }

  if (!encoded && !resolved && !xmp) return { result: buffer, encoded: 0, resolved: 0, xmp: 0 };
  const bytes = await pdf.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: Infinity });
  return { result: bytes.buffer, encoded, resolved, xmp };
}
