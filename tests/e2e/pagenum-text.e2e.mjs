// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/pagenum-text.e2e.mjs — Page Numbers: text around the number,
//  colour, font (2026-11-05).
//
//  A user asked for "第 1 页" and a colour; the tool page promised a
//  prefix/suffix that the panel didn't have, and the worker's Helvetica
//  can't write Chinese at all. This checks: plain numbers still go through
//  worker.js (pageNumWorker.js is only used when text/colour/font is set);
//  the 第 … 页 chip writes real, extractable Chinese in the chosen colour;
//  a typed prefix/suffix in Serif; Arabic text is refused with a clear
//  message; a batch; and the new controls' tap size on a phone.
//
//  Fixtures: tests/fixtures/nup/five-pages.pdf ("Page N TOP"), form-annots.pdf
//  (a second, different file for the batch — the same file twice is one file).
//  Run: node tests/e2e/pagenum-text.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const FIX = path.join(__dirname, '..', 'fixtures', 'nup');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();
async function openTool(files, viewport = { width: 1280, height: 900 }, urlPath = '/pagenum-pdf/') {
  const page = await (await browser.newContext({ serviceWorkers: 'block', viewport })).newPage();
  const errors = [], workers = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('worker', w => workers.push(w.url()));
  await page.addInitScript(() => {
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (b instanceof Blob && /pdf|zip/.test(b.type)) window.__out = b; return orig(b); };
  });
  await page.goto(BASE_URL + urlPath, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', files.map(f => path.join(FIX, f)));
  await page.waitForSelector('#pnPrefix', { timeout: 30000 });
  return { page, errors, workers };
}
// text of each page's bottom band and how many blue pixels it has, read with the page's own pdf.js
async function result(page) {
  await page.waitForFunction(() => window.__out, null, { timeout: 90000 });
  return page.evaluate(async () => {
    await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await window.__out.arrayBuffer()) }).promise;
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const vp = p.getViewport({ scale: 2 });
      const items = (await p.getTextContent()).items;
      const bottom = items.filter(t => t.transform[5] < 60).map(t => t.str).join('').replace(/\s+/g, ' ').trim();
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      const d = c.getContext('2d').getImageData(0, vp.height - 120, vp.width, 120).data;
      let blue = 0, minX = Infinity, maxX = -1;
      for (let k = 0; k < d.length; k += 4) {
        if (d[k + 2] > 120 && d[k + 2] - d[k] > 60) { blue++; const x = (k / 4) % vp.width; minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
      }
      // what the eye sees: the BLUE label's drawn width in em (10 pt at scale 2 = 20 px) — only the
      // label is blue; any dark pixel would count the page's own text too (17 em, a false pass)
      out.push({ bottom, blue, inkEm: maxX < 0 ? 0 : (maxX - minX + 1) / 20 });
    }
    return out;
  });
}

