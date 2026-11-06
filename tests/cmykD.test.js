// tests/cmykD.test.js — js/cmykD.js (Compress mode D300 for print images), in Node.
//
// The real chain: pdf-lib from node_modules, pdf.js's image decoders (the
// devDependency the vendored copy must equal — check_vendor_sync.py), and the
// site's own qpdf WASM (js/vendor/qpdf/lib). Checks:
//   - the row-band downsample gives the same bytes as the whole-image
//     version the research prototype measured (chain.mjs);
//   - placements: the largest drawing decides, forms' /Matrix is followed;
//   - an image also used outside the page content (a pattern) is left alone;
//   - a 600-ppi CMYK photo becomes a 300-ppi DeviceCMYK JPEG, close to the source;
//   - pure-K text stays free of C/M/Y; pure K against colour → the guard keeps
//     the original; an image over the device limit is left alone;
//   - Standard/Maximum/Light/signed options (processor.js _cmykDOptions).
//
// Run: node tests/cmykD.test.js

import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import { deflateSync } from 'zlib';
import * as PDFLib from 'pdf-lib';

const { PDFDocument, PDFName, PDFRawStream } = PDFLib;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
globalThis.PDFLib = PDFLib;
globalThis.self = globalThis;

// the site's qpdf: its factory is a CommonJS module; this package is ESM, so a .cjs copy
const tmp = mkdtempSync(join(tmpdir(), 'cmykd-'));
writeFileSync(join(tmp, 'qpdf.cjs'), readFileSync(join(ROOT, 'js/vendor/qpdf/lib/qpdf.js')));
globalThis.Module = createRequire(import.meta.url)(join(tmp, 'qpdf.cjs'));
globalThis.importScripts = () => {};
const URLS = {
  decoders: pathToFileURL(join(ROOT, 'node_modules/pdfjs-dist/legacy/image_decoders/pdf.image_decoders.mjs')).href,
  qpdfJs: '', qpdfWasm: join(ROOT, 'js/vendor/qpdf/lib/qpdf.wasm'),
};

// the file is one function scope (see its header); the test reads its inner functions
const src = readFileSync(join(ROOT, 'js/cmykD.js'), 'utf8').replace(/^\(\(\) => \{$/m, '').replace(/^\}\)\(\);\s*$/m, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const D = await new AsyncFunction(src + '\nreturn { cmykD, _cmykdDownsample, _cmykdPlacements, _cmykdUsedElsewhere };')();

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); failed++; }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

// The prototype's whole-image downsample (chain.mjs), kept here as the reference.
function referenceDownsample(src, w, h, nc, nw, nh) {
  const sx = w / nw, sy = h / nh;
  const tmpRows = new Float32Array(nw * h * nc);
  for (let x = 0; x < nw; x++) {
    const x0 = x * sx, x1 = x0 + sx;
    for (let xs = Math.floor(x0); xs < Math.min(w, Math.ceil(x1)); xs++) {
      const wt = (Math.min(x1, xs + 1) - Math.max(x0, xs)) / sx;
      for (let y = 0; y < h; y++) {
        const si = (y * w + xs) * nc, di = (y * nw + x) * nc;
        for (let c = 0; c < nc; c++) tmpRows[di + c] += src[si + c] * wt;
      }
    }
  }
  const out = new Uint8Array(nw * nh * nc), acc = new Float32Array(nw * nc);
  for (let y = 0; y < nh; y++) {
    acc.fill(0);
    const y0 = y * sy, y1 = y0 + sy;
    for (let ys = Math.floor(y0); ys < Math.min(h, Math.ceil(y1)); ys++) {
      const wt = (Math.min(y1, ys + 1) - Math.max(y0, ys)) / sy;
      for (let i = 0; i < nw * nc; i++) acc[i] += tmpRows[ys * nw * nc + i] * wt;
    }
    for (let i = 0; i < nw * nc; i++) out[y * nw * nc + i] = Math.min(255, Math.max(0, Math.round(acc[i])));
  }
  return out;
}

// A photo-like CMYK field (noisy, so JPEG beats Flate); with pureK, a pure-K
// block in one corner, right against the colour.
function photo(w, h, pureK = false) {
  const a = new Uint8Array(w * h * 4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (pureK && x < w / 4 && y < h / 4) { a[i + 3] = 220; continue; }
    for (let c = 0; c < 4; c++) a[i + c] = Math.max(0, Math.min(255, 110 + 80 * Math.sin((x * (c + 1)) / 37 + (y * (4 - c)) / 53) + (rnd() - 0.5) * 30));
  }
  return a;
}

