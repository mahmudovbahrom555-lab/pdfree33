// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/clean-scan-straighten.e2e.mjs — Clean Scan's "Straighten
//  tilted pages" in a real browser (2026-10-14).
//
//  tests/fixtures/clean-scan/tilted.pdf: 30 lines of text scanned 3° off.
//  Judged without the tool's own angle search: on the output page, the
//  ink's row profile — sharp when lines run level, smeared when tilted.
//  Straighten on must give a clearly sharper profile than off; off must
//  stay as before (the option defaults to off).
//  Run: node tests/e2e/clean-scan-straighten.e2e.mjs   (dist/ on :8934)
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
// Runs Clean Scan; returns the output page's row-profile sharpness: the sum
// of squared ink counts per row over the squared total — higher when the
// ink sits in level lines.
async function sharpness(straighten) {
  const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
  await page.addInitScript(() => {
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (b instanceof Blob && /pdf/.test(b.type)) window.__pdf = b; return orig(b); };
  });
  await page.goto(BASE_URL + '/clean-scan/', { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', path.join(__dirname, '..', 'fixtures', 'clean-scan', 'tilted.pdf'));
  await page.waitForSelector('#csStraighten', { state: 'attached', timeout: 30000 });
  if (await page.isChecked('#csStraighten')) throw new Error('straighten should default to off');
  if (straighten) await page.click('label:has(#csStraighten)');
  await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled);
  await page.click('#mergeBtn');
  await page.waitForFunction(() => window.__pdf, null, { timeout: 90000 });
  return page.evaluate(async () => {
    await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await window.__pdf.arrayBuffer()) }).promise;
    const p = await doc.getPage(1);
    const vp = p.getViewport({ scale: 1 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    await p.render({ canvasContext: ctx, viewport: vp }).promise;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let total = 0, sq = 0;
    for (let y = 0; y < c.height; y++) {
      let row = 0;
      for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4] < 128) row++;
      total += row; sq += row * row;
    }
    return sq / (total * total) * c.height;
  });
}

console.log(`\nclean scan — straighten E2E (${BASE_URL}):`);
try {
  await test('a page scanned 3° off comes out level: row profile clearly sharper with Straighten on', async () => {
    const off = await sharpness(false), on = await sharpness(true);
    if (!(on > off * 1.3)) throw new Error(`sharpness off ${off.toFixed(2)}, on ${on.toFixed(2)}`);
  });
} finally {
  await browser.close();
}
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
