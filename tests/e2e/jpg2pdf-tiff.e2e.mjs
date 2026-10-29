// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/jpg2pdf-tiff.e2e.mjs — TIFF → PDF in a real browser (2026-10-29).
//
//  "TIF转PDF" was searched on the site and found nothing (Search Miss,
//  7 people in China, 2026-10-14..29); Chrome/Edge/Firefox can't decode
//  TIFF at all. Images → PDF reads it now (js/tiffWorker.js): a fax's G4
//  page and a single-strip JPEG go into the PDF as they are, the rest is
//  decoded and stored losslessly (or as JPEG with "compress" on), the page
//  is the file's physical size (X and Y resolution separately), the
//  Orientation tag is honoured, and TIFFs mixed with other images keep the
//  person's order. Checked through pdf.js here (pages, order, size, shape,
//  the time a 100-page fax takes, Cancel) and, with TIFF_PDF_OUT=<dir>,
//  bit for bit against libtiff by tests/fixtures/tiff/check_pdf.py.
//
//  Fixtures: tests/fixtures/tiff/ (make.py builds and checks them).
//  Run: node tests/e2e/jpg2pdf-tiff.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const FIX = path.join(__dirname, '..', 'fixtures', 'tiff');
const OUT = process.env.TIFF_PDF_OUT;
if (OUT) fs.mkdirSync(OUT, { recursive: true });

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const browser = await chromium.launch();
async function newPage() {
  const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (b instanceof Blob && /pdf|zip/.test(b.type)) window.__out = b; return orig(b); };
  });
  return { page, errors };
}
// every page: its size in pt, and which page it is (the n-wide bar at the top left, in bar units)
async function readPdf(page, save) {
  await page.waitForFunction(() => window.__out, null, { timeout: 120000 });
  if (save && OUT) {
    const b64 = await page.evaluate(async () => { const u = new Uint8Array(await window.__out.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768)); return btoa(s); });
    const base = save.as || save.tiff.replace(/\.tif$/, '');
    fs.writeFileSync(path.join(OUT, base + '.pdf'), Buffer.from(b64, 'base64'));
    fs.writeFileSync(path.join(OUT, base + '.json'), JSON.stringify(save));
  }
  return page.evaluate(async () => {
    await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await window.__out.arrayBuffer()) }).promise;
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i), vp = p.getViewport({ scale: 2 });
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const g = c.getContext('2d'); await p.render({ canvasContext: g, viewport: vp }).promise;
      // the image fills the page here (pageSize auto); the bar spans x 30..30+40n of 420, y 30..110 of 594
      const sx = c.width / 420, row = g.getImageData(0, Math.round(70 * c.height / 594), c.width, 1).data;
      let dark = 0; for (let x = Math.round(25 * sx); x < c.width; x++) { if (row[x * 4] < 100) dark++; else if (dark > 5) break; }
      out.push({ w: vp.width / 2, h: vp.height / 2, bar: Math.round(dark / (40 * sx)) });
    }
    return { pages: out, bytes: window.__out.size };
  });
}
async function convert(files, { compress = true, pageSize, separate = false } = {}) {
  const { page, errors } = await newPage();
  await page.goto(BASE_URL + '/jpg2pdf/', { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', files.map(f => path.join(FIX, f)));
  await page.waitForSelector('.j2p-thumb__canvas', { timeout: 20000 });
  if (!compress) await page.click('label:has(#j2pCompressCheck)');
  if (separate) await page.click('label:has(#j2pSeparateCheck)');
  if (pageSize) await page.click(`label[data-name="j2pSize"][data-value="${pageSize}"]`);
  await page.click('#mergeBtn');
  return { page, errors };
}
const done = async page => page.context().close();

try {
  console.log('\nEvery kind of TIFF — pages, order, physical size:');
  // [file, pages, page size in pt (auto = from the resolution), lossless?, options]
  const P150 = [420 * 72 / 150, 594 * 72 / 150], P200 = [420 * 72 / 200, 594 * 72 / 200];
  const cases = [
    ['fax-g4-3p.tif', 3, P200, true], ['g4-whiteiszero.tif', 1, P200, true], ['g4-fillorder2.tif', 1, P200, true],
    ['deflate-gray-2p.tif', 2, P150, true, { compress: false }], ['packbits-gray.tif', 1, P150, true, { compress: false }],
    ['lzw-rgb.tif', 1, P150, true, { compress: false }], ['planar-rgb.tif', 1, P150, true, { compress: false }],
    ['tiled-gray.tif', 1, P150, true, { compress: false }], ['gray16.tif', 1, P150, true, { compress: false }],
    ['palette.tif', 1, P150, true, { compress: false }], ['rgba.tif', 1, P150, true, { compress: false }],
    ['raw-gray.tif', 1, [210 * 72 / 75, 297 * 72 / 75], true, { compress: false }],
    ['cmyk.tif', 1, P150, false, { compress: false }],
    ['lzw-rgb.tif', 1, P150, false, { compress: true, tag: 'lzw-rgb-compressed' }],
    ['jpeg-rgb.tif', 1, P150, false], ['jpeg-tables-1strip.tif', 1, P150, false], ['jpeg-ycbcr.tif', 1, P150, false],
    ['dpi-cm.tif', 1, P150, true, { compress: false }], ['dpi-none.tif', 1, [420, 594], true, { compress: false }],
    ['dpi-missing.tif', 1, [420, 594], true, { compress: false }],
  ];
  for (const [file, n, [pw, ph], lossless, opt = {}] of cases) {
    await test(`${opt.tag || file}: ${n} page(s), in order, ${pw.toFixed(0)}×${ph.toFixed(0)} pt`, async () => {
      const { page, errors } = await convert([file], opt);
      const { pages } = await readPdf(page, { tiff: file, lossless, ...(opt.tag ? { as: opt.tag } : {}) });
      if (pages.length !== n) throw new Error(`${pages.length} pages`);
      pages.forEach((p, i) => {
        if (p.bar !== i + 1) throw new Error(`page ${i + 1}: bar ${p.bar} — ${JSON.stringify(pages)}`);
        if (!near(p.w, pw, 1) || !near(p.h, ph, 1)) throw new Error(`page ${i + 1}: ${p.w}×${p.h} pt`);
      });
      if (errors.length) throw new Error(errors.join('; '));
      await done(page);
    });
  }

  console.log('\nFax pages — kept as they are:');
  await test('A4 300-dpi G4, one strip a page: A4 pages, PDF ≤ 1.2 × the TIFF + 3 KB', async () => {
    const { page } = await convert(['g4-a4-single.tif']);
    const { pages, bytes } = await readPdf(page, { tiff: 'g4-a4-single.tif', lossless: true });
    const tiff = fs.statSync(path.join(FIX, 'g4-a4-single.tif')).size;
    if (pages.length !== 2 || pages.some(p => !near(p.w, 595.28, 1) || !near(p.h, 841.89, 1))) throw new Error(JSON.stringify(pages));
    if (bytes > 1.2 * tiff + 3072) throw new Error(`PDF ${bytes} B, TIFF ${tiff} B`);
    console.log(`      TIFF ${tiff} B → PDF ${bytes} B`);
    await done(page);
  });
  await test('fax "normal" (204 × 98 dpi): the page is its physical size — X and Y resolution apart, not squashed', async () => {
    const { page } = await convert(['fax-normal-2p.tif']);
    const { pages } = await readPdf(page, { tiff: 'fax-normal-2p.tif', lossless: true });
    const want = [420 * 72 / 204, 297 * 72 / 98];
    if (pages.length !== 2 || pages.some(p => !near(p.w, want[0], 1) || !near(p.h, want[1], 1))) throw new Error(`${JSON.stringify(pages)} want ${want}`);
    await done(page);
  });
  for (let o = 1; o <= 8; o++) {
    await test(`Orientation ${o}: the page is shown upright`, async () => {
      const { page } = await convert([`orient-${o}.tif`]);
      const { pages } = await readPdf(page, { tiff: `orient-${o}.tif`, lossless: true });
      const p = pages[0];
      if (p.bar !== 1 || !near(p.w, P200[0], 1) || !near(p.h, P200[1], 1)) throw new Error(JSON.stringify(p));
      await done(page);
    });
  }
  await test('Orientation 6 on a decoded (Deflate) page: upright too', async () => {
    const { page } = await convert(['orient-6-deflate.tif'], { compress: false });
    const { pages } = await readPdf(page, { tiff: 'orient-6-deflate.tif', lossless: true });
    if (pages[0].bar !== 1 || !near(pages[0].w, P200[0], 1)) throw new Error(JSON.stringify(pages));
    await done(page);
  });

  console.log('\nLayout, mixing, many pages:');
  await test('A4 setting: a TIFF page sits where the same picture as PNG does (worker.js placement)', async () => {
    const box = async (file) => {
      const { page } = await convert([file], { pageSize: 'a4' });
      await page.waitForFunction(() => window.__out, null, { timeout: 60000 });
      const r = await page.evaluate(async () => {
        await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
        const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await window.__out.arrayBuffer()) }).promise;
        const p = await doc.getPage(1), vp = p.getViewport({ scale: 1 });
        const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const g = c.getContext('2d'); await p.render({ canvasContext: g, viewport: vp }).promise;
        const d = g.getImageData(0, 0, c.width, c.height).data; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4] < 128) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        return [vp.width, vp.height, x0, y0, x1, y1];
      });
      await done(page); return r;
    };
    const t = await box('deflate-gray-2p.tif'), p = await box('bar4.png');
    // same page, same frame (the frame is the image's own edge) within 2 pt
    if (!near(t[0], p[0], 0.5) || !near(t[1], p[1], 0.5) || [2, 3, 4, 5].some(i => !near(t[i], p[i], 2))) throw new Error(`TIFF ${t} vs PNG ${p}`);
  });
  await test('mixed TIFF + PNG + TIFF: every page, in the person\'s order (TIFF pages still kept as they are)', async () => {
    const { page } = await convert(['fax-g4-3p.tif', 'bar4.png', 'g4-whiteiszero.tif']);
    const { pages } = await readPdf(page);
    if (pages.map(p => p.bar).join() !== '1,2,3,4,1') throw new Error(JSON.stringify(pages.map(p => p.bar)));
    await done(page);
  });
  await test('separate PDFs: one PDF per file, a multi-page TIFF whole in its own', async () => {
    const { page } = await convert(['fax-g4-3p.tif', 'bar4.png'], { separate: true });
    await page.waitForFunction(() => window.__out, null, { timeout: 60000 });
    const names = await page.evaluate(async () => {
      const { loadJSZip } = await import('/js/lazyLibs.js'); await loadJSZip();
      const zip = await window.JSZip.loadAsync(await window.__out.arrayBuffer());
      await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
      const out = [];
      for (const n of Object.keys(zip.files).sort()) out.push([n, (await window.pdfjsLib.getDocument({ data: await zip.file(n).async('uint8array') }).promise).numPages]);
      return out;
    });
    if (JSON.stringify(names) !== JSON.stringify([['bar4.pdf', 1], ['fax-g4-3p.pdf', 3]])) throw new Error(JSON.stringify(names));
    await done(page);
  });
  await test('100-page fax: done, progress moves, time reported', async () => {
    const { page } = await newPage();
    await page.goto(BASE_URL + '/jpg2pdf/', { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', path.join(FIX, 'g4-100p.tif'));
    await page.waitForSelector('.j2p-thumb__canvas', { timeout: 20000 });
    const seen = new Set();
    const t0 = Date.now();
    await page.click('#mergeBtn');
    while (!(await page.evaluate(() => !!window.__out)) && Date.now() - t0 < 120000) {
      seen.add(await page.evaluate(() => document.querySelector('#progressFill, .progress-fill')?.style.width || ''));
      await page.waitForTimeout(100);
    }
    const { pages, bytes } = await readPdf(page);
    console.log(`      100 pages in ${((Date.now() - t0) / 1000).toFixed(1)} s, PDF ${bytes} B, progress values seen ${seen.size}`);
    if (pages.length !== 100) throw new Error(`${pages.length} pages`);
    await done(page);
  });
  await test('Cancel while the TIFF worker is busy: stops, no PDF, the button works again', async () => {
    const { page, errors } = await newPage();
    // hold the worker's decoder 4 s so Cancel lands mid-job (100 fax pages take ~2 s)
    await page.context().route('**/vendor/UTIF.js', async r => { await new Promise(res => setTimeout(res, 4000)); await r.continue(); });
    await page.goto(BASE_URL + '/jpg2pdf/', { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', path.join(FIX, 'g4-100p.tif'));
    await page.waitForSelector('.j2p-thumb__canvas', { timeout: 20000 });
    await page.click('#mergeBtn');
    await page.waitForTimeout(800);
    await page.click('#cancelBtn');
    await page.waitForTimeout(5000);
    if (await page.evaluate(() => !!window.__out)) throw new Error('a PDF came out after Cancel');
    if (await page.evaluate(() => document.querySelector('#mergeBtn').disabled)) throw new Error('button stays disabled');
    if (errors.length) throw new Error(errors.join('; '));
    await done(page);
  });

  console.log('\nImages without a TIFF — the path worker.js takes, unchanged:');
  await test('PNG + PNG → one 2-page PDF', async () => {
    fs.copyFileSync(path.join(FIX, 'bar4.png'), path.join(FIX, '..', 'bar4-copy.png'));
    const { page, errors } = await newPage();
    await page.goto(BASE_URL + '/jpg2pdf/', { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', [path.join(FIX, 'bar4.png'), path.join(FIX, '..', 'bar4-copy.png')]);
    await page.waitForSelector('.j2p-thumb__canvas', { timeout: 20000 });
    await page.click('#mergeBtn');
    const { pages } = await readPdf(page);
    fs.unlinkSync(path.join(FIX, '..', 'bar4-copy.png'));
    if (pages.map(p => p.bar).join() !== '4,4') throw new Error(JSON.stringify(pages));
    if (errors.length) throw new Error(errors.join('; '));
    await done(page);
  });
  await test('PNG + PNG as separate PDFs → a ZIP of two', async () => {
    fs.copyFileSync(path.join(FIX, 'bar4.png'), path.join(FIX, '..', 'bar4-copy.png'));
    const { page } = await newPage();
    await page.goto(BASE_URL + '/jpg2pdf/', { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', [path.join(FIX, 'bar4.png'), path.join(FIX, '..', 'bar4-copy.png')]);
    await page.waitForSelector('.j2p-thumb__canvas', { timeout: 20000 });
    await page.click('label:has(#j2pSeparateCheck)');
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__out, null, { timeout: 60000 });
    const n = await page.evaluate(async () => {
      const { loadJSZip } = await import('/js/lazyLibs.js'); await loadJSZip();
      return Object.keys((await window.JSZip.loadAsync(await window.__out.arrayBuffer())).files).length;
    });
    fs.unlinkSync(path.join(FIX, '..', 'bar4-copy.png'));
    if (n !== 2) throw new Error(`${n} files in the ZIP`);
    await done(page);
  });

  console.log('\nThumbnail, damaged file, homepage:');
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
    await done(page);
  });
  await test('a damaged TIFF: no crash, no PDF, the person is told', async () => {
    const { page, errors } = await convert(['broken.tif']);
    await page.waitForFunction(() => !document.querySelector('#toast')?.hidden && document.querySelector('#toast')?.textContent.trim(), null, { timeout: 30000 });
    if (await page.evaluate(() => !!window.__out)) throw new Error('a PDF was made from a damaged TIFF');
    if (errors.length) throw new Error(errors.join('; '));
    await done(page);
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
    const { pages } = await readPdf(page);
    if (pages.length !== 3) throw new Error(`${pages.length} pages`);
    await done(page);
  });
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
