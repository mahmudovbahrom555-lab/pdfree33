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
//  2. Print (CMYK) images:
//     - mode D300 (js/cmykD.js, owner 2026-11-06): on Standard (q82) and
//       Maximum (q75) a CMYK photo becomes a DeviceCMYK JPEG — 4 channels,
//       Adobe — downsampled only above 330 dpi, to 300; js/worker.js leaves
//       it so (it skips CMYK). (Light never runs D300: tests/cmykD.test.js);
//     - an image D300's pure-K guard keeps is still re-deflated losslessly
//       (criteria v0.2, owner 2026-11-05): the same samples, fewer bytes.
//     A soft mask stays a DeviceGray mask (C30).
//  3. js/compressUI.js — the background pre-scan only covers
//     selectedFiles[0], yet its recommended preset was applied to the whole
//     batch: a plain-text first file flipped every file to Light (real
//     report: a 21-file batch saved 1%). A batch must stay on Standard.
//
//  All fixtures are synthetic. Requires dist/ built and served at
//  PDFREE_BASE_URL (default http://localhost:8934).
//  Run: node tests/e2e/compress.e2e.mjs
// ============================================================

import { chromium, devices } from 'playwright';
import JSZip from 'jszip';
import { PDFDocument, PDFName, StandardFonts, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } from 'pdf-lib';
import zlib from 'zlib';
import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { trapCases, textPdf, firstImage, imagePdf, RAW_RGB, W as TW, H as TH } from '../corpus/traps.mjs';

// The size field shows the file's own unit (KB under 1 MB, else MB); typing
// into it is what turns compress-to-size on (owner, 2026-11-24).
async function setTargetKb(page, kb) {
  const unit = (await page.textContent('.compress-target__unit')).trim();
  await page.fill('#compressTargetValue', String(unit === 'KB' ? Number(kb) : Number(kb) / 1000));
}

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
async function compressViaUi(browser, file, preset = null) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.addInitScript(BLOB_HOOK);
    await page.goto(`${BASE_URL}/compress-pdf/`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', file);
    await page.waitForTimeout(3000); // background pre-scan + preset auto-pick
    if (preset) await page.click(`label[data-preset="${preset}"]`);
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

// pdf.js's JPEG decoder — the same build the page uses (js/vendor/pdfjs-4.10.38)
const { JpegImage } = await import('pdfjs-dist/legacy/image_decoders/pdf.image_decoders.mjs');
const meanDiff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

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
  // still CMYK, and what a reader shows is what it showed (D300 may re-encode it, as CMYK)
  cmykKept(before, after) {
    const cs = o => { const v = o.dict.get(PDFName.of('ColorSpace')); return String(o.dict.context.lookup(v) ?? v); };
    expect(cs(after)).toBe('/DeviceCMYK');
    const seen = o => {   // samples as a reader takes them: the JPEG's, then /Decode [1 0 …] inverts
      const { data } = cmykJpegSamples(o);
      const inv = String(o.dict.get(PDFName.of('Decode')) ?? '').startsWith('[ 1 0');
      return inv ? data.map(v => 255 - v) : data;
    };
    const d = meanDiff(seen(after), seen(before));
    if (!(d < 3)) throw new Error(`mean |Δ| ${d.toFixed(2)} of 255 from what it showed`);
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

// A CMYK photo-like image stored at zlib level 1, as some print workflows write it
const CW = 600, CH = 800, CMYK = Buffer.alloc(CW * CH * 4);
for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
  const i = (y * CW + x) * 4, n = (x * 7 + y * 13) % 5;
  CMYK[i] = 128 + 100 * Math.sin(x / 40) + n; CMYK[i + 1] = 100 + 80 * Math.cos(y / 30) + n;
  CMYK[i + 2] = 90 + 60 * Math.sin((x + y) / 50) + n; CMYK[i + 3] = 20 + n;
}
const cmykFile = path.join(tmp, 'cmyk-flate.pdf');
const cmykBytes = await imagePdf(zlib.deflateSync(CMYK, { level: 1 }), { Width: CW, Height: CH, ColorSpace: 'DeviceCMYK', Filter: 'FlateDecode', Decode: [0, 1, 0, 1, 0, 1, 0, 1] });
fs.writeFileSync(cmykFile, cmykBytes);
const cmykBefore = firstImage(await PDFDocument.load(cmykBytes));

function cmykJpegSamples(img) {
  const j = new JpegImage({ decodeTransform: null, colorTransform: -1 });
  j.parse(new Uint8Array(img.contents));
  if (j.numComponents !== 4 || !j.adobe) throw new Error(`not an Adobe 4-channel JPEG (${j.numComponents} components)`);
  return { data: j.getData({ width: j.width, height: j.height, forceRGB: false, isSourcePDF: true }), w: j.width, h: j.height };
}

await test('D300 on Standard: a 72-dpi CMYK photo → a DeviceCMYK JPEG at its own size, close to the source, smaller', async () => {
  const after = firstImage(await PDFDocument.load(await compressViaUi(browser, cmykFile, 'medium')));
  expect(after.dict.get(PDFName.of('Filter'))?.toString()).toBe('/DCTDecode');
  expect(after.dict.get(PDFName.of('ColorSpace'))?.toString()).toBe('/DeviceCMYK');
  expect(`${after.dict.get(PDFName.of('Width'))}×${after.dict.get(PDFName.of('Height'))}`).toBe(`${CW}×${CH}`);
  expect(after.dict.has(PDFName.of('Decode'))).toBe(false);
  if (!(after.contents.length < cmykBefore.contents.length)) throw new Error(`not smaller: ${after.contents.length} vs ${cmykBefore.contents.length}`);
  const d = meanDiff(cmykJpegSamples(after).data, CMYK);
  if (!(d < 3)) throw new Error(`mean |Δ| ${d.toFixed(2)} of 255`);
});

// 1800×1200 drawn 3 × 2 in: 600 ppi → Maximum brings it to 300 (900×600)
const BW = 1800, BH = 1200, BIG = Buffer.alloc(BW * BH * 4);
for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
  const i = (y * BW + x) * 4, n = (x * 31 + y * 17) % 9;
  BIG[i] = 120 + 90 * Math.sin(x / 70) + n; BIG[i + 1] = 110 + 70 * Math.cos(y / 45) + n;
  BIG[i + 2] = 100 + 60 * Math.sin((x - y) / 90) + n; BIG[i + 3] = 30 + n;
}
const bigPdf = await PDFDocument.create();
const bigImg = bigPdf.context.register(bigPdf.context.stream(zlib.deflateSync(BIG), { Type: 'XObject', Subtype: 'Image', Width: BW, Height: BH, ColorSpace: 'DeviceCMYK', BitsPerComponent: 8, Filter: 'FlateDecode' }));
const bigPage = bigPdf.addPage([595, 842]);
bigPage.node.setXObject(PDFName.of('Im0'), bigImg);
bigPage.pushOperators(pushGraphicsState(), concatTransformationMatrix(216, 0, 0, 144, 100, 400), drawObject('Im0'), popGraphicsState());
const bigFile = path.join(tmp, 'cmyk-600ppi.pdf');
fs.writeFileSync(bigFile, await bigPdf.save({ useObjectStreams: false }));

