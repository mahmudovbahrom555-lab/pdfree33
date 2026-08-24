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
