// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/compress.e2e.mjs — real-browser regression tests for two
//  compress bugs behind a real user report (2026-09-29): a 21-file batch
//  went 1376.8 → 1366.9 MB (-1%).
//
//  1. js/compressPrepWorker.js — an image stored with NO /Filter (raw
//     pixels) was skipped by worker.js's handleCompress on every preset,
//     so a 6.3 MB raw scan compressed 6.31 → 6.31 MB even on Maximum. The
//     pre-pass now Flate-encodes it; this checks it's genuinely lossless
//     (decoded bytes identical to the source pixels), not just smaller.
//  2. js/compressUI.js — the background pre-scan only covers
//     selectedFiles[0], yet its recommended preset was applied to the whole
//     batch: a plain-text first file flipped every file to Light, which
//     never touches images. A batch must stay on Standard.
//
//  Both fixtures are generated here with pdf-lib — synthetic, no real
//  user documents. Requires dist/ built and served at PDFREE_BASE_URL
//  (default http://localhost:8934). Run: node tests/e2e/compress.e2e.mjs
// ============================================================

import { chromium } from 'playwright';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts,
         pushGraphicsState, concatTransformationMatrix, drawObject, popGraphicsState } from 'pdf-lib';
import zlib from 'zlib';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe: (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
  };
}

// A page with one 600×400 RGB image stored raw (no /Filter) — a smooth
// gradient, so Flate shrinks it far below worker.js's 10% threshold.
const W = 600, H = 400;
const RAW = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 3;
  RAW[i] = x % 256; RAW[i + 1] = y % 256; RAW[i + 2] = 128;
}
async function rawImagePdf() {
  const pdf  = await PDFDocument.create();
  const page = pdf.addPage([W, H]);
  const img  = pdf.context.register(pdf.context.stream(RAW, {
    Type: 'XObject', Subtype: 'Image', Width: W, Height: H,
    ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
  }));
  page.node.setXObject(PDFName.of('Im0'), img);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(W, 0, 0, H, 0, 0), drawObject('Im0'), popGraphicsState());
  return pdf.save({ useObjectStreams: false });
}
async function textPdf() {
  const pdf  = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  page.drawText('Plain text document with no images.', { x: 50, y: 780, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
  return pdf.save({ useObjectStreams: false, updateMetadata: false });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfree-compress-e2e-'));
const RAW_PDF  = path.join(tmp, 'raw-image.pdf');
const TEXT_PDF = path.join(tmp, 'text-first.pdf');
fs.writeFileSync(RAW_PDF, await rawImagePdf());
fs.writeFileSync(TEXT_PDF, await textPdf());

console.log(`\ncompress E2E — raw-image pre-pass + batch preset (real browser, ${BASE_URL}):`);

let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  console.error('Could not launch Chromium — run `npx playwright install --with-deps chromium` first.');
  console.error(e.message);
  process.exit(1);
}

await test('compressPrepWorker Flate-encodes a raw image losslessly (decoded pixels identical)', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${BASE_URL}/compress-pdf/`, { waitUntil: 'load', timeout: 30000 });
    const res = await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const w = new Worker('/js/compressPrepWorker.js');
      const d = await new Promise(r => { w.onmessage = e => r(e.data); w.postMessage({ file: bytes.buffer }, [bytes.buffer]); });
      const u = new Uint8Array(d.result); let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return { encoded: d.encoded, b64: btoa(s) };
    }, fs.readFileSync(RAW_PDF).toString('base64'));
    expect(res.encoded).toBe(1);

    const out = await PDFDocument.load(Buffer.from(res.b64, 'base64'));
    const img = [...out.context.enumerateIndirectObjects()].map(([, o]) => o)
      .find(o => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype'))?.toString() === '/Image');
    expect(img.dict.get(PDFName.of('Filter'))?.toString()).toBe('/FlateDecode');
    if (!(img.contents.length < RAW.length * 0.9)) throw new Error(`not smaller: ${img.contents.length} vs ${RAW.length}`);
    expect(Buffer.compare(zlib.inflateSync(Buffer.from(img.contents)), RAW)).toBe(0);
  } finally {
    await page.close();
  }
});

await test('a batch whose first file is plain text stays on Standard, not the scan\'s Light pick', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.goto(`${BASE_URL}/compress-pdf/`, { waitUntil: 'load', timeout: 30000 });
    // Baseline: the same text file ALONE is still auto-switched to Light —
    // single-file behaviour must be unchanged.
    await page.setInputFiles('#fileInput', TEXT_PDF);
    await page.waitForFunction(() => document.querySelector('input[name="compressPreset"]:checked')?.value === 'low', null, { timeout: 15000 });
    // Adding more files turns it into a batch → the scan's pick is reverted.
    await page.setInputFiles('#fileInput', RAW_PDF);
    await page.waitForFunction(() => document.querySelector('input[name="compressPreset"]:checked')?.value === 'medium', null, { timeout: 15000 });
  } finally {
    await context.close();
  }
});

await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
