// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// PDF→Word pictures on two-column pages (2026-10-02). Visual gaps are found
// among one column's lines when a page is processed column by column, but were
// cropped across the whole page width — the other column's text went into the
// Word file as pictures (4–6 per two-column ground-truth page; 39 on the
// Wikipedia article, 51 on an arXiv paper with 5 figures), Arabic glyph
// fragments became 24×14 px "pictures", and the inline scan found a full-width
// figure again in every column.
//
// Fixture tests/fixtures/pdf2word_figures_2col.pdf: Chromium print of a
// two-column page — prose, a full-width bar chart (column-span: all), prose, a
// one-column figure (an orange circle), prose. Expected: exactly those two
// pictures — the chart whole and full width, the circle inside its column.
// Ground-truth pages (tests/corpus/groundtruth/*-cols2.pdf, ar-web.pdf) have
// no pictures at all, so any picture there is a false one.
//
// Run: node tests/e2e/pdf2word-visuals.e2e.mjs   (dist/ served on :8934)

import { chromium } from 'playwright';
import JSZip from 'jszip';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'pdf2word_figures_2col.pdf');
const GT = path.join(__dirname, '..', 'corpus', 'groundtruth');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();

// Picture sizes (pt) in the .docx PDF→Word produces for `pdf`.
async function pictures(pdf) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  try {
    // the Word library straight from the fallback CDN (CDN fallback has its own test)
    await ctx.route('**://cdn.jsdelivr.net/**', r => r.abort());
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => { if (blob instanceof Blob) window.__blob = blob; return orig(blob); };
    });
    await page.goto(`${BASE_URL}/pdf-to-word/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', pdf);
    await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled
      && !/Analys/.test(document.querySelector('#toast')?.textContent || '')
      && /Output mode/.test(document.querySelector('#pdf2wordOptions')?.textContent || ''), null, { timeout: 60000 });
    await page.evaluate(() => { window.__blob = null; });
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__blob && /officedocument/.test(window.__blob.type), null, { timeout: 90000 });
    const b64 = await page.evaluate(async () => {
      const u = new Uint8Array(await window.__blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return btoa(s);
    });
    const xml = await (await JSZip.loadAsync(Buffer.from(b64, 'base64'))).file('word/document.xml').async('string');
    return [...xml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)].map(m => ({ w: m[1] / 12700, h: m[2] / 12700 }));
  } finally {
    await ctx.close();
  }
}

console.log(`\nPDF→Word pictures E2E (real browser, ${BASE_URL}):`);

await test('a full-width figure comes out whole and once, a column figure inside its column', async () => {
  const pics = await pictures(FIXTURE);
  if (pics.length !== 2) throw new Error(`expected 2 pictures, got ${pics.length}: ${JSON.stringify(pics.map(p => `${Math.round(p.w)}x${Math.round(p.h)}`))}`);
  const [wide, col] = [...pics].sort((a, b) => b.w - a.w);
  if (wide.w < 400) throw new Error(`the full-width chart should span the page, got ${Math.round(wide.w)}pt`);
  if (col.w > 260) throw new Error(`the column figure should stay inside its column, got ${Math.round(col.w)}pt`);
});

for (const name of ['en-cols2', 'ar-cols2', 'he-cols2', 'ar-web']) {
  await test(`${name}: no pictures in a document that has none (no column text, no glyph fragments)`, async () => {
    const pics = await pictures(path.join(GT, `${name}.pdf`));
    if (pics.length) throw new Error(`got ${pics.length} false picture(s): ${JSON.stringify(pics.map(p => `${Math.round(p.w)}x${Math.round(p.h)}`))}`);
  });
}

await browser.close();
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
