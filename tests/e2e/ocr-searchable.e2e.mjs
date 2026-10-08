// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// The OCR tool's searchable PDF must carry the recognized text (2026-10-08).
// fontkit was never loaded on the main thread, so the Noto font a non-Latin
// language needs silently fell back to Helvetica, which can't encode Arabic,
// Cyrillic or CJK: every such word was dropped from the invisible layer —
// 0 % of an Arabic or Russian scan's words were searchable. Measured after
// the fix with MuPDF: Arabic 85 %, Persian 77 %, Russian 98 %, English 99 %.
//
// Fixture: tests/fixtures/pdf2word_scan_ar_no_text.pdf (an image-only scan of
// the Arabic prose ground truth, see tests/e2e/pdf2word-ocr.e2e.mjs). The
// output's text is read back with the page's own pdf.js.
//
// Needs the network (OCR engine and models from the CDN) — not in the CI gate.
// Run: node tests/e2e/ocr-searchable.e2e.mjs   (dist/ served on :8934)

import { chromium } from 'playwright';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const GT = path.join(__dirname, '..', 'corpus', 'groundtruth');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// Arabic-script word bag — same normalisation as tests/e2e/pdf2word-ocr.e2e.mjs.
const norm = s => s.normalize('NFKC')
  .replace(/[ً-ٰٟـ]/g, '')
  .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ک/g, 'ك').replace(/ی/g, 'ي')
  .replace(/[‌‎‏]/g, '')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .split(/\s+/).filter(Boolean);

function recall(text, doc) {
  const truth = JSON.parse(readFileSync(path.join(GT, `${doc}.json`), 'utf8')).blocks.map(b => b.text).join(' ');
  const got = new Map();
  for (const w of norm(text)) got.set(w, (got.get(w) || 0) + 1);
  const words = norm(truth);
  let hit = 0;
  for (const w of words) if (got.get(w) > 0) { hit++; got.set(w, got.get(w) - 1); }
  return hit / words.length;
}

const browser = await chromium.launch();

console.log(`\nOCR tool searchable PDF E2E (real browser, ${BASE_URL}):`);

await test('an Arabic scan made searchable carries its Arabic words in the text layer', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => { if (blob instanceof Blob && /pdf/.test(blob.type)) window.__pdf = blob; return orig(blob); };
    });
    await page.goto(`${BASE_URL}/ocr-pdf/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', path.join(__dirname, '..', 'fixtures', 'pdf2word_scan_ar_no_text.pdf'));
    await page.waitForSelector('#ocrLangSelect', { timeout: 60000 });
    const install = await page.$('#btnInstallOcr');
    if (install && await install.isVisible()) {
      await install.click();
      await page.waitForFunction(() => !!window.Tesseract, null, { timeout: 180000 });
    }
    await page.selectOption('#ocrLangSelect', 'ara');
    await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 60000 });
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__pdf, null, { timeout: 300000 });
    const text = await page.evaluate(async () => {
      const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await window.__pdf.arrayBuffer()) }).promise;
      const content = await (await doc.getPage(1)).getTextContent();
      return content.items.map(i => i.str).join(' ');
    });
    const r = recall(text, 'ar-web');
    if (r < 0.6) throw new Error(`expected at least 60% of the words in the text layer, got ${(r * 100).toFixed(0)}%`);
  } finally {
    await ctx.close();
  }
});

await browser.close();
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
