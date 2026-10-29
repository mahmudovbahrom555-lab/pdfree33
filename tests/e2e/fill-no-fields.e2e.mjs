// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/fill-no-fields.e2e.mjs — Fill on a PDF without form fields
//  (2026-10-29).
//
//  45 of 57 people who added a file to Fill (2026-10-26..29) left with no
//  result and no error. A PDF with no fields stops Fill by design, with a
//  link to Draw on PDF — but the stop was not counted, and the link opened
//  Draw empty, so the file had to be added again. Checks: the stop is sent
//  as Tool Notice, the link is counted as a cross-sell, and Draw opens
//  with the same file loaded.
//  Run: node tests/e2e/fill-no-fields.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const PDF = path.join(__dirname, '..', 'fixtures', 'normal-3page.pdf');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  // analytics is off for automated browsers; on here, and caught, not sent
  await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  const events = [];
  await ctx.route('**/api/analytics', r => { events.push(JSON.parse(r.request().postData())); r.fulfill({ status: 204 }); });

  console.log('\nFill → no fields → Draw on PDF:');
  await page.goto(BASE_URL + '/fill/', { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', PDF);
  const link = page.locator('#fillOptions a[href*="draw"]');
  await link.waitFor({ timeout: 30000 });

  await test('the stop is sent as Tool Notice fill / no_fields', async () => {
    await page.waitForTimeout(300);
    const n = events.filter(e => e.event === 'Tool Notice' && e.props.tool === 'fill' && e.props.notice === 'no_fields');
    if (n.length !== 1) throw new Error(`Tool Notice events: ${JSON.stringify(events.map(e => e.event))}`);
  });

  await Promise.all([page.waitForURL('**/draw-on-pdf/**', { timeout: 15000 }), link.click()]);

  await test('Draw opens with the same file, no second upload', async () => {
    await page.waitForFunction(() => {
      const c = document.querySelector('#pdfCanvas');
      return c && c.width > 0 && c.height > 0;
    }, null, { timeout: 30000 });
    await page.waitForFunction(() => /\/\s*3$/.test(document.querySelector('#pageLabel')?.textContent.trim()), null, { timeout: 10000 })
      .catch(async () => { throw new Error(`page label "${await page.textContent('#pageLabel')}" — not the 3-page file`); });
  });

  await test('the link is counted: Cross Sell Click fill → draw-pdf', async () => {
    const c = events.filter(e => e.event === 'Cross Sell Click');
    if (c.length !== 1 || c[0].props.from !== 'fill' || c[0].props.to !== 'draw-pdf') throw new Error(JSON.stringify(c));
  });
  await test('no page errors', async () => { if (errors.length) throw new Error(errors.join('; ')); });
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
