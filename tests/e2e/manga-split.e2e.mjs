// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/manga-split.e2e.mjs — Split Manga Pages in a real browser
//  (2026-11-17, no dedicated test before).
//
//  Spreads are drawn in two colours — the right half red, the left half
//  blue — so the order and the cut can be read from pixels (pdf.js extracts
//  text even outside a clip, so text can't tell the halves apart). Each
//  output page is rendered and sampled at its centre and near its edges.
//
//  Run: node tests/e2e/manga-split.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, rgb, degrees } from 'pdf-lib';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const RED = rgb(0.9, 0.1, 0.1), BLUE = rgb(0.1, 0.2, 0.9), GREEN = rgb(0.1, 0.8, 0.2), GREY = rgb(0.6, 0.6, 0.6);

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// a spread: left half blue, right half red (as displayed)
function spread(doc, w = 800, h = 600) {
  const p = doc.addPage([w, h]);
  p.drawRectangle({ x: 0, y: 0, width: w / 2, height: h, color: BLUE });
  p.drawRectangle({ x: w / 2, y: 0, width: w / 2, height: h, color: RED });
  return p;
}
function single(doc, color = GREY, w = 400, h = 600) {
  const p = doc.addPage([w, h]);
  p.drawRectangle({ x: 0, y: 0, width: w, height: h, color });
  return p;
}
const bytes = async build => { const doc = await PDFDocument.create(); await build(doc); return Buffer.from(await doc.save()); };

const browser = await chromium.launch();

// Runs the tool; returns every output page as { w, h, centre, leftEdge, rightEdge } colours.
async function run(pdf, { ltr = false, viewport } = {}) {
  const page = await (await browser.newContext({ serviceWorkers: 'block', ...(viewport ? { viewport } : {}) })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (b instanceof Blob && /pdf/.test(b.type)) window.__out = b; return orig(b); };
  });
  await page.goto(BASE_URL + '/split-manga-pages/', { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', { name: 'manga.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 30000 });
  await page.waitForTimeout(1200);
  if (ltr) {
    await page.click('label:has(#msRtlToggle)');
    if (await page.isChecked('#msRtlToggle')) throw new Error('reading direction still right to left');
  }
  await page.click('#mergeBtn');
  await page.waitForFunction(() => window.__out, null, { timeout: 60000 });
  const pages = await page.evaluate(async () => {
    await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await window.__out.arrayBuffer()) }).promise;
    const name = ([r, g, b]) => r > 180 && g < 90 && b < 90 ? 'red' : b > 180 && r < 90 ? 'blue' : g > 160 && r < 90 && b < 120 ? 'green'
      : Math.abs(r - g) < 20 && Math.abs(g - b) < 20 && r > 120 && r < 200 ? 'grey' : r > 240 && g > 240 && b > 240 ? 'white' : `rgb(${r},${g},${b})`;
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const vp = p.getViewport({ scale: 0.5 });
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const ctx = c.getContext('2d');
      await p.render({ canvasContext: ctx, viewport: vp }).promise;
      const at = (x, y) => name(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data);
      const full = p.getViewport({ scale: 1 });
      out.push({ w: Math.round(full.width), h: Math.round(full.height), centre: at(c.width / 2, c.height / 2), leftEdge: at(3, c.height / 2), rightEdge: at(c.width - 4, c.height / 2) });
    }
    return { out, size: window.__out.size };
  });
  await page.close();
  return { pages: pages.out, size: pages.size, errors };
}
const sig = pages => pages.map(p => `${p.centre}${p.leftEdge !== p.centre || p.rightEdge !== p.centre ? `[${p.leftEdge}|${p.rightEdge}]` : ''} ${p.w}x${p.h}`).join(', ');

await test('a cover and three spreads, right to left: cover kept whole, then red, blue per spread', async () => {
  const pdf = await bytes(doc => { single(doc); spread(doc); spread(doc); spread(doc); });
  const { pages, errors } = await run(pdf);
  if (errors.length) throw new Error(errors.join('; '));
  const want = 'grey 400x600, red 400x600, blue 400x600, red 400x600, blue 400x600, red 400x600, blue 400x600';
  if (sig(pages) !== want) throw new Error(`got ${sig(pages)}`);
});

await test('left to right: blue before red', async () => {
  const pdf = await bytes(doc => { spread(doc); spread(doc); });
  const { pages } = await run(pdf, { ltr: true });
  if (sig(pages) !== 'blue 400x600, red 400x600, blue 400x600, red 400x600') throw new Error(`got ${sig(pages)}`);
});

