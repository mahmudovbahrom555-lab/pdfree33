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

import { chromium } from 'playwright';
import { PDFDocument, PDFName, StandardFonts, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } from 'pdf-lib';
import zlib from 'zlib';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { trapCases, textPdf, firstImage, imagePdf, RAW_RGB, W as TW, H as TH } from '../corpus/traps.mjs';

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

await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
