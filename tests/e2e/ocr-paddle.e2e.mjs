// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/ocr-paddle.e2e.mjs — PP-OCRv5 for Chinese/Japanese scans on desktops
//  (2026-10-30), in a real browser.
//
//  js/ppocrEngine.js reads a Chinese or Japanese page with PP-OCRv5 when the
//  device is a desktop with ≥ 8 GB (navigator.deviceMemory, userAgentData.mobile
//  — the gate js/fileLimits.js uses); anything else stays with Tesseract. Checked
//  here: the models are fetched from the site and the page read on a desktop;
//  on 4 GB or a phone the models aren't even fetched; with the models
//  unreachable the page still comes out (Tesseract); a page stored upside down;
//  the OCR tool's searchable PDF carries the text.
//  Fixture: tests/fixtures/ppocr/ (make.py — a scan with known text).
//  Run: node tests/e2e/ocr-paddle.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const FIX = path.join(__dirname, '..', 'fixtures', 'ppocr');
const TRUTH = fs.readFileSync(path.join(FIX, 'truth.txt'), 'utf8');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
// share of the truth's Han characters found (multiset)
function recall(out) {
  const han = s => s.match(/[㐀-鿿]/g) ?? [];
  const got = new Map();
  for (const c of han(out)) got.set(c, (got.get(c) ?? 0) + 1);
  const want = han(TRUTH);
  let hit = 0;
  for (const c of want) if (got.get(c) > 0) { hit++; got.set(c, got.get(c) - 1); }
  return hit / want.length;
}

const browser = await chromium.launch();
// device: { memory, mobile } as navigator reports them; blockModels: the model files unreachable
async function open(urlPath, { memory = 8, mobile = false, blockModels = false } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const fetched = [];
  page.on('request', r => { if (/\/js\/vendor\/ppocr\//.test(r.url())) fetched.push(r.url()); });
  if (blockModels) await ctx.route('**/js/vendor/ppocr/**', r => r.abort());
  await page.addInitScript(({ memory, mobile }) => {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => memory });
    Object.defineProperty(navigator, 'userAgentData', { get: () => ({ mobile, brands: [], platform: '' }) });
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (b instanceof Blob && /officedocument|pdf/.test(b.type)) window.__out = b; return orig(b); };
  }, { memory, mobile });
  await page.goto(BASE_URL + urlPath, { waitUntil: 'load' });
  return { page, fetched, ctx };
}
async function wordText(file, device) {
  const { page, fetched, ctx } = await open('/zh/pdf-zhuan-word/', device);
  await page.setInputFiles('#fileInput', path.join(FIX, file));
  await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const t0 = Date.now();
  await page.click('#mergeBtn');
  await page.waitForFunction(() => window.__out, null, { timeout: 300000 });
  const text = await page.evaluate(async () => {
    await (await import('/js/lazyLibs.js')).loadJSZip();
    const zip = await window.JSZip.loadAsync(await window.__out.arrayBuffer());
    const xml = await zip.file('word/document.xml').async('string');
    return [...xml.matchAll(/<w:t[^>]*>([^<]*)/g)].map(t => t[1]).join('');
  });
  await ctx.close();
  return { text, fetched, seconds: (Date.now() - t0) / 1000 };
}

console.log(`\nPP-OCRv5 for Chinese scans (${BASE_URL}):`);
try {
  let paddle, tess;
  await test('desktop, 8 GB: the models come from the site and the page is read (≥ 95 % of the characters)', async () => {
    paddle = await wordText('zh-scan.pdf', {});
    const r = recall(paddle.text);
    console.log(`      PP-OCR: ${(r * 100).toFixed(1)} %, ${paddle.seconds.toFixed(0)} s, ${paddle.fetched.length} model files fetched`);
    if (!paddle.fetched.some(u => u.endsWith('rec.onnx'))) throw new Error('rec.onnx never fetched — PP-OCR did not run');
    if (r < 0.95) throw new Error(`${(r * 100).toFixed(1)} %: ${paddle.text.slice(0, 120)}`);
  });
  await test('4 GB: Tesseract reads it, the models are never fetched', async () => {
    tess = await wordText('zh-scan.pdf', { memory: 4 });
    console.log(`      Tesseract: ${(recall(tess.text) * 100).toFixed(1)} %, ${tess.seconds.toFixed(0)} s`);
    if (tess.fetched.length) throw new Error(`fetched ${tess.fetched.join(', ')}`);
    if (recall(tess.text) < 0.5) throw new Error('Tesseract read almost nothing');
  });
  await test('a phone (userAgentData.mobile): Tesseract, no models fetched', async () => {
    const r = await wordText('zh-scan.pdf', { mobile: true });
    if (r.fetched.length) throw new Error(`fetched ${r.fetched.join(', ')}`);
  });
  await test('models unreachable: the page still comes out, read by Tesseract', async () => {
    const r = await wordText('zh-scan.pdf', { blockModels: true });
    console.log(`      fallback: ${(recall(r.text) * 100).toFixed(1)} %`);
    if (recall(r.text) < 0.5) throw new Error(`${(recall(r.text) * 100).toFixed(1)} %`);
  });
  await test('a page stored upside down: PP-OCR not below Tesseract on it', async () => {
    const p = await wordText('zh-scan-upside-down.pdf', {}), t = await wordText('zh-scan-upside-down.pdf', { memory: 4 });
    console.log(`      upside down — PP-OCR ${(recall(p.text) * 100).toFixed(1)} %, Tesseract ${(recall(t.text) * 100).toFixed(1)} %`);
    if (recall(p.text) + 0.02 < recall(t.text)) throw new Error('PP-OCR below Tesseract');
  });
  await test('OCR tool: the searchable PDF carries the text (PP-OCR, ≥ 95 %)', async () => {
    const { page, fetched, ctx } = await open('/zh/pdf-wenzi-shibie/');
    await page.setInputFiles('#fileInput', path.join(FIX, 'zh-scan.pdf'));
    await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__out, null, { timeout: 300000 });
    const text = await page.evaluate(async () => {
      await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
      const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await window.__out.arrayBuffer()) }).promise;
      return (await (await doc.getPage(1)).getTextContent()).items.map(i => i.str).join('');
    });
    await ctx.close();
    console.log(`      text layer: ${(recall(text) * 100).toFixed(1)} %`);
    if (!fetched.some(u => u.endsWith('rec.onnx'))) throw new Error('PP-OCR did not run');
    if (recall(text) < 0.95) throw new Error(text.slice(0, 120));
  });
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
