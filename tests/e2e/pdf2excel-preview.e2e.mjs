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
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
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

const browser = await chromium.launch(process.env.PDFREE_BROWSER_CHANNEL ? {channel:process.env.PDFREE_BROWSER_CHANNEL} : {});

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

async function open(viewport, input = PDF) {
  const page = await (await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, ...(viewport ? { viewport } : {}) })).newPage();
  if (process.env.PDFREE_EXCELJS_PATH) await page.route('**/exceljs@4.4.0/dist/exceljs.min.js', route => route.fulfill({path:process.env.PDFREE_EXCELJS_PATH,contentType:'application/javascript',headers:{'access-control-allow-origin':'*'}}));
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE_URL + '/pdf-to-excel/', { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', input);
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

await test('source fills, text colour and size reach a valid XLSX without changing numbers', async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const source = pdf.addPage([400,400]);
  [['Item','Qty'],['Paper','42'],['Ink','7']].forEach((row,r) => {
    row.forEach((text,c) => {
      source.drawRectangle({x:40+c*140,y:320-r*30,width:140,height:30,
        color:r===0 ? rgb(0.2,0.4,0.6) : rgb(1,1,1),borderColor:rgb(0,0,0),borderWidth:1});
      source.drawText(text,{x:45+c*140,y:330-r*30,size:12,font:r===0?bold:font,
        color:r===0?rgb(1,1,1):rgb(0,0,0)});
    });
  });
  const input={name:'styles.pdf',mimeType:'application/pdf',buffer:Buffer.from(await pdf.save())};
  const {page,errors}=await open(undefined,input);
  const file=await convert(page);
  const zip=await JSZip.loadAsync(fs.readFileSync(file));
  const styles=await zip.file('xl/styles.xml').async('string');
  if (!styles.includes('FF336699') || !styles.includes('FFFFFFFF')) throw new Error('source header colours missing');
  if (!styles.includes('<sz val="12"')) throw new Error('source font size missing');
  for (const match of styles.matchAll(/rgb="([^"]*)"/g)) if (!/^[0-9A-F]{8}$/i.test(match[1])) throw new Error('invalid XLSX colour: '+match[1]);
  const c=await cells(file);
  if(c.B2!==42||c.B3!==7)throw new Error('numeric cells changed');
  const paint=await page.locator('#p2ePreview th').first().evaluate(el=>({background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}));
  if(paint.background!=='rgb(51, 102, 153)'||paint.color!=='rgb(255, 255, 255)')throw new Error('preview does not match file: '+JSON.stringify(paint));
  if(errors.length)throw new Error(errors.join('; '));
  const {page:phone}=await open({width:390,height:844},input);
  await convert(phone);
  const layout=await phone.locator('.p2e-preview-scroll').evaluate(el=>{
    el.scrollLeft=el.scrollWidth;
    return {scroll:el.scrollLeft,pageWidth:document.documentElement.scrollWidth,viewport:innerWidth};
  });
  if(layout.scroll<=0||layout.pageWidth>layout.viewport)throw new Error('table must scroll inside the phone preview: '+JSON.stringify(layout));
});

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
