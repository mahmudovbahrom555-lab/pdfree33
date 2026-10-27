// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// A page image the browser can't encode must end the run with an error, not
// hang it (2026-10-27). Tesseract.js encodes a canvas inside canvas.toBlob's
// callback, where nothing catches a failure: when toBlob gave null (a page too
// large, memory short), an unhandled "Failed to execute 'readAsArrayBuffer' on
// 'FileReader'" was thrown and recognize() never settled — PDF→Word (3
// people), OCR and PDF→PPT (1 each), 2026-10-24..27. js/ocrEngine.js now makes
// the PNG itself and throws a handled error when it can't.
//
// The browser's PNG encoding is made to fail (toBlob → null for PNG, as when
// memory runs short) and a scan goes through the OCR tool and through PDF→Word
// (which reads scans with OCR; a page it can't read stays a picture). Each run
// must end — an error or a result shown, the button
// ready again — with no unhandled rejection.
//
// Needs the OCR engine and models (self-hosted on the served site) — minutes,
// not in the CI gate. Run: node tests/e2e/ocr-unencodable-page.e2e.mjs
// (dist/ served on :8934, or PDFREE_BASE_URL).

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

async function run(browser, toolPath) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__rejections = [];
    addEventListener('unhandledrejection', e => window.__rejections.push(String(e.reason?.message ?? e.reason)));
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (cb, type, q) {
      if (!type || type === 'image/png') { setTimeout(() => cb(null), 0); return; }
      return toBlob.call(this, cb, type, q);
    };
    if (globalThis.OffscreenCanvas) {
      const convert = OffscreenCanvas.prototype.convertToBlob;
      OffscreenCanvas.prototype.convertToBlob = function (o) {
        return !o?.type || o.type === 'image/png' ? Promise.resolve(null) : convert.call(this, o);
      };
    }
  });
  await page.goto(`${BASE_URL}${toolPath}`);
  await page.setInputFiles('#fileInput', SCAN);
  await page.waitForTimeout(2500);
  await page.click('#mergeBtn');
  const ended = await page.waitForFunction(() => {
    const busy = document.querySelector('#mergeBtn')?.classList.contains('merge-btn--processing');
    const shown = document.querySelector('#toast.show') || document.querySelector('#successCard')?.offsetParent;
    return !busy && shown;
  }, null, { timeout: 180_000 }).then(() => true, () => false);
  const rejections = await page.evaluate(() => window.__rejections);
  const toast = await page.evaluate(() => document.querySelector('#toast')?.innerText?.trim() ?? '');
  await ctx.close();
  return { ended, rejections, toast };
}

const browser = await chromium.launch();
for (const [name, toolPath] of [['OCR', '/ocr-pdf/'], ['PDF→Word on a scan', '/pdf-to-word/']]) {
  await test(`${name}: an unencodable page ends the run (an error or a result), no unhandled rejection`, async () => {
    const r = await run(browser, toolPath);
    if (!r.ended) throw new Error(`the run never ended (3 min); unhandled: ${JSON.stringify(r.rejections)}`);
    if (r.rejections.length) throw new Error(`unhandled: ${JSON.stringify(r.rejections)}`);
    console.log(`    toast: ${r.toast.slice(0, 100)}`);
  });
}
await browser.close();
console.log(`\n${'─'.repeat(40)}\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
process.exit(failed ? 1 : 0);
