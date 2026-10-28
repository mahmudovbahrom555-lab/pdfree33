// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Merge's page-count scan and Compress's scan start the shared worker when a
// file is added; its importScripts('vendor/pdf-lib.min.js') doesn't retry. On
// a flaky connection that logged "importScripts failed: /js/vendor/pdf-lib.min.js"
// (6 people, 2026-10-24..27) and the file list got no page counts. The scans
// now fetch pdf-lib first with doProcess's retries (_warmPdfLib).
//
// The first two requests for pdf-lib.min.js fail (a dropped connection); two
// files are added to Merge. Their page counts must show, with no worker error.
// Run: node tests/e2e/scan-flaky-pdflib.e2e.mjs   (dist/ served on :8934)

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const FIX = path.join(__dirname, '..', 'fixtures');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();
await test('Merge: page counts show although the first two pdf-lib requests failed', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  let dropped = 0;
  await ctx.route('**/js/vendor/pdf-lib.min.js*', r => (dropped < 2 ? (dropped++, r.abort('connectionreset')) : r.continue()));
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (/importScripts|Worker error/i.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${BASE_URL}/merge-pdf/`);
  await page.setInputFiles('#fileInput', [path.join(FIX, 'normal-3page.pdf'), path.join(FIX, 'normal-1page.pdf')]);
  const counted = await page.waitForFunction(
    () => [...document.querySelectorAll('.file-item-size')].map(e => e.textContent).filter(t => / · \dp/.test(t)).length === 2,
    null, { timeout: 20_000 }).then(() => true, () => false);
  const sizes = await page.$$eval('.file-item-size', els => els.map(e => e.textContent));
  await ctx.close();
  if (dropped < 2) throw new Error(`only ${dropped} pdf-lib request(s) made — the test didn't drop two`);
  if (!counted) throw new Error(`no page counts: ${JSON.stringify(sizes)}; errors: ${JSON.stringify(errors)}`);
  if (errors.length) throw new Error(`worker errors: ${JSON.stringify(errors)}`);
});
await browser.close();
console.log(`\n${'─'.repeat(40)}\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
process.exit(failed ? 1 : 0);
