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

// Default-import + destructure, NOT `import { getDocument } from '...'` —
// pdfjs-dist's legacy Node build is a webpack-bundled CommonJS module, and
// Node's static cjs-module-lexer named-export detection is version-
// dependent: this exact named-import syntax resolves fine on Node 26
// (used during local development) but throws
// "SyntaxError: Named export 'getDocument' not found" on Node 20 (what
// this repo's CI actually runs) — found only because CI caught it, not
// local testing. The default-import form works uniformly across both.
import pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';
import { _p2mdExtractText, _p2mdRender } from './core/pdf2mdCore.js';

const { getDocument } = pdfjsLib;

/**
 * Converts a PDF (file path or raw bytes) to Markdown.
 * @param {string|Uint8Array|ArrayBuffer|Buffer} input — a file path, or
 *   the PDF's raw bytes.
 * @param {{ signal?: AbortSignal }} [options] — optional AbortSignal.
 *   COOPERATIVE cancellation only, checked once per page via
 *   `_p2mdExtractText`'s existing `isCancelled` hook (built for the
 *   browser tool's Cancel button — reused here unchanged): if the signal
 *   is ALREADY aborted when passed in, or becomes aborted during a real
 *   `await` gap between pages, extraction stops and this throws instead of
 *   returning partial Markdown silently. Do NOT rely on this for a hard,
 *   real-time timeout on a CPU-bound-enough PDF — verified directly (a
 *   real 130-page/20MB document) that a `setTimeout`/`AbortSignal.timeout`
 *   scheduled mid-conversion can fail to fire AT ALL until the whole
 *   conversion finishes, because pdf.js's per-page await chain resolves
 *   fast enough to stay entirely in the microtask queue, starving the
 *   timer/macrotask phase for the full duration. For a real, enforced
 *   deadline (e.g. a server processing untrusted uploads), run the
 *   conversion in a `worker_threads` Worker and call `worker.terminate()`
 *   on timeout instead — see `packages/pdf2md-server/convertWorker.js` for
 *   the pattern that actually works, and why this same-thread `signal`
 *   doesn't.
 * @returns {Promise<string>} the rendered Markdown.
 */
export async function pdfToMarkdown(input, { signal } = {}) {
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
    //
    // isEvalSupported: false is REQUIRED, not just defensive — pdfjs-dist
    // is pinned to 3.11.174 (see package.json's comment on why), which is
    // within the affected range of CVE-2024-4367 (GHSA-wgrm-67xf-hhpq,
    // CVSS 8.8): a malicious PDF can trigger arbitrary JS execution via
    // pdf.js's own `eval` use, DEFAULT ON (isEvalSupported defaults to
    // true) if not explicitly disabled. Mozilla's own published workaround
    // for versions before the real fix (4.2.67+, removes eval entirely) is
    // exactly this flag. Verified directly against the GitHub Security
    // Advisory text, not assumed from the CVE title alone.
    isEvalSupported: false,
  });

  let pdfDoc;
  try {
    pdfDoc = await loadingTask.promise;
  } catch (err) {
    // pdf.js throws a real, named PasswordException for both "needs a
    // password" (code 1) and "wrong password" (code 2) — this package has
    // no --password flag in v1, so both cases are equally unsupported.
    // Re-thrown as a plain Error with a clear, actionable message instead
    // of pdf.js's own terse "No password given" / "Incorrect Password".
    if (err?.name === 'PasswordException') {
      throw new Error(
        `${input instanceof Uint8Array || Buffer.isBuffer(input) ? 'This PDF' : input} is password-protected — ` +
        'pdf2md-core does not support decrypting PDFs yet. Remove the password first (e.g. with qpdf ' +
        '--decrypt) and try again.'
      );
    }
    throw err;
  }

  try {
    const blocks = await _p2mdExtractText(pdfDoc, {
      isCancelled: signal ? () => signal.aborted : undefined,
    });
    if (signal?.aborted) {
      throw new Error('pdfToMarkdown: cancelled (signal aborted before extraction finished)');
    }
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
