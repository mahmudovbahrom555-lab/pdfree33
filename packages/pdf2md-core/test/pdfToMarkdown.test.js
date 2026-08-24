// SPDX-License-Identifier: AGPL-3.0-only
//
// Real end-to-end tests: proves pdfjs-dist's Node/legacy build produces a
// PDFDocumentProxy-shaped object compatible with pdf2mdCore.js's
// _p2mdExtractText — the one claim this package's whole existence rests on
// and that was NOT yet verified anywhere in the parent repo when this
// package was built (see the pdf2md structural-gap plan). The fake-pdfDoc
// unit coverage for the extraction logic itself (heading/list/table/formula
// classification) already lives in the parent repo's tests/pdf2md.test.js,
// against the same source file (js/pdf2mdCore.js, synced into src/core/ here)
// — deliberately NOT duplicated here to avoid two copies of the same tests
// drifting apart, the exact failure mode this whole refactor was designed
// to avoid. This file tests what's actually new here: the Node/pdfjs-dist
// integration and the public pdfToMarkdown() API surface.
//
// Run: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pdfToMarkdown } from '../src/index.js';

const here    = dirname(fileURLToPath(import.meta.url));
const fixture = name => join(here, '..', '..', '..', 'tests', 'fixtures', 'columns', name);

test('a real 8-page arXiv paper converts to Markdown with the expected title and structure', async () => {
  const md = await pdfToMarkdown(fixture('2608.11433.pdf'));
  assert.ok(md.length > 1000, `expected substantial output, got ${md.length} chars`);
  assert.match(md, /^#{1,6} .*Stigma and Support/m, 'title should render as a heading');
  assert.match(md, /Abstract/i);
  // Real content preserved, not corrupted/truncated mid-word.
  assert.match(md, /Reddit/);
});

test('a real 13-page paper with embedded charts converts without crashing (images gracefully skipped in Node mode)', async () => {
  const md = await pdfToMarkdown(fixture('2608.11694.pdf'));
  assert.ok(md.length > 1000);
  // No Canvas in plain Node -> no image markdown syntax should appear;
  // this is the documented v1 limitation, not a silent failure.
  assert.ok(!md.includes('!['), 'v1 has no canvasFactory — images should be skipped, not referenced');
});

test('pdfToMarkdown accepts a file path (string)', async () => {
  const md = await pdfToMarkdown(fixture('2608.11441.pdf'));
  assert.ok(md.length > 500);
});

test('pdfToMarkdown accepts raw bytes (Buffer)', async () => {
  const buf = await readFile(fixture('2608.11441.pdf'));
  const md  = await pdfToMarkdown(buf);
  assert.ok(md.length > 500);
});

test('pdfToMarkdown accepts raw bytes (Uint8Array)', async () => {
  const buf = await readFile(fixture('2608.11441.pdf'));
  const md  = await pdfToMarkdown(new Uint8Array(buf));
  assert.ok(md.length > 500);
});

test('the same file produces byte-identical output across two independent runs (deterministic, no hidden state leak)', async () => {
  const a = await pdfToMarkdown(fixture('2608.11433.pdf'));
  const b = await pdfToMarkdown(fixture('2608.11433.pdf'));
  assert.equal(a, b);
});

test('an invalid input type throws a clear TypeError, not a cryptic internal one', async () => {
  await assert.rejects(() => pdfToMarkdown(12345), /must be a file path, Uint8Array, ArrayBuffer, or Buffer/);
});

// ── Real-world edge cases (found no fixtures for these existed anywhere in
//    the repo — built small, purpose-specific ones under test/fixtures/) ──

test('a missing file throws a clear filesystem error', async () => {
  await assert.rejects(
    () => pdfToMarkdown('/nonexistent/path/does-not-exist.pdf'),
    /ENOENT/
  );
});

test('a corrupted/non-PDF file throws a clear parse error, not a crash', async () => {
  const fakeBytes = new Uint8Array(Buffer.from('this is not a real pdf file'));
  await assert.rejects(() => pdfToMarkdown(fakeBytes), /Invalid PDF/);
});

test('a password-protected PDF throws a clear, actionable error (v1 has no --password support)', async () => {
  await assert.rejects(
    () => pdfToMarkdown(join(here, 'fixtures', 'password-protected.pdf')),
    /password-protected — pdf2md-core does not support decrypting/
  );
});

test('a PDF with no extractable text (scanned/image-only) does not throw — returns the same graceful "try OCR" message the browser tool shows', async () => {
  const md = await pdfToMarkdown(join(here, 'fixtures', 'no-text-layer.pdf'));
  assert.match(md, /No extractable text was found/);
});

// Regression guard for CVE-2024-4367 (GHSA-wgrm-67xf-hhpq, CVSS 8.8) — pdfjs-dist
// is pinned to 3.11.174, which is within the affected range; `isEvalSupported: false`
// is the documented mitigation (Mozilla's own workaround before the real fix at
// 4.2.67+, which removes the vulnerable eval() call entirely). A structural check
// on the source, not a functional exploit test — deliberately not constructing a
// real CVE-2024-4367 trigger PDF just to prove a negative. If this ever fails, the
// flag was removed from src/index.js — put it back before doing anything else.
test('SECURITY: isEvalSupported: false is set on the getDocument() call (CVE-2024-4367 mitigation)', async () => {
  const src = await readFile(join(here, '..', 'src', 'index.js'), 'utf8');
  assert.match(src, /isEvalSupported:\s*false/, 'isEvalSupported: false must stay set — see CVE-2024-4367');
});

// The `signal` option is COOPERATIVE only (checked once per page) — a real,
// verified limitation, not a guess: an AbortSignal.timeout() scheduled
// mid-conversion can fail to fire at all until the whole conversion
// finishes (pdf.js's per-page await chain stays in the microtask queue,
// starving the timer phase — reproduced on a real 130-page/20MB PDF). The
// one case that DOES reliably work is an already-aborted signal passed in
// before extraction starts — that's what this test covers. Real enforced
// deadlines need worker_threads + terminate() instead — see
// packages/pdf2md-server/convertWorker.js.
test('an already-aborted signal short-circuits before extraction, without silently returning partial output', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => pdfToMarkdown(fixture('2608.11433.pdf'), { signal: controller.signal }),
    /cancelled/
  );
});
