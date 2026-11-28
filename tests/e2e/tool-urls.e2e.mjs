// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/tool-urls.e2e.mjs — the address a homepage gives a tool
//  (2026-11-28), in a real browser.
//
//  Opening a tool from the homepage search put an address in the bar built
//  from the tool's key or taken from the English page list: a PDF chosen on
//  the Quick Edit result went to "/quickEdit-pdf/" (404), Read PDF showed
//  "/read-pdf/" (404 on reload), every tool opened from /zh/ showed its
//  English address, and the logo "went home" to the tool's address — so a
//  reload or a shared link landed somewhere else.
//  Run: node tests/e2e/tool-urls.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const PDF = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'normal-1page.pdf');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();
async function home(urlPath) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })).newPage();
  await page.goto(BASE_URL + urlPath, { waitUntil: 'load' });
  return page;
}
// search, then choose a file on the result card
async function openFromSearch(page, query) {
  await page.fill('#toolSearch', query);
  await page.locator('label[for="srFileInput"]').first().waitFor();
  await page.setInputFiles('#srFileInput', PDF);
}
const pathOf = page => { const u = new URL(page.url()); return u.pathname + u.search; };
async function status(page) {
  return (await page.request.get(page.url())).status();
}
function expectEqual(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

try {
  for (const [lang, query, target] of [['/', 'quick edit', '/quick-edit-pdf/'], ['/zh/', '快速编辑', '/zh/kuaisu-bianji-pdf/']]) {
    await test(`${lang}: a PDF chosen on the Quick Edit result opens ${target}`, async () => {
      const page = await home(lang);
      try {
        await openFromSearch(page, query);
        await page.waitForURL(url => new URL(url).pathname === target, { timeout: 15000 });
        expectEqual(await status(page), 200, 'status');
      } finally { await page.close(); }
    });
  }

  await test('/zh/: a tool opened from search shows its Chinese address, and the logo goes back to /zh/', async () => {
    const page = await home('/zh/');
    try {
      await openFromSearch(page, '合并');
      await page.waitForFunction(() => location.pathname !== '/zh/');
      expectEqual(pathOf(page), '/zh/hebing-pdf/', 'tool address');
      await page.click('#logo');
      await page.waitForFunction(() => location.pathname === '/zh/');
      await page.reload({ waitUntil: 'load' });
      expectEqual(await page.locator('#toolSearch').isVisible(), true, 'homepage after reload');
    } finally { await page.close(); }
  });

  await test('Read PDF (no page of its own) gets ?tool=read on its homepage, and a reload opens it again', async () => {
    const page = await home('/zh/');
    try {
      await openFromSearch(page, 'read pdf');
      await page.waitForFunction(() => location.search === '?tool=read');
      expectEqual(pathOf(page), '/zh/?tool=read', 'address');
      expectEqual(await status(page), 200, 'status');
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => getComputedStyle(document.getElementById('toolArea')).display !== 'none');
    } finally { await page.close(); }
  });
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
