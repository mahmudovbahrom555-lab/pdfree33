// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// A primary CDN that HANGS (no error, no response) must not hang the tool.
// Real case 2026-10-01: cdn.jsdelivr.net stopped answering for minutes while
// unpkg answered in ~1s; js/lazyLibs.js only fell back on a script error, so
// PDF→Word sat on "Loading libraries…" until jsdelivr came back. Here jsdelivr
// requests are held open forever and PDF→Excel (ExcelJS, still on the CDN
// pair) must still produce a .xlsx via the fallback CDN (after lazyLibs'
// CDN_TIMEOUT_MS).
//
// And the libraries pdfree.io serves itself (2026-10-24: pdf-lib, JSZip,
// docx — 16 people couldn't load them from a CDN, 8 in China/Hong Kong):
// with every CDN refused, PDF→Word still makes a .docx and Split a .zip; a
// load cut once by the network works on the next press; and opening pages
// downloads none of them.
//
// Run: node tests/e2e/cdn-fallback.e2e.mjs   (needs dist/ served on :8934)

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const PDF = path.join(__dirname, '..', 'fixtures', 'normal-1page.pdf');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

console.log(`\nCDN fallback E2E (real browser, ${BASE_URL}):`);
const browser = await chromium.launch();

await test('PDF→Excel still converts when the primary CDN (jsdelivr) hangs forever', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const fallbackHits = [];
  // never fulfilled, never aborted: a CDN that accepted the connection and went silent
  await page.route('**://cdn.jsdelivr.net/**', () => {});
  page.on('response', r => { if (r.url().includes('unpkg.com')) fallbackHits.push(r.status()); });
  await page.addInitScript(() => {
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { if (blob instanceof Blob) window.__blob = blob; return orig(blob); };
  });
  try {
    await page.goto(`${BASE_URL}/pdf-to-excel/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', PDF);
    await page.waitForTimeout(1500);
    await page.evaluate(() => { window.__blob = null; });
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__blob && /spreadsheetml/.test(window.__blob.type), null, { timeout: 90000 })
      .catch(() => { throw new Error('no .xlsx within 90s — the hanging CDN blocked the tool'); });
    if (!fallbackHits.includes(200)) throw new Error(`expected the library from the fallback CDN, got ${JSON.stringify(fallbackHits)}`);
  } finally {
    await context.close();
  }
});


for (const [tool, url, files, type] of [
  ['PDF→Word makes a .docx', '/pdf-to-word/', [PDF], /officedocument\.wordprocessingml/],
  ['Split makes a .zip', '/split-pdf/', [path.join(__dirname, '..', 'fixtures', 'normal-3page.pdf')], /zip/],
]) {
  await test(`with every CDN refused, ${tool} (its libraries come from pdfree.io)`, async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const cdn = [];
    for (const host of ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com']) {
      await page.route(`**://${host}/**`, r => {
        // pdf.js itself still comes from cdnjs (a separate step); everything else is refused
        if (/pdf\.js\/3\.11\.174\/pdf\.min\.js$/.test(r.request().url())) return r.continue();
        cdn.push(r.request().url()); return r.abort();
      });
    }
    await page.addInitScript(() => {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => { if (blob instanceof Blob) window.__blob = blob; return orig(blob); };
      document.addEventListener('pdfree:error', e => { window.__error = e.detail.message; });
    });
    try {
      await page.goto(BASE_URL + url, { waitUntil: 'load' });
      await page.setInputFiles('#fileInput', files);
      await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 30000 });
      await page.waitForTimeout(1500);
      await page.evaluate(() => { window.__blob = null; });
      await page.click('#mergeBtn');
      await page.waitForFunction(t => (window.__blob && new RegExp(t).test(window.__blob.type)) || window.__error, type.source, { timeout: 90000 });
      const err = await page.evaluate(() => window.__error);
      if (err) throw new Error(`${err} — refused: ${cdn.join(', ')}`);
    } finally {
      await context.close();
    }
  });
}


await test('a library that failed to load once (network blip) loads on the next press, no reload', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  let refused = 0;
  await page.route('**/js/vendor/jszip.min.js', r => { if (refused++ === 0) return r.abort(); return r.continue(); });
  await page.addInitScript(() => {
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { if (blob instanceof Blob && /zip/.test(blob.type)) window.__blob = blob; return orig(blob); };
    document.addEventListener('pdfree:error', e => { window.__error = e.detail.message; });
  });
  try {
    await page.goto(`${BASE_URL}/split-pdf/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', path.join(__dirname, '..', 'fixtures', 'normal-3page.pdf'));
    await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__error || window.__blob, null, { timeout: 60000 });
    if (await page.evaluate(() => !!window.__blob)) throw new Error('the first load was not refused — the test is not testing anything');
    await page.evaluate(() => { window.__error = null; });
    await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 30000 });
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__error || window.__blob, null, { timeout: 60000 });
    const err = await page.evaluate(() => window.__error);
    if (err) throw new Error(`second press failed too: ${err}`);
  } finally {
    await context.close();
  }
});

await test('opening pages loads none of them: docx and JSZip wait for the tool that needs them', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const seen = [];
  page.on('request', r => { if (/vendor\/(docx\.umd|jszip\.min)\.js/.test(r.url())) seen.push(r.url()); });
  try {
    for (const url of ['/', '/pdf-to-word/', '/split-pdf/', '/merge-pdf/']) {
      await page.goto(BASE_URL + url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1500);
    }
    if (seen.length) throw new Error(`loaded without being needed: ${seen.join(', ')}`);
  } finally {
    await context.close();
  }
});

await browser.close();
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
