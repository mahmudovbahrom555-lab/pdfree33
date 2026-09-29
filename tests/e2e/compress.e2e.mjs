// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/compress.e2e.mjs — real-browser regression tests for two
//  compress bugs behind a real user report (2026-09-29): a 21-file batch
//  went 1376.8 → 1366.9 MB (-1%).
//
//  1. js/compressPrepWorker.js — an image stored with NO /Filter (raw
//     pixels) was skipped by worker.js's handleCompress on every preset,
//     so a 6.3 MB raw scan compressed 6.31 → 6.31 MB even on Maximum. The
//     pre-pass now Flate-encodes it; checked through the FULL compress run
//     that it's genuinely lossless (decoded bytes identical), not just smaller.
//  3. The first version of that pre-pass also encoded raw DeviceRGB/
//     DeviceGray images, which handleCompress then corrupted (it writes the
//     downsampled size before its 10% check and doesn't restore it on
//     revert, and reads a by-reference colour space as RGB) — a gray image
//     came out as striped garbage in production. Such images must pass
//     through byte-identical.
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
import { fileURLToPath } from 'url';
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

// Raw (no /Filter) images, 1200×1600 so Maximum's DPI downsampling applies —
// smooth gradients, so Flate shrinks them far below the 10% threshold.
const W = 1200, H = 1600;
const RAW_RGB  = Buffer.alloc(W * H * 3);
const RAW_GRAY = Buffer.alloc(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 3;
  RAW_RGB[i] = x % 256; RAW_RGB[i + 1] = y % 256; RAW_RGB[i + 2] = 128;
  RAW_GRAY[y * W + x] = (x * 255 / W) | 0;
}
const ICC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'js', 'vendor', 'sRGB2014.icc'));

// colorSpace(pdf) → the image dict's /ColorSpace value
async function rawImagePdf(raw, colorSpace) {
  const pdf  = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const img  = pdf.context.register(pdf.context.stream(raw, {
    Type: 'XObject', Subtype: 'Image', Width: W, Height: H, BitsPerComponent: 8,
    ColorSpace: colorSpace(pdf),
  }));
  page.node.setXObject(PDFName.of('Im0'), img);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(595, 0, 0, 842, 0, 0), drawObject('Im0'), popGraphicsState());
  return pdf.save({ useObjectStreams: false });
}
// ICC by reference — exactly the shape of the real 6.3 MB scan
const iccRef = pdf => pdf.context.register(pdf.context.obj([PDFName.of('ICCBased'),
  pdf.context.register(pdf.context.stream(ICC, { N: 3 }))]));
// DeviceGray by reference — the shape that came out as garbage
const grayRef = pdf => pdf.context.register(PDFName.of('DeviceGray'));

function firstImage(doc) {
  return [...doc.context.enumerateIndirectObjects()].map(([, o]) => o)
    .find(o => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype'))?.toString() === '/Image');
}

const BLOB_HOOK = () => {
  window.__blob = null;
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) { if (blob instanceof Blob && blob.type === 'application/pdf') window.__blob = blob; return orig(blob); };
};
// Real single-file compress through the UI (auto-picked preset) → output PDF bytes
async function compressViaUi(browser, file) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.addInitScript(BLOB_HOOK);
    await page.goto(`${BASE_URL}/compress-pdf/`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', file);
    await page.waitForTimeout(3000); // background pre-scan + preset auto-pick
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__blob, null, { timeout: 60000 });
    const b64 = await page.evaluate(async () => {
      const u = new Uint8Array(await window.__blob.arrayBuffer()); let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return btoa(s);
    });
    return Buffer.from(b64, 'base64');
  } finally {
    await context.close();
  }
}
async function textPdf() {
  const pdf  = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  page.drawText('Plain text document with no images.', { x: 50, y: 780, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
  return pdf.save({ useObjectStreams: false, updateMetadata: false });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfree-compress-e2e-'));
const RAW_PDF  = path.join(tmp, 'raw-icc-image.pdf');
const GRAY_PDF = path.join(tmp, 'raw-gray-by-ref.pdf');
const TEXT_PDF = path.join(tmp, 'text-first.pdf');
fs.writeFileSync(RAW_PDF,  await rawImagePdf(RAW_RGB, iccRef));
fs.writeFileSync(GRAY_PDF, await rawImagePdf(RAW_GRAY, grayRef));
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

await test('a raw ICC image compresses losslessly through the full run (decoded pixels identical)', async () => {
  const out = firstImage(await PDFDocument.load(await compressViaUi(browser, RAW_PDF)));
  expect(out.dict.get(PDFName.of('Filter'))?.toString()).toBe('/FlateDecode');
  expect(out.dict.get(PDFName.of('Width'))?.toString()).toBe(String(W));
  if (!(out.contents.length < RAW_RGB.length * 0.9)) throw new Error(`not smaller: ${out.contents.length} vs ${RAW_RGB.length}`);
  expect(Buffer.compare(zlib.inflateSync(Buffer.from(out.contents)), RAW_RGB)).toBe(0);
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

await test('a raw DeviceGray-by-reference image passes through byte-identical (was corrupted)', async () => {
  const out = firstImage(await PDFDocument.load(await compressViaUi(browser, GRAY_PDF)));
  expect(out.dict.get(PDFName.of('Filter'))).toBe(undefined);
  expect(out.dict.get(PDFName.of('Width'))?.toString()).toBe(String(W));
  expect(out.dict.get(PDFName.of('Height'))?.toString()).toBe(String(H));
  expect(Buffer.compare(Buffer.from(out.contents), RAW_GRAY)).toBe(0);
});

await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