await test('D300 on Maximum: a 600-ppi CMYK photo → 300 ppi (900×600), still DeviceCMYK, 4 channels', async () => {
  const after = firstImage(await PDFDocument.load(await compressViaUi(browser, bigFile, 'high')));
  expect(after.dict.get(PDFName.of('ColorSpace'))?.toString()).toBe('/DeviceCMYK');
  expect(`${after.dict.get(PDFName.of('Width'))}×${after.dict.get(PDFName.of('Height'))}`).toBe('900×600');
  const { w, h } = cmykJpegSamples(after);
  expect(`${w}×${h}`).toBe('900×600');
});

// JPEG 2000 (class JPX, 2026-11-10): a 1200×800 RGB JPX drawn 4 × 2.67 in
// (300 dpi) under a line of text — before, no mode touched JPX at all
const jpxPdf = await PDFDocument.create();
const jpxImg = jpxPdf.context.register(jpxPdf.context.stream(fs.readFileSync(new URL('../fixtures/jpx/rgb-1200x800.jp2', import.meta.url)),
  { Type: 'XObject', Subtype: 'Image', Width: 1200, Height: 800, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'JPXDecode' }));
const jpxPage = jpxPdf.addPage([595, 842]);
jpxPage.node.setXObject(PDFName.of('Im0'), jpxImg);
jpxPage.pushOperators(pushGraphicsState(), concatTransformationMatrix(288, 0, 0, 192, 100, 400), drawObject('Im0'), popGraphicsState());
jpxPage.drawText('JPX survey page 7', { x: 100, y: 700, size: 14, font: await jpxPdf.embedFont(StandardFonts.Helvetica) });
const jpxFile = path.join(tmp, 'jpx-300dpi.pdf');
const jpxBytes = await jpxPdf.save({ useObjectStreams: false });
fs.writeFileSync(jpxFile, jpxBytes);
const pageText = async (bytes) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, standardFontDataUrl: new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname }).promise;
  const text = (await (await doc.getPage(1)).getTextContent()).items.map(i => i.str).join(' ');
  await doc.destroy();
  return text;
};
for (const [preset, size] of [['medium', '600×400'], ['high', '384×256']]) {
  await test(`JPX on ${preset === 'high' ? 'Maximum' : 'Standard'}: a 300-dpi JPEG 2000 → a JPEG at ${size}, RGB, smaller, the text kept`, async () => {
    const out = await compressViaUi(browser, jpxFile, preset);
    const after = firstImage(await PDFDocument.load(out));
    expect(after.dict.get(PDFName.of('Filter'))?.toString()).toBe('/DCTDecode');
    expect(after.dict.get(PDFName.of('ColorSpace'))?.toString()).toBe('/DeviceRGB');
    expect(`${after.dict.get(PDFName.of('Width'))}×${after.dict.get(PDFName.of('Height'))}`).toBe(size);
    if (!(out.length < jpxBytes.length / 2)) throw new Error(`${jpxBytes.length} → ${out.length}`);
    expect((await pageText(out)).includes('JPX survey page 7')).toBe(true);
  });
}
await test('JPX on Light: the JPEG 2000 image is left as it is', async () => {
  // A thumbnail gives Light a real opportunity, so the UI does not refuse a no-op.
  const lightPdf = await PDFDocument.load(jpxBytes);
  const thumbnail = lightPdf.context.register(lightPdf.context.stream(new Uint8Array(4096), {
    Type: 'XObject', Subtype: 'Image', Width: 64, Height: 64, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
  }));
  lightPdf.getPage(0).node.set(PDFName.of('Thumb'), thumbnail);
  const lightFile = path.join(tmp, 'jpx-with-thumbnail.pdf');
  fs.writeFileSync(lightFile, await lightPdf.save());
  const output = await PDFDocument.load(await compressViaUi(browser, lightFile, 'low'));
  CHECKS.untouched(firstImage(jpxPdf), firstImage(output));
});

