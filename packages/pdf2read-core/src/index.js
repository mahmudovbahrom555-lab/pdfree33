// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  @pdfree/pdf2read-core — pdf.js (Node/legacy build) -> the same
//  browser-independent reflow core pdfree.io's own "Read PDF" tool uses
//  (src/core/pdf2readCore.js, synced from the parent repo's
//  js/pdf2readCore.js — see scripts/copy-core.mjs).
//
//  No file this package processes ever leaves the machine it runs on —
//  same guarantee as the browser tool, just running locally instead of in
//  a browser tab.
//
//  v1 limitation, disclosed here and in README.md: an `image`-type block
//  (from a formula-heavy line that can't be rendered as text, or a
//  column-straddling grid that can't be split) carries only a bounding box
//  (`region: {x0,x1,y0,y1}`) in PDF points, never actual pixel data — real
//  cropping needs a rendered `<canvas>`, which plain Node doesn't have.
//  Same tradeoff @pdfree/pdf2md-core already made for embedded images —
//  text/headings/lists/tables are completely unaffected, none of that
//  needs a canvas.
// ============================================================

// Same pdfjs-dist version already verified working on Node 20 by the sibling
// @pdfree/pdf2md-core package (see that package's own src/index.js for the
// full version-bisection history — 5.0.375 is the last version before a
// real regression, confirmed by running its test suite against the exact
// Node 20.20.2 binary CI uses, with the same `--omit=optional` install flag).
// This package makes the identical pdf.js call shape, so the same version
// constraint applies unchanged — not re-litigated here.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { _p2wBuildPageData, _rpBuildPageBlocks } from './core/pdf2readCore.js';

/**
 * Reflows a PDF (file path or raw bytes) into structured reading blocks —
 * headings, paragraphs, list items, tables, and image placeholders (bbox
 * only, no pixel data — see the file header) — one array of blocks per page.
 * @param {string|Uint8Array|ArrayBuffer|Buffer} input — a file path, or the
 *   PDF's raw bytes.
 * @param {{ signal?: AbortSignal }} [options] — optional AbortSignal.
 *   COOPERATIVE cancellation only, checked once per page via
 *   `_p2wBuildPageData`'s own `isCancelled` seam (built for the browser
 *   tool's Cancel button, reused here unchanged): if the signal is ALREADY
 *   aborted when passed in, or becomes aborted during a real `await` gap
 *   between pages, extraction stops and this throws instead of returning
 *   partial output silently. Do NOT rely on this for a hard, real-time
 *   timeout on a CPU-bound-enough PDF — @pdfree/pdf2md-core's own src/index.js
 *   documents a real, verified case (a 130-page/20MB document) where a
 *   same-thread `setTimeout`/`AbortSignal.timeout` scheduled mid-conversion
 *   failed to fire at all until the whole conversion finished, because
 *   pdf.js's per-page await chain stays entirely in the microtask queue,
 *   starving the timer/macrotask phase. For a real, enforced deadline (e.g.
 *   a server processing untrusted uploads), run this in a `worker_threads`
 *   Worker and call `worker.terminate()` on timeout instead — see
 *   `packages/pdf2read-server/convertWorker.js`.
 * @returns {Promise<{ pages: Array<{blocks: object[], scanned: boolean}>, pageCount: number }>}
 *   `pages[i].scanned` is true for a page with no extractable text (e.g. a
 *   scanned image with no OCR text layer) — `blocks` is empty for that page,
 *   not an error; a scanned PDF is a normal, expected input, not a failure.
 */
export async function pdfToReadingBlocks(input, { signal } = {}) {
  const data = await _resolveInput(input);

  const loadingTask = getDocument({
    data,
    useSystemFonts:    false,
    verbosity:         0,
    disableJavaScript: true,
    // No workerSrc configured — pdf.js falls back to running entirely on
    // the main thread ("fake worker"), exactly what a short-lived CLI/script
    // process wants (no benefit to a separate thread for a one-shot call).
    //
    // isEvalSupported: false — defense-in-depth against CVE-2024-4367
    // (GHSA-wgrm-67xf-hhpq); see @pdfree/pdf2md-core's own src/index.js for
    // the fuller history of this flag. Same mitigation, same reasoning,
    // not re-derived here.
    isEvalSupported: false,
  });

  let pdfDoc;
  try {
    pdfDoc = await loadingTask.promise;
  } catch (err) {
    // pdf.js throws a real, named PasswordException for both "needs a
    // password" (code 1) and "wrong password" (code 2) — this package has
    // no --password flag in v1, so both cases are equally unsupported.
    if (err?.name === 'PasswordException') {
      throw new Error(
        `${input instanceof Uint8Array || Buffer.isBuffer(input) ? 'This PDF' : input} is password-protected — ` +
        'pdf2read-core does not support decrypting PDFs yet. Remove the password first (e.g. with qpdf ' +
        '--decrypt) and try again.'
      );
    }
    throw err;
  }

  try {
    const { pageData, median, repeatTextSet, repeatPatternSet } = await _p2wBuildPageData(pdfDoc, {
      isCancelled: signal ? () => signal.aborted : undefined,
    });
    if (signal?.aborted) {
      throw new Error('pdfToReadingBlocks: cancelled (signal aborted before extraction finished)');
    }
    const pages = pageData.map(page => _rpBuildPageBlocks(page, median, repeatTextSet, repeatPatternSet));
    return { pages, pageCount: pdfDoc.numPages };
  } finally {
    // pdfjs-dist 5.x moved teardown onto the loading task itself — see
    // @pdfree/pdf2md-core's own src/index.js for the confirmation that
    // PDFDocumentProxy no longer has .destroy() in this version.
    await loadingTask.destroy();
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
  // rather than Buffer" — it checks the exact constructor, not instanceof).
  if (Buffer.isBuffer(input)) return new Uint8Array(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError('pdfToReadingBlocks: input must be a file path, Uint8Array, ArrayBuffer, or Buffer');
}
