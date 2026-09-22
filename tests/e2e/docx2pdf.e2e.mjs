// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/docx2pdf.e2e.mjs — real-browser regression tests for two
//  real end-user bugs in the Word→PDF tool (js/docxToPdfCore.js).
//
//  1. "Malformed table row, a cell is undefined" — a DOCX table with a
//     merged cell (Word's gridSpan/vMerge, i.e. colspan/rowspan once
//     docx-preview renders them as real HTML) crashed pdfmake's table
//     renderer. Root cause: parseTable() assumed every <tr> has the same
//     number of <td> children as the first row — true for a plain table,
//     false the instant any row has a merged cell, since HTML simply
//     omits a <td> for a cell covered by an earlier row's rowSpan (and a
//     colSpan cell's row has fewer <td>s than the table's true column
//     count). Fixed by walking the table as a real grid, inserting
//     pdfmake's own documented {} placeholder for spanned positions.
//
//  2. A bare "Failed to fetch" aborting the WHOLE conversion — traced to
//     _imgToDataUrl()'s fetch(img.src): a network-level failure fetching
//     ONE embedded image used to crash the entire document instead of
//     just that one image (never reproduced against a specific real file
//     — the reporting user's actual file had zero images — but the code
//     path itself is real and independently verifiable: force a fetch
//     failure and confirm graceful degradation instead of a hard crash).
//
//  Uses small synthetic fixtures (not the real reporter's file, which
//  contains someone else's personal document) that reproduce the same
//  structural patterns.
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
const IMAGE_DOCX        = path.join(__dirname, '..', 'fixtures', 'eri', '004_libreoffice.docx');

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

async function convertAndCapture(page, filePath) {
  await page.goto(`${BASE_URL}/word-to-pdf/`, { waitUntil: 'load', timeout: 30000 });
  await page.setInputFiles('#fileInput', filePath);
  await page.waitForTimeout(500);
  // docx-preview's own rendering (which parseTable/parseParagraph walk)
  // can call createObjectURL for an embedded image's <img src> well before
  // the real conversion even starts — reset right before the actual
  // trigger so BLOB_HOOK's capture can only be the real output blob, not
  // an incidental earlier one (caught a real false-positive from this
  // during development: the hook had captured an intermediate image/png
  // blob, not the final application/pdf one).
  await page.evaluate(() => { window.__blob = null; });
  await page.click('#mergeBtn');

  let result = null, toastText = null;
  for (let i = 0; i < 60; i++) {
    result = await page.evaluate(() => window.__blob ? { size: window.__blob.size, type: window.__blob.type } : null).catch(() => null);
    if (result && result.type === 'application/pdf') break;
    toastText = await page.locator('#toast').textContent().catch(() => null);
    if (toastText && toastText.trim()) break;
    await page.waitForTimeout(500);
    result = null;
  }
  return { result, toastText };
}

console.log(`\ndocx2pdf E2E — real end-user regressions stay fixed (real browser, ${BASE_URL}):`);

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
    const { result, toastText } = await convertAndCapture(page, MERGED_CELLS_DOCX);

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

await test('a failed image fetch degrades gracefully (skips that image) instead of aborting the whole conversion', async () => {
  // Real user report: a bare "Failed to fetch" toast, whole conversion
  // aborted. _imgToDataUrl()'s fetch(img.src) is the only fetch() call
  // reachable in this tool's pipeline (verified by searching the whole
  // codebase) — force it to reject and confirm the document still comes
  // out, proving one unreachable image can no longer sink the whole file.
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  try {
    await page.addInitScript(BLOB_HOOK);
    await page.addInitScript(() => {
      const origFetch = window.fetch.bind(window);
      window.fetch = function (url, ...rest) {
        // docx-preview's own embedded-image src is a blob: URL — only
        // sabotage those, so pdfmake/pdf.js's own unrelated fetches (if
        // any, elsewhere on the page) aren't collaterally broken.
        if (typeof url === 'string' && url.startsWith('blob:')) {
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return origFetch(url, ...rest);
      };
    });
    const { result, toastText } = await convertAndCapture(page, IMAGE_DOCX);

    if (!result) {
      throw new Error(`Expected the conversion to still succeed despite the forced image-fetch failure. Toast: ${toastText || '(empty)'}. Console errors: ${consoleErrors.join(' | ')}`);
    }
    if (toastText && /Failed to fetch/i.test(toastText)) {
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