// C35 (2026-11-11): a 1200×800 RGB JPEG drawn 2 in wide (600 dpi) — worker.js
// judged its dpi from the page size and left it; now it follows where it is drawn
const figPdf = await PDFDocument.create();
const figImg = figPdf.context.register(figPdf.context.stream(fs.readFileSync(new URL('../fixtures/placed/rgb-1200x800.jpg', import.meta.url)),
  { Type: 'XObject', Subtype: 'Image', Width: 1200, Height: 800, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' }));
const figPage = figPdf.addPage([595, 842]);
figPage.node.setXObject(PDFName.of('Im0'), figImg);
figPage.pushOperators(pushGraphicsState(), concatTransformationMatrix(144, 0, 0, 96, 100, 500), drawObject('Im0'), popGraphicsState());
figPage.drawText('Figure 3: placed small', { x: 100, y: 450, size: 12, font: await figPdf.embedFont(StandardFonts.Helvetica) });
const figFile = path.join(tmp, 'figure-600dpi.pdf');
const figBytes = await figPdf.save({ useObjectStreams: false });
fs.writeFileSync(figFile, figBytes);
for (const [preset, size] of [['medium', '300×200'], ['high', '192×128']]) {
  await test(`C35 on ${preset === 'high' ? 'Maximum' : 'Standard'}: a figure drawn 2 in wide at 600 dpi → ${size}, RGB, smaller, the text kept`, async () => {
    const out = await compressViaUi(browser, figFile, preset);
    const after = firstImage(await PDFDocument.load(out));
    expect(after.dict.get(PDFName.of('ColorSpace'))?.toString()).toBe('/DeviceRGB');
    expect(`${after.dict.get(PDFName.of('Width'))}×${after.dict.get(PDFName.of('Height'))}`).toBe(size);
    if (!(out.length < figBytes.length / 3)) throw new Error(`${figBytes.length} → ${out.length}`);
    expect((await pageText(out)).includes('Figure 3: placed small')).toBe(true);
  });
}

// Pure K right against colour: D300's guard keeps the original, so the
// lossless CMYK re-deflate (owner 2026-11-05) still does its part.
const KW = 600, KH = 800, KC = Buffer.from(CMYK);
for (let y = 0; y < KH / 4; y++) for (let x = 0; x < KW / 4; x++) { const i = (y * KW + x) * 4; KC[i] = KC[i + 1] = KC[i + 2] = 0; KC[i + 3] = 220; }
const kFile = path.join(tmp, 'cmyk-pure-k.pdf');
const kBytes = await imagePdf(zlib.deflateSync(KC, { level: 1 }), { Width: KW, Height: KH, ColorSpace: 'DeviceCMYK', Filter: 'FlateDecode' });
fs.writeFileSync(kFile, kBytes);
await test('a CMYK image D300 keeps (pure K against colour): re-deflated losslessly, the same samples', async () => {
  const before = firstImage(await PDFDocument.load(kBytes));
  const after = firstImage(await PDFDocument.load(await compressViaUi(browser, kFile, 'medium')));
  expect(after.dict.get(PDFName.of('Filter'))?.toString()).toBe('/FlateDecode');
  if (!(after.contents.length < before.contents.length)) throw new Error(`not smaller: ${after.contents.length} vs ${before.contents.length}`);
  expect(Buffer.compare(zlib.inflateSync(Buffer.from(after.contents)), KC)).toBe(0);
});

// C30 (owner-approved worker.js change 2026-11-05): an image's soft mask is a mask,
// not a picture — it was re-encoded into an RGB JPEG labelled /DeviceRGB.
await test('a soft mask stays a one-channel DeviceGray mask with the same values (C30)', async () => {
  const MW = 600, MH = 800, mask = Buffer.alloc(MW * MH), rgb = Buffer.alloc(MW * MH * 3);
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    // a photo-like alpha (noisy, so a JPEG would come out smaller than Flate and be kept)
    mask[y * MW + x] = (128 + 100 * Math.sin(x / 23) * Math.cos(y / 17) + ((x * 7919 + y * 104729) % 41) - 20) | 0;
    const i = (y * MW + x) * 3; rgb[i] = x % 256; rgb[i + 1] = y % 256; rgb[i + 2] = (x * y) % 256;
  }
  const bytes = await imagePdf(zlib.deflateSync(rgb), pdf => ({ Width: MW, Height: MH, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode',
    SMask: pdf.context.register(pdf.context.stream(zlib.deflateSync(mask), { Type: 'XObject', Subtype: 'Image', Width: MW, Height: MH, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'FlateDecode' })) }));
  const file = path.join(tmp, 'smask.pdf');
  fs.writeFileSync(file, bytes);
  const out = await PDFDocument.load(await compressViaUi(browser, file, 'medium'));
  const withMask = out.context.enumerateIndirectObjects().map(([, o]) => o).find(o => o?.dict?.has?.(PDFName.of('SMask')));
  const sm = out.context.lookup(withMask.dict.get(PDFName.of('SMask')));
  expect(sm.dict.get(PDFName.of('ColorSpace'))?.toString()).toBe('/DeviceGray');
  expect(sm.dict.get(PDFName.of('Filter'))?.toString()).toBe('/FlateDecode');
  expect(Buffer.compare(zlib.inflateSync(Buffer.from(sm.contents)), mask)).toBe(0);
});

// A grey JPEG scan (as office scanners write) downsampled on Standard: canvas re-encodes
// it as an RGB JPEG; the label stayed /DeviceGray, so readers drew three channels as grey —
// a page of overlapping ghost copies (C31, real scans, 2026-11-06). The JPEG's own component
// count must match the colour space the dictionary names.
const jpegComponents = b => { for (let i = 2; i < b.length - 9; ) { if (b[i] !== 0xFF) return null; const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3]; if (m >= 0xC0 && m <= 0xC3) return b[i + 9]; i += 2 + len; } return null; };
await test('a grey JPEG scan on Standard: the JPEG\'s channels match its colour space (C31)', async () => {
  const file = path.join(tmp, 'gray-scan.pdf');
  fs.writeFileSync(file, await imagePdf(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'gray-scan.jpg')), { Width: 1700, Height: 2200, ColorSpace: 'DeviceGray', Filter: 'DCTDecode' }));
  const after = firstImage(await PDFDocument.load(await compressViaUi(browser, file, 'medium')));
  const cs = after.dict.get(PDFName.of('ColorSpace'))?.toString();
  if (after.dict.get(PDFName.of('Filter'))?.toString() === '/DCTDecode') {
    const n = jpegComponents(after.contents);
    expect(`${cs} ${n}`).toBe(n === 1 ? '/DeviceGray 1' : '/DeviceRGB 3');
  }
});

