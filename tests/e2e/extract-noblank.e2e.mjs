// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/extract-noblank.e2e.mjs — Extract's "Without blank pages" in
//  a real browser (2026-10-14).
//
//  tests/fixtures/blank/mixed.pdf: 1 text, 2 white, 3 a scanned blank sheet
//  (grey noise, a dark strip at the edge), 4 text, 5 only a page number.
//  Pages 2 and 3 must be left out; 5 kept — a page with anything on it is
//  never dropped. The saved PDF read back with pdf.js.
//  Run: node tests/e2e/extract-noblank.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();
console.log(`\nextract — without blank pages E2E (${BASE_URL}):`);
try {
  await test('blank and scanned-blank pages left out, a page-number-only page kept → pages 1, 4, 5', async () => {
    const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
    await page.addInitScript(() => {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = b => { if (b instanceof Blob && /pdf/.test(b.type)) window.__pdf = b; return orig(b); };
    });
    await page.goto(BASE_URL + '/extract-pdf/', { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', path.join(__dirname, '..', 'fixtures', 'blank', 'mixed.pdf'));
    await page.waitForSelector('.ext-quick-btn[data-preset="noblank"]', { timeout: 30000 });
    await page.click('.ext-quick-btn[data-preset="noblank"]');
    // the button is disabled while it checks, then the selection is applied at once
    await page.waitForFunction(() => {
      const b = document.querySelector('.ext-quick-btn[data-preset="noblank"]');
      return b && !b.disabled && (document.getElementById('extRangeInput')?.value || '') !== '';
    }, null, { timeout: 30000 });
    const range = (await page.inputValue('#extRangeInput')).replace(/\s/g, '');
    if (range !== '1,4-5' && range !== '1,4,5') throw new Error(`selected ${range}`);
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__pdf, null, { timeout: 60000 });
    const texts = await page.evaluate(async () => {
      await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
      const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await window.__pdf.arrayBuffer()) }).promise;
      const out = [];
      for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getTextContent()).items.map(t => t.str).join(' ').slice(0, 20));
      return out;
    });
    if (texts.length !== 3 || !/Text page one/.test(texts[0]) || !/Text page four/.test(texts[1]) || texts[2].trim() !== '5') throw new Error(JSON.stringify(texts));
  });
} finally {
  await browser.close();
}
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
