// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/draw-image.e2e.mjs — images on a page in Draw on PDF, in a
//  real browser (2026-10-14, Search Miss "paste an image").
//
//  Ctrl/Cmd+V of an image places it on the open PDF. A photo stays a photo
//  (every image used to be thresholded down to its darkest pixels, as if
//  it were a signature); a signature on white paper still loses its white
//  background. Checked on the placed bitmap's own pixels, the images made
//  in the page — no user documents.
//  Run: node tests/e2e/draw-image.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
await page.goto(BASE_URL + '/draw-on-pdf/', { waitUntil: 'load' });
await page.setInputFiles('#fileInput', path.join(__dirname, '..', 'fixtures', 'nup', 'five-pages.pdf'));
// (waitForFunction can't wait on an async predicate — its Promise is truthy at once)
await page.evaluate(async () => {
  const ui = await import('/js/drawUI.js');
  for (let i = 0; i < 300 && !ui.getPageCount(); i++) await new Promise(r => setTimeout(r, 100));
  if (!ui.getPageCount()) throw new Error('the PDF never opened');
});

// Pastes a PNG drawn by `kind` ('photo' | 'signature') through a real paste
// event; returns what the placed image's own pixels look like.
const pasteAndRead = kind => page.evaluate(async kind => {
  const c = document.createElement('canvas'); c.width = 200; c.height = 120;
  const g = c.getContext('2d');
  if (kind === 'photo') {
    const grad = g.createLinearGradient(0, 0, 200, 120);
    grad.addColorStop(0, '#1e4fa0'); grad.addColorStop(0.5, '#e8c070'); grad.addColorStop(1, '#3a8a3a');
    g.fillStyle = grad; g.fillRect(0, 0, 200, 120);
  } else {
    g.fillStyle = '#fff'; g.fillRect(0, 0, 200, 120);
    g.strokeStyle = '#1a237e'; g.lineWidth = 5; g.beginPath(); g.moveTo(20, 80); g.bezierCurveTo(60, 10, 120, 110, 180, 40); g.stroke();
  }
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], `${kind}.png`, { type: 'image/png' }));
  const ui = await import('/js/drawUI.js');
  const before = ui.getEffectiveCommands().filter(x => x.type === 'image').length;
  document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  for (let i = 0; i < 40 && ui.getEffectiveCommands().filter(x => x.type === 'image').length === before; i++) await new Promise(r => setTimeout(r, 100));
  const imgs = ui.getEffectiveCommands().filter(x => x.type === 'image');
  if (imgs.length === before) return null;
  const bmp = imgs[imgs.length - 1].bitmap;
  const d = bmp.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data;
  let transparent = 0, colourful = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 10) transparent++;
    if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 60) colourful++;
  }
  const n = d.length / 4;
  return { transparent: transparent / n, colourful: colourful / n };
}, kind);

console.log(`\ndraw — images E2E (${BASE_URL}):`);
try {
  await test('pasting a photo places it as it is — no transparent holes, colour kept', async () => {
    const r = await pasteAndRead('photo');
    if (!r) throw new Error('nothing was placed');
    if (r.transparent > 0.01 || r.colourful < 0.3) throw new Error(JSON.stringify(r));
  });
  // the toolbar's image button — the path production already had: a photo
  // used to be thresholded there too, like a signature
  await test('uploading a photo with the image button keeps it as it is', async () => {
    const before = await page.evaluate(async () => (await import('/js/drawUI.js')).getEffectiveCommands().filter(x => x.type === 'image').length);
    await page.setInputFiles('#signatureImageInput', path.join(__dirname, '..', 'fixtures', 'draw', 'photo.png'));
    const r = await page.evaluate(async before => {
      const ui = await import('/js/drawUI.js');
      for (let i = 0; i < 40 && ui.getEffectiveCommands().filter(x => x.type === 'image').length === before; i++) await new Promise(res => setTimeout(res, 100));
      const imgs = ui.getEffectiveCommands().filter(x => x.type === 'image');
      if (imgs.length === before) return null;
      const bmp = imgs[imgs.length - 1].bitmap;
      const d = bmp.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data;
      let transparent = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] < 10) transparent++;
      return { transparent: transparent / (d.length / 4) };
    }, before);
    if (!r) throw new Error('nothing was placed');
    if (r.transparent > 0.01) throw new Error(`photo thresholded: ${JSON.stringify(r)}`);
  });

  await test('pasting a signature on white paper still removes the white background', async () => {
    const r = await pasteAndRead('signature');
    if (!r) throw new Error('nothing was placed');
    if (r.transparent < 0.8) throw new Error(JSON.stringify(r));
  });
} finally {
  await browser.close();
}
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