await test('a spread with bleed: the cut is at the middle of the trimmed page, no bleed on the halves', async () => {
  const pdf = await bytes(doc => {
    const p = doc.addPage([840, 640]);
    p.drawRectangle({ x: 0, y: 0, width: 840, height: 640, color: GREEN });         // bleed
    p.drawRectangle({ x: 20, y: 20, width: 400, height: 600, color: BLUE });
    p.drawRectangle({ x: 420, y: 20, width: 400, height: 600, color: RED });
    p.setCropBox(20, 20, 800, 600);
  });
  const { pages } = await run(pdf);
  if (sig(pages) !== 'red 400x600, blue 400x600') throw new Error(`got ${sig(pages)}`);
});

await test('a single portrait page between spreads stays one page', async () => {
  const pdf = await bytes(doc => { spread(doc); single(doc, GREY); spread(doc); });
  const { pages } = await run(pdf);
  if (sig(pages) !== 'red 400x600, blue 400x600, grey 400x600, red 400x600, blue 400x600') throw new Error(`got ${sig(pages)}`);
});

await test('a spread saved as a rotated portrait page (/Rotate 90) is cut down its displayed middle', async () => {
  // Stored 600 wide, 800 tall, shown turned 90° clockwise: the stored top
  // half becomes the displayed right half. Checked on the source first.
  const pdf = await bytes(doc => {
    const p = doc.addPage([600, 800]);
    p.drawRectangle({ x: 0, y: 0, width: 600, height: 400, color: BLUE });
    p.drawRectangle({ x: 0, y: 400, width: 600, height: 400, color: RED });
    p.setRotation(degrees(90));
  });
  const page = await (await browser.newContext()).newPage();
  await page.goto(BASE_URL + '/split-manga-pages/', { waitUntil: 'load' });
  const shown = await page.evaluate(async b64 => {
    await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
    const data = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
    const p = await (await window.pdfjsLib.getDocument({ data }).promise).getPage(1);
    const vp = p.getViewport({ scale: 0.5 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const px = x => [...c.getContext('2d').getImageData(x, c.height / 2, 1, 1).data].slice(0, 3);
    return { w: vp.width * 2, h: vp.height * 2, left: px(10), right: px(c.width - 10) };
  }, pdf.toString('base64'));
  await page.close();
  if (!(shown.w > shown.h && shown.right[0] > 180 && shown.left[2] > 180)) throw new Error(`source not a red-right spread on screen: ${JSON.stringify(shown)}`);
  const { pages } = await run(pdf);
  if (sig(pages) !== 'red 400x600, blue 400x600') throw new Error(`got ${sig(pages)}`);
});

for (const [angle, build] of [
  // 270°: the stored bottom half is shown on the right
  [270, p => { p.drawRectangle({ x: 0, y: 0, width: 600, height: 400, color: RED }); p.drawRectangle({ x: 0, y: 400, width: 600, height: 400, color: BLUE }); }],
  // 180°: the stored left half is shown on the right
  [180, p => { p.drawRectangle({ x: 0, y: 0, width: 400, height: 600, color: RED }); p.drawRectangle({ x: 400, y: 0, width: 400, height: 600, color: BLUE }); }],
]) {
  await test(`a spread turned ${angle}° is cut down its displayed middle, red (shown right) first`, async () => {
    const pdf = await bytes(doc => {
      const p = doc.addPage(angle === 180 ? [800, 600] : [600, 800]);
      build(p); p.setRotation(degrees(angle));
    });
    const { pages } = await run(pdf);
    if (sig(pages) !== 'red 400x600, blue 400x600') throw new Error(`got ${sig(pages)}`);
  });
}

await test('scanned spreads: each image is stored once — the result is not twice the input', async () => {
  const jpg = fs.readFileSync(path.join(FIX, 'gray-scan.jpg'));
  const pdf = await bytes(async doc => {
    for (let i = 0; i < 4; i++) {
      const img = await doc.embedJpg(jpg);
      doc.addPage([1600, 1100]).drawImage(img, { x: 0, y: 0, width: 1600, height: 1100 });
    }
  });
  const { pages, size } = await run(pdf);
  if (pages.length !== 8) throw new Error(`${pages.length} pages`);
  if (size > pdf.length * 1.15) throw new Error(`output ${size} B is ${(size / pdf.length).toFixed(2)}x the input ${pdf.length} B`);
});

await test('phone 390×844: the same file splits the same way', async () => {
  const pdf = await bytes(doc => { single(doc); spread(doc); });
  const { pages } = await run(pdf, { viewport: { width: 390, height: 844 } });
  if (sig(pages) !== 'grey 400x600, red 400x600, blue 400x600') throw new Error(`got ${sig(pages)}`);
});

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
