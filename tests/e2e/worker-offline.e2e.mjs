// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/worker-offline.e2e.mjs — a tool still starts when the connection
//  drops after it was opened (2026-10-16).
//
//  A tool's worker is only made when its button is pressed; its scripts
//  (the worker, pdf-lib) came over the network then, and a connection lost
//  meanwhile left Merge, Compress, Organize, PowerPoint unable to start —
//  "NetworkError: Failed to execute 'importScripts'", 10 people in 3 days,
//  shown as a bare "Worker error". Now they're fetched into the service
//  worker's cache when the tool opens (processor.js warmToolScripts), and a
//  worker that still can't load says what happened.
//  Run: node tests/e2e/worker-offline.e2e.mjs   (dist/ served on :8934)
// ============================================================

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

async function open(ctx, url, files) {
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    const o = URL.createObjectURL.bind(URL);
    URL.createObjectURL = x => { if (x instanceof Blob && x.size > 500 && /pdf|zip/.test(x.type)) window.__result = x; return o(x); };
    document.addEventListener('pdfree:error', e => { window.__error = e.detail; });
  });
  await page.goto(BASE_URL + url, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', files);
  await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 30000 });
  await page.waitForTimeout(3500);           // the page idles: its tool's scripts are fetched
  return page;
}
const outcome = page => page.waitForFunction(() => window.__result || window.__error, null, { timeout: 60000 })
  .then(() => page.evaluate(() => (window.__result ? null : window.__error)));

const browser = await chromium.launch();
console.log(`\nworker scripts and a dropped connection E2E (${BASE_URL}):`);
try {
  for (const [tool, url, files] of [
    ['Merge', '/merge-pdf/', [path.join(FIX, 'normal-3page.pdf'), path.join(FIX, 'normal-1page.pdf')]],
    ['Organize', '/organize-pdf/', [path.join(FIX, 'normal-3page.pdf')]],
  ]) {
    await test(`${tool} still runs when the connection drops after the tool was opened`, async () => {
      const ctx = await browser.newContext();
      const page = await open(ctx, url, files);
      await ctx.setOffline(true);
      await page.click('#mergeBtn');
      const error = await outcome(page);
      await ctx.close();
      if (error) throw new Error(JSON.stringify(error));
    });
  }

  await test('a worker whose script does not load says so, as worker_load_failed', async () => {
    // no service worker, the worker's own script refused: the case warming can't save
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    await ctx.route('**/organizeWorker.js', r => r.abort());
    const page = await open(ctx, '/organize-pdf/', [path.join(FIX, 'normal-3page.pdf')]);
    await page.click('#mergeBtn');
    const error = await outcome(page);
    await ctx.close();
    if (!error) throw new Error('no error');
    if (error.errorType !== 'worker_load_failed') throw new Error(`type ${error.errorType}`);
    if (!/connection/i.test(error.message) || /Worker error/.test(error.message)) throw new Error(`message: ${error.message}`);
  });
} finally {
  await browser.close();
}
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
