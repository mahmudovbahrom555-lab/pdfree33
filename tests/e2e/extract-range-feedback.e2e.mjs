// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Extract's Apply drew rage clicks from 8 people in each of two 3-day windows
// (2026-10-21..27): applying "30-35" changed nothing near the field — the count
// sits under the thumbnails (on a phone, under the sticky button) and the
// thumbnails stayed on pages 1–16. Now the count shows under the field and
// the thumbnails move to the first selected page; a range with no pages says
// so ("Selected: 0 pages").
// Run: node tests/e2e/extract-range-feedback.e2e.mjs   (dist/ served on :8934)

import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
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
for (let i = 0; i < 40; i++) doc.addPage([595, 842]);
const file = path.join(os.tmpdir(), `extract-40-${process.pid}.pdf`);
fs.writeFileSync(file, await doc.save());

const browser = await chromium.launch();
async function apply(range) {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 664 } })).newPage();
  await page.goto(`${BASE_URL}/extract-pdf/`);
  await page.setInputFiles('#fileInput', file);
  await page.waitForSelector('#extRangeInput', { state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll('.ext-thumb-card').length > 0, null, { timeout: 30_000 });
  await page.fill('#extRangeInput', range);
  await page.click('#extRangeApply');
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => ({
    status: document.getElementById('extRangeStatus')?.textContent ?? '',
    pager: document.getElementById('extPagerLabel')?.textContent ?? '',
    selected: [...document.querySelectorAll('.ext-thumb-card--sel')].map(c => +c.dataset.page),
  }));
  await page.context().close();
  return r;
}

await test('"30-35": the count under the field, the thumbnails on the page holding 30', async () => {
  const r = await apply('30-35');
  if (r.status !== 'Selected: 6 pages') throw new Error(`status "${r.status}"`);
  if (!r.pager.startsWith('2')) throw new Error(`pager "${r.pager}"`);
  if (!r.selected.includes(30)) throw new Error(`selected thumbnails ${r.selected}`);
});
await test('a range with no pages says so under the field', async () => {
  const r = await apply('abc');
  if (r.status !== 'Selected: 0 pages') throw new Error(`status "${r.status}"`);
});
await browser.close();
fs.unlinkSync(file);
console.log(`\n${'─'.repeat(40)}\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
process.exit(failed ? 1 : 0);
