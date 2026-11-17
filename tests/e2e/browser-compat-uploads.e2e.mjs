// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Three errors people hit on 2026-11-17 (Analytics, one day), each reproduced
// here as it happened to them:
// - Compress to a size stopped with "r.throwIfAborted is not a function" on a
//   browser older than Chrome 100 / Safari 15.4 (2 people, 10–50 MB files).
// - The install nudge, shown after every result, gathered one click listener
//   per result: one click called prompt() again and again, and every call but
//   the first failed with "must be called with a user gesture" (Split, 3 people).
// - A Watermark logo named .jpg that is another format inside (the browser
//   types a file by its name): pdf-lib stopped with "SOI not found in JPEG"
//   (3 people).
//
// Run: node tests/e2e/browser-compat-uploads.e2e.mjs   (dist/ served on :8934)

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const base = BASE_URL;
const FIX = path.join(__dirname, '..', 'fixtures', 'pdf2word_scan_ar_no_text.pdf');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const b = await chromium.launch();
console.log(`\nBrowser compatibility and uploads E2E (real browser, ${BASE_URL}):`);
await test('Compress to a size on a browser without AbortSignal.throwIfAborted or signal.reason gives a result', async () => {
  const page = await (await b.newContext({ serviceWorkers: 'block' })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.addInitScript(() => {
    delete AbortSignal.prototype.throwIfAborted;
    Object.defineProperty(AbortSignal.prototype, 'reason', { get() { return undefined; }, configurable: true });
    const o = URL.createObjectURL.bind(URL); URL.createObjectURL = x => { if (x instanceof Blob && /pdf/.test(x.type)) window.__res = x; return o(x); };
  });
  await page.goto(base + '/compress-pdf/', { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', FIX);
  await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 60000 });
  await page.click('.compress-target [data-target="custom"]');
  await page.selectOption('#compressTargetUnit', 'KB');
  await page.fill('#compressTargetValue', '60');
  await page.click('#mergeBtn');
  const r = await page.waitForFunction(() => window.__res ? 'ok' : (/throwIfAborted|wrong|error/i.test(document.querySelector('#toast')?.textContent || '') ? document.querySelector('#toast').textContent : null), null, { timeout: 180000 }).then(h => h.jsonValue()).catch(() => 'timeout');
  if (r !== 'ok') throw new Error(`no result: ${r}`);
  if (errs.some(e => /throwIfAborted|reason/.test(e))) throw new Error(errs.join('; '));
});
await test('the install nudge after two results prompts once per click', async () => {
  const page = await (await b.newContext({ serviceWorkers: 'block' })).newPage();
  await page.goto(base + '/', { waitUntil: 'load' });
  const n = await page.evaluate(async () => {
    window.__prompts = 0;
    const ev = new Event('beforeinstallprompt', { cancelable: true });
    ev.prompt = () => { window.__prompts++; return Promise.resolve(); };
    ev.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(ev);
    const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
    for (let i = 0; i < 2; i++) document.dispatchEvent(new CustomEvent('pdfree:success', { detail: { tool: 'split', blob, desc: '', filename: 'a.pdf' } }));
    await new Promise(r => setTimeout(r, 300));
    const btn = document.querySelector('#pwaNudgeBtn');
    if (!btn || getComputedStyle(document.querySelector('#pwaNudge')).display === 'none') return 'nudge not shown';
    btn.click();
    await new Promise(r => setTimeout(r, 100));
    return window.__prompts;
  });
  if (n !== 1) throw new Error(`prompt() called ${n} times`);
});
await test('a Watermark logo named .jpg that is a WebP inside is embedded', async () => {
  const page = await (await b.newContext({ serviceWorkers: 'block' })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.addInitScript(() => { const o = URL.createObjectURL.bind(URL); URL.createObjectURL = x => { if (x instanceof Blob && /pdf/.test(x.type) && x.size > 2000) window.__res = x; return o(x); }; });
  await page.goto(base + '/add-watermark/', { waitUntil: 'load' }).catch(() => {});
  if (!(await page.$('#fileInput'))) await page.goto(base + '/watermark-pdf/', { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', FIX);
  await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 60000 });
  const webp = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 120; c.height = 60; const x = c.getContext('2d'); x.fillStyle = '#c00'; x.fillRect(0, 0, 120, 60); return c.toDataURL('image/webp').split(',')[1]; });
  await page.locator('[data-value="image"], button:has-text("Image")').first().click();
  await page.setInputFiles('#wmLogoInput', { name: 'logo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(webp, 'base64') });
  await page.waitForSelector('.wm-logo-drop__preview', { timeout: 15000 });
  await page.click('#mergeBtn');
  const r = await page.waitForFunction(() => window.__res ? 'ok' : (/SOI|wrong|error/i.test(document.querySelector('#toast')?.textContent || '') ? document.querySelector('#toast').textContent : null), null, { timeout: 120000 }).then(h => h.jsonValue()).catch(() => 'timeout');
  if (r !== 'ok') throw new Error(`no result: ${r}`);
});

await b.close();
console.log(`\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed) process.exit(1);
