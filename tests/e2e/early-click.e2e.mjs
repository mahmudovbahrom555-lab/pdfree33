// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// A press on Convert while the page is still reading the file ("Analysing
// PDF…") was turned away and started nothing — the user had to press again
// (found 2026-10-28: the corpus run recorded such files as refused). Now the
// press is kept and the conversion starts once the reading is done; a file
// changed meanwhile drops it. pdf.js is held back 4 s here so the press
// always comes early.
// Run: node tests/e2e/early-click.e2e.mjs   (dist/ served on :8934)

import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 3; i++) doc.addPage([595, 842]).drawText(`Page ${i + 1} of an early press`, { x: 60, y: 760, size: 14, font });
const file = path.join(os.tmpdir(), `early-click-${process.pid}.pdf`);
fs.writeFileSync(file, await doc.save());

const browser = await chromium.launch();
async function earlyPress(tool, then) {
  const ctx = await browser.newContext();
  // the page reads the file with pdf.js: hold the library back
  await ctx.route(/pdf\.js|pdf\.min\.js|pdfjs/, async r => { await new Promise(res => setTimeout(res, 4000)); await r.continue(); });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__blob = null; window.__armed = false; window.__runs = 0;
    document.addEventListener('pdfree:success', () => { window.__runs++; });
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (window.__armed && !window.__blob && b instanceof Blob && b.size && !/javascript/.test(b.type)) window.__blob = b; return orig(b); };
  });
  await page.goto(`${BASE_URL}/${tool}/`, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', file);
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.__armed = true; });
  await page.click('#mergeBtn');
  // the press is handled on the next frame: its message comes a moment later
  const early = await page.waitForFunction(() => /Analys/i.test(document.querySelector('#toast')?.innerText || ''), null, { timeout: 2000 }).then(() => true, () => false);
  if (!early) throw new Error('the press should come while the file is being analysed');
  const r = await then(page);
  await ctx.close();
  return r;
}

for (const tool of ['pdf-to-word', 'pdf-to-excel']) {
  await test(`${tool}: an early press converts once the file is read, with no second press`, async () => {
    const made = await earlyPress(tool, page => page.waitForFunction(() => !!window.__blob, null, { timeout: 60_000 }).then(() => true, () => false));
    if (!made) throw new Error('no result came out');
  });
}

await test('pressed early and again once the file is read: one conversion, not two', async () => {
  const runs = await earlyPress('pdf-to-word', async page => {
    // the reading ends ~4 s in; press again right after it does
    await page.waitForFunction(() => !/Analys/i.test(document.querySelector('#pdf2wordOptions')?.innerText || ''), null, { timeout: 30_000 });
    await page.click('#mergeBtn').catch(() => {});
    await page.waitForFunction(() => !!window.__blob, null, { timeout: 60_000 });
    await page.waitForTimeout(3000);
    return page.evaluate(() => window.__runs);
  });
  if (runs !== 1) throw new Error(`${runs} conversions`);
});

await test('a file removed while waiting: nothing starts', async () => {
  const started = await earlyPress('pdf-to-word', async page => {
    await page.evaluate(() => document.querySelector('#fileList .file-remove, #fileList [data-action="remove"], #fileList button')?.click());
    await page.waitForTimeout(7000);
    return page.evaluate(() => !!window.__blob || !!document.querySelector('#mergeBtn')?.classList.contains('merge-btn--processing'));
  });
  if (started) throw new Error('a conversion started for a file no longer there');
});

await browser.close();
fs.unlinkSync(file);
console.log(`\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
process.exit(failed ? 1 : 0);
