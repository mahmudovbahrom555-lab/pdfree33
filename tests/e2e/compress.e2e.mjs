// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/compress.e2e.mjs — real-browser regression gate for Compress.
//
//  1. Every trap in tests/corpus/traps.mjs (image shapes that broke Compress
//     in production 2026-09-29/30 — see each trap's `why`) is compressed
//     through the real /compress-pdf/ UI and checked against its `expect`:
//     'untouched', 'lossless' (compressPrepWorker's raw-image pre-pass) or
//     'recompressed' (savings that must not be lost). The worker.js fixes
//     behind most of them are an owner-approved exception to its off-limits
//     rule (CLAUDE.md).
//  2. js/compressUI.js — the background pre-scan only covers
//     selectedFiles[0], yet its recommended preset was applied to the whole
//     batch: a plain-text first file flipped every file to Light (real
//     report: a 21-file batch saved 1%). A batch must stay on Standard.
//
//  All fixtures are synthetic. Requires dist/ built and served at
//  PDFREE_BASE_URL (default http://localhost:8934).
//  Run: node tests/e2e/compress.e2e.mjs
// ============================================================

import { chromium } from 'playwright';
import { PDFDocument, PDFName } from 'pdf-lib';
import zlib from 'zlib';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { trapCases, textPdf, firstImage } from '../corpus/traps.mjs';

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

const CHECKS = {
  untouched(before, after) {
    for (const key of ['Filter', 'Width', 'Height', 'BitsPerComponent', 'DecodeParms']) {
      expect(String(after.dict.get(PDFName.of(key)))).toBe(String(before.dict.get(PDFName.of(key))));
    }
    expect(Buffer.compare(Buffer.from(after.contents), Buffer.from(before.contents))).toBe(0);
  },
  lossless(before, after, trap) {
    expect(after.dict.get(PDFName.of('Filter'))?.toString()).toBe('/FlateDecode');
    expect(String(after.dict.get(PDFName.of('Width')))).toBe(String(before.dict.get(PDFName.of('Width'))));
    if (!(after.contents.length < trap.source.length * 0.9)) throw new Error(`not smaller: ${after.contents.length} vs ${trap.source.length}`);
    expect(Buffer.compare(zlib.inflateSync(Buffer.from(after.contents)), trap.source)).toBe(0);
  },
  recompressed(before, after) {
    expect(after.dict.get(PDFName.of('Filter'))?.toString()).toBe('/DCTDecode');
  },
};

console.log(`\ncompress E2E — corpus traps + batch preset (real browser, ${BASE_URL}):`);

let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  console.error('Could not launch Chromium — run `npx playwright install --with-deps chromium` first.');
  console.error(e.message);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfree-compress-e2e-'));
const traps = await trapCases(browser);

for (const trap of traps) {
  await test(`${trap.name} → ${trap.expect} (${trap.why})`, async () => {
    const file = path.join(tmp, `${trap.name}.pdf`);
    fs.writeFileSync(file, trap.bytes);
    const before = firstImage(await PDFDocument.load(trap.bytes));
    const after  = firstImage(await PDFDocument.load(await compressViaUi(browser, file)));
    CHECKS[trap.expect](before, after, trap);
  });
}

await test('a batch whose first file is plain text stays on Standard, not the scan\'s Light pick', async () => {
  const textFile = path.join(tmp, 'text-first.pdf');
  fs.writeFileSync(textFile, await textPdf());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.goto(`${BASE_URL}/compress-pdf/`, { waitUntil: 'load', timeout: 30000 });
    // Baseline: the same text file ALONE is still auto-switched to Light —
    // single-file behaviour must be unchanged.
    await page.setInputFiles('#fileInput', textFile);
    await page.waitForFunction(() => document.querySelector('input[name="compressPreset"]:checked')?.value === 'low', null, { timeout: 15000 });
    // Adding more files turns it into a batch → the scan's pick is reverted.
    await page.setInputFiles('#fileInput', path.join(tmp, 'raw-icc-by-ref.pdf'));
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
