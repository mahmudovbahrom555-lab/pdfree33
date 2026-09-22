// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/docx2pdf.e2e.mjs — real-browser regression test for a
//  "Malformed table row, a cell is undefined" crash in the Word→PDF tool
//  (js/docxToPdfCore.js).
//
//  Found via a real end-user bug report (error ID DOCX2PDF-8490): a real
//  DOCX with tables containing merged cells (Word's gridSpan/vMerge, i.e.
//  colspan/rowspan once docx-preview renders them as real HTML) crashed
//  pdfmake's table renderer. Root cause: parseTable() in docxToPdfCore.js
//  used to assume every <tr> has the same number of <td> children as the
//  first row — true for a plain table, false the instant any row has a
//  merged cell, since HTML simply omits a <td> for a cell covered by an
//  earlier row's rowSpan (and a colSpan cell's row has fewer <td>s than
//  the table's true column count). Fixed by walking the table as a real
//  grid, inserting pdfmake's own documented {} placeholder for spanned
//  positions.
//
//  Uses a small synthetic fixture (not the real reporter's file, which
//  contains someone else's personal document) that reproduces the same
//  structural pattern: one row with a colSpan cell, and a colSpan+rowSpan
//  cell combined — the exact shape that broke.
//
//  Requires: dist/ already built (`python3 scripts/build.py`) and served
//  at PDFREE_BASE_URL (default http://localhost:8934).
//
//  Run: node tests/e2e/docx2pdf.e2e.mjs
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL  = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const MERGED_CELLS_DOCX = path.join(__dirname, '..', 'fixtures', 'docx2pdf_merged_cells.docx');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe: (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
  };
}

const BLOB_HOOK = () => {
  window.__blob = null;
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) { if (blob instanceof Blob) window.__blob = blob; return orig(blob); };
};

console.log(`\ndocx2pdf E2E — a table with merged cells (colspan/rowspan) doesn't crash pdfmake (real browser, ${BASE_URL}):`);

let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  console.error('Could not launch Chromium — run `npx playwright install --with-deps chromium` first.');
  console.error(e.message);
  process.exit(1);
}

await test('a DOCX table with a colSpan cell and a colSpan+rowSpan cell converts without "Malformed table row"', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  try {
    await page.addInitScript(BLOB_HOOK);
    await page.goto(`${BASE_URL}/word-to-pdf/`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', MERGED_CELLS_DOCX);
    await page.waitForTimeout(500);
    await page.click('#mergeBtn');

    let result = null, toastText = null;
    for (let i = 0; i < 60; i++) {
      result = await page.evaluate(() => window.__blob ? { size: window.__blob.size, type: window.__blob.type } : null).catch(() => null);
      if (result) break;
      toastText = await page.locator('#toast').textContent().catch(() => null);
      if (toastText && toastText.trim()) break;
      await page.waitForTimeout(500);
    }

    if (!result) {
      throw new Error(`Expected a downloaded PDF, got none. Toast: ${toastText || '(empty)'}. Console errors: ${consoleErrors.join(' | ')}`);
    }
    if (toastText && /Malformed table row/i.test(toastText)) {
      throw new Error(`Got the exact real-user regression back: ${toastText}`);
    }
    expect(result.type).toBe('application/pdf');
    if (!(result.size > 0)) throw new Error(`Expected a non-empty PDF, got size ${result.size}`);
  } finally {
    await context.close();
  }
});

await browser.close();

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
