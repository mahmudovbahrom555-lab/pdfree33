// tests/eriScore.test.js — Cross-language parity tests for js/eriScore.js
//
// Every pinned value below was computed by running Python's
// eri_core.evaluate_structural() (Atlas_DR repo) on the exact same .docx
// fixture in tests/fixtures/eri/ — this is the regression net that keeps
// the JS port honest against silent drift from its Python source of truth
// (see eriScore.js's header comment for why that matters: an earlier,
// unchecked JS port of this same logic caused a real scoring bug once).
//
// Run: node tests/eriScore.test.js

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import JSZip from 'jszip';
import { DOMParser as XmldomParser } from '@xmldom/xmldom';

// eriAnatomy.js is written for the browser: it awaits loadJSZip() (which
// short-circuits if window.JSZip already exists) and calls the global
// DOMParser. Providing both here means the exact same code path runs in
// Node as in a browser -- not a separate mock implementation.
global.window = { JSZip };
global.document = { createElement: () => ({}), head: { appendChild: () => {} } };
global.DOMParser = XmldomParser;

const { evaluateStructural } = await import('../js/eriScore.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures', 'eri');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const TOLERANCE = 0.15; // same tolerance as Atlas_DR's tests/test_corpus_regression.py

function loadFixture(name) {
  const buf = readFileSync(path.join(FIXTURES, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// file -> pinned ERI, computed via Python's evaluate_structural() on the
// identical fixture (see the PR description for the exact command run).
const PINNED = {
  '001_reference.docx':   100.0,
  '002_libreoffice.docx':  46.3,
  '004_pdf2docx.docx':     75.1,
  '004_libreoffice.docx':  55.0,
  '014_pdf2docx.docx':     94.6,
  '014_libreoffice.docx':  55.0,
  '013_pdf2docx.docx':     90.1,
};

console.log('eriScore.js — cross-language parity vs. Python eri_core');
for (const [file, expected] of Object.entries(PINNED)) {
  await testAsync(`${file}: ERI matches pinned Python value`, async () => {
    const result = await evaluateStructural(loadFixture(file));
    if (result.error) throw new Error(`failed to parse: ${result.error}`);
    const diff = Math.abs(result.eri - expected);
    if (diff > TOLERANCE) {
      throw new Error(`ERI drifted to ${result.eri}, expected ${expected} ± ${TOLERANCE}`);
    }
  });
}

console.log('\neriScore.js — mechanism checks (not just the final number)');

await testAsync('002_libreoffice.docx: paragraphs channel reflects the text-box trap', async () => {
  const r = await evaluateStructural(loadFixture('002_libreoffice.docx'));
  if (r.components.paragraphs > 0.05) {
    throw new Error(`expected paragraphs ~0 (text-box trap), got ${r.components.paragraphs}`);
  }
  if (!r.findings.paragraphs.some((f) => f.includes('trapped in text boxes'))) {
    throw new Error('expected a text-box-trap finding, got: ' + JSON.stringify(r.findings.paragraphs));
  }
});

await testAsync('004_pdf2docx.docx: tables channel reflects the layout-grid strip-table penalty', async () => {
  const r = await evaluateStructural(loadFixture('004_pdf2docx.docx'));
  if (r.components.tables >= 0.99) {
    throw new Error(`expected tables < 1.0 (layout-grid penalty), got ${r.components.tables}`);
  }
  if (!r.findings.tables.some((f) => f.includes('layout-by-grid'))) {
    throw new Error('expected a layout-by-grid finding, got: ' + JSON.stringify(r.findings.tables));
  }
});

await testAsync('014_pdf2docx.docx: RTL fragmentation fix keeps flow high (not falsely penalized)', async () => {
  const r = await evaluateStructural(loadFixture('014_pdf2docx.docx'));
  if (r.components.flow < 0.8) {
    throw new Error(`expected flow >= 0.8 (RTL-aware terminal-punctuation check), got ${r.components.flow}`);
  }
});

await testAsync('013_pdf2docx.docx: structural mode does NOT penalize the (real) paragraph merge', async () => {
  const r = await evaluateStructural(loadFixture('013_pdf2docx.docx'));
  if (r.components.paragraphs !== 1.0) {
    throw new Error(`expected paragraphs === 1.0 (no_merge_pairs is profile-only, a no-op in ` +
      `structural mode on the Python side too), got ${r.components.paragraphs}`);
  }
});

await testAsync('custom weights are normalized the same way as Python', async () => {
  const buf = loadFixture('001_reference.docx');
  const withWeights = await evaluateStructural(buf, { tables: 3, paragraphs: 1, flow: 0 });
  // All 3 components are 1.0 on a clean reference doc regardless of weights,
  // so this only exercises that normalize doesn't throw and still yields 100.
  if (withWeights.eri !== 100.0) {
    throw new Error(`expected 100.0 on a clean reference doc, got ${withWeights.eri}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
