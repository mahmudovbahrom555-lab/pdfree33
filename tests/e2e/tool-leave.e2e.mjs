// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Tool Leave (2026-11-18): a page left while a tool works says how far the
// work had come — the progress reached and the seconds since the press, as
// numbers only. Three people pressed OCR on 2026-11-17 and got no result, no
// error and no cancel: nothing said where they gave up.
//
// Fixture: tests/fixtures/pdf2word_scan_ar_no_text.pdf — a scan PDF→Word reads
// by OCR, slow enough to leave in the middle.
//
// Run: node tests/e2e/tool-leave.e2e.mjs   (dist/ served on :8934)

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
console.log(`\nTool Leave E2E (real browser, ${BASE_URL}):`);

// The analytics events a page sends. A request sent as the page goes is
// delivered by the browser (keepalive; the server logs it) but never shown to
// Playwright, so each event is also written to localStorage as it is sent —
// at once, on the way out too — and read back from a page of the same site.
async function watched() {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    // a real person's page sends events; an automated one is left out on purpose
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    const orig = window.fetch.bind(window);
    window.fetch = (url, opts) => {
      if (String(url).endsWith('/api/analytics')) {
        try { localStorage.setItem('__sent', JSON.stringify([...JSON.parse(localStorage.getItem('__sent') || '[]'), JSON.parse(opts.body)])); } catch { /* storage full */ }
      }
      return orig(url, opts);
    };
  });
  const events = async () => {
    const page = await ctx.newPage();
    await page.goto(`${BASE_URL}/privacy/`, { waitUntil: 'domcontentloaded' }).catch(() => page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' }));
    const sent = await page.evaluate(() => JSON.parse(localStorage.getItem('__sent') || '[]'));
    await page.close();
    return sent;
  };
  return { ctx, events };
}

await test('leaving PDF→Word while it reads a scan sends Tool Leave with how far it got', async () => {
  const { ctx, events } = await watched();
  try {
    const page = await ctx.newPage();
    await page.goto(`${BASE_URL}/pdf-to-word/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', SCAN);
    await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled
      && /Output mode/.test(document.querySelector('#pdf2wordOptions')?.textContent || ''), null, { timeout: 60000 });
    await page.click('#mergeBtn');
    await page.waitForFunction(() => /language|Recognizing/i.test(document.querySelector('#progressLabel')?.textContent || ''), null, { timeout: 60000 });
    await page.waitForTimeout(500);
    await page.close({ runBeforeUnload: true });
    const sent = await events();
    const leave = sent.find(e => e.event === 'Tool Leave');
    if (!leave) throw new Error(`no Tool Leave — events: ${sent.map(e => e.event).join(', ')}`);
    const p = leave.props;
    if (p.tool !== 'pdf2word') throw new Error(`tool ${p.tool}`);
    if (!(p.x_pct >= 10 && p.x_pct <= 50)) throw new Error(`progress ${p.x_pct} — expected the OCR stretch, 10–50`);
    if (typeof p.x_after_s !== 'number') throw new Error(`no seconds: ${JSON.stringify(p)}`);
    if (Object.keys(p).some(k => !['locale', 'session', 'tool', 'x_pct', 'x_after_s'].includes(k))) throw new Error(`unexpected fields: ${Object.keys(p)}`);
  } finally {
    await ctx.close();
  }
});

await test('no Tool Leave after the result came — the run is over', async () => {
  const { ctx, events } = await watched();
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
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__res, null, { timeout: 180000 });
    await page.close({ runBeforeUnload: true });
    const sent = await events();
    if (!sent.some(e => e.event === 'Tool Success')) throw new Error(`no Tool Success — events: ${sent.map(e => e.event).join(', ')}`);
    if (sent.some(e => e.event === 'Tool Leave')) throw new Error('Tool Leave sent after the result');
  } finally {
    await ctx.close();
  }
});

await browser.close();
console.log(`\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed) process.exit(1);