// A scan at 96 dpi (Maximum's default, the target-size chips): an honest note that small
// print and Chinese / Japanese characters can become hard to read (measured 2026-11-05).
await test('a scan on Maximum (96 dpi) shows the readability note; Standard hides it; a text PDF never shows it', async () => {
  const scanFile = path.join(tmp, 'scan-note.pdf');
  fs.writeFileSync(scanFile, await imagePdf(zlib.deflateSync(RAW_RGB), { Width: TW, Height: TH, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode' }));
  const textFile = path.join(tmp, 'text-note.pdf');
  fs.writeFileSync(textFile, await textPdf());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const noteShown = () => page.evaluate(() => { const n = document.getElementById('compressDpiNote'); return !!n && !n.hidden && /96/.test(n.textContent); });
  try {
    await page.goto(`${BASE_URL}/compress-pdf/`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', scanFile);
    await page.waitForFunction(() => /compress-scan--(clean|found)/.test(document.getElementById('compressScanBanner')?.className || ''), null, { timeout: 45000 });   // the background scan can be slow on a busy machine
    await page.click('label[data-preset="high"]');
    if (!(await noteShown())) throw new Error('no note on a scan at 96 dpi');
    await page.click('label[data-preset="medium"]');
    if (await noteShown()) throw new Error('note still shown on Standard (150 dpi)');
    await page.goto(`${BASE_URL}/compress-pdf/`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', textFile);
    await page.waitForFunction(() => /compress-scan--(clean|found)/.test(document.getElementById('compressScanBanner')?.className || ''), null, { timeout: 45000 });   // the background scan can be slow on a busy machine
    await page.click('label[data-preset="high"]');
    if (await noteShown()) throw new Error('note shown for a text PDF');
  } finally {
    await context.close();
  }
});

await test('a batch whose first file is plain text stays on Standard, not the scan\'s Light pick', async () => {
  const textFile = path.join(tmp, 'text-first.pdf');
  fs.writeFileSync(textFile, await textPdf());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.goto(`${BASE_URL}/compress-pdf/`, { waitUntil: 'load', timeout: 30000 });
    // The same text file alone: the scan has run (its banner is up) and the
    // pick is Standard too.
    await page.setInputFiles('#fileInput', textFile);
    await page.waitForFunction(() => /compress-scan--(clean|found)/.test(document.getElementById('compressScanBanner')?.className || ''), null, { timeout: 15000 });
    expect(await page.evaluate(() => document.querySelector('input[name="compressPreset"]:checked')?.value)).toBe('medium');
    // Adding more files turns it into a batch → the scan's pick is reverted.
    await page.setInputFiles('#fileInput', path.join(tmp, 'raw-icc-by-ref.pdf'));
    await page.waitForFunction(() => document.querySelector('input[name="compressPreset"]:checked')?.value === 'medium', null, { timeout: 15000 });
  } finally {
    await context.close();
  }
});

await test('a clean text PDF compresses on the first click — the starred preset is never one validate() refuses', async () => {
  // A text PDF with nothing for Light to strip: the scan used to star and
  // pick Light, and validate() then refused Light with val_light_no_savings
  // (owner's report 2026-10-21, a 4-page worksheet).
  const textFile = path.join(tmp, 'clean-text.pdf');
  fs.writeFileSync(textFile, await textPdf());
  const out = await compressViaUi(browser, textFile);
  expect(out.length > 0).toBe(true);
});

// "Fit into N MB/KB" (a person asked for 4 MB, 2026-11-13): the gentlest
// setting whose file fits, the cost said; an unreachable size said plainly
async function compressToSize(file, kb) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.addInitScript(BLOB_HOOK);
    await page.goto(`${BASE_URL}/compress-pdf/`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', file);
    await page.waitForTimeout(3000);
    await setTargetKb(page, String(kb));
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__blob, null, { timeout: 120000 });
    const size = await page.evaluate(() => window.__blob.size);
    const verdict = await page.locator('#targetVerdict').innerText();
    return { size, verdict };
  } finally {
    await context.close();
  }
}

// A colour photo filling the page: never black and white (C37), so its
// strongest steps are JPEG under 150 dpi — below the readable floor
async function photoPdf() {
  const W = 1200, H = 900, rgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3, n = (x * 13 + y * 7) % 19;
    rgb[i] = 128 + 90 * Math.sin(x / 23) + n; rgb[i + 1] = 120 + 80 * Math.cos(y / 19) + n; rgb[i + 2] = 110 + n;
  }
  const file = path.join(tmp, 'photo-page.pdf');
  fs.writeFileSync(file, await imagePdf(zlib.deflateSync(rgb), { Width: W, Height: H, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode' }));
  return file;
}

// Compress photoPdf() to `kb`; answer the floor question with `answer`
// ('go' | 'cancel' | null = must not be asked) → { size, verdict, asked, tries }
async function photoToSize(file, kb, answer) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.addInitScript(BLOB_HOOK);
    await page.addInitScript(() => {
      window.__tries = new Set();
      setInterval(() => {
        const m = (document.querySelector('#progressLabel')?.textContent || '').match(/(\d+)\D*$/);
        if (m && /fits/.test(document.querySelector('#progressLabel')?.textContent || '')) window.__tries.add(+m[1]);
      }, 50);
    });
    await page.goto(`${BASE_URL}/compress-pdf/`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', file);
    await page.waitForTimeout(3000);
    await setTargetKb(page, String(kb));
    await page.click('#mergeBtn');
    const asked = await page.waitForFunction(() => window.__blob || document.querySelector('#floorConfirmGo'), null, { timeout: 120000 })
      .then(() => page.evaluate(() => !!document.querySelector('#floorConfirmGo')));
    if (asked) {
      if (!answer) throw new Error('asked, and must not be');
      await page.click(answer === 'go' ? '#floorConfirmGo' : '#floorConfirmCancel');
      await page.waitForFunction(() => window.__blob, null, { timeout: 120000 });
    } else if (answer) throw new Error('not asked');
    return {
      size: await page.evaluate(() => window.__blob.size), asked,
      verdict: await page.locator('#targetVerdict').innerText(),
      tries: await page.evaluate(() => Math.max(0, ...window.__tries)),
    };
  } finally {
    await context.close();
  }
}

await test('a size out of reach: the strongest try, then the smallest readable file — not a 72 dpi one', async () => {
  // 43 % of the people who set a size in 14 days missed it, 3 in 4 by more
  // than 2×; each try is a full pass (512 KB from a 74 MB scan: 11 tries,
  // 144 s) — the strongest step goes first (2026-11-19); out of reach, the
  // answer is the smallest file that still reads (owner, 2026-11-20)
  const r = await photoToSize(await photoPdf(), 1, null);
  if (r.tries !== 2) throw new Error(`answered after ${r.tries} tries`);
  if (!r.verdict.includes("Couldn't get under") || !r.verdict.includes('readable')) throw new Error(r.verdict);
});

await test('a size reachable only below the readable floor: the user is asked — Cancel keeps it readable, the other button meets the size', async () => {
  const file = await photoPdf();
  const readable = (await photoToSize(file, 1, null)).size;
  const kb = Math.floor(readable * 0.8 / 1000);
  const kept = await photoToSize(file, kb, 'cancel');
  if (Math.abs(kept.size - readable) > readable * 0.02) throw new Error(`kept ${kept.size}, readable was ${readable}`);
  if (!kept.verdict.includes('readable')) throw new Error(kept.verdict);
  const met = await photoToSize(file, kb, 'go');
  if (met.size > kb * 1000) throw new Error(`${met.size} bytes, over ${kb} KB`);
});

await test('a text scan under a tight size goes black and white at 200 dpi or more, not a 72 dpi JPEG (C37)', async () => {
  // Below 150 dpi a JPEG text page stops reading (scripts/bench/scan_floor.py);
  // in black and white it reads at 200 dpi and is no larger (2026-11-20)
  const W = 2480, H = 3508, rgb = Buffer.alloc(W * H * 3);   // A4 at 300 dpi
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ink = y % 60 < 30 && ((Math.floor(x / 9) + Math.floor(y / 13)) % 4 === 0 || x % 37 < 3), n = (rnd() - 0.5) * 10;
    const i = (y * W + x) * 3, v = ink ? [32, 30, 36] : [244, 241, 232];
    for (let c = 0; c < 3; c++) rgb[i + c] = Math.max(0, Math.min(255, v[c] + n));
  }
  const file = path.join(tmp, 'text-scan.pdf');
  fs.writeFileSync(file, await imagePdf(zlib.deflateSync(rgb), { Width: W, Height: H, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode' }));
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.addInitScript(BLOB_HOOK);
    await page.goto(`${BASE_URL}/compress-pdf/`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', file);
    await page.waitForTimeout(3000);
    await setTargetKb(page, '150');
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__blob, null, { timeout: 180000 });
    const out = Buffer.from(await page.evaluate(async () => Array.from(new Uint8Array(await window.__blob.arrayBuffer()))));
    if (out.length > 150_000) throw new Error(`${out.length} bytes, over 150 KB`);
    const d = firstImage(await PDFDocument.load(out)).dict;
    const bpc = d.get(PDFName.of('BitsPerComponent')).asNumber(), w = d.get(PDFName.of('Width')).asNumber();
    if (bpc !== 1 || d.get(PDFName.of('ColorSpace')).toString() !== '/DeviceGray') throw new Error(`not black and white: ${d}`);
    if (w < 1600) throw new Error(`${w} px wide: under 200 dpi`);
    const verdict = await page.locator('#targetVerdict').innerText();
    if (!verdict.includes('black and white')) throw new Error(`the card doesn't say so: ${verdict}`);
  } finally {
    await context.close();
  }
});

await test('fit into a size: an image PDF fits 40 % of its size, and the cost is said', async () => {
  const W = 1600, H = 1200, rgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3, n = (x * 31 + y * 17) % 23;
    rgb[i] = 128 + 90 * Math.sin(x / 37) + n; rgb[i + 1] = 120 + 80 * Math.cos(y / 29) + n; rgb[i + 2] = 110 + 70 * Math.sin((x - y) / 41) + n;
  }
  const bytes = await imagePdf(zlib.deflateSync(rgb), { Width: W, Height: H, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode' });
  const file = path.join(tmp, 'photo-size.pdf');
  fs.writeFileSync(file, bytes);
  const kb = Math.floor(bytes.length * 0.4 / 1000);
  const { size, verdict } = await compressToSize(file, kb);
  if (!(size <= kb * 1000)) throw new Error(`${size} bytes over ${kb} KB`);
  if (!/fits/.test(verdict) || !/dpi|No quality lost/.test(verdict)) throw new Error(verdict);
});

await test('fit into a size: an unreachable size is said plainly and a file is still given', async () => {
  const file = path.join(tmp, 'text-size.pdf');
  fs.writeFileSync(file, await textPdf());
  const { size, verdict } = await compressToSize(file, 0.2);   // the text PDF is ~1 KB already
  expect(size > 0).toBe(true);
  if (!/Couldn't get under/.test(verdict)) throw new Error(verdict);
});

const realCorpus = new URL('../corpus/real/', import.meta.url);
const realFiles = ['wikipedia-ar-pdf.pdf', 'irs-f1040-form.pdf'].map(corpusName => ({
  name: 'report.pdf',
  mimeType: 'application/pdf',
  buffer: fs.readFileSync(new URL(corpusName, realCorpus)),
}));

async function batchWithTarget(context, kb) {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/compress-pdf/`);
  await page.setInputFiles('#fileInput', realFiles);
  await setTargetKb(page, String(kb));
  await page.click('#mergeBtn');
  const button = page.locator('#downloadBtn');
  await button.waitFor({ timeout: 120000 });
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  const zip = await JSZip.loadAsync(fs.readFileSync(await download.path()));
  return { page, zip };
}

for (const [name, profile] of [
  ['desktop light', { viewport: { width: 1440, height: 900 } }],
  ['iPhone dark', { ...devices['iPhone 13'], colorScheme: 'dark' }],
  ['Android light', devices['Pixel 7']],
]) {
  await test(`real PDFs, ${name}: preserves both same-name files and reports an unreachable target`, async () => {
    const context = await browser.newContext({ ...profile, serviceWorkers: 'block', acceptDownloads: true });
    try {
      const { page, zip } = await batchWithTarget(context, 0.1);
      const names = Object.keys(zip.files);
      expect(names.sort().join('|')).toBe(['report-compressed (2).pdf', 'report-compressed.pdf'].join('|'));
      for (let i = 0; i < realFiles.length; i++) {
        const entry = i === 0 ? 'report-compressed.pdf' : 'report-compressed (2).pdf';
        const output = await PDFDocument.load(await zip.file(entry).async('uint8array'));
        const input = await PDFDocument.load(realFiles[i].buffer);
        expect(output.getPageCount()).toBe(input.getPageCount());
        expect(JSON.stringify(output.getPage(0).getSize())).toBe(JSON.stringify(input.getPage(0).getSize()));
      }
      const verdicts = await page.locator('#targetVerdict li').allTextContents();
      expect(verdicts.length).toBe(2);
      if (!verdicts.every(text => text.includes("Couldn't get under"))) throw new Error(verdicts.join('\n'));
    } finally {
      await context.close();
    }
  });
}

await test('real PDFs: reports a met target for each ZIP entry', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
  try {
    const { page, zip } = await batchWithTarget(context, 300);
    const verdicts = await page.locator('#targetVerdict li').allTextContents();
    expect(verdicts.length).toBe(2);
    if (!verdicts.every(text => text.includes('fits'))) throw new Error(verdicts.join('\n'));
    for (const entry of Object.values(zip.files)) {
      const size = (await entry.async('uint8array')).byteLength;
      if (size > 300_000) throw new Error(`${entry.name} exceeded target: ${size}`);
    }
  } finally {
    await context.close();
  }
});

await test('cancelled target compression cannot time out or interfere with a retry', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.stallNextCompress = true;
      window.compressRequests = 0;
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        postMessage(message, transfer) {
          if (message.tool === 'compress') {
            window.compressRequests++;
            if (window.stallNextCompress) {
              window.stallNextCompress = false;
              return;
            }
          }
          super.postMessage(message, transfer);
        }
      };
    });
    await page.goto(`${BASE_URL}/compress-pdf/`);
    await page.setInputFiles('#fileInput', realFiles[0]);
    await setTargetKb(page, 5000);
    await page.clock.install();
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.compressRequests === 1);
    await page.click('#cancelBtn');
    await page.clock.fastForward(46000);
    expect(await page.getByText(/Compression timed out/).count()).toBe(0);
    await page.click('#mergeBtn');
    await page.locator('#downloadBtn').waitFor();
    expect(await page.getByText(/Compression timed out/).count()).toBe(0);
  } finally {
    await context.close();
  }
});

await test('real PDF: a timed-out worker is terminated before retry', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.compressWorkers = [];
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        postMessage(message, transfer) {
          if (message.tool === 'compress') {
            window.compressWorkers.push(this);
            if (window.compressWorkers.length === 1) return;
          }
          super.postMessage(message, transfer);
        }

        terminate() {
          this.stopped = true;
          super.terminate();
        }
      };
    });
    await page.goto(`${BASE_URL}/compress-pdf/`);
    await page.setInputFiles('#fileInput', realFiles[0]);
    await page.clock.install();
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.compressWorkers.length === 1);
    await page.clock.fastForward(46000);
    await page.getByText(/Compression timed out/).first().waitFor();
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.compressWorkers.length === 2);
    const isolated = await page.evaluate(() => {
      const [first, retry] = window.compressWorkers;
      return first.stopped === true && first !== retry;
    });
    expect(isolated).toBe(true);
    await page.locator('#downloadBtn').waitFor();
  } finally {
    await context.close();
  }
});

async function testTargetSelection({ fittingQuality, attempts, dpi, exactLimit, refinement, fitBytes }) {
  const fitDpi = dpi;
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const pdf = Array.from(await textPdf());
    await page.addInitScript(BLOB_HOOK);
    await page.addInitScript(({ pdf, fittingQuality, exactLimit, refinement, fitBytes, fitDpi }) => {
      window.targetAttempts = [];
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        postMessage(message, transfer) {
          if (message.tool !== 'compress') {
            super.postMessage(message, transfer);
            return;
          }
          const { quality, targetDpi } = message.options;
          window.targetAttempts.push(quality);
          // at the same dpi a lower quality is never larger (a real PDF's way, which
          // the halving search relies on); across a dpi drop it can be (150 dpi at
          // 0.75 larger than 200 dpi at 0.70 — the case these tests keep)
          const fits = quality === fittingQuality || (quality !== null && quality <= 0.60)
            || (targetDpi === 200 && fitDpi === 200 && quality !== null && quality <= fittingQuality);
          let size = exactLimit ? exactLimit + (fits ? 0 : 1) : pdf.length + (fits ? 0 : 1024);
          if (fitBytes && quality === fittingQuality) size = fitBytes;
          if (refinement && quality === 0.75) size = 460_000;
          if (refinement && quality === 0.77) size = refinement;
          const result = new Uint8Array(size).fill(32);
          result.set(pdf);
          setTimeout(() => this.onmessage?.({ data: {
            type: 'done', result: result.buffer, compressedSize: size, report: {},
          } }), 0);
        }
      };
    }, { pdf, fittingQuality, exactLimit, refinement, fitBytes, fitDpi });
    await page.goto(`${BASE_URL}/compress-pdf/`);
    const input = exactLimit ? fileURLToPath(new URL('arxiv-2609.36796.pdf', realCorpus)) : realFiles[0];
    await page.setInputFiles('#fileInput', input);
    await setTargetKb(page, String(exactLimit ? exactLimit / 1000 : Math.ceil(pdf.length / 1000)));
    await page.click('#mergeBtn');
    await page.locator('#downloadBtn').waitFor();
    if (exactLimit) {
      const expected = refinement ? (refinement <= exactLimit ? refinement : 460_000) : (fitBytes ?? exactLimit);
      expect(await page.evaluate(() => window.__blob.size)).toBe(expected);
    }
    expect(JSON.stringify(await page.evaluate(() => window.targetAttempts))).toBe(JSON.stringify(attempts));
    if (!(await page.locator('#targetVerdict').innerText()).includes(`${dpi} dpi`)) {
      throw new Error(`Expected the ${dpi} dpi result`);
    }
  } finally {
    await context.close();
  }
}

// The strongest step (72 dpi, 30 %) is tried first since 2026-11-19 — a size out
// of reach ends there. A reachable one: the 3 gentle steps one by one, then
// halving (60, then 75/65 at 150 dpi), then the last 200 dpi step (2026-11-21).
await test('target size checks a gentler fit even when the next preset grows', () =>
  testTargetSelection({ fittingQuality: 0.85, attempts: [0.30, null, 0.85], dpi: 300 }));

await test('target size lowers JPEG quality at 200 dpi before reducing resolution', () =>
  testTargetSelection({ exactLimit: 500_000, fittingQuality: 0.70, attempts: [0.30, null, 0.85, 0.80, 0.60, 0.75, 0.65, 0.70], dpi: 200 }));


await test('target size treats 500 KB as exactly 500000 bytes', () =>
  testTargetSelection({ exactLimit: 500_000, fittingQuality: 0.75,
    attempts: [0.30, null, 0.85, 0.80, 0.60, 0.75, 0.70, 0.75], dpi: 200 }));

for (const [description, refinement] of [
  ['uses intermediate quality if it fits', 495_000],
  ['keeps the first fit if intermediate quality exceeds the limit', 500_001],
]) {
  await test(`target size ${description}`, () => testTargetSelection({
    exactLimit: 500_000, fittingQuality: 0.75, refinement,
    attempts: [0.30, null, 0.85, 0.80, 0.60, 0.75, 0.70, 0.75, 0.77], dpi: 200,
  }));
}

await test('target size keeps the tested 70 percent preset when it fits with headroom', () =>
  testTargetSelection({ exactLimit: 500_000, fittingQuality: 0.70, fitBytes: 460_000,
    attempts: [0.30, null, 0.85, 0.80, 0.60, 0.75, 0.65, 0.70], dpi: 200 }));

await test('mixed packet restores a sharper scan within budget and preserves the form', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/compress-pdf/`);
    const jpeg = async size => page.evaluate(async size => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const draw = canvas.getContext('2d');
      draw.fillStyle = '#f0dfb3';
      draw.fillRect(0, 0, size, size);
      draw.fillStyle = '#242833';
      for (let y = 2; y < size; y += 8) draw.fillRect(5, y, size - 10, 2);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.86));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    }, size);
    async function packet(size) {
      const scan = await imagePdf(Uint8Array.from(await jpeg(size)), {
        Width: size, Height: size, ColorSpace: 'DeviceRGB', Filter: 'DCTDecode',
      });
      const pdf = await PDFDocument.load(scan);
      const electronic = pdf.addPage();
      electronic.drawText('Electronic form', { x: 30, y: 740 });
      const field = pdf.getForm().createTextField('reference');
      field.setText('EXAMPLE-123');
      field.addToPage(electronic, { x: 30, y: 700, width: 100, height: 18 });
      return pdf.save();
    }
    const base = await packet(120);
    const larger = await packet(240);
    const hit = await page.evaluate(async ({ base, larger }) => {
      const worker = new Worker('/js/compressPageRefineWorker.js');
      try {
        const run = targetBytes => new Promise((resolve, reject) => {
          worker.onerror = event => reject(Error(event.message || 'Page refinement worker failed to load'));
          worker.onmessage = ({ data }) => resolve(data);
          worker.postMessage({ base: Uint8Array.from(base).buffer, larger: Uint8Array.from(larger).buffer, targetBytes });
        });
        const tooSmall = await run(base.length);
        const result = await run(larger.length + 1024);
        return { tooSmall, pages: result?.pages, pdf: result && Array.from(new Uint8Array(result.buffer)) };
      } finally {
        worker.terminate();
      }
    }, { base: Array.from(base), larger: Array.from(larger) });
    expect(hit.tooSmall).toBe(null);
    expect(JSON.stringify(hit.pages)).toBe('[1]');
    expect(hit.pdf.length <= larger.length + 1024).toBe(true);
    const pdf = await PDFDocument.load(Uint8Array.from(hit.pdf));
    expect(pdf.getPageCount()).toBe(2);
    expect(firstImage(pdf).dict.get(PDFName.of('Width')).asNumber()).toBe(240);
    expect(pdf.getForm().getTextField('reference').getText()).toBe('EXAMPLE-123');
  } finally {
    await context.close();
  }
});

