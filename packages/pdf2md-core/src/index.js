// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  @pdfree/pdf2md-core — pdf.js (Node/legacy build) -> the same
//  browser-independent extraction core pdfree.io's own PDF-to-Markdown
//  tool uses (src/core/pdf2mdCore.js, synced from the parent repo's
//  js/pdf2mdCore.js — see scripts/copy-core.mjs).
//
//  No file this package processes ever leaves the machine it runs on —
//  same guarantee as the browser tool, just running locally instead of
//  in a browser tab. See https://pdfree.io/blog/pdf-to-markdown-benchmark/
//  for real, independently-scored output-quality numbers.
//
//  v1 limitation, disclosed here and in README.md: real embedded-image
//  extraction and the display-formula image-crop feature both need a
//  Canvas implementation, which plain Node doesn't have. Neither is
//  wired up in this version — canvasFactory is intentionally omitted,
//  so _p2mdExtractText degrades gracefully: images are skipped, formulas
//  fall back to the same $...$ text flattening already used for inline
//  math in the browser tool. Text, headings, lists, and tables are
//  unaffected — none of that code path needs a canvas.
// ============================================================

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.js';
import { _p2mdExtractText, _p2mdRender } from './core/pdf2mdCore.js';

/**
 * Converts a PDF (file path or raw bytes) to Markdown.
 * @param {string|Uint8Array|ArrayBuffer|Buffer} input — a file path, or
 *   the PDF's raw bytes.
 * @returns {Promise<string>} the rendered Markdown.
 */
export async function pdfToMarkdown(input) {
  const data = await _resolveInput(input);

  const loadingTask = getDocument({
    data,
    useSystemFonts:    false,
    verbosity:         0,
    disableJavaScript: true,
    // No workerSrc configured — pdf.js falls back to running entirely on
    // the main thread ("fake worker") when it can't spawn a real Worker,
    // which is exactly what a short-lived CLI/script process wants (no
    // benefit to a separate thread for a single one-shot conversion).
    isEvalSupported: false,
  });
  const pdfDoc = await loadingTask.promise;

  try {
    const blocks = await _p2mdExtractText(pdfDoc);
    return _p2mdRender(blocks);
  } finally {
    await pdfDoc.destroy();
  }
}

async function _resolveInput(input) {
  if (typeof input === 'string') {
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(input));
  }
  // Buffer.isBuffer MUST be checked before the generic `instanceof
  // Uint8Array` test below — Node's Buffer is a real Uint8Array subclass,
  // so a plain Buffer silently passes that check unconverted, and pdf.js
  // rejects it at runtime ("Please provide binary data as Uint8Array,
  // rather than Buffer" — it checks the exact constructor, not
  // instanceof). Found via this package's own real end-to-end test.
  if (Buffer.isBuffer(input)) return new Uint8Array(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError('pdfToMarkdown: input must be a file path, Uint8Array, ArrayBuffer, or Buffer');
}
