// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/ocr-self-hosted.e2e.mjs — the OCR engine, its WASM core and its
//  language models come from pdfree.io, not jsdelivr (2026-10-24: "Failed to
//  load Tesseract.js" for 4 people in October, 3 in mainland China), and so
//  does the Noto font of the searchable PDF's text layer (was fonts.gstatic.com).
//
//  - a first visit OCRs a scan with jsdelivr, unpkg, cdnjs and fonts.gstatic
//    refused (pdf.js itself aside: its own step), its text layer in Noto Sans
//    Arabic from pdfree.io;
//  - a second run downloads neither the model nor the font again: both are in
//    IndexedDB under the same keys as before (unchanged on purpose — same bytes);
//  - a model download cut once by the network is tried again in the same run
//    (js/ocrEngine.js _fetchWatched, 2026-10-29; it used to need a second run);
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

// every CDN refused but pdf.js (cdnjs) — not this step
async function refuseCdns(page, refused) {
  for (const host of ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'fonts.gstatic.com']) {
    await page.route(`**://${host}/**`, r => {
      if (/pdf\.js\/3\.11\.174\/pdf\.min\.js$/.test(r.request().url())) return r.continue();
      refused.push(r.request().url()); return r.abort();
    });
  }
}

// one OCR run of the Arabic scan; resolves to its searchable PDF's text and
// the names of its fonts
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
    const bytes = new Uint8Array(await window.__pdf.arrayBuffer());
    const doc = await window.pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const text = (await (await doc.getPage(1)).getTextContent()).items.map(i => i.str).join(' ');
    // object streams hide /BaseFont from the raw bytes: read the font dicts (pdf-lib is loaded for OCR)
    const pdf = await window.PDFLib.PDFDocument.load(bytes);
    const { PDFDict, PDFName } = window.PDFLib;
    const fonts = pdf.context.enumerateIndirectObjects()
      .filter(([, o]) => o instanceof PDFDict && o.get(PDFName.of('Type')) === PDFName.of('Font'))
      .map(([, o]) => String(o.get(PDFName.of('BaseFont'))));
    return { text, fonts };
  });
}

const hook = () => {
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = blob => { if (blob instanceof Blob && /pdf/.test(blob.type)) window.__pdf = blob; return orig(blob); };
  document.addEventListener('pdfree:error', e => { window.__error = e.detail.message; });
};

const browser = await chromium.launch();
console.log(`\nOCR from pdfree.io E2E (real browser, ${BASE_URL}):`);

await test('a first visit OCRs a scan with every CDN refused; a second run reads the model and the font from the cache', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const refused = [], models = [], fonts = [];
  await refuseCdns(page, refused);
  page.on('request', r => {
    if (/tessdata\/.*traineddata/.test(r.url())) models.push(r.url());
    if (/\.ttf(\?|$)/.test(r.url())) fonts.push(r.url());
  });
  await page.addInitScript(hook);
  try {
    const { text, fonts: embedded } = await ocr(page);
    if (!/[؀-ۿ]{3}/.test(text)) throw new Error(`no Arabic in the text layer: ${text.slice(0, 120)} — refused: ${refused.join(', ')}`);
    if (!models.some(u => u.includes('/js/vendor/tessdata/ara.traineddata'))) throw new Error(`the model didn't come from pdfree.io: ${models.join(', ')}`);
    if (!fonts.some(u => u.includes('/js/vendor/noto/notosansarabic-v33.ttf'))) throw new Error(`the font didn't come from pdfree.io: ${fonts.join(', ') || 'no font request'}`);
    if (!embedded.some(f => /NotoSansArabic/.test(f))) throw new Error(`the text layer isn't in Noto Sans Arabic: ${embedded.join(', ')}`);
    const firstModels = models.length, firstFonts = fonts.length;
    const again = await ocr(page);
    if (models.length !== firstModels) throw new Error(`the second run downloaded the model again: ${models.slice(firstModels).join(', ')}`);
    if (fonts.length !== firstFonts) throw new Error(`the second run downloaded the font again: ${fonts.slice(firstFonts).join(', ')}`);
    if (!again.fonts.some(f => /NotoSansArabic/.test(f))) throw new Error(`second run: the text layer isn't in Noto Sans Arabic: ${again.fonts.join(', ')}`);
  } finally {
    await ctx.close();
  }
});

await test('a model download cut once by the network is tried again and the run comes through', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  let cut = 0;
  await page.route('**/js/vendor/tessdata/ara.traineddata*', r => (cut++ === 0 ? r.abort() : r.continue()));
  await page.addInitScript(hook);
  try {
    const { text } = await ocr(page);
    if (cut < 2) throw new Error(`the model was requested ${cut} time(s) — the cut wasn't tried again, the test tests nothing`);
    if (!/[؀-ۿ]{3}/.test(text)) throw new Error(`no Arabic: ${text.slice(0, 120)}`);
  } finally {
    await ctx.close();
  }
});

await test('opening pages loads none of the OCR engine or its fonts', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const seen = [];
  page.on('request', r => { if (/tesseract|tessdata|vendor\/noto/.test(r.url())) seen.push(r.url()); });
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
