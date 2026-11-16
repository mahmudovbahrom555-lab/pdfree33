// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/pdf2excel-preview.e2e.mjs — PDF→Excel result preview
//  (2026-11-17).
//
//  The file still downloads by itself like every tool's result; the card
//  shows the first rows of each table next to it. The number format
//  (Auto / comma / dot) decides how "1,234" is read: Auto follows the
//  table's own unambiguous numbers ("12,50" ⇒ comma is decimal ⇒ 1.234),
//  a choice overrides them. Changing the format hides the old result.
//  Values are read from the downloaded .xlsx itself.
//
//  Run: node tests/e2e/pdf2excel-preview.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';
import JSZip from 'jszip';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const PDF = path.join(__dirname, '..', 'fixtures', 'pdf2excel', 'amounts.pdf');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// cell text of the first table sheet, keyed "A1"
async function cells(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const shared = [...((await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '').matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map(m => m[1]);
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const out = {};
  for (const m of xml.matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>(.*?)<\/c>)/g)) {
    const v = /<v>([^<]*)<\/v>/.exec(m[3] ?? '')?.[1];
    if (v === undefined) continue;
    out[m[1]] = /t="s"/.test(m[2]) ? shared[+v] : Number(v);
  }
  return out;
}

const browser = await chromium.launch();

async function convert(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.click('#mergeBtn'),
  ]);
  const file = path.join(fs.mkdtempSync('/tmp/p2e-'), 'out.xlsx');
  await download.saveAs(file);
  await page.waitForSelector('#p2ePreview', { state: 'visible', timeout: 10000 });
  return file;
}

async function open(viewport) {
  const page = await (await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, ...(viewport ? { viewport } : {}) })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE_URL + '/pdf-to-excel/', { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', PDF);
  await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  return { page, errors };
}

await test('the XLSX downloads by itself and the preview shows the table', async () => {
  const { page, errors } = await open();
  const file = await convert(page);
  const preview = await page.$eval('#p2ePreview', el => el.innerText);
  if (!/Paper/.test(preview) || !/Ink/.test(preview)) throw new Error(`preview: ${preview.slice(0, 200)}`);
  const c = await cells(file);
  // Auto: "12,50" in the same table says the comma is decimal
  if (c.B2 !== 1.234 || c.B3 !== 12.5) throw new Error(`Auto read B2=${c.B2} B3=${c.B3}`);
  if (errors.length) throw new Error(errors.join('; '));
});

await test('choosing "dot" hides the old result; converting again reads 1,234 as 1234', async () => {
  const { page } = await open();
  await convert(page);
  await page.selectOption('#p2eDecimalSeparator', 'dot');
  if (await page.isVisible('#successCard')) throw new Error('old result still shown after the format changed');
  const c = await cells(await convert(page));
  if (c.B2 !== 1234 || c.B3 !== 12.5) throw new Error(`dot read B2=${c.B2} B3=${c.B3}`);
});

await test('phone 390×844: downloads by itself, preview visible', async () => {
  const { page } = await open({ width: 390, height: 844 });
  const c = await cells(await convert(page));
  if (c.A2 !== 'Paper') throw new Error(`A2=${c.A2}`);
});

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
