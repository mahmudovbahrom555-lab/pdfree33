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

// pdfjs-dist bumped from 3.11.174 to 5.4.149 as part of the CVE-2024-4367
// clean fix — see the isEvalSupported comment below, which is now defense-
// in-depth rather than the only mitigation. NOT 6.x: 6.3.289 (the actual
// latest at the time of this bump) requires Node >=22.13.0 || >=24 and
// uses Promise.withResolvers() internally, which doesn't exist on Node 20
// — confirmed by actually running this package's test suite under a real
// downloaded Node v20.20.2 binary (matching .github/workflows/deploy.yml's
// pinned CI version exactly), which is hard-pinned to Node 20 for its own
// unrelated reason (wrangler's own Node-version floor — see that workflow
// file's comment on the wrangler 4.86.0 pin). It failed immediately with
// "Promise.withResolvers is not a function". 5.4.149 is the newest release
// whose own package.json still declares Node 20 support (`>=20.16.0 ||
// >=22.3.0`) — re-confirmed against that same real Node 20.20.2 binary,
// all 13 of this package's tests pass. Re-check this ceiling on any future
// pdfjs-dist bump; don't assume the latest release stays Node-20-compatible.
//
// Separately, this version restructured pdf.js's legacy Node build from a
// webpack-bundled CommonJS file (pdf.js) to a genuine ESM file (pdf.mjs).
// The OLD default-import-then-destructure pattern here existed specifically
// to dodge a real, CI-caught Node-version-dependent cjs-module-lexer quirk
// on the CJS build (named-export static detection for CJS modules is a
// heuristic, and it disagreed between Node 20 and 26). That workaround no
// longer applies: a `.mjs` file is unambiguously real ESM to Node's loader
// regardless of Node version — no lexer heuristic is involved at all — so
// the plain named import is not just simpler, it's actually the more
// version-safe form now, not less.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { _p2mdExtractText, _p2mdRender } from './core/pdf2mdCore.js';

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
    // isEvalSupported: false — pdfjs-dist was bumped to 5.4.149 specifically
    // to get a real fix for CVE-2024-4367 (GHSA-wgrm-67xf-hhpq, CVSS 8.8:
    // a malicious PDF could trigger arbitrary JS execution via pdf.js's own
    // `eval` use; GitHub's advisory lists 4.2.67 as the first patched
    // version), which Mozilla fixed for real by removing the eval path
    // entirely — this flag is no longer the ONLY thing standing between a
    // crafted PDF and code execution the way it was on the old pinned
    // 3.11.174. Kept anyway as explicit defense-in-depth (costs nothing,
    // and matches the same flag already set on every pdf.js call site in
    // the browser tool's own js/*.js — see that codebase's own
    // CVE-2024-4367 fix commit for the fuller history).
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
    // pdfjs-dist 5.x moved teardown from the resolved document
    // (`pdfDoc.destroy()`, pdf.js 3.x) onto the loading task itself —
    // `pdfDoc.destroy` no longer exists on PDFDocumentProxy at all (only
    // `.cleanup()` remains there, a lighter-weight operation). Confirmed by
    // inspecting the real resolved object's own method list directly
    // against the installed package, not assumed from a changelog.
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
  // rather than Buffer" — it checks the exact constructor, not
  // instanceof). Found via this package's own real end-to-end test.
  if (Buffer.isBuffer(input)) return new Uint8Array(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError('pdfToMarkdown: input must be a file path, Uint8Array, ArrayBuffer, or Buffer');
}
