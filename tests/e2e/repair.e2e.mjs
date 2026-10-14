// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/repair.e2e.mjs — "Tap to repair it and try again" on the
//  damaged-file error, in a real browser (2026-10-14).
//
//  Two damages our tools really hit: a content stream cut short ("Bad
//  encoding in flate stream", Resize) and a catalog whose /Pages isn't the
//  page tree ("catalog.Pages(...).traverse is not a function", Compress).
//  Each must first fail with the repair offer — then one tap repairs the
//  file, re-runs the tool and produces the result, its text read back with
//  the page's own pdf.js. Plus: a file with leading bytes before %PDF- is
//  no longer rejected as "not a valid PDF".
//  Fixtures: tests/fixtures/repair/ (built by pdf-lib, no user documents).
//  Run: node tests/e2e/repair.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const FIX = path.join(__dirname, '..', 'fixtures', 'repair');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();
async function open(tool, file) {
  const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
  await page.addInitScript(() => {
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (b instanceof Blob && /pdf/.test(b.type) && b.size > 0) window.__pdf = b; return orig(b); };
  });
  await page.goto(BASE_URL + tool, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', file);
  await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  return page;
}
const toast = page => page.evaluate(() => (document.querySelector('#toast')?.innerText || '').trim());
async function resultText(page) {
  await page.waitForFunction(() => window.__pdf, null, { timeout: 60000 });
  return page.evaluate(async () => {
    await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await window.__pdf.arrayBuffer()) }).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) text += (await (await doc.getPage(i)).getTextContent()).items.map(t => t.str).join(' ') + ' | ';
    return { pages: doc.numPages, text };
  });
}
// process → the damaged-file error offering a repair → tap it
async function failThenRepair(page) {
  await page.click('#mergeBtn');
  await page.waitForFunction(() => /repair/i.test(document.querySelector('#toast')?.innerText || ''), null, { timeout: 60000 });
  const offer = await toast(page);
  if (/Bad encoding|catalog|traverse/i.test(offer)) throw new Error(`raw engine text shown: ${offer}`);
  await page.click('#toast');
}

console.log(`\nrepair E2E (${BASE_URL}):`);
try {
  await test('Resize, a content stream cut short: error offers repair → tap → resized PDF with the text before the cut', async () => {
    const page = await open('/resize-pdf-for-printing/', path.join(FIX, 'cut-stream.pdf'));
    await failThenRepair(page);
    const { text } = await resultText(page);
    if (!/Line 1 of a long page/.test(text) || !/Line 200 of a long page/.test(text)) throw new Error(text.slice(0, 200));
  });

  await test('Compress, a catalog not pointing at the page tree: error offers repair → tap → all 3 pages', async () => {
    const page = await open('/compress-pdf/', path.join(FIX, 'bad-catalog.pdf'));
    await failThenRepair(page);
    const { pages, text } = await resultText(page);
    if (pages !== 3 || !/Repair page 3/.test(text)) throw new Error(`${pages} pages: ${text.slice(0, 120)}`);
  });

  await test('bytes before %PDF- (a saved HTTP response): accepted, not "not a valid PDF"', async () => {
    const file = path.join(os.tmpdir(), 'leading-bytes.pdf');
    fs.writeFileSync(file, Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\n\r\n'), fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'nup', 'five-pages.pdf'))]));
    const page = await open('/rotate-pdf/', file);
    const listed = await page.evaluate(() => document.querySelectorAll('#fileList > *').length);
    if (listed !== 1) throw new Error(`file list: ${listed}; toast: ${await toast(page)}`);
  });
} finally {
  await browser.close();
}
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
