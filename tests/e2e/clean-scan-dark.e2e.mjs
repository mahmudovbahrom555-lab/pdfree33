// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/clean-scan-dark.e2e.mjs — Clean Scan, light text on a dark
//  or coloured background
//
//  A user's case (2026-10-30, a phone): a dark-blue page with white text.
//  Clean Scan kept the background as "coloured ink" — a <1 MB file came back
//  over 50 MB after 9.5 min — and they wrote "text only, not the blue
//  background". Such regions are now found (js/cleanScanWorker.js,
//  _darkRegionMask) and OFFERED — a switch above the preview, off by default
//  (the owner, 2026-11-04: turned over unasked, a photo on a book cover and
//  letters by a dark scanner edge were lost). Checked here, Keep colours on
//  (the default):
//   - off (default): the switch is shown, the page is cleaned as before;
//   - on: the "after" preview changes, and in the downloaded PDF OCR reads
//     ≥ 90 % of the text, nothing but white paper and dark ink is left, and
//     the file is at most twice the size of the same text on white paper;
//   - a black box on a white page, on: the caption beside it keeps its ink;
//   - white lines over a photograph: no switch offered.
//  Fixtures: tests/fixtures/clean-scan/dark (make.mjs, truth.json); the
//  white-paper twins are built at run time (make.mjs --twin).
//  CLEANSCAN_CORPUS=1 (local, not CI): also the real corpus pages where
//  turning over lost information (corpus-pages.json — names and SHA-256s,
//  the documents aren't ours to commit): with the switch off each comes out
//  exactly as on PDFREE_PROD_URL (default https://pdfree.io); whether the
//  switch is offered is printed.
//  Needs the tesseract CLI (CI installs tesseract-ocr).
//  Requires dist/ served at PDFREE_BASE_URL (default http://localhost:8934).
//  Run: node tests/e2e/clean-scan-dark.e2e.mjs
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'clean-scan', 'dark');
const TRUTH = JSON.parse(fs.readFileSync(path.join(FIX, 'truth.json'), 'utf8'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dark-'));
execFileSync('node', [path.join(FIX, 'make.mjs'), '--twin', TMP]);

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();
// Runs Clean Scan on `file`, the light-on-dark switch turned on when `invert`;
// returns whether the switch was offered, whether the "after" preview changed
// with it, the output's size, its page as a PNG file (for OCR) and the shares
// of white and in-between pixels.
async function clean(file, { keep = true, invert = false, base = BASE_URL } = {}) {
  const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
  await page.addInitScript(() => {
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (b instanceof Blob && /pdf/.test(b.type)) window.__pdf = b; return orig(b); };
  });
  await page.goto(base + '/clean-scan/', { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', file);
  await page.waitForSelector('#csKeepColor', { state: 'attached', timeout: 60000 });
  if (!keep) await page.click('label:has(#csKeepColor)');
  await page.waitForFunction(() => document.querySelector('#csAfterImg')?.src, null, { timeout: 60000 });
  await page.waitForTimeout(800);
  const offered = await page.isVisible('#csDarkHint').catch(() => false);
  let previewChanged = null;
  if (invert) {
    const before = await page.getAttribute('#csAfterImg', 'src');
    await page.click('label:has(#csLightOnDark)');
    await page.waitForFunction(b => document.querySelector('#csAfterImg')?.src !== b, before, { timeout: 30000 }).catch(() => {});
    previewChanged = (await page.getAttribute('#csAfterImg', 'src')) !== before;
  }
  await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled);
  await page.click('#mergeBtn');
  await page.waitForFunction(() => window.__pdf, null, { timeout: 120000 });
  const r = await page.evaluate(async () => {
    await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
    const bytes = new Uint8Array(await window.__pdf.arrayBuffer());
    const doc = await window.pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const p = await doc.getPage(1);
    const vp = p.getViewport({ scale: 1240 / p.getViewport({ scale: 1 }).width });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    await p.render({ canvasContext: ctx, viewport: vp }).promise;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let white = 0, dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lo = Math.min(d[i], d[i + 1], d[i + 2]), hi = Math.max(d[i], d[i + 1], d[i + 2]);
      if (lo >= 230) white++;
      else if (hi <= 110) dark++;
    }
    const n = d.length / 4;
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', d))).slice(0, 8).map(x => x.toString(16).padStart(2, '0')).join('');
    return { size: bytes.length, white: white / n, between: 1 - (white + dark) / n, hash, png: c.toDataURL('image/png') };
  });
  await page.context().close();
  const png = path.join(TMP, `${path.basename(file, '.pdf')}-${keep ? 'keep' : 'nokeep'}-${invert ? 'on' : 'off'}.png`);
  fs.writeFileSync(png, Buffer.from(r.png.split(',')[1], 'base64'));
  return { ...r, offered, previewChanged, png };
}

const norm = s => s.replace(/\s+/g, '').toLowerCase();
// share of the truth's characters found in order in the OCR text (longest common subsequence)
function recall(truth, text) {
  const a = norm(truth), b = norm(text);
  let prev = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Uint16Array(b.length + 1);
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[b.length] / Math.max(1, a.length);
}
const ocr = (png, lang = 'eng') => execFileSync('tesseract', [png, '-', '-l', lang, '--psm', '3'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

console.log(`\nclean scan — light text on dark backgrounds (${BASE_URL}):`);
try {
  await test('off by default: the switch is offered on a dark-blue page, and the page is cleaned as before', async () => {
    const r = await clean(path.join(FIX, 'navy-white.pdf'));
    if (!r.offered) throw new Error('the switch was not offered');
    if (r.between < 0.1) throw new Error(`the background was removed without being asked (${(r.between * 100).toFixed(1)} % left)`);
  });

  const cases = [['navy-white', true], ['navy-white', false], ['black-white', true], ['green-cream', true],
    ['maroon-white', true], ['gradient', true], ['textured', true], ['stamp-dark', true]];
  for (const [name, keep] of cases) {
    await test(`${name}${keep ? '' : ' (Keep colours off)'}, switched on: the preview changes; the text reads, the background is gone, the file is small`, async () => {
      const r = await clean(path.join(FIX, `${name}.pdf`), { keep, invert: true });
      const twin = await clean(path.join(TMP, `${name}.pdf`), { keep });
      if (!r.offered) throw new Error('the switch was not offered');
      if (!r.previewChanged) throw new Error('the "after" preview did not change');
      const rec = recall(TRUTH[name].text, ocr(r.png));
      if (rec < 0.9) throw new Error(`OCR read ${(rec * 100).toFixed(1)} % of the text`);
      if (r.between > 0.03) throw new Error(`${(r.between * 100).toFixed(1)} % of the page is neither paper nor ink (background left)`);
      if (r.size > 2 * twin.size) throw new Error(`${r.size} B, the same text on white paper ${twin.size} B`);
    });
  }

  await test('a black box on a white page, switched on: the box is read, the caption beside it keeps its ink', async () => {
    const r = await clean(path.join(FIX, 'mixed-box.pdf'), { invert: true });
    const text = ocr(r.png), lines = TRUTH['mixed-box'].text.split('\n').filter(l => l.trim());
    for (const l of [lines[0], lines[2], lines.at(-1)]) {
      if (recall(l, text) < 0.9) throw new Error(`not read: "${l}"`);
    }
  });

  await test('white lines over a photograph: the switch is not offered', async () => {
    const r = await clean(path.join(FIX, 'photo-title.pdf'));
    if (r.offered) throw new Error('offered — turned over, the photo would be lost');
  });

  if (process.env.CLEANSCAN_CORPUS) {
    const PROD = process.env.PDFREE_PROD_URL || 'https://pdfree.io';
    const pages = JSON.parse(fs.readFileSync(path.join(FIX, 'corpus-pages.json'), 'utf8'));
    const dir = path.join(TMP, 'corpus');
    execFileSync('python3', [path.join(FIX, '..', '..', '..', '..', 'scripts', 'corpus-cloud', 'cache.py'), 'materialize', dir, ...pages.map(p => p.name)], { stdio: 'ignore' });
    const { PDFDocument } = await import('pdf-lib');
    for (const p of pages) {
      await test(`corpus ${p.name} p.${p.page} (${p.why.split(':')[0]}), switch off: as on ${PROD}`, async () => {
        const src = await PDFDocument.load(fs.readFileSync(path.join(dir, p.name)), { ignoreEncryption: true });
        const one = await PDFDocument.create();
        one.addPage((await one.copyPages(src, [p.page - 1]))[0]);
        const file = path.join(TMP, `corpus-${p.name}`);
        fs.writeFileSync(file, await one.save());
        const ours = await clean(file), prod = await clean(file, { base: PROD });
        console.log(`      switch offered: ${ours.offered ? 'yes' : 'no'}`);
        if (ours.hash !== prod.hash) throw new Error('the page came out differently from production');
      });
    }
  }
} finally {
  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
