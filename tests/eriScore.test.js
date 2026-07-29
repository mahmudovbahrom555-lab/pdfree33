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
const { dissect } = await import('../js/eriAnatomy.js');

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

// ── Synthetic fixtures for the two v0.2.1/v0.2.2 anatomy.py changes ────────
// Neither of the two existing anatomy.py changes (NFC normalization,
// gridSpan-aware Tbl.regular) is exercised by ANY of the 7 real corpus
// fixtures above — confirmed by running Python's evaluate_structural() over
// the entire Atlas_DR corpus and finding zero "irregular row widths"
// findings anywhere. Cross-language parity against a fixture that never
// takes the new code path proves nothing about the port, so these two build
// a minimal word/document.xml directly (the only part eriAnatomy.js reads).
async function buildMinimalDocx(bodyXml) {
  const zip = new JSZip();
  zip.file('word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
    `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
    `<w:body>${bodyXml}</w:body></w:document>`);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

console.log('\neriScore.js / eriAnatomy.js — synthetic fixtures for the NFC + gridSpan port');

await testAsync('gridSpan-aware Tbl.regular: a row whose merged-cell total disagrees with the rest is irregular', async () => {
  // 3 columns nominally: header + 1 normal body row (each 3 plain <w:tc>,
  // effective width 3) + 1 row with a single <w:tc> and no gridSpan
  // (effective width 1) — the mismatch (3 vs 1) is exactly what
  // anatomy.py's Tbl.regular is meant to catch; a real converter bug this
  // shape has actually appeared as (a truncated/malformed row after a
  // page-split, not a deliberately merged summary row spanning the full
  // width, which correctly stays "regular" — see anatomy.py's comment on
  // why gridSpan must sum to the SAME total, not just "any span present").
  const tc = t => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
  const buf = await buildMinimalDocx(
    `<w:tbl>` +
    `<w:tr>${tc('Product')}${tc('Quantity')}${tc('Price')}</w:tr>` +
    `<w:tr>${tc('Widget')}${tc('10')}${tc('19.99')}</w:tr>` +
    `<w:tr>${tc('Note about this shipment only, not a real 3-column data row')}</w:tr>` +
    `</w:tbl>`
  );
  const a = await dissect(buf);
  if (a.parseError) throw new Error(`failed to parse: ${a.parseError}`);
  if (a.tables.length !== 1) throw new Error(`expected 1 table, got ${a.tables.length}`);
  if (a.tables[0].regular !== false) {
    throw new Error(`expected regular === false (row widths 3,3,1 disagree), got ${a.tables[0].regular}`);
  }

  const r = await evaluateStructural(buf);
  if (r.components.tables !== 0.9) {
    throw new Error(`expected tables === 0.9 (1 irregular table, mult = max(0.7, 1-0.1*1)), got ${r.components.tables}`);
  }
  if (!r.findings.tables.some((f) => f.includes('irregular row widths'))) {
    throw new Error('expected an irregular-row-widths finding, got: ' + JSON.stringify(r.findings.tables));
  }
});

await testAsync('a merged FULL-width row (gridSpan sums match) stays regular — not every merged cell is a defect', async () => {
  // Same 3-column table, but the merged row spans all 3 columns
  // (gridSpan=3 on its one cell) — effective width 3, matching the two
  // normal rows (3 plain cells = width 3 too). This is the "regular"
  // control case anatomy.py's docstring calls out: a well-formed merged
  // header/footer whose total width still matches the rest of the grid
  // costs nothing extra to insert a plain row into, and must NOT be
  // penalized just because a gridSpan attribute is present somewhere.
  const tc = (t, span) => span
    ? `<w:tc><w:tcPr><w:gridSpan w:val="${span}"/></w:tcPr><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`
    : `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
  const buf = await buildMinimalDocx(
    `<w:tbl>` +
    `<w:tr>${tc('Product')}${tc('Quantity')}${tc('Price')}</w:tr>` +
    `<w:tr>${tc('Widget')}${tc('10')}${tc('19.99')}</w:tr>` +
    `<w:tr>${tc('Full-width footer note spanning all three columns evenly', 3)}</w:tr>` +
    `</w:tbl>`
  );
  const a = await dissect(buf);
  if (a.tables[0].regular !== true) {
    throw new Error(`expected regular === true (row widths 3,3,3 all match), got ${a.tables[0].regular}`);
  }
  const r = await evaluateStructural(buf);
  if (r.components.tables !== 1.0) {
    throw new Error(`expected tables === 1.0 (no irregular-width penalty), got ${r.components.tables}`);
  }
});

await testAsync('NFC normalization: NFD-decomposed text (combining marks) reads identical to its NFC form', async () => {
  // 'é' as NFD is the letter 'e' (U+0065) + a combining acute accent
  // (U+0301) — two code points. A converter reading a decomposed-Unicode
  // source PDF can pass this straight through into <w:t> (confirmed
  // directly on pdf2docx per anatomy.py's v0.2.2 comment). Without NFC
  // normalization at extraction, this paragraph's text would differ from
  // its composed form even though they render identically.
  const nfd = 'Café also has a déjà-vu accent, twice decomposed';
  const nfc = nfd.normalize('NFC');
  if (nfd === nfc) throw new Error('test fixture is broken: NFD and NFC forms must differ as authored');
  const buf = await buildMinimalDocx(`<w:p><w:r><w:t>${nfd}</w:t></w:r></w:p>`);
  const a = await dissect(buf);
  if (a.paras[0].text !== nfc) {
    throw new Error(`expected extracted text normalized to NFC form, got a different string ` +
      `(length ${a.paras[0].text.length} vs expected ${nfc.length})`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