await test('strong compression keeps a QR-readable scan when the smaller version loses its code', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/compress-pdf/`);
    const pathToQr = new URL('../fixtures/compress-qr.png', import.meta.url);
    const encoded = fs.readFileSync(pathToQr).toString('base64');
    async function scan(withQr) {
      const jpeg = await page.evaluate(async ({ encoded, withQr }) => {
        const canvas = document.createElement('canvas');
        canvas.width = 520;
        canvas.height = 736;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (withQr) {
          const image = new Image();
          image.src = 'data:image/png;base64,' + encoded;
          await image.decode();
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(image, 65, 267, 132, 132);
        }
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
      }, { encoded, withQr });
      return imagePdf(Uint8Array.from(jpeg), {
        Width: 520, Height: 736, ColorSpace: 'DeviceRGB', Filter: 'DCTDecode',
      });
    }
    const readable = await scan(true);
    const unreadable = await scan(false);
    const verdict = await page.evaluate(async ({ readable, unreadable }) => {
      const worker = new Worker('/js/compressPageRefineWorker.js');
      try {
        const check = bytes => new Promise((resolve, reject) => {
          worker.onerror = () => reject(Error('QR verification worker failed'));
          worker.onmessage = ({ data }) => resolve(data);
          const original = Uint8Array.from(readable).buffer;
          const base = Uint8Array.from(bytes).buffer;
          const larger = Uint8Array.from(readable).buffer;
          worker.postMessage({ original, base, larger }, [original, base, larger]);
        });
        const lost = await check(unreadable);
        const retained = await check(readable);
        return { protected: lost?.qrProtected, retained, bytes: lost?.buffer?.byteLength };
      } finally {
        worker.terminate();
      }
    }, { readable: Array.from(readable), unreadable: Array.from(unreadable) });
    expect(verdict.protected).toBe(true);
    expect(verdict.retained).toBe(null);
    expect(verdict.bytes).toBe(readable.byteLength);
  } finally {
    await context.close();
  }
});

// The size field (owner, 2026-11-24): at the top, above the mode cards; no
// preset buttons; the file's own unit (KB under 1 MB, else MB); it starts at
// the file's size less 20 % and does nothing until the person changes it;
// − steps down; choosing a mode card turns it off again.
await test('size field: on top, own unit, −20 %, off until changed, − steps down, a mode card turns it off', async () => {
  const tests = new URL('../', import.meta.url);
  for (const [name, unit] of [['corpus/real/wikipedia-tr-pdf.pdf', 'KB'], ['fixtures/clean-scan/stamp-red.pdf', 'MB']]) {
    const file = fileURLToPath(new URL(name, tests));
    const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
    await page.goto(`${BASE_URL}/compress-pdf/`);
    await page.setInputFiles('#fileInput', file);
    await page.waitForSelector('.compress-target__unit');
    const s = await page.evaluate(() => {
      const box = document.querySelector('#compressTarget');
      return {
        unit: box.querySelector('.compress-target__unit').textContent.trim(),
        value: Number(document.querySelector('#compressTargetValue').value),
        aboveCards: !!(box.compareDocumentPosition(document.querySelector('.compress-presets')) & Node.DOCUMENT_POSITION_FOLLOWING),
        chips: box.querySelectorAll('[data-target], select').length,
        on: box.classList.contains('compress-target--on'),
      };
    });
    const size = fs.statSync(file).size;
    // −20 % of the size the page shows (1 KB = 1024 bytes): "737 KB" offers 589
    const want = unit === 'KB' ? Math.floor(size * 0.8 / 1024) : Math.floor(size * 0.8 / 1_048_576 * 10) / 10;
    if (s.unit !== unit || s.value !== want || !s.aboveCards || s.chips || s.on) throw new Error(`${name}: ${JSON.stringify(s)}, want ${want} ${unit}`);
    await page.click('.compress-target__step[data-step="-1"]');
    const after = await page.evaluate(() => ({ value: Number(document.querySelector('#compressTargetValue').value),
      on: document.querySelector('#compressTarget').classList.contains('compress-target--on') }));
    const step = unit === 'KB' ? (want > 100 ? 10 : 1) : (want > 10 ? 1 : 0.1);
    if (!after.on || Math.abs(after.value - Math.round((want - step) * 10) / 10) > 1e-9) throw new Error(`${name} after −: ${JSON.stringify(after)}`);
    // − / + are steppers, not rage (rageClicks.js); held, − keeps stepping
    // and steps 5× after ~1.5 s; its closing click adds no extra step
    if (!(await page.evaluate(async () => (await import('/js/rageClicks.js')).isRepeatControl(document.querySelector('#compressTargetDown'))))) throw new Error(`${name}: − counted as a rage click`);
    const held = after.value;
    const box = await page.locator('#compressTargetDown').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.waitForTimeout(2600); await page.mouse.up();
    await page.waitForTimeout(600);
    const afterHold = Number(await page.inputValue('#compressTargetValue'));
    if (!(afterHold < held - 15 * step)) throw new Error(`${name}: holding − went ${held} → ${afterHold}`);
    await page.click('#compressTargetUp');
    const one = Number(await page.inputValue('#compressTargetValue'));
    if (Math.abs(one - afterHold - (unit === 'KB' ? (afterHold >= 100 ? 10 : 1) : (afterHold >= 10 ? 1 : 0.1))) > 1e-9 && afterHold > (unit === 'KB' ? 1 : 0.1)) throw new Error(`${name}: one + after a hold went ${afterHold} → ${one}`);
    await page.click('.compress-preset[data-preset="high"]');
    if (await page.evaluate(() => document.querySelector('#compressTarget').classList.contains('compress-target--on'))) throw new Error(`${name}: a mode card left the size on`);
    await page.context().close();
  }
});

// A background tab: the browser starves it of CPU, so the worker goes quiet for
// longer than the 45 s watchdog while nothing is wrong. 14 of 15 people whose
// Compress timed out had the tab hidden (Analytics, 2026-11-24). Here the tab is
// hidden and the compress worker's messages held back for 50 s, then the tab comes back
// and the messages arrive: the file must come out, with no timeout.
await test('a background tab whose worker goes quiet past 45 s still gets its file', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.addInitScript(BLOB_HOOK);
    await page.addInitScript(() => {
      window.__hidden = false; window.__held = [];
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__hidden ? 'hidden' : 'visible') });
      const Real = window.Worker;
      window.Worker = class extends Real {
        constructor(...args) {
          super(...args);
          // the compress worker only: the prep worker's own limit falls back, it never errs
          const main = /\/worker\.js/.test(String(args[0]));
          let handler = null;
          super.onmessage = e => { if (main && window.__hidden) window.__held.push(() => handler?.(e)); else handler?.(e); };
          Object.defineProperty(this, 'onmessage', { configurable: true, get: () => handler, set: fn => { handler = fn; } });
        }
      };
      window.__setHidden = hidden => {
        window.__hidden = hidden;
        document.dispatchEvent(new Event('visibilitychange'));
        if (!hidden) for (const deliver of window.__held.splice(0)) deliver();
      };
    });
    await page.goto(`${BASE_URL}/compress-pdf/`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', await photoPdf());
    await page.waitForTimeout(3000);
    await page.click('#mergeBtn');
    await page.evaluate(() => window.__setHidden(true));
    await page.waitForTimeout(50_000);
    const toastWhileHidden = await page.evaluate(() => document.querySelector('#toast')?.textContent || '');
    await page.evaluate(() => window.__setHidden(false));
    await page.waitForFunction(() => window.__blob, null, { timeout: 60000 });
    const toast = toastWhileHidden + await page.evaluate(() => document.querySelector('#toast')?.textContent || '');
    if (/timed out/i.test(toast)) throw new Error(`timed out: ${toast.slice(0, 80)}`);
  } finally {
    await context.close();
  }
});

// C38: the worker removes a page's /PieceInfo (an editor's private data) and
// pdf-lib still wrote what it pointed to — 31 of 32 MB of one Maximum output
// (2026-11-25). The stream nobody references must not come out.
await test('C38: private data the worker unhooks leaves the file (Maximum)', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 300]);
  page.drawText('C38', { x: 40, y: 150, size: 30 });
  const junk = pdf.context.register(pdf.context.stream(randomBytes(400000)));   // random: no filter can shrink it
  page.node.set(PDFName.of('PieceInfo'), pdf.context.obj({ Illustrator: { Private: junk } }));
  const file = path.join(tmp, 'c38-pieceinfo.pdf');
  fs.writeFileSync(file, await pdf.save());
  const out = await compressViaUi(browser, file, 'high');
  const doc = await PDFDocument.load(out);
  expect(doc.getPageCount()).toBe(1);
  if (!(out.length < 50000)) throw new Error(`private data kept: ${out.length} bytes`);
});

// Screen & email (owner, 2026-11-25): a 4th card; CMYK images become RGB at
// 150 dpi (the chain 15 held-out print PDFs passed), the rest as Maximum.
// Its line says "not for print", on a phone and on a desktop.
async function textPdfFile() {
  const file = path.join(tmp, 'screen-text.pdf');
  fs.writeFileSync(file, await textPdf());
  return file;
}
async function cmykPhotoPdf() {
  const W = 2480, H = 3508, cmyk = Buffer.alloc(W * H * 4);   // A4 at 300 dpi, a photo-like field
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, n = (x * 13 + y * 7) % 23;
    cmyk[i] = 90 + 60 * Math.sin(x / 41) + n; cmyk[i + 1] = 80 + 50 * Math.cos(y / 37) + n; cmyk[i + 2] = 70 + n; cmyk[i + 3] = 20 + (n >> 1);
  }
  const file = path.join(tmp, 'screen-cmyk.pdf');
  fs.writeFileSync(file, await imagePdf(zlib.deflateSync(cmyk), { Width: W, Height: H, ColorSpace: 'DeviceCMYK', Filter: 'FlateDecode' }));
  return file;
}
await test('Screen & email: CMYK → DeviceRGB at 150 dpi, smaller than Maximum; Maximum keeps CMYK', async () => {
  const file = await cmykPhotoPdf();
  const screen = await compressViaUi(browser, file, 'screen');
  const max = await compressViaUi(browser, file, 'high');
  const s = firstImage(await PDFDocument.load(screen)), m = firstImage(await PDFDocument.load(max));
  expect(String(s.dict.get(PDFName.of('ColorSpace')))).toBe('/DeviceRGB');
  expect(String(m.dict.get(PDFName.of('ColorSpace')))).toBe('/DeviceCMYK');
  expect(String(s.dict.get(PDFName.of('Width')))).toBe('1240');   // 8.27 in × 150
  if (!(screen.length < max.length)) throw new Error(`screen ${screen.length} ≥ maximum ${max.length}`);
});
for (const [vp, w, h] of [['phone', 390, 844], ['desktop', 1440, 900]]) {
  await test(`Screen & email card shows its "not for print" line (${vp})`, async () => {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: w, height: h } });
    const page = await context.newPage();
    try {
      await page.goto(`${BASE_URL}/compress-pdf/`, { waitUntil: 'load', timeout: 30000 });
      await page.setInputFiles('#fileInput', await textPdfFile());
      const card = page.locator('label[data-preset="screen"]');
      await card.waitFor({ state: 'visible', timeout: 15000 });
      const text = await card.innerText();
      if (!/not for print/i.test(text)) throw new Error(`card text: ${text}`);
      await card.click();
      if (await page.locator('#qualityRow').isVisible()) throw new Error('manual quality shown for Screen & email');
    } finally { await context.close(); }
  });
}

await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
