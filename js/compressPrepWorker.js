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
//  MB even on Maximum. Here each such image is Flate-encoded losslessly
//  (identical pixels once decoded); handleCompress then treats it like
//  any other Flate image under the user's chosen preset.
//
//  Only image XObjects with no /Filter are touched, and only when Flate
//  saves at least 10% (worker.js's own replacement threshold). If none
//  qualify, the ORIGINAL buffer is returned as-is — no re-save.
//
//  Message contract:
//   in  → { file: ArrayBuffer }                               [transferred]
//   out → { type: 'done', result: ArrayBuffer, encoded: number } [transferred]
//         result is the original buffer when encoded === 0.
//         Any failure also answers 'done' with the original buffer and
//         encoded: 0 — this pass must never block a compression.
// ============================================================

importScripts('./vendor/pdf-lib.min.js');

self.onmessage = async (e) => {
  const buffer = e.data.file;
  let out = { result: buffer, encoded: 0 };
  try {
    out = await _encodeRawImages(buffer);
  } catch { /* fall through with the original buffer */ }
  self.postMessage({ type: 'done', ...out }, [out.result]);
};

async function _encodeRawImages(buffer) {
  const { PDFDocument, PDFName, PDFRawStream } = PDFLib;
  const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });

  let encoded = 0;
  for (const [ref, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    if (dict.has(PDFName.of('Filter'))) continue;

    const raw = obj.contents;
    const deflated = pdf.context.flateStream(raw).contents;
    if (deflated.length >= raw.length * 0.9) continue;

    dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    dict.delete(PDFName.of('DecodeParms')); // only meaningful alongside a filter
    pdf.context.assign(ref, PDFRawStream.of(dict, deflated));
    encoded++;
  }

  if (!encoded) return { result: buffer, encoded: 0 };
  const bytes = await pdf.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  return { result: bytes.buffer, encoded };
}
