// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// The PDF safety check's page reading in a real browser (js/pdfSafetyPages.js):
// the text drawn under a link (shows www.mybank.com, leads elsewhere) and a QR
// code drawn on the page — with the browser's own BarcodeDetector where it has
// one, and with jsQR in js/qrWorker.js where it doesn't. The PDF is built here.
// Run: node tests/e2e/pdf-safety-pages.e2e.mjs   (dist/ served on :8934)

import { chromium } from 'playwright';
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const __dir = path.dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const codes = JSON.parse(fs.readFileSync(path.join(__dir, '../fixtures/safety/qr-codes.json'), 'utf8'));
const doc = await PDFDocument.create();
const page = doc.addPage([595, 842]);
const font = await doc.embedFont(StandardFonts.Helvetica);
page.drawText('Log in at www.mybank.com to confirm.', { x: 60, y: 760, size: 14, font });
page.drawText('Our site: www.example.org', { x: 60, y: 720, size: 14, font });
const link = (rect, uri) => doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0], A: { S: 'URI', URI: PDFString.of(uri) } }));
const w = font.widthOfTextAtSize('www.mybank.com', 14), x0 = 60 + font.widthOfTextAtSize('Log in at ', 14);
page.node.set(PDFName.of('Annots'), doc.context.obj([
  link([x0, 755, x0 + w, 775], 'https://mybank-login.example.test/verify'),          // shows another site
  link([60 + font.widthOfTextAtSize('Our site: ', 14), 715, 260, 735], 'https://www.example.org/'),  // shows its own
]));
const m = 5;   // a QR code, 5 pt a module, at the bottom left
codes.phish.rows.forEach((row, r) => [...row].forEach((bit, c) => {
  if (bit === '1') page.drawRectangle({ x: 60 + c * m, y: 300 - r * m, width: m, height: m, color: rgb(0, 0, 0) });
}));
const bytes = [...await doc.save()];

const browser = await chromium.launch();
async function run(forceWorker) {
  const p = await (await browser.newContext()).newPage();
  await p.goto(`${BASE_URL}/`, { waitUntil: 'load' });
  const r = await p.evaluate(async ({ bytes, forceWorker }) => {
    if (forceWorker) delete window.BarcodeDetector;
    const { loadPdfJs } = await import('/js/pdf2jpgUI.js');
    const { loadPdfLib } = await import('/js/lazyLibs.js');
    await loadPdfJs(); await loadPdfLib();
    const data = new Uint8Array(bytes);
    const { scanPdf } = await import('/js/pdfSafetyScan.js');
    const { linkMismatchesOnPages, qrCodesOnPages } = await import('/js/pdfSafetyPages.js');
    const scan = await scanPdf(data, window.PDFLib);
    const pdf = await window.pdfjsLib.getDocument({ data: data.slice(), isEvalSupported: false, enableScripting: false }).promise;
    return {
      native: typeof window.BarcodeDetector !== 'undefined',
      mismatches: await linkMismatchesOnPages(pdf, scan.uris),
      qr: await qrCodesOnPages(pdf),
    };
  }, { bytes, forceWorker });
  await p.context().close();
  return r;
}

for (const forceWorker of [false, true]) {
  const r = await run(forceWorker);
  const how = forceWorker ? 'jsQR worker' : (r.native ? 'BarcodeDetector' : 'jsQR worker (no BarcodeDetector here)');
  await test(`links: the one showing another site is caught, its own is not (${how})`, async () => {
    if (r.mismatches.length !== 1 || r.mismatches[0].uri !== 'https://mybank-login.example.test/verify' || !/mybank\.com/.test(r.mismatches[0].shown)) {
      throw new Error(JSON.stringify(r.mismatches));
    }
  });
  await test(`QR: the code drawn on the page is read, its host named (${how})`, async () => {
    if (r.qr.length !== 1 || r.qr[0].data !== codes.phish.payload || r.qr[0].host !== 'mybank-login.example.test') throw new Error(JSON.stringify(r.qr));
  });
}

await browser.close();
console.log(`\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
process.exit(failed ? 1 : 0);
