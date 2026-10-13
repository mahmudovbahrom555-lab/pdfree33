// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/nup.e2e.mjs — Pages per Sheet in a real browser (2026-10-13).
//
//  The tool exists because of on-site searches that found nothing ("Put
//  multiple pages on one page", "combine every two pages in one") and the
//  Chinese chore of printing invoices two to an A4 sheet. This checks the
//  golden path (file + one click), the invoices mode with several files,
//  the Chinese page, and that the homepage search now finds the tool.
//  Output checked through pdf.js: page count, page size, text kept.
//
//  Fixtures: tests/fixtures/nup/ — five-pages.pdf ("Page N TOP"), two
//  240 × 140 mm invoices (embedded CJK font: pdf.js can't read a
//  non-embedded one back), form-annots.pdf (a filled-in text field, a
//  FreeText note, a hidden note).
//  Run: node tests/e2e/nup.e2e.mjs   (dist/ served on :8934)
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
async function openTool(urlPath, files) {
  const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (b instanceof Blob && /pdf/.test(b.type)) window.__pdf = b; return orig(b); };
  });
  await page.goto(BASE_URL + urlPath, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', files.map(f => path.join(FIX, f)));
  await page.waitForSelector('#nupPreview svg', { timeout: 30000 });
  return { page, errors };
}
// the result, read back with the page's own pdf.js
async function result(page) {
  await page.waitForFunction(() => window.__pdf, null, { timeout: 60000 });
  return page.evaluate(async () => {
    await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await window.__pdf.arrayBuffer()) }).promise;
    const sheets = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const vp = p.getViewport({ scale: 1 });
      sheets.push({ w: Math.round(vp.width), h: Math.round(vp.height), text: (await p.getTextContent()).items.map(t => t.str).join(' ') });
    }
    return sheets;
  });
}

try {
  await test('five pages, defaults (2 per sheet), one click: 3 landscape A4 sheets, text kept', async () => {
    const { page, errors } = await openTool('/pages-per-sheet/', ['five-pages.pdf']);
    await page.click('#mergeBtn');
    const sheets = await result(page);
    if (sheets.length !== 3) throw new Error(`${sheets.length} sheets`);
    if (!(sheets[0].w === 842 && sheets[0].h === 595)) throw new Error(`sheet ${sheets[0].w}×${sheets[0].h}`);
    if (!/Page 1 TOP/.test(sheets[0].text) || !/Page 2 TOP/.test(sheets[0].text) || !/Page 5 TOP/.test(sheets[2].text)) throw new Error(sheets.map(s => s.text).join(' | '));
    if (errors.length) throw new Error(errors.join('; '));
  });

  await test('4 per sheet: two sheets, the preview shows pages 1–4', async () => {
    const { page } = await openTool('/pages-per-sheet/', ['five-pages.pdf']);
    await page.click('label[data-name="nupPerSheet"][data-value="4"]');
    const labels = await page.$$eval('#nupPreview text', ts => ts.map(t => t.textContent));
    if (labels.join() !== '1,2,3,4') throw new Error(`preview ${labels}`);
    await page.click('#mergeBtn');
    const sheets = await result(page);
    if (sheets.length !== 2) throw new Error(`${sheets.length} sheets`);
  });

  await test('invoices on A4, two files: one portrait A4 sheet with both invoices', async () => {
    const { page } = await openTool('/pages-per-sheet/', ['invoice-1.pdf', 'invoice-2.pdf']);
    await page.click('label[data-name="nupMode"][data-value="invoices"]');
    await page.waitForSelector('#nupPreview svg');
    await page.click('#mergeBtn');
    const sheets = await result(page);
    if (sheets.length !== 1) throw new Error(`${sheets.length} sheets`);
    if (!(sheets[0].w === 595 && sheets[0].h === 842)) throw new Error(`sheet ${sheets[0].w}×${sheets[0].h}`);
    if (!/INVOICE 1/.test(sheets[0].text) || !/INVOICE 2/.test(sheets[0].text)) throw new Error(sheets[0].text);
  });

  // embedPage() alone drops annotations: a filled-in field, a stamp, an
  // invoice's seal would be gone from the sheet
  await test('filled-in form values and notes stay on the sheet, hidden ones stay hidden', async () => {
    const { page } = await openTool('/pages-per-sheet/', ['form-annots.pdf', 'five-pages.pdf']);
    await page.click('#mergeBtn');
    const { text } = (await result(page))[0];
    for (const s of ['FORM PAGE BODY', 'FILLED VALUE', 'STAMPED NOTE']) if (!text.includes(s)) throw new Error(`no "${s}": ${text}`);
    if (text.includes('HIDDEN NOTE')) throw new Error(`hidden note shown: ${text}`);
  });

  await test('the Chinese page (发票合并打印) runs the same tool', async () => {
    const { page } = await openTool('/zh/fapiao-hebing-dayin/', ['invoice-1.pdf', 'invoice-2.pdf']);
    await page.click('#mergeBtn');
    const sheets = await result(page);
    if (!/发票/.test(sheets[0].text)) throw new Error(sheets[0].text);
  });

  await test('homepage search finds it: "multiple pages on one page", and 发票合并打印 on /zh/', async () => {
    const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
    for (const [p, q] of [['/', 'multiple pages on one page'], ['/', 'combine every two pages in one'], ['/zh/', '发票合并打印']]) {
      await page.goto(BASE_URL + p, { waitUntil: 'load' });
      await page.evaluate(q => { const el = document.querySelector('#toolSearch'); el.value = q; el.dispatchEvent(new InputEvent('input', { data: q })); }, q);
      await page.waitForTimeout(500);
      const name = await page.evaluate(() => document.querySelector('#searchResult')?.hidden ? '' : document.querySelector('#srName')?.innerText);
      if (!/Pages per Sheet|多页合一/.test(name)) throw new Error(`"${q}" → "${name}"`);
    }
  });
} finally {
  await browser.close();
}

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
