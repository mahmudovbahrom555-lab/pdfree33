// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/clean-scan-stamp.e2e.mjs — Clean Scan keeps a coloured stamp,
//  and survives a very large page (2026-10-15, a real report CLEANSCAN-B536:
//  "leave the blue round stamp, whiten everything else" + "The ImageBitmap
//  could not be allocated").
//
//  stamp.pdf: grey scanned paper, dark text, a blue round stamp; stamp-red,
//  stamp-faded: the same in red and in faded pink. With the
//  option on (default) the output keeps blue pixels and a white background;
//  off, the page is grey only (as before). a0.pdf: an A0 page — 32 MP at the
//  default scale — must come out, rendered at ≤ 12 MP.
//  Run: node tests/e2e/clean-scan-stamp.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const FIX = path.join(__dirname, '..', 'fixtures', 'clean-scan');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();
// Runs Clean Scan; returns the output page's image size and its blue / white shares.
async function clean(file, keepColor = true) {
  const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
  await page.addInitScript(() => {
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (b instanceof Blob && /pdf/.test(b.type)) window.__pdf = b; return orig(b); };
    document.addEventListener('pdfree:error', e => { window.__err = e.detail.message; });
  });
  await page.goto(BASE_URL + '/clean-scan/', { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', path.join(FIX, file));
  await page.waitForSelector('#csKeepColor', { state: 'attached', timeout: 60000 });
  if (!keepColor) await page.click('label:has(#csKeepColor)');
  await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled);
  await page.click('#mergeBtn');
  await page.waitForFunction(() => window.__pdf || window.__err, null, { timeout: 120000 });
  return page.evaluate(async () => {
    if (window.__err) return { err: window.__err };
    await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await window.__pdf.arrayBuffer()) }).promise;
    const p = await doc.getPage(1);
    const vp = p.getViewport({ scale: 800 / p.getViewport({ scale: 1 }).width });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    await p.render({ canvasContext: ctx, viewport: vp }).promise;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let blue = 0, white = 0, colored = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 2] - d[i] > 60) blue++;
      if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 50) colored++;
      if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) white++;
    }
    const ops = await p.getOperatorList();
    let img = null;
    for (let k = 0; k < ops.fnArray.length; k++) if (ops.fnArray[k] === window.pdfjsLib.OPS.paintImageXObject) img = ops.argsArray[k][0];
    const obj = img ? await new Promise(r => p.objs.get(img, r)) : null;
    const n = d.length / 4;
    return { blue: blue / n, white: white / n, colored: colored / n, px: obj ? obj.width * obj.height : null };
  });
}

console.log(`\nclean scan — stamp + large page E2E (${BASE_URL}):`);
try {
  await test('the blue stamp stays blue, the grey paper turns white', async () => {
    const r = await clean('stamp.pdf');
    if (r.err) throw new Error(r.err);
    if (r.blue < 0.003) throw new Error(`stamp lost: ${JSON.stringify(r)}`);
    if (r.white < 0.8) throw new Error(`background not whitened: ${JSON.stringify(r)}`);
  });
  // any colour, faded too (a red stamp fades to pink — first version lost it)
  for (const f of ['stamp-red.pdf', 'stamp-faded.pdf']) {
    await test(`${f}: the stamp keeps its colour`, async () => {
      const r = await clean(f);
      if (r.err) throw new Error(r.err);
      if (r.colored < 0.003) throw new Error(`stamp lost: ${JSON.stringify(r)}`);
    });
  }

  // A real document: a 1949 certificate on yellowed paper with a faint
  // violet round stamp and violet signatures (public domain, Wikimedia
  // Commons: "Справка о съёмке боксёрского матча Градополов -Никитин.jpg").
  // Judged against white, its paper counted as colour and stayed yellow.
  await test('a real 1949 certificate: yellowed paper turns white, the violet stamp and signatures stay', async () => {
    const r = await clean('spravka-1949.pdf');
    if (r.err) throw new Error(r.err);
    // 0.84 white with the whole faded stamp kept (it covers ~4 % of the
    // page); the regression this guards against left 0.37
    if (r.white < 0.78) throw new Error(`paper not whitened: ${JSON.stringify(r)}`);
    if (r.colored < 0.02) throw new Error(`stamp / signatures lost: ${JSON.stringify(r)}`);
  });

  await test('option off: grey only, as before', async () => {
    const r = await clean('stamp.pdf', false);
    if (r.err) throw new Error(r.err);
    if (r.blue > 0.0005) throw new Error(`colour kept with the option off: ${JSON.stringify(r)}`);
  });
  await test('an A0 page (32 MP at scale 2) comes out, rendered at ≤ 12 MP', async () => {
    const r = await clean('a0.pdf');
    if (r.err) throw new Error(r.err);
    if (!r.px || r.px > 12_100_000) throw new Error(`image ${r.px} px`);
  });
} finally {
  await browser.close();
}
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
