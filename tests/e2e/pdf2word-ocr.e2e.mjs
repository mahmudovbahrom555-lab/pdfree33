// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// PDF→Word on a scan with no text layer (2026-10-08). Such a page used to go
// into the Word file as one picture of the whole page; it is now read with the
// in-browser OCR layer (js/pdf2wordOcr.js) and rebuilt as text.
//
// Fixtures: tests/fixtures/pdf2word_scan_{ar,fa}_no_text.pdf — the Arabic and
// Persian prose ground truth (tests/corpus/groundtruth/{ar,fa}-web) printed as
// an image-only "office scan": 200 dpi, aged paper, noise, slight blur, 1.2°
// tilt, JPEG 70. Measured when written: Arabic 76 % of the words, Persian 87 %
// (Persian read with its own model), 4 of 4 / 4 of 4 paragraphs.
//
// Needs the network: the OCR engine and its language models load from the CDN
// the site itself uses. Not in the CI gate for that reason — run it before
// shipping a change to the OCR engine or the OCR layer.
//
// Run: node tests/e2e/pdf2word-ocr.e2e.mjs   (dist/ served on :8934)

import { chromium } from 'playwright';
import JSZip from 'jszip';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const GT = path.join(__dirname, '..', 'corpus', 'groundtruth');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// Arabic-script word bag: presentation forms → letters, harakat and tatweel
// out, alef/hamza forms, ى/ي, ة/ه and Persian ک/ی unified, punctuation dropped.
const norm = s => s.normalize('NFKC')
  .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
  .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ک/g, 'ك').replace(/ی/g, 'ي')
  .replace(/[\u200c\u200e\u200f]/g, '')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .split(/\s+/).filter(Boolean);

function recall(text, doc) {
  const truth = JSON.parse(readFileSync(path.join(GT, `${doc}.json`), 'utf8')).blocks.map(b => b.text).join(' ');
  const got = new Map();
  for (const w of norm(text)) got.set(w, (got.get(w) || 0) + 1);
  const words = norm(truth);
  let hit = 0;
  for (const w of words) if (got.get(w) > 0) { hit++; got.set(w, got.get(w) - 1); }
  return hit / words.length;
}

const browser = await chromium.launch();

async function convert(pdf) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => { if (blob instanceof Blob) window.__blob = blob; return orig(blob); };
    });
    await page.goto(`${BASE_URL}/pdf-to-word/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', pdf);
    await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled
      && /Output mode/.test(document.querySelector('#pdf2wordOptions')?.textContent || ''), null, { timeout: 60000 });
    const note = await (await page.waitForSelector('#p2wOcrHint', { timeout: 30000 })).textContent();
    await page.evaluate(() => { window.__blob = null; });
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__blob && /officedocument/.test(window.__blob.type), null, { timeout: 300000 });
    const b64 = await page.evaluate(async () => {
      const u = new Uint8Array(await window.__blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return btoa(s);
    });
    const xml = await (await JSZip.loadAsync(Buffer.from(b64, 'base64'))).file('word/document.xml').async('string');
    const paras = (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [])
      .map(p => [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join(''))
      .filter(t => t.trim());
    return { note, paras, text: paras.join('\n') };
  } finally {
    await ctx.close();
  }
}

console.log(`\nPDF→Word OCR layer E2E (real browser, ${BASE_URL}):`);

await test('an Arabic scan with no text layer comes out as Arabic text, not a picture of the page', async () => {
  const out = await convert(path.join(__dirname, '..', 'fixtures', 'pdf2word_scan_ar_no_text.pdf'));
  if (!/OCR/.test(out.note)) throw new Error(`the scan note should mention OCR, got ${JSON.stringify(out.note)}`);
  const r = recall(out.text, 'ar-web');
  if (r < 0.6) throw new Error(`expected at least 60% of the words, got ${(r * 100).toFixed(0)}%`);
  if (out.paras.length < 4) throw new Error(`expected the page's paragraphs, got ${out.paras.length}`);
});

await test('a Persian scan is read with the Persian model (its own letters present)', async () => {
  const out = await convert(path.join(__dirname, '..', 'fixtures', 'pdf2word_scan_fa_no_text.pdf'));
  const r = recall(out.text, 'fa-web');
  if (r < 0.6) throw new Error(`expected at least 60% of the words, got ${(r * 100).toFixed(0)}%`);
  if (!/[پچژگ]/.test(out.text)) throw new Error('no Persian-only letters — read with the Arabic model?');
});

await browser.close();
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
