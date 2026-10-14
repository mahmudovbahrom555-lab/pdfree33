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
//  Message contract:
//   in  → { file: ArrayBuffer }                               [transferred]
//   out → { type: 'done', result: ArrayBuffer, encoded: number, resolved: number } [transferred]
//         result is the original buffer when nothing was changed.
//         Any failure also answers 'done' with the original buffer and
//         encoded: 0 — this pass must never block a compression.
// ============================================================

importScripts('./vendor/pdf-lib.min.js');

self.onmessage = async (e) => {
  const buffer = e.data.file;
  let out = { result: buffer, encoded: 0, resolved: 0 };
  try {
    out = await _encodeRawImages(buffer);
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

async function _encodeRawImages(buffer) {
  const { PDFDocument, PDFName, PDFRawStream, PDFArray, PDFRef } = PDFLib;
  const bytesIn = new Uint8Array(buffer);
  const rawImages = _mayHaveRawImage(bytesIn), dimRefs = _mayHaveIndirectDims(bytesIn);
  if (!rawImages && !dimRefs) return { result: buffer, encoded: 0, resolved: 0 };
  const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
  // Still-encrypted stream bytes are ciphertext: Flate-encoding them would
  // make a reader decrypt compressed bytes. Ciphertext happens not to
  // compress (so the 10% rule below already rejects it), but don't deflate
  // megabytes of it just to find that out.
  if (pdf.isEncrypted) return { result: buffer, encoded: 0, resolved: 0 };

  const resolved = dimRefs ? _resolveImageDims(pdf) : 0;
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

  if (!encoded && !resolved) return { result: buffer, encoded: 0, resolved: 0 };
  const bytes = await pdf.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  return { result: bytes.buffer, encoded, resolved };
}
