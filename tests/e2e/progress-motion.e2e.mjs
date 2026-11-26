// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// The process button keeps moving while a tool works (2026-11-17). Its fill
// moves only when the real percent does, and PDF→Word sat at one percent for
// 44 s while it found a scan's language — the button looked stuck, with
// "Reading page 1/16" under it, and people left before the end (Analytics:
// 4 of 23 who pressed got no result, no error, no cancel). Now a light runs
// through the fill the whole time, and the step says what it is.
//
// Fixture: tests/fixtures/pdf2word_scan_ar_no_text.pdf — an Arabic scan with no
// text layer, read by OCR (the Tesseract model comes from the network).
//
// Run: node tests/e2e/progress-motion.e2e.mjs   (dist/ served on :8934)

import { chromium } from 'playwright';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import zlib from 'zlib';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const SCAN = path.join(__dirname, '..', 'fixtures', 'pdf2word_scan_ar_no_text.pdf');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();

console.log(`\nProcess button motion E2E (real browser, ${BASE_URL}):`);

// Compress (2026-11-26): the pre-pass works image by image before the main
// worker starts, and the bar sat at "Loading PDF..." for 100 s on a 34 MB
// report (pdfree.io); 25 people a week left Compress there, on average after
// 106 s. Now the pre-pass names the image it is on and the bar moves.
async function cmykImagesPdf(n) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const W = 900, H = 600, xo = {};
  let ops = '';
  for (let k = 0; k < n; k++) {
    const px = Buffer.alloc(W * H * 4);
    for (let i = 0; i < px.length; i++) px[i] = (i * (k + 7) + (i >> 9)) % 251;
    xo[`Im${k}`] = pdf.context.register(PDFRawStream.of(pdf.context.obj({ Type: 'XObject', Subtype: 'Image', Width: W, Height: H,
      ColorSpace: 'DeviceCMYK', BitsPerComponent: 8, Filter: 'FlateDecode' }), zlib.deflateSync(px)));
    ops += `q 90 0 0 60 ${20 + (k % 6) * 95} ${20 + Math.floor(k / 6) * 70} cm /Im${k} Do Q\n`;   // 900 px over 1.25 in: 720 ppi
  }
  page.node.set(PDFName.of('Resources'), pdf.context.obj({ XObject: xo }));
  page.node.set(PDFName.of('Contents'), pdf.context.register(PDFRawStream.of(pdf.context.obj({}), Buffer.from(ops))));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prog-')), 'cmyk-images.pdf');
  fs.writeFileSync(file, await pdf.save());
  return file;
}
await test('Compress: the pre-pass counts its images and the bar moves before the main step', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await ctx.newPage();
    await page.goto(`${BASE_URL}/compress-pdf/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', await cmykImagesPdf(24));
    await page.waitForTimeout(3000);
    await page.click('label[data-preset="medium"]');
    await page.evaluate(() => {
      window.__steps = [];
      setInterval(() => window.__steps.push([(document.querySelector('#progressLabel')?.textContent || '').trim(),
        parseFloat(document.querySelector('#progressFill')?.style.width) || 0]), 100);
    });
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__steps.some(([l]) => /^Done/.test(l)), null, { timeout: 180000 });
    const steps = await page.evaluate(() => window.__steps);
    const prep = steps.filter(([l]) => /image \d+ of \d+/i.test(l) && !/Recompressing/.test(l));
    if (!prep.length) throw new Error(`no pre-pass image count shown — labels: ${JSON.stringify([...new Set(steps.map(s => s[0]))])}`);
    const pcts = [...new Set(prep.map(s => s[1]))];
    if (pcts.length < 3) throw new Error(`the bar didn't move in the pre-pass: ${JSON.stringify(pcts)}`);
    if (Math.max(...pcts) > 18) throw new Error(`the pre-pass ran past the main step's 18 %: ${Math.max(...pcts)}`);
  } finally {
    await ctx.close();
  }
});

await test('PDF→Word on a scan: the light runs the whole time, and the language step is named', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = b => { if (b instanceof Blob && /officedocument/.test(b.type)) window.__res = b; return orig(b); };
    });
    await page.goto(`${BASE_URL}/pdf-to-word/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', SCAN);
    await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled
      && /Output mode/.test(document.querySelector('#pdf2wordOptions')?.textContent || ''), null, { timeout: 60000 });
    await page.evaluate(() => {
      window.__labels = new Set(); window.__light = [];
      setInterval(() => {
        window.__labels.add((document.querySelector('#progressLabel')?.textContent || '').trim());
        if (!document.querySelector('#mergeBtn').classList.contains('merge-btn--processing')) return;
        const a = document.getAnimations().find(x => x.animationName === 'merge-btn-run');
        window.__light.push(a && a.playState === 'running' ? a.currentTime : null);
      }, 250);
    });
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__res, null, { timeout: 180000 });
    const { labels, light } = await page.evaluate(() => ({ labels: [...window.__labels], light: window.__light }));
    if (!labels.some(l => /language/i.test(l))) throw new Error(`no language step shown — labels: ${JSON.stringify(labels)}`);
    if (light.length < 8) throw new Error(`too few samples while processing (${light.length})`);
    const stopped = light.filter((t, i) => t === null || (i && t <= light[i - 1])).length;
    if (stopped) throw new Error(`the light stood still or was missing in ${stopped} of ${light.length} samples`);
  } finally {
    await ctx.close();
  }
});

await test('PDF→Word on a scan, a slow line: the language step counts the megabytes of the OCR models as they come', async () => {
  // two people in China left at "Finding the text's language… 10 %" after 70 s
  // and 20 min (Tool Leave, 2026-11-18): the models were downloading, the bar
  // stood still — at 400 KB/s for 58 s
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = b => { if (b instanceof Blob && /officedocument/.test(b.type)) window.__res = b; return orig(b); };
    });
    await page.goto(`${BASE_URL}/pdf-to-word/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', SCAN);
    await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled
      && /Output mode/.test(document.querySelector('#pdf2wordOptions')?.textContent || ''), null, { timeout: 60000 });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 100, downloadThroughput: 1024 * 1024, uploadThroughput: 256 * 1024 });
    await page.evaluate(() => {
      window.__mb = [];
      setInterval(() => {
        const m = (document.querySelector('#progressLabel')?.textContent || '').match(/language… ([\d.]+) MB of the text reader loaded/);
        if (m && window.__mb[window.__mb.length - 1] !== +m[1]) window.__mb.push(+m[1]);
      }, 100);
    });
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__res, null, { timeout: 300000 });
    const mb = await page.evaluate(() => window.__mb);
    if (mb.length < 3) throw new Error(`the language step showed ${mb.length} download figures: ${JSON.stringify(mb)}`);
    if (mb.some((v, i) => i && v < mb[i - 1])) throw new Error(`the figures went back: ${JSON.stringify(mb)}`);
  } finally {
    await ctx.close();
  }
});

await browser.close();
console.log(`\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed) process.exit(1);
