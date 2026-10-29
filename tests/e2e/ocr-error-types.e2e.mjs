// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// What the OCR tool tells analytics when a run doesn't produce a file. Two
// endings were logged as unknown errors in each locale's words (2026-10): a
// PDF that needs its password ("unknown: 🔒 This PDF is password protected…")
// and an iPhone user who said no to the long-document question ("unknown:
// Cancelled by user."). The first is a refusal with a type of its own; the
// second is a cancel, not an error. Neither needs the OCR engine: both end
// before it loads.
// Run: node tests/e2e/ocr-error-types.e2e.mjs   (dist/ served on :8934)

import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const LOCKED = path.join(__dirname, '..', 'fixtures', 'ocr_user_password.pdf');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// past MAX_PAGES_IOS (30) in js/ocrUI.js
const long = await PDFDocument.create();
for (let i = 0; i < 31; i++) long.addPage([200, 200]);
const LONG = path.join(os.tmpdir(), `ocr-long-${process.pid}.pdf`);
fs.writeFileSync(LONG, await long.save());

const browser = await chromium.launch();
async function run(file, ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', ...ctxOpts });
  const page = await ctx.newPage();
  const events = [];
  await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  await page.route('**/api/analytics', r => { events.push(JSON.parse(r.request().postData() || '{}')); r.fulfill({ status: 204 }); });
  page.on('dialog', d => d.dismiss());   // "OCR only the first 30 pages?" → no
  await page.goto(`${BASE_URL}/ocr-pdf/`, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', file);
  await page.waitForTimeout(2500);
  await page.click('#mergeBtn');
  await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.classList.contains('ocr-btn--busy'), null, { timeout: 30_000 });
  await page.waitForTimeout(1500);       // the event goes out after the run
  const toast = await page.evaluate(() => document.querySelector('#toast.show')?.innerText?.trim() ?? '');
  await ctx.close();
  return { events: events.filter(e => /^Tool (Error|Cancel)$/.test(e.event)), toast };
}

await test('a PDF that needs its password: Tool Error password_protected, not unknown', async () => {
  const { events } = await run(LOCKED);
  const types = events.filter(e => e.event === 'Tool Error').map(e => e.props?.error_type);
  if (String(types) !== 'password_protected') throw new Error(`Tool Error types: ${JSON.stringify(types)}`);
});

await test('an iPhone user says no to a long document: Tool Cancel, no error and no error toast', async () => {
  const { events, toast } = await run(LONG, {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  });
  const names = events.map(e => e.event);
  if (String(names) !== 'Tool Cancel') throw new Error(`events: ${JSON.stringify(events)}`);
  if (toast) throw new Error(`toast shown: ${toast}`);
});

await browser.close();
fs.unlinkSync(LONG);
console.log(`\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
process.exit(failed ? 1 : 0);
