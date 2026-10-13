// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/empty-button.e2e.mjs — the tool's big button before a file
//  is added (2026-10-13).
//
//  The button sits disabled until a file is added, and a click on it did
//  nothing — no picker, no hint (CLAUDE.md UX rule 5: never a silent no-op).
//  A new visitor's first click often lands there. With no file, it opens
//  the file picker — mouse on desktop, a tap on a phone.
//
//  Run: node tests/e2e/empty-button.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';

const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();
const centre = page => page.evaluate(() => {
  const r = document.querySelector('#mergeBtn').getBoundingClientRect();
  return [r.x + r.width / 2, r.y + r.height / 2];
});
try {
  for (const [path, label] of [['/merge-pdf/', 'Merge'], ['/zh/tiqu-pdf/', 'Extract (zh)']]) {
    await test(`${label}: a click on the empty button opens the file picker`, async () => {
      const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
      await page.goto(BASE_URL + path, { waitUntil: 'load' });
      if (!await page.evaluate(() => document.querySelector('#mergeBtn').disabled)) throw new Error('button not disabled before a file');
      const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
      await page.mouse.click(...await centre(page));
      await chooser;
    });
  }
  await test('a tap on a phone opens it too', async () => {
    const page = await (await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true })).newPage();
    await page.goto(`${BASE_URL}/compress-pdf/`, { waitUntil: 'load' });
    const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
    await page.touchscreen.tap(...await centre(page));
    await chooser;
  });
} finally {
  await browser.close();
}

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
