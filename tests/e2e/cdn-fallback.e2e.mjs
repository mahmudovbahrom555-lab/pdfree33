// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// A primary CDN that HANGS (no error, no response) must not hang the tool.
// Real case 2026-10-01: cdn.jsdelivr.net stopped answering for minutes while
// unpkg answered in ~1s; js/lazyLibs.js only fell back on a script error, so
// PDF→Word sat on "Loading libraries…" until jsdelivr came back. Here jsdelivr
// requests are held open forever and PDF→Word must still produce a .docx via
// the fallback CDN (after lazyLibs' CDN_TIMEOUT_MS).
//
// Run: node tests/e2e/cdn-fallback.e2e.mjs   (needs dist/ served on :8934)

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const PDF = path.join(__dirname, '..', 'fixtures', 'normal-1page.pdf');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

console.log(`\nCDN fallback E2E (real browser, ${BASE_URL}):`);
const browser = await chromium.launch();

await test('PDF→Word still converts when the primary CDN (jsdelivr) hangs forever', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const fallbackHits = [];
  // never fulfilled, never aborted: a CDN that accepted the connection and went silent
  await page.route('**://cdn.jsdelivr.net/**', () => {});
  page.on('response', r => { if (r.url().includes('unpkg.com')) fallbackHits.push(r.status()); });
  await page.addInitScript(() => {
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { if (blob instanceof Blob) window.__blob = blob; return orig(blob); };
  });
  try {
    await page.goto(`${BASE_URL}/pdf-to-word/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', PDF);
    await page.waitForTimeout(1500);
    await page.evaluate(() => { window.__blob = null; });
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__blob && /officedocument/.test(window.__blob.type), null, { timeout: 90000 })
      .catch(() => { throw new Error('no .docx within 90s — the hanging CDN blocked the tool'); });
    if (!fallbackHits.includes(200)) throw new Error(`expected the library from the fallback CDN, got ${JSON.stringify(fallbackHits)}`);
  } finally {
    await context.close();
  }
});

await browser.close();
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
