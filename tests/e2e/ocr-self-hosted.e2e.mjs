// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/ocr-self-hosted.e2e.mjs — the OCR engine, its WASM core and its
//  language models come from pdfree.io, not jsdelivr (2026-10-24: "Failed to
//  load Tesseract.js" for 4 people in October, 3 in mainland China).
//
//  - a first visit OCRs a scan with jsdelivr, unpkg and cdnjs refused
//    (pdf.js itself and Google's fonts aside: their own steps);
//  - a second run doesn't download the model again: it is in IndexedDB under
//    the same cachePath as before (unchanged on purpose — same bytes);
//  - a model download cut once by the network comes through on the next run;
//  - opening pages loads none of the engine.
//
//  Run: node tests/e2e/ocr-self-hosted.e2e.mjs   (dist/ served on :8934)
// ============================================================

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

// every CDN refused but pdf.js (cdnjs) and Noto fonts (Google) — not this step
async function refuseCdns(page, refused) {
  for (const host of ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com']) {
    await page.route(`**://${host}/**`, r => {
      if (/pdf\.js\/3\.11\.174\/pdf\.min\.js$/.test(r.request().url())) return r.continue();
      refused.push(r.request().url()); return r.abort();
    });
  }
}

// one OCR run of the Arabic scan; resolves to its searchable PDF's text
async function ocr(page) {
  await page.evaluate(() => { window.__pdf = null; window.__error = null; });
  await page.goto(`${BASE_URL}/ocr-pdf/`, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', SCAN);
  await page.waitForSelector('#ocrLangSelect', { timeout: 60000 });
  await page.selectOption('#ocrLangSelect', 'ara');
  await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 60000 });
  await page.click('#mergeBtn');
  await page.waitForFunction(() => window.__pdf || window.__error, null, { timeout: 300000 });
  const err = await page.evaluate(() => window.__error);
  if (err) throw new Error(err);
  return page.evaluate(async () => {
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await window.__pdf.arrayBuffer()) }).promise;
    return (await (await doc.getPage(1)).getTextContent()).items.map(i => i.str).join(' ');
  });
}

const hook = () => {
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = blob => { if (blob instanceof Blob && /pdf/.test(blob.type)) window.__pdf = blob; return orig(blob); };
  document.addEventListener('pdfree:error', e => { window.__error = e.detail.message; });
};

const browser = await chromium.launch();
console.log(`\nOCR from pdfree.io E2E (real browser, ${BASE_URL}):`);

await test('a first visit OCRs a scan with every CDN refused; a second run reads the model from the cache', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const refused = [], models = [];
  await refuseCdns(page, refused);
  page.on('request', r => { if (/tessdata\/.*traineddata/.test(r.url())) models.push(r.url()); });
  await page.addInitScript(hook);
  try {
    const text = await ocr(page);
    if (!/[؀-ۿ]{3}/.test(text)) throw new Error(`no Arabic in the text layer: ${text.slice(0, 120)} — refused: ${refused.join(', ')}`);
    if (!models.some(u => u.includes('/js/vendor/tessdata/ara.traineddata'))) throw new Error(`the model didn't come from pdfree.io: ${models.join(', ')}`);
    const first = models.length;
    await ocr(page);
    if (models.length !== first) throw new Error(`the second run downloaded the model again: ${models.slice(first).join(', ')}`);
  } finally {
    await ctx.close();
  }
});

await test('a model download cut once by the network comes through on the next run', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  let cut = 0;
  await page.route('**/js/vendor/tessdata/ara.traineddata*', r => (cut++ === 0 ? r.abort() : r.continue()));
  await page.addInitScript(hook);
  try {
    let firstFailed = false;
    try { await ocr(page); } catch { firstFailed = true; }
    if (!firstFailed) throw new Error('the first download was not cut — the test tests nothing');
    const text = await ocr(page);
    if (!/[؀-ۿ]{3}/.test(text)) throw new Error(`second run: no Arabic: ${text.slice(0, 120)}`);
  } finally {
    await ctx.close();
  }
});

await test('opening pages loads none of the OCR engine', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const seen = [];
  page.on('request', r => { if (/tesseract|tessdata/.test(r.url())) seen.push(r.url()); });
  try {
    for (const url of ['/', '/pdf-to-word/', '/merge-pdf/']) { await page.goto(BASE_URL + url, { waitUntil: 'networkidle' }); await page.waitForTimeout(1500); }
    if (seen.length) throw new Error(`loaded without being needed: ${seen.join(', ')}`);
  } finally {
    await ctx.close();
  }
});

await browser.close();
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
