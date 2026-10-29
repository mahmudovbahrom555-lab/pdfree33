// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/jpg2pdf-tiff.e2e.mjs — TIFF → PDF in a real browser (2026-10-29).
//
//  "TIF转PDF" was searched on the site and found nothing (Search Miss,
//  7 people in China, 2026-10-14..29); Chrome/Edge/Firefox can't decode
//  TIFF at all. Images → PDF now reads it (js/tiffDecode.js +
//  js/tiffWorker.js). Checked through pdf.js: one PDF page per TIFF page,
//  in order (page n carries an n-wide black bar), fax pages with
//  half-height pixels not squashed, every compression scanners use,
//  a damaged TIFF refused without a crash, and the homepage route.
//
//  Fixtures: tests/fixtures/tiff/ (make.py builds them).
//  Run: node tests/e2e/jpg2pdf-tiff.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const FIX = path.join(__dirname, '..', 'fixtures', 'tiff');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();
async function newPage() {
  const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (b instanceof Blob && /pdf/.test(b.type)) window.__pdf = b; return orig(b); };
  });
  return { page, errors };
}
// pages of the result: size, and how wide the black bar at the top left is (in bar units)
async function readPdf(page) {
  await page.waitForFunction(() => window.__pdf, null, { timeout: 60000 });
  return page.evaluate(async () => {
    await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await window.__pdf.arrayBuffer()) }).promise;
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i), vp = p.getViewport({ scale: 1 });
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const g = c.getContext('2d'); await p.render({ canvasContext: g, viewport: vp }).promise;
      // the bar spans x 30..30+40n of a 420-wide page, y 30..110 (scaled to the page)
      const sx = c.width / 420;
      const row = g.getImageData(0, Math.min(c.height - 1, Math.round(70 * sx)), c.width, 1).data;
      let dark = 0; for (let x = Math.round(25 * sx); x < c.width; x++) { if (row[x * 4] < 100) dark++; else if (dark > 5) break; }
      out.push({ w: vp.width, h: vp.height, bar: Math.round(dark / (40 * sx)) });
    }
    return out;
  });
}
async function convert(files) {
  const { page, errors } = await newPage();
  await page.goto(BASE_URL + '/jpg2pdf/', { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', files.map(f => path.join(FIX, f)));
  await page.waitForSelector('.j2p-thumb__canvas', { timeout: 20000 });
  await page.click('#mergeBtn');
  return { page, errors };
}

try {
  console.log('\nTIFF → PDF:');
  for (const [file, n] of [['fax-g4-3p.tif', 3], ['deflate-gray-2p.tif', 2], ['lzw-rgb.tif', 1], ['jpeg-rgb.tif', 1], ['packbits-gray.tif', 1]]) {
    await test(`${file}: ${n} page(s), in order, content kept`, async () => {
      const { page, errors } = await convert([file]);
      const pages = await readPdf(page);
      if (pages.length !== n) throw new Error(`${pages.length} pages`);
      pages.forEach((p, i) => { if (p.bar !== i + 1) throw new Error(`page ${i + 1}: bar ${p.bar} (expected ${i + 1}) — ${JSON.stringify(pages)}`); });
      if (errors.length) throw new Error(errors.join('; '));
      await page.context().close();
    });
  }

  await test('fax "normal" mode (204 × 98 dpi): pages come out upright, not squashed to half height', async () => {
    const { page } = await convert(['fax-normal-2p.tif']);
    const pages = await readPdf(page);
    if (pages.length !== 2) throw new Error(`${pages.length} pages`);
    for (const p of pages) if (p.h / p.w < 1.3) throw new Error(`page ${p.w}×${p.h} — squashed`);
    await page.context().close();
  });

  await test('the thumbnail shows the first TIFF page (no browser but Safari decodes TIFF itself)', async () => {
    const { page } = await newPage();
    await page.goto(BASE_URL + '/jpg2pdf/', { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', path.join(FIX, 'fax-g4-3p.tif'));
    await page.waitForFunction(() => {
      const c = document.querySelector('.j2p-thumb__canvas[data-index="0"]');
      if (!c) return false;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] && d[i] < 80) return true;
      return false;
    }, null, { timeout: 20000 });
    await page.context().close();
  });

  await test('two TIFFs: all pages, in file order (3 + 2)', async () => {
    const { page } = await convert(['fax-g4-3p.tif', 'deflate-gray-2p.tif']);
    const pages = await readPdf(page);
    if (pages.map(p => p.bar).join() !== '1,2,3,1,2') throw new Error(JSON.stringify(pages.map(p => p.bar)));
    await page.context().close();
  });

  await test('a damaged TIFF: no crash, no PDF, the person is told', async () => {
    const { page, errors } = await convert(['broken.tif']);
    await page.waitForFunction(() => !document.querySelector('#toast')?.hidden && document.querySelector('#toast')?.textContent.trim(), null, { timeout: 30000 });
    const got = await page.evaluate(() => !!window.__pdf);
    if (got) throw new Error('a PDF was made from a damaged TIFF');
    if (errors.length) throw new Error(errors.join('; '));
    await page.context().close();
  });

  await test('homepage: a TIFF dropped on the hero is offered Images → PDF only (Scan Document can\'t read it), and converts', async () => {
    const { page } = await newPage();
    await page.goto(BASE_URL + '/', { waitUntil: 'load' });
    await page.setInputFiles('#heroFileInput', path.join(FIX, 'fax-g4-3p.tif'));
    await page.waitForSelector('.hero-recs .hero-rec-card', { timeout: 10000 });
    const recs = await page.$$eval('.hero-recs .hero-rec-card .hero-rec-name', els => els.map(e => e.textContent));
    if (recs.length !== 1 || !/JPG to PDF/.test(recs[0])) throw new Error(JSON.stringify(recs));
    await page.click('.hero-recs .hero-rec-card');
    await page.waitForSelector('.j2p-thumb__canvas', { timeout: 20000 });
    await page.click('#mergeBtn');
    const pages = await readPdf(page);
    if (pages.length !== 3) throw new Error(`${pages.length} pages`);
    await page.context().close();
  });
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
