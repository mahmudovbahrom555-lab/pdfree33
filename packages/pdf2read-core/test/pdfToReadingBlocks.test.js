// SPDX-License-Identifier: AGPL-3.0-only
//
// Real end-to-end tests: proves pdfjs-dist's Node/legacy build produces a
// PDFDocumentProxy-shaped object compatible with pdf2readCore.js's
// _p2wBuildPageData/_rpBuildPageBlocks. Unit coverage for the block-building
// logic itself (heading/list/table/column classification, fake pdfDoc
// fixtures) already lives in the parent repo's
// tests/pdf2read-reconstruct.test.js, against the same source file
// (js/pdf2readCore.js, synced into src/core/ here) — deliberately NOT
// duplicated here, same reasoning @pdfree/pdf2md-core's own test file
// documents for itself. This file tests what's actually new here: the
// Node/pdfjs-dist integration and the public pdfToReadingBlocks() API.
//
// Run: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pdfToReadingBlocks } from '../src/index.js';

const here    = dirname(fileURLToPath(import.meta.url));
const fixture = name => join(here, '..', '..', '..', 'tests', 'fixtures', 'columns', name);
// Reused from the sibling package rather than duplicating the same bytes —
// these are generic edge-case fixtures (no-text-layer, password-protected),
// not specific to Markdown output.
const pdf2mdFixture = name => join(here, '..', '..', 'pdf2md-core', 'test', 'fixtures', name);

test('a real 8-page arXiv paper reflows with the expected title heading and real structure', async () => {
  const { pages, pageCount } = await pdfToReadingBlocks(fixture('2608.11433.pdf'));
  assert.equal(pageCount, pages.length);
  const allBlocks = pages.flatMap(p => p.blocks);
  assert.ok(allBlocks.length > 10, `expected substantial structure, got ${allBlocks.length} blocks`);
  const firstHeading = allBlocks.find(b => b.type === 'heading');
  assert.ok(firstHeading, 'expected at least one heading block');
  assert.match(firstHeading.text, /Stigma and Support/);
  assert.ok(allBlocks.some(b => /Abstract/i.test(b.text || '')), 'expected an Abstract section');
  // Real content preserved, not corrupted/truncated mid-word.
  assert.ok(allBlocks.some(b => /Reddit/.test(b.text || '')));
});

test('a real 13-page paper with embedded charts converts without crashing (images become bbox-only placeholders in Node mode)', async () => {
  const { pages } = await pdfToReadingBlocks(fixture('2608.11694.pdf'));
  const allBlocks = pages.flatMap(p => p.blocks);
  assert.ok(allBlocks.length > 10);
  // No Canvas in plain Node -> any image block must have a region (bbox),
  // never pixel data — this is the documented v1 limitation, not a silent
  // failure or a crash.
  for (const b of allBlocks) {
    if (b.type === 'image') {
      assert.ok(b.region && typeof b.region.x0 === 'number', 'image block must carry a bbox');
      assert.ok(!('dataUrl' in b) && !('src' in b), 'v1 has no canvas — image blocks must not carry pixel data');
    }
  }
});

test('pdfToReadingBlocks accepts a file path (string)', async () => {
  const { pages } = await pdfToReadingBlocks(fixture('2608.11441.pdf'));
  assert.ok(pages.flatMap(p => p.blocks).length > 5);
});

test('pdfToReadingBlocks accepts raw bytes (Buffer)', async () => {
  const buf = await readFile(fixture('2608.11441.pdf'));
  const { pages } = await pdfToReadingBlocks(buf);
  assert.ok(pages.flatMap(p => p.blocks).length > 5);
});

test('pdfToReadingBlocks accepts raw bytes (Uint8Array)', async () => {
  const buf = await readFile(fixture('2608.11441.pdf'));
  const { pages } = await pdfToReadingBlocks(new Uint8Array(buf));
  assert.ok(pages.flatMap(p => p.blocks).length > 5);
});

test('the same file produces byte-identical block structure across two independent runs (deterministic, no hidden state leak)', async () => {
  const a = await pdfToReadingBlocks(fixture('2608.11433.pdf'));
  const b = await pdfToReadingBlocks(fixture('2608.11433.pdf'));
  assert.deepEqual(a, b);
});

test('an invalid input type throws a clear TypeError, not a cryptic internal one', async () => {
  await assert.rejects(() => pdfToReadingBlocks(12345), /must be a file path, Uint8Array, ArrayBuffer, or Buffer/);
});

// ── Real-world edge cases ───────────────────────────────────────────────

test('a missing file throws a clear filesystem error', async () => {
  await assert.rejects(
    () => pdfToReadingBlocks('/nonexistent/path/does-not-exist.pdf'),
    /ENOENT/
  );
});

test('a corrupted/non-PDF file throws a clear parse error, not a crash', async () => {
  const fakeBytes = new Uint8Array(Buffer.from('this is not a real pdf file'));
  await assert.rejects(() => pdfToReadingBlocks(fakeBytes), /Invalid PDF/);
});

test('a password-protected PDF throws a clear, actionable error (v1 has no --password support)', async () => {
  await assert.rejects(
    () => pdfToReadingBlocks(pdf2mdFixture('password-protected.pdf')),
    /password-protected — pdf2read-core does not support decrypting/
  );
});

test('a PDF with no extractable text (scanned/image-only) does not throw — every page reports scanned:true with empty blocks', async () => {
  const { pages } = await pdfToReadingBlocks(pdf2mdFixture('no-text-layer.pdf'));
  assert.ok(pages.length > 0);
  for (const page of pages) {
    assert.equal(page.scanned, true);
    assert.deepEqual(page.blocks, []);
  }
});

// Regression guard for CVE-2024-4367 (GHSA-wgrm-67xf-hhpq, CVSS 8.8) — same
// mitigation @pdfree/pdf2md-core's own test file guards, applied to this
// package's own getDocument() call site instead.
test('SECURITY: isEvalSupported: false is set on the getDocument() call (CVE-2024-4367 mitigation)', async () => {
  const src = await readFile(join(here, '..', 'src', 'index.js'), 'utf8');
  assert.match(src, /isEvalSupported:\s*false/, 'isEvalSupported: false must stay set — see CVE-2024-4367');
});

// The `signal` option is COOPERATIVE only (checked once per page) — see
// @pdfree/pdf2md-core's own src/index.js for the full, verified explanation
// of why a same-thread AbortSignal.timeout() is not a reliable deadline for
// a CPU-bound-enough PDF. Real enforced deadlines need worker_threads +
// terminate() instead — see packages/pdf2read-server/convertWorker.js.
test('an already-aborted signal short-circuits before extraction, without silently returning partial output', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => pdfToReadingBlocks(fixture('2608.11433.pdf'), { signal: controller.signal }),
    /cancelled/
  );
});
