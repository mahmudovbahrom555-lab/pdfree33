// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// PDF→Excel takes many files at once (2026-11-18). It read only the first
// one: people converted 65, 103, 188 PDFs a session one by one — 79 % of the
// next runs began within 25 s of the last download (Analytics Engine, 30
// days). Now 2+ files go through the same queue as Compress and Protect and
// come back as one ZIP of .xlsx files; one file is converted as before.
//
// Run: node tests/e2e/pdf2excel-batch.e2e.mjs   (dist/ served on :8934)

import { chromium } from 'playwright';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// a page holding one ruled table whose cells carry `tag`
async function tablePdf(tag) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const cols = [60, 220, 380, 540], top = 760, rowH = 24;
  const rows = [['Item', 'Qty', 'Price'], ...Array.from({ length: 6 }, (_, r) => [`${tag}-${r + 1}`, String(r + 2), `${(r + 1) * 12}.50`])];
  rows.forEach((row, r) => {
    const y = top - r * rowH;
    page.drawLine({ start: { x: cols[0], y: y + 8 }, end: { x: cols[3], y: y + 8 }, thickness: 0.8 });
    row.forEach((text, c) => page.drawText(text, { x: cols[c] + 6, y: y - 8, size: 10, font }));
  });
  const bottom = top - rows.length * rowH + 8;
  page.drawLine({ start: { x: cols[0], y: bottom }, end: { x: cols[3], y: bottom }, thickness: 0.8 });
  for (const x of cols) page.drawLine({ start: { x, y: top + 8 }, end: { x, y: bottom }, thickness: 0.8 });
  return Buffer.from(await doc.save());
}

const browser = await chromium.launch();

// the Blob the tool hands to the download, as bytes, for `files`
async function convert(files, typeRe) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await ctx.newPage();
    await page.addInitScript(re => {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = b => { if (b instanceof Blob && new RegExp(re).test(b.type)) window.__res = b; return orig(b); };
      document.addEventListener('pdfree:error', e => { window.__error = e.detail.message; });
    }, typeRe.source);
    await page.goto(`${BASE_URL}/pdf-to-excel/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', files);
    await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__res || window.__error, null, { timeout: 180000 });
    const err = await page.evaluate(() => window.__error);
    if (err) throw new Error(`the tool failed: ${err}`);
    const b64 = await page.evaluate(async () => {
      const u = new Uint8Array(await window.__res.arrayBuffer());
      let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return btoa(s);
    });
    return { bytes: Buffer.from(b64, 'base64'), hasPreview: await page.evaluate(() => !!document.querySelector('#p2ePreview')) };
  } finally {
    await ctx.close();
  }
}

// every XML part of an .xlsx, joined: where its cells' text is
async function xlsxText(bytes) {
  const x = await JSZip.loadAsync(bytes);
  const parts = await Promise.all(Object.keys(x.files).filter(n => n.endsWith('.xml')).map(n => x.file(n).async('string')));
  return parts.join('\n');
}

console.log(`\nPDF→Excel batch E2E (real browser, ${BASE_URL}):`);

const [a, b, c] = await Promise.all(['Alpha', 'Bravo', 'Charlie'].map(tablePdf));

await test('three PDFs → one ZIP of three .xlsx, each with its own table', async () => {
  const { bytes } = await convert([
    { name: 'march.pdf', mimeType: 'application/pdf', buffer: a },
    { name: 'april.pdf', mimeType: 'application/pdf', buffer: b },
    { name: 'may.pdf', mimeType: 'application/pdf', buffer: c },
  ], /zip/);
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).sort();
  if (JSON.stringify(names) !== JSON.stringify(['april.xlsx', 'march.xlsx', 'may.xlsx'])) throw new Error(`ZIP holds ${JSON.stringify(names)}`);
  for (const [name, tag] of [['march.xlsx', 'Alpha'], ['april.xlsx', 'Bravo'], ['may.xlsx', 'Charlie']]) {
    const text = await xlsxText(await zip.file(name).async('uint8array'));
    if (!text.includes(`${tag}-1`) || !text.includes(`${tag}-6`)) throw new Error(`${name} lacks its table (${tag}-1 … ${tag}-6)`);
    for (const other of ['Alpha', 'Bravo', 'Charlie'].filter(t => t !== tag)) {
      if (text.includes(`${other}-1`)) throw new Error(`${name} holds ${other}'s table too`);
    }
  }
});

await test('two files of one name come back as two files, not one over the other', async () => {
  // two different files (sizes differ): one name, size and time is one file
  // chosen twice, which the file list keeps once (files.js)
  const { bytes } = await convert([
    { name: 'report.pdf', mimeType: 'application/pdf', buffer: a },
    { name: 'report.pdf', mimeType: 'application/pdf', buffer: c },
  ], /zip/);
  const names = Object.keys((await JSZip.loadAsync(bytes)).files).sort();
  if (JSON.stringify(names) !== JSON.stringify(['report (2).xlsx', 'report.xlsx'])) throw new Error(`ZIP holds ${JSON.stringify(names)}`);
});

await test('one file is converted as before: an .xlsx, its tables previewed', async () => {
  const { bytes, hasPreview } = await convert([{ name: 'single.pdf', mimeType: 'application/pdf', buffer: a }], /spreadsheetml/);
  const text = await xlsxText(bytes);
  if (!text.includes('Alpha-1')) throw new Error('the .xlsx lacks the table');
  if (!hasPreview) throw new Error('the table preview is gone from the result');
});

await browser.close();
console.log(`\n${'─'.repeat(40)}\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed) process.exit(1);
