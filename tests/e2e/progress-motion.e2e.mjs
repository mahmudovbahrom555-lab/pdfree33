// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// The process button keeps moving while a tool works (2026-11-17). Its fill
// moves only when the real percent does, and PDF→Word sat at one percent for
// 44 s while it found a scan's language — the button looked stuck, with
// "Reading page 1/16" under it, and people left before the end (Analytics:
// 4 of 23 who pressed got no result, no error, no cancel). Now a light runs
// through the fill the whole time, and the step says what it is.
//
// Fixture: tests/fixtures/pdf2word_scan_ar_no_text.pdf — an Arabic scan with no
// text layer, read by OCR (the Tesseract model comes from the network).
//
// Run: node tests/e2e/progress-motion.e2e.mjs   (dist/ served on :8934)

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const SCAN = path.join(__dirname, '..', 'fixtures', 'pdf2word_scan_ar_no_text.pdf');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();

console.log(`\nProcess button motion E2E (real browser, ${BASE_URL}):`);

await test('PDF→Word on a scan: the light runs the whole time, and the language step is named', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = b => { if (b instanceof Blob && /officedocument/.test(b.type)) window.__res = b; return orig(b); };
    });
    await page.goto(`${BASE_URL}/pdf-to-word/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', SCAN);
    await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled
      && /Output mode/.test(document.querySelector('#pdf2wordOptions')?.textContent || ''), null, { timeout: 60000 });
    await page.evaluate(() => {
      window.__labels = new Set(); window.__light = [];
      setInterval(() => {
        window.__labels.add((document.querySelector('#progressLabel')?.textContent || '').trim());
        if (!document.querySelector('#mergeBtn').classList.contains('merge-btn--processing')) return;
        const a = document.getAnimations().find(x => x.animationName === 'merge-btn-run');
        window.__light.push(a && a.playState === 'running' ? a.currentTime : null);
      }, 250);
    });
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__res, null, { timeout: 180000 });
    const { labels, light } = await page.evaluate(() => ({ labels: [...window.__labels], light: window.__light }));
    if (!labels.some(l => /language/i.test(l))) throw new Error(`no language step shown — labels: ${JSON.stringify(labels)}`);
    if (light.length < 8) throw new Error(`too few samples while processing (${light.length})`);
    const stopped = light.filter((t, i) => t === null || (i && t <= light[i - 1])).length;
    if (stopped) throw new Error(`the light stood still or was missing in ${stopped} of ${light.length} samples`);
  } finally {
    await ctx.close();
  }
});

await browser.close();
console.log(`\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed) process.exit(1);
