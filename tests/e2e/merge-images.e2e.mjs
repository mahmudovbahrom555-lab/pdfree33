// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Merge takes pictures as well as PDFs (2026-11-18): 4 people in one day
// brought a .jpg to Merge and were turned away. Each picture becomes one page,
// made by Images → PDF's own conversion — a phone photo turned by its EXIF
// tag comes out upright, as it does there.
//
// Fixtures: normal-3page.pdf, merge_green.png (a green 120×160 picture),
// merge_exif_rot6.jpg (stored 200×100, red left half and blue right half,
// EXIF orientation 6: shown upright it is 100×200, red on top), merge_alpha.png
// / merge_alpha_lossy.webp / merge_alpha_lossless.webp (a red disc on a
// transparent 160×120 ground).
//
// Run: node tests/e2e/merge-images.e2e.mjs   (dist/ served on :8934)

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const FIX = name => path.join(__dirname, '..', 'fixtures', name);

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();
console.log(`\nMerge with pictures E2E (real browser, ${BASE_URL}):`);

const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => {
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = b => { if (b instanceof Blob && /pdf/.test(b.type) && b.size > 1500) window.__out = b; return orig(b); };
});
await page.goto(`${BASE_URL}/merge-pdf/`, { waitUntil: 'load' });
await page.setInputFiles('#fileInput', [FIX('normal-3page.pdf'), FIX('merge_green.png'), FIX('merge_exif_rot6.jpg')]);

await test('the pictures are taken, each listed as one page', async () => {
  await page.waitForFunction(() => document.querySelectorAll('#fileList .file-item').length === 3, null, { timeout: 30000 })
    .catch(async () => { throw new Error(`file list: ${await page.locator('#fileList').innerText()}`); });
  await page.waitForFunction(() => /·\s*3p/.test(document.querySelector('#fileList')?.textContent || ''), null, { timeout: 30000 });
  const text = await page.locator('#fileList').innerText();
  if ((text.match(/·\s*1p/g) || []).length !== 2) throw new Error(`pictures not listed as one page each: ${text}`);
});

await test('merged: the PDF\'s pages, then each picture as an upright page', async () => {
  await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 30000 });
  await page.click('#mergeBtn');
  await page.waitForFunction(() => window.__out, null, { timeout: 90000 });
  const pages = await page.evaluate(async () => {
    await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await window.__out.arrayBuffer()) }).promise;
    const out = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const p = await doc.getPage(n);
      const vp = p.getViewport({ scale: 0.5 });
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const ctx = c.getContext('2d');
      await p.render({ canvasContext: ctx, viewport: vp }).promise;
      const at = (fx, fy) => [...ctx.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data].slice(0, 3);
      out.push({ w: c.width, h: c.height, top: at(0.5, 0.25), bottom: at(0.5, 0.75) });
    }
    return out;
  });
  if (pages.length !== 5) throw new Error(`${pages.length} pages, expected 3 + 1 + 1`);
  const green = ([r, g, b]) => g > 120 && r < 100 && b < 120, red = ([r, g, b]) => r > 160 && g < 90 && b < 90, blue = ([r, g, b]) => b > 160 && r < 90;
  if (!green(pages[3].top)) throw new Error(`page 4 is not the green picture: ${JSON.stringify(pages[3])}`);
  const photo = pages[4];
  if (!(photo.h > photo.w)) throw new Error(`the EXIF-turned photo is not upright (portrait): ${photo.w}×${photo.h}`);
  if (!red(photo.top) || !blue(photo.bottom)) throw new Error(`the photo is turned the wrong way: top ${photo.top}, bottom ${photo.bottom}`);
});

// A picture's see-through parts come out white, not black (2026-11-21): the
// picture is re-encoded as JPEG, which has no transparency. A red disc on a
// transparent ground, as PNG, lossy WebP (VP8X) and lossless WebP (VP8L).
await test('transparent pictures: the clear part is white, the disc stays red', async () => {
  const p2 = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
  await p2.addInitScript(() => {
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (b instanceof Blob && /pdf/.test(b.type) && b.size > 1500) window.__out = b; return orig(b); };
  });
  await p2.goto(`${BASE_URL}/merge-pdf/`, { waitUntil: 'load' });
  await p2.setInputFiles('#fileInput', [FIX('merge_alpha.png'), FIX('merge_alpha_lossy.webp'), FIX('merge_alpha_lossless.webp')]);
  await p2.waitForFunction(() => document.querySelectorAll('#fileList .file-item').length === 3, null, { timeout: 30000 });
  await p2.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 30000 });
  await p2.click('#mergeBtn');
  await p2.waitForFunction(() => window.__out, null, { timeout: 90000 });
  const pages = await p2.evaluate(async () => {
    await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await window.__out.arrayBuffer()) }).promise;
    const out = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const p = await doc.getPage(n);
      const vp = p.getViewport({ scale: 1 });
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const ctx = c.getContext('2d');
      await p.render({ canvasContext: ctx, viewport: vp }).promise;
      const at = (fx, fy) => [...ctx.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data].slice(0, 3);
      out.push({ corner: at(0.05, 0.05), center: at(0.5, 0.5) });
    }
    return out;
  });
  if (pages.length !== 3) throw new Error(`${pages.length} pages`);
  pages.forEach(({ corner, center }, i) => {
    if (!corner.every(v => v > 235)) throw new Error(`picture ${i + 1}: the clear corner is ${corner}, not white`);
    if (!(center[0] > 160 && center[1] < 90)) throw new Error(`picture ${i + 1}: the disc is ${center}, not red`);
  });
});

await test('no page errors', async () => { if (errors.length) throw new Error(errors.join('; ')); });

await browser.close();
console.log(`\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed) process.exit(1);