// Pure-K "text" (noisy strokes) on white: C, M and Y are 0 everywhere.
function kText(w, h) {
  const a = new Uint8Array(w * h * 4);
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x % 9 < 3 || y % 13 < 2) && rnd() > 0.2) a[(y * w + x) * 4 + 3] = 150 + Math.floor(rnd() * 105);
  return a;
}

async function onePage(w, h, samples, ops) {
  const pdf = await PDFDocument.create();
  const img = cmykImage(pdf, w, h, samples);
  const page = pdf.addPage([600, 800]);
  page.node.set(PDFName.of('Resources'), pdf.context.obj({ XObject: { Im0: img } }));
  page.node.set(PDFName.of('Contents'), content(pdf, ops));
  return { pdf, img };
}

function cmykImage(pdf, w, h, samples) {
  const s = PDFRawStream.of(pdf.context.obj({ Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceCMYK', BitsPerComponent: 8, Filter: 'FlateDecode' }), deflateSync(samples));
  return pdf.context.register(s);
}

const content = (pdf, ops) => pdf.context.register(PDFRawStream.of(pdf.context.obj({}), new TextEncoder().encode(ops)));

console.log('\nCompress — D300 (js/cmykD.js)');

await test('row-band downsample = the prototype\'s whole-image downsample, byte for byte', () => {
  for (const [w, h, nw, nh] of [[97, 61, 48, 30], [600, 400, 300, 200], [301, 299, 100, 99], [50, 7, 17, 3]]) {
    const a = new Uint8Array(w * h * 4).map((_, i) => (i * 2654435761) >>> 24);
    const x = D._cmykdDownsample(a, w, h, 4, nw, nh), y = referenceDownsample(a, w, h, 4, nw, nh);
    assert(x.length === y.length && x.every((v, i) => v === y[i]), `${w}×${h}→${nw}×${nh} differs`);
  }
});

await test('placements: the largest drawing decides; a form\'s /Matrix is followed', async () => {
  const pdf = await PDFDocument.create();
  const img = cmykImage(pdf, 64, 64, photo(64, 64));
  const form = pdf.context.register(PDFRawStream.of(pdf.context.obj({ Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Matrix: [2, 0, 0, 2, 0, 0], Resources: { XObject: { Im0: img } } }), new TextEncoder().encode('/Im0 Do')));
  const page = pdf.addPage([600, 800]);
  page.node.set(PDFName.of('Resources'), pdf.context.obj({ XObject: { Im0: img, Fm0: form } }));
  page.node.set(PDFName.of('Contents'), content(pdf, 'q 72 0 0 36 10 10 cm /Im0 Do Q q 72 0 0 72 0 0 cm /Fm0 Do Q'));
  const { minInch } = D._cmykdPlacements(pdf);
  const p = minInch.get(img.tag);
  assert(p && Math.abs(p.inchX - 2) < 1e-9 && Math.abs(p.inchY - 2) < 1e-9, JSON.stringify(p));
});

await test('an image also used in a pattern is left alone', async () => {
  const pdf = await PDFDocument.create();
  const img = cmykImage(pdf, 64, 64, photo(64, 64));
  const pattern = pdf.context.register(PDFRawStream.of(pdf.context.obj({ Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10, Resources: { XObject: { P0: img } } }), new TextEncoder().encode('q 10 0 0 10 0 0 cm /P0 Do Q')));
  const page = pdf.addPage([600, 800]);
  page.node.set(PDFName.of('Resources'), pdf.context.obj({ XObject: { Im0: img }, Pattern: { Pa0: pattern } }));
  page.node.set(PDFName.of('Contents'), content(pdf, 'q 72 0 0 72 0 0 cm /Im0 Do Q'));
  const { xobjectDicts } = D._cmykdPlacements(pdf);
  const out = D._cmykdUsedElsewhere(pdf, new Set([img.tag]), xobjectDicts);
  assert(out.has(img.tag), 'not flagged');
});

for (const [mode, quality] of [['Maximum', 75], ['Standard', 82]]) {
  await test(`${mode}: a 600-ppi CMYK photo → 300 ppi DeviceCMYK JPEG, close to the source`, async () => {
    const w = 600, h = 400, a = photo(w, h);
    const { pdf, img } = await onePage(w, h, a, 'q 72 0 0 48 0 0 cm /Im0 Do Q');   // 1 × 0.667 in → 600 ppi
    const r = await D.cmykD(pdf, { target: 300, quality, maxMegapixels: 64, urls: URLS });
    assert(r.replaced === 1, JSON.stringify(r));
    const o = pdf.context.lookup(img);
    const d = o.dict;
    assert(d.get(PDFName.of('Filter')).toString() === '/DCTDecode', 'filter');
    assert(d.get(PDFName.of('ColorSpace')).toString() === '/DeviceCMYK', 'colour space');
    assert(d.get(PDFName.of('Width')).asNumber() === 300 && d.get(PDFName.of('Height')).asNumber() === 200, 'size');
    const { JpegImage } = await import(URLS.decoders);
    const j = new JpegImage({ decodeTransform: null, colorTransform: -1 }); j.parse(o.contents);
    assert(j.numComponents === 4 && j.adobe, 'not an Adobe 4-channel JPEG');
    const back = j.getData({ width: 300, height: 200, forceRGB: false, isSourcePDF: true });
    const ref = referenceDownsample(a, w, h, 4, 300, 200);
    let sum = 0; for (let i = 0; i < ref.length; i++) sum += Math.abs(ref[i] - back[i]);
    assert(sum / ref.length < 4, `mean |Δ| ${(sum / ref.length).toFixed(2)}`);
  });
}

await test('pure-K text on white: re-encoded, and C, M, Y stay 0', async () => {
  const w = 600, h = 400, a = kText(w, h);
  const { pdf, img } = await onePage(w, h, a, 'q 72 0 0 48 0 0 cm /Im0 Do Q');
  const r = await D.cmykD(pdf, { target: 300, quality: 75, maxMegapixels: 64, urls: URLS });
  if (r.replaced === 0) { assert(r.skipped['not smaller'] === 1, JSON.stringify(r)); return; }   // Flate may win on line art: then it stays
  const { JpegImage } = await import(URLS.decoders);
  const j = new JpegImage({ decodeTransform: null, colorTransform: -1 }); j.parse(pdf.context.lookup(img).contents);
  const back = j.getData({ width: 300, height: 200, forceRGB: false, isSourcePDF: true });
  let cmy = 0; for (let i = 0; i < back.length; i += 4) cmy = Math.max(cmy, back[i], back[i + 1], back[i + 2]);
  assert(cmy <= 2, `C/M/Y up to ${cmy}`);
});

await test('pure K right against colour: the guard keeps the original', async () => {
  const w = 600, h = 400;
  const { pdf, img } = await onePage(w, h, photo(w, h, true), 'q 72 0 0 48 0 0 cm /Im0 Do Q');
  const before = pdf.context.lookup(img).contents;
  const r = await D.cmykD(pdf, { target: 300, quality: 75, maxMegapixels: 64, urls: URLS });
  assert(r.replaced === 0 && r.skipped['pure-K guard'] === 1, JSON.stringify(r));
  assert(pdf.context.lookup(img).contents === before, 'the image changed');
});

await test('a device limit: a larger image is left alone', async () => {
  const { pdf } = await onePage(600, 400, photo(600, 400), 'q 72 0 0 48 0 0 cm /Im0 Do Q');
  const r = await D.cmykD(pdf, { target: 300, quality: 75, maxMegapixels: 0.2, urls: URLS });
  assert(r.replaced === 0 && r.skipped['too large for this device'] === 1, JSON.stringify(r));
});

await test('options: Light and signed files never; manual dpi never below 300; manual quality only from 75', () => {
  const p = readFileSync(join(ROOT, 'js/processor.js'), 'utf8');
  const body = p.slice(p.indexOf('function _cmykDOptions'), p.indexOf('function _compressPrep('));
  const isLargeDevice = () => false;
  const f = new Function('isLargeDevice', body + '\nreturn _cmykDOptions;')(isLargeDevice);
  assert(f('low', {}) === null && f('medium', { _signed: true }) === null, 'Light/signed');
  assert(JSON.stringify(f('medium', {}, {})) === JSON.stringify({ target: 300, quality: 82, maxMegapixels: 16 }), 'Standard');
  assert(JSON.stringify(f('high', {}, { targetDpi: 96, quality: 0.72 })) === JSON.stringify({ target: 300, quality: 75, maxMegapixels: 16 }), 'Maximum defaults');
  assert(f('high', {}, { targetDpi: 400, quality: 0.8 }).target === 400 && f('high', {}, { quality: 0.8 }).quality === 80, 'manual above the floor');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