try {
  await test('plain numbers: one click, numbered 1…5, still drawn by worker.js (no pageNumWorker)', async () => {
    const { page, errors, workers } = await openTool(['five-pages.pdf']);
    await page.click('#mergeBtn');
    const pages = await result(page);
    if (pages.map(p => p.bottom).join(',') !== '1,2,3,4,5') throw new Error(pages.map(p => p.bottom).join(','));
    if (workers.some(u => /pageNumWorker/.test(u))) throw new Error('pageNumWorker used for plain numbers');
    if (errors.length) throw new Error(errors.join('; '));
  });

  await test('the 第 1 页 chip + blue: real Chinese text "第 1 页" … "第 5 页", drawn blue', async () => {
    const { page, errors, workers } = await openTool(['five-pages.pdf']);
    await page.click('label[data-name="pnTpl"][data-value="zh"]');
    await page.click('label[data-name="pnColor"][data-value="#1d4ed8"]');
    if (await page.inputValue('#pnPrefix') !== '第 ' || await page.inputValue('#pnSuffix') !== ' 页') throw new Error('chip did not fill the fields');
    const mock = await page.textContent('.pn-mock-page__num');
    if (!/第\s*1\s*页/.test(mock)) throw new Error(`preview shows "${mock}"`);
    await page.click('#mergeBtn');
    const pages = await result(page);
    const want = [1, 2, 3, 4, 5].map(n => `第 ${n} 页`);
    if (pages.map(p => p.bottom).join('|') !== want.join('|')) throw new Error(pages.map(p => p.bottom).join('|'));
    if (pages.some(p => p.blue < 20)) throw new Error('not blue: ' + pages.map(p => p.blue).join(','));
    // every glyph drawn, not just the first: "第 1 页" is ~3 em wide, "第" alone 1 em (pdfree.io 2026-11-05)
    if (pages.some(p => p.inkEm < 2.4)) throw new Error('glyphs missing, drawn width in em: ' + pages.map(p => p.inkEm.toFixed(1)).join(','));
    if (!workers.some(u => /pageNumWorker/.test(u))) throw new Error('pageNumWorker not used');
    if (errors.length) throw new Error(errors.join('; '));
  });

  await test('typed prefix/suffix in Serif: "Page 1 of 5", the grey default when no colour is picked', async () => {
    const { page } = await openTool(['five-pages.pdf']);
    await page.fill('#pnPrefix', 'Page ');
    await page.fill('#pnSuffix', ' of 5');
    await page.click('label[data-name="pnFont"][data-value="serif"]');
    await page.click('#mergeBtn');
    const pages = await result(page);
    if (pages[0].bottom !== 'Page 1 of 5' || pages[4].bottom !== 'Page 5 of 5') throw new Error(pages.map(p => p.bottom).join('|'));
    if (pages.some(p => p.blue > 5)) throw new Error('coloured without a colour picked');
  });

  await test('lowercase Roman (thesis front matter): i, ii, iii, iv, v', async () => {
    const { page } = await openTool(['five-pages.pdf']);
    await page.click('label[data-name="pnFmt"][data-value="roman-lower"]');
    await page.click('#mergeBtn');
    const pages = await result(page);
    if (pages.map(p => p.bottom).join(',') !== 'i,ii,iii,iv,v') throw new Error(pages.map(p => p.bottom).join(','));
  });

  await test('a character no page-label font has (蘿), and Devanagari: drawn, every page, no error', async () => {
    for (const prefix of ['蘿 ', 'पृष्ठ ']) {
      const { page, errors } = await openTool(['five-pages.pdf']);
      await page.fill('#pnPrefix', prefix);
      await page.click('label[data-name="pnColor"][data-value="#1d4ed8"]');
      await page.click('#mergeBtn');
      const pages = await result(page);
      if (pages.length !== 5 || pages.some(p => p.inkEm < 1.6)) throw new Error(`${prefix}: drawn width ` + pages.map(p => p.inkEm.toFixed(1)).join(','));
      if (errors.length) throw new Error(errors.join('; '));
    }
  });

  await test('Arabic around the number: a clear message, no download', async () => {
    const { page } = await openTool(['five-pages.pdf']);
    await page.fill('#pnPrefix', 'صفحة ');
    await page.click('#mergeBtn');
    await page.waitForFunction(() => { const t = document.querySelector('#toast'); return t && !t.hidden && /right-to-left/i.test(t.innerText); }, null, { timeout: 30000 });
    if (await page.evaluate(() => !!window.__out)) throw new Error('a file was produced');
  });

  await test('font cannot be downloaded (offline on first use): a clear message, no download', async () => {
    const { page } = await openTool(['five-pages.pdf']);
    await page.route('**/fonts/pagenum/**', r => r.abort());
    await page.click('label[data-name="pnTpl"][data-value="zh"]');
    await page.click('#mergeBtn');
    await page.waitForFunction(() => { const t = document.querySelector('#toast'); return t && !t.hidden && /Noto Sans/.test(t.innerText) && /connection/i.test(t.innerText); }, null, { timeout: 30000 });
    if (await page.evaluate(() => !!window.__out)) throw new Error('a file was produced');
  });

  await test('batch of two files with a prefix: a ZIP with both, no error', async () => {
    const { page, errors } = await openTool(['five-pages.pdf', 'form-annots.pdf']);
    await page.fill('#pnPrefix', 'p. ');
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__out && /zip/.test(window.__out.type), null, { timeout: 90000 });
    const n = await page.evaluate(async () => {
      const JSZip = window.JSZip; const z = await JSZip.loadAsync(await window.__out.arrayBuffer());
      return Object.keys(z.files).length;
    });
    if (n !== 2) throw new Error(`${n} files in the zip`);
    if (errors.length) throw new Error(errors.join('; '));
  });

  await test('the "Page 1" chip speaks the page\'s language; none that would be refused; no repeats', async () => {
    const chips = async (urlPath) => {
      const { page } = await openTool(['five-pages.pdf'], undefined, urlPath);
      return page.$$eval('[data-name="pnTpl"]', els => els.map(e => e.textContent.trim()));
    };
    const zh = await chips('/zh/yema-pdf/'), ar = await chips('/ar/tarqim-pdf/'), en = await chips('/pagenum-pdf/');
    if (zh.filter(x => /第\s*1\s*页/.test(x)).length !== 1) throw new Error('zh: ' + zh.join(' | '));
    if (zh.some(x => /页\s*1$/.test(x))) throw new Error('zh chip lost the place of the number: ' + zh.join(' | '));
    if (ar.some(x => /[\u0600-\u06FF]/.test(x))) throw new Error('ar offers Arabic text: ' + ar.join(' | '));
    if (!en.includes('Page 1')) throw new Error('en: ' + en.join(' | '));
  });

  await test('phone (390 px): the new chips and fields are at least 24 px tall and fit the screen', async () => {
    const { page } = await openTool(['five-pages.pdf'], { width: 390, height: 664 });
    const r = await page.evaluate(() => {
      const els = [...document.querySelectorAll('[data-name="pnTpl"], [data-name="pnColor"], [data-name="pnFont"], #pnPrefix, #pnSuffix')];
      return { small: els.filter(e => e.getBoundingClientRect().height < 24).length, n: els.length,
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    if (!r.n || r.small) throw new Error(JSON.stringify(r));
    if (r.overflow) throw new Error('page scrolls sideways');
  });
} finally {
  await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
