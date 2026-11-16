// SPDX-License-Identifier: AGPL-3.0-only
importScripts('./vendor/pdf-lib.min.js');

const {
  PDFDocument, PDFName, PDFNumber, PDFDict, PDFArray, PDFRef,
  PDFRawStream, decodePDFRawStream,
} = self.PDFLib;
const name = PDFName.of;
const plainImageKeys = new Set([
  '/Type', '/Subtype', '/Filter', '/ColorSpace', '/BitsPerComponent',
  '/Width', '/Height', '/Length', '/Interpolate',
]);
const decoder = new TextDecoder('ascii');

function equalBytes(a, b) {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function referenceCounts(doc) {
  const counts = new Map();
  function visit(object) {
    if (object instanceof PDFRef) counts.set(object.tag, (counts.get(object.tag) || 0) + 1);
    else if (object instanceof PDFRawStream) visit(object.dict);
    else if (object instanceof PDFDict) for (const [, value] of object.entries()) visit(value);
    else if (object instanceof PDFArray) for (const value of object.asArray()) visit(value);
  }
  for (const [, object] of doc.context.enumerateIndirectObjects()) visit(object);
  return counts;
}

function fullPageImage(doc, page, counts) {
  const resources = page.node.get(name('Resources'));
  const resourceDict = doc.context.lookup(resources);
  if (!(resourceDict instanceof PDFDict)) return null;
  const xobjects = resourceDict.get(name('XObject'));
  const images = doc.context.lookup(xobjects);
  if (!(images instanceof PDFDict) || images.entries().length !== 1) return null;
  if ([resources, xobjects].some(ref => ref instanceof PDFRef && counts.get(ref.tag) !== 1)) return null;
  const [[key, ref]] = images.entries();
  if (!(ref instanceof PDFRef) || counts.get(ref.tag) !== 1) return null;

  // A scan page in this first pass is one image painted over the page.
  // Forms, overlays, masks and shared images stay on the established path.
  const annotations = page.node.Annots();
  if (annotations && (!(annotations instanceof PDFArray) || annotations.size() > 0)) return null;
  const contents = page.node.Contents();
  const stream = contents instanceof PDFArray && contents.size() === 1 ? contents.lookup(0) : contents;
  if (!(stream instanceof PDFRawStream) || stream.getContentsSize() > 1024) return null;
  const text = decoder.decode(decodePDFRawStream(stream).decode()).trim().split(/\s+/);
  if (text.length !== 11 || text[0] !== 'q' || text[7] !== 'cm'
      || text[8] !== key.toString() || text[9] !== 'Do' || text[10] !== 'Q') return null;
  const [width, skewX, skewY, height, x, y] = text.slice(1, 7).map(Number);
  const box = page.getCropBox();
  if (![width, height, x, y].every(Number.isFinite) || skewX !== 0 || skewY !== 0
      || Math.abs(width - box.width) > box.width * 0.02 || Math.abs(height - box.height) > box.height * 0.02
      || Math.abs(x - box.x) > box.width * 0.02 || Math.abs(y - box.y) > box.height * 0.02) return null;

  const image = doc.context.lookup(ref);
  if (!(image instanceof PDFRawStream)
      || image.dict.get(name('Subtype')) !== name('Image')
      || image.dict.get(name('Filter')) !== name('DCTDecode')
      || image.dict.get(name('BitsPerComponent'))?.asNumber?.() !== 8
      || image.dict.keys().some(key => !plainImageKeys.has(key.toString()))) return null;
  return { ref, image, text: text.join(' ') };
}

function colorSpace(doc, image) {
  const color = doc.context.lookup(image.dict.get(name('ColorSpace')));
  if (color === name('DeviceRGB') || color === name('DeviceGray')) return { type: color };
  if (!(color instanceof PDFArray) || color.size() !== 2 || color.lookup(0) !== name('ICCBased')) return null;
  const profile = color.lookup(1);
  if (!(profile instanceof PDFRawStream)) return null;
  const channels = profile.dict.get(name('N'))?.asNumber?.();
  if (channels !== 1 && channels !== 3) return null;
  return { type: name('ICCBased'), details: profile.dict.toString(), samples: profile.getContents() };
}

async function refine(base, larger, targetBytes) {
  const load = { updateMetadata: false, parseSpeed: Infinity };
  const [pdf, source] = await Promise.all([PDFDocument.load(base, load), PDFDocument.load(larger, load)]);
  const pages = pdf.getPages();
  const sourcePages = source.getPages();
  if (pages.length !== sourcePages.length || pages.length > 80) return null;
  if (pdf.context.enumerateIndirectObjects().length > 12000 || source.context.enumerateIndirectObjects().length > 12000) return null;

  const baseCounts = referenceCounts(pdf);
  const sourceCounts = referenceCounts(source);
  const upgrades = [];
  let hasElectronicPage = false;
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    const before = fullPageImage(pdf, page, baseCounts);
    if (!before) {
      const fonts = page.node.Resources()?.lookup(name('Font'));
      hasElectronicPage ||= fonts instanceof PDFDict && fonts.keys().length > 0;
      continue;
    }
    const alternate = sourcePages[index];
    if (page.ref.tag !== alternate.ref.tag || Object.values(page.getCropBox()).join() !== Object.values(alternate.getCropBox()).join()) continue;
    const after = fullPageImage(source, alternate, sourceCounts);
    if (!after || before.ref.tag !== after.ref.tag || before.text !== after.text
        || before.image.dict.get(name('Interpolate')) !== after.image.dict.get(name('Interpolate'))) continue;
    const a = colorSpace(pdf, before.image);
    const b = colorSpace(source, after.image);
    if (!a || !b || a.type !== b.type || a.details !== b.details
        || (a.samples && !equalBytes(a.samples, b.samples))) continue;
    const w = after.image.dict.get(name('Width'))?.asNumber?.();
    const h = after.image.dict.get(name('Height'))?.asNumber?.();
    const oldW = before.image.dict.get(name('Width'))?.asNumber?.();
    const oldH = before.image.dict.get(name('Height'))?.asNumber?.();
    if (![w, h, oldW, oldH].every(Number.isSafeInteger) || oldW <= 0 || oldH <= 0
        || w <= oldW || h <= oldH || Math.abs(w / h - oldW / oldH) > 0.004) continue;
    const cost = after.image.getContentsSize() - before.image.getContentsSize();
    upgrades.push({ index, before, after, w, h, cost });
  }

  if (!hasElectronicPage) return null;
  let remaining = targetBytes - base.byteLength;
  const changed = [];
  for (const { index, before, after, w, h, cost } of upgrades.sort((a, b) => a.cost - b.cost)) {
    if (cost > remaining) break;
    remaining -= cost;
    const dict = before.image.dict.clone(pdf.context);
    dict.set(name('Width'), PDFNumber.of(w));
    dict.set(name('Height'), PDFNumber.of(h));
    pdf.context.assign(before.ref, PDFRawStream.of(dict, after.image.getContents()));
    changed.push(index + 1);
  }
  if (!changed.length) return null;
  const bytes = await pdf.save({ updateFieldAppearances: false, useObjectStreams: true });
  return bytes.length <= targetBytes ? { buffer: bytes.buffer, pages: changed.sort((a, b) => a - b) } : null;
}

