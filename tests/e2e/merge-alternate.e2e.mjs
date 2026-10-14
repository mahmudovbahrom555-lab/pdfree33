// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/merge-alternate.e2e.mjs — Merge's "Alternate pages" in a real
//  browser (2026-10-14, Search Miss "interleave").
//
//  A duplex document scanned on a one-sided scanner: fronts (1, 3, 5),
//  then the turned-over stack of backs (6, 4, 2). Alternating with the
//  backs reversed must give 1…6 — from two files, and from one scan that
//  holds both stacks. The default (one file after another) is unchanged.
//  Output read back with the page's own pdf.js.
//  Run: node tests/e2e/merge-alternate.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const FIX = path.join(__dirname, '..', 'fixtures', 'merge-alternate');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();
// Adds the files, optionally picks Alternate pages, merges; returns the
// page numbers ("Sheet page N") of the result in order.
async function merge(files, alternate) {
  const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
  await page.addInitScript(() => {
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (b instanceof Blob && /pdf/.test(b.type)) window.__pdf = b; return orig(b); };
  });
  await page.goto(BASE_URL + '/merge-pdf/', { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', files.map(f => path.join(FIX, f)));
  await page.waitForSelector('label[data-name="mergePageOrder"]', { timeout: 30000 });
  if (alternate) {
    await page.click('label[data-name="mergePageOrder"][data-value="alternate"]');
    if (!(await page.isVisible('#mergeReverseOthers + *, label:has(#mergeReverseOthers)'))) throw new Error('reverse option not shown');
    if (await page.isVisible('#mergeBookmarksToggle + *, label:has(#mergeBookmarksToggle)')) throw new Error('bookmarks still shown in alternate mode');
  }
  await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled);
  await page.waitForTimeout(1000);
  await page.click('#mergeBtn');
  await page.waitForFunction(() => window.__pdf, null, { timeout: 60000 });
  return page.evaluate(async () => {
    await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await window.__pdf.arrayBuffer()) }).promise;
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const text = (await (await doc.getPage(i)).getTextContent()).items.map(t => t.str).join(' ');
      out.push(Number((text.match(/Sheet page (\d+)/) || [])[1]));
    }
    return out.join(',');
  });
}

console.log(`\nmerge — alternate pages E2E (${BASE_URL}):`);
try {
  await test('fronts + reversed backs, Alternate pages (backs reversed by default): 1…6', async () => {
    const got = await merge(['fronts.pdf', 'backs-reversed.pdf'], true);
    if (got !== '1,2,3,4,5,6') throw new Error(got);
  });
  await test('one scan holding both stacks: split in half and alternated → 1…6', async () => {
    const got = await merge(['one-scan.pdf'], true);
    if (got !== '1,2,3,4,5,6') throw new Error(got);
  });
  await test('default stays one file after another', async () => {
    const got = await merge(['fronts.pdf', 'backs-reversed.pdf'], false);
    if (got !== '1,3,5,6,4,2') throw new Error(got);
  });
} finally {
  await browser.close();
}
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