// Decode QR codes from the first full-page JPEG for the strong-compression
// check. Keep coordinates so subsequent versions only need small crops.
async function firstScanBitmap(buffer) {
  const doc = await PDFDocument.load(buffer, { updateMetadata: false, parseSpeed: Infinity });
  const page = doc.getPages()[0];
  if (!page) return null;
  const scan = fullPageImage(doc, page, referenceCounts(doc));
  if (!scan) return null;
  const width = scan.image.dict.get(name('Width'))?.asNumber?.();
  const height = scan.image.dict.get(name('Height'))?.asNumber?.();
  if (!width || !height || width * height > 12_000_000) return null;
  return createImageBitmap(new Blob([scan.image.getContents()], { type: 'image/jpeg' }));
}

function readQr(bitmap, rect, maxSide) {
  const [x, y, width, height] = rect;
  const scale = Math.min(2, maxSide / Math.max(width, height));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, x, y, width, height, 0, 0, canvas.width, canvas.height);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const qr = self.jsQR(image.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
  if (!qr?.data) return null;
  const points = Object.values(qr.location);
  const xs = points.map(point => point.x / scale + x);
  const ys = points.map(point => point.y / scale + y);
  return { data: qr.data, box: [Math.min(...xs) / bitmap.width, Math.min(...ys) / bitmap.height,
    Math.max(...xs) / bitmap.width, Math.max(...ys) / bitmap.height] };
}

async function originalQrCodes(buffer) {
  const bitmap = await firstScanBitmap(buffer);
  if (!bitmap) return [];
  try {
    const codes = new Map();
    for (const y of [0, 0.29, 0.58]) for (const x of [0, 0.29, 0.58]) {
      const qr = readQr(bitmap, [x * bitmap.width, y * bitmap.height, 0.42 * bitmap.width, 0.42 * bitmap.height], 1150);
      if (qr) codes.set(qr.data, qr);
    }
    return [...codes.values()];
  } finally {
    bitmap.close();
  }
}

async function keepsQrCodes(buffer, codes) {
  const bitmap = await firstScanBitmap(buffer);
  // A format we cannot inspect is inconclusive.
  if (!bitmap) return null;
  try {
    return codes.every(({ data, box: [left, top, right, bottom] }) => {
      const padX = (right - left) * 0.24;
      const padY = (bottom - top) * 0.24;
      const x = Math.max(0, left - padX);
      const y = Math.max(0, top - padY);
      const width = Math.min(1, right + padX) - x;
      const height = Math.min(1, bottom + padY) - y;
      return readQr(bitmap, [x * bitmap.width, y * bitmap.height, width * bitmap.width, height * bitmap.height], 560)?.data === data;
    });
  } finally {
    bitmap.close();
  }
}

async function checkQr({ original, base, larger }) {
  if (!self.jsQR) importScripts('./vendor/jsQR.js');
  const codes = await originalQrCodes(original);
  if (!codes.length || await keepsQrCodes(base, codes) !== false) return null;
  const keptCandidate = !!larger && await keepsQrCodes(larger, codes) === true;
  return { buffer: keptCandidate ? larger : original, qrProtected: true, keptCandidate };
}

self.onmessage = async ({ data }) => {
  let result = null;
  try {
    result = data.original ? await checkQr(data) : await refine(data.base, data.larger, data.targetBytes);
  } catch {
    // The caller already has a fitting PDF.
  }
  self.postMessage(result, result ? [result.buffer] : []);
};
