// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/password-guard.e2e.mjs — real-browser gate for app.js's
//  password guard (2026-09-30).
//
//  A PDF that still needs its USER password used to be processed anyway:
//  every pdf-lib tool loads with ignoreEncryption, so compress / watermark /
//  page numbers / metadata silently returned a corrupt file (0 pages even
//  with the password — found by the corpus gate, scripts/corpus-diff), and
//  rotate / split / pdf2jpg said "select at least one page". The guard stops
//  such a file before the tool's own validation, with the existing
//  "password protected — unlock it first" message. It must NOT block an
//  owner-only file (opens without a password) or the Unlock tool itself.
//
//  Fixtures: tests/corpus/synthetic/encrypted-*.pdf (user password "user").
//  Both ways a file can carry /Encrypt are covered: a direct dictionary in
//  the trailer (MuPDF) — which the preflight didn't recognise at all, so
//  Unlock also claimed no password was needed — and a reference (qpdf/Acrobat).
//  And a PDF with editing restrictions, an EMPTY open password and one image
//  stream over ~4.5 MB (a teacher's exam sheet, 2026-10-25): the in-browser
//  qpdf ran out of memory and the file was called "password protected" in
//  every tool. Read-only converters must work, the others say why not, Unlock
//  must not say "wrong password". Built at run time (pdf-lib + qpdf, 4.6 MB of
//  noise is no fixture to commit); needs qpdf on PATH (CI installs it).
//  Requires dist/ served at PDFREE_BASE_URL (default http://localhost:8934).
//  Run: node tests/e2e/password-guard.e2e.mjs
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { PDFDocument, StandardFonts, PDFName } from 'pdf-lib';

const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const SYN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'corpus', 'synthetic');
const USER_PW_FILES = {
  'direct /Encrypt dict (MuPDF)': path.join(SYN, 'encrypted-user-password.pdf'),
  '/Encrypt reference (qpdf)':    path.join(SYN, 'encrypted-user-password-qpdf.pdf'),
};
const OWNER_PW = path.join(SYN, 'encrypted-owner-only.pdf');
const PASSWORD_TOAST = /password protected/i;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); failed++; }
}

// Adds a file, optionally prepares the page, clicks process, and reports
// what happened: { blob: {type,size} | null, toast }.
async function processOn(browser, toolPath, file, prepare) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      window.__blob = null;
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = b => { if (b instanceof Blob && /pdf|zip|officedocument/.test(b.type) && b.size > 0) window.__blob = b; return orig(b); };
    });
    await page.goto(`${BASE_URL}${toolPath}`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', file);
    await page.waitForTimeout(2500);
    if (prepare) await prepare(page);
    await page.click('#mergeBtn');
    let blob = null, toast = '';
    for (let i = 0; i < 60 && !blob; i++) {
      await page.waitForTimeout(250);
      ({ blob, toast } = await page.evaluate(() => ({
        blob: window.__blob ? { type: window.__blob.type, size: window.__blob.size } : null,
        toast: (document.querySelector('#toast')?.innerText || '').trim(),
      })));
      if (PASSWORD_TOAST.test(toast) || /restrictions/i.test(toast)) break;
    }
    return { blob, toast };
  } finally {
    await context.close();
  }
}

console.log(`\npassword guard E2E (real browser, ${BASE_URL}):`);
const browser = await chromium.launch();

for (const [form, file] of Object.entries(USER_PW_FILES)) {
  for (const tool of ['/compress-pdf/', '/rotate-pdf/', '/watermark-pdf/']) {
    await test(`${tool} [${form}]: a user-password PDF is stopped with the password message, no file`, async () => {
      const { blob, toast } = await processOn(browser, tool, file);
      if (blob) throw new Error(`produced a file (${blob.type}, ${blob.size} B) — expected a refusal`);
      if (!PASSWORD_TOAST.test(toast)) throw new Error(`expected the password message, got: "${toast}"`);
    });
  }
  await test(`/unlock-pdf/ [${form}]: Unlock still takes the user-password PDF and unlocks it`, async () => {
    const { blob, toast } = await processOn(browser, '/unlock-pdf/', file, page => page.fill('#unlockPwd', 'user', { timeout: 5000 }));
    if (!blob) throw new Error(`no unlocked file; toast: "${toast}"`);
  });
}

await test('/compress-pdf/: an owner-only PDF (opens without a password) is NOT blocked', async () => {
  const { blob, toast } = await processOn(browser, '/compress-pdf/', OWNER_PW);
  if (!blob) throw new Error(`no file produced; toast: "${toast}"`);
});

// a restricted PDF (empty open password) with one 4.6 MB image stream
async function restrictedWithLargeImage(userPassword = '') {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Restricted exam sheet: question 1 of 15', { x: 72, y: 780, size: 14, font });
  const side = 1240;   // 1240 x 1240 x 3 = 4.6 MB, noise: no filter shrinks it
  const img = doc.context.stream(crypto.randomBytes(side * side * 3), { Type: 'XObject', Subtype: 'Image', Width: side, Height: side, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
  const ref = doc.context.register(img);
  page.node.setXObject(PDFName.of('Im1'), ref);
  const plain = path.join(os.tmpdir(), `pdfree-restricted-${process.pid}.pdf`);
  const out = plain.replace('.pdf', userPassword ? '-user-aes.pdf' : '-aes.pdf');
  fs.writeFileSync(plain, await doc.save({ useObjectStreams: false }));
  execFileSync('qpdf', ['--encrypt', userPassword, 'owner-pw', '128', '--use-aes=y', '--modify=none', '--extract=n', '--', plain, out]);
  return out;
}
const RESTRICTED = await restrictedWithLargeImage();

await test('pdf2word: a restricted PDF with a large image is converted — its text, no password message', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = b => { if (b instanceof Blob && /officedocument/.test(b.type)) window.__docx = b; return orig(b); };
    });
    await page.goto(`${BASE_URL}/pdf-to-word/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', RESTRICTED);
    await page.waitForTimeout(4000);
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__docx || /password|restrictions/i.test(document.querySelector('#toast')?.innerText || ''), null, { timeout: 120000 });
    const text = await page.evaluate(async () => {
      if (!window.__docx) return 'TOAST: ' + document.querySelector('#toast')?.innerText;
      await (await import('/js/lazyLibs.js')).loadJSZip();
      const zip = await window.JSZip.loadAsync(await window.__docx.arrayBuffer());
      return (await zip.file('word/document.xml').async('string')).replace(/<[^>]+>/g, '');
    });
    if (!text.includes('Restricted exam sheet')) throw new Error(`no text in the .docx: ${text.slice(0, 160)}`);
  } finally {
    await context.close();
  }
});

// qpdf with a growing heap (js/qpdfWorker.js, 2026-10-30) decrypts it: the
// tools that write a PDF now give one — opened without a password, unencrypted.
async function decryptedOut(toolPath) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => { const o = URL.createObjectURL.bind(URL); URL.createObjectURL = b => { if (b instanceof Blob && /pdf/.test(b.type)) window.__out = b; return o(b); }; });
    await page.goto(`${BASE_URL}${toolPath}`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', RESTRICTED);
    await page.waitForTimeout(4000);
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__out || /password|restrictions/i.test(document.querySelector('#toast')?.innerText || ''), null, { timeout: 120000 });
    return await page.evaluate(async () => {
      if (!window.__out) return { toast: document.querySelector('#toast')?.innerText };
      const bytes = new Uint8Array(await window.__out.arrayBuffer());
      await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
      const doc = await window.pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      return { encrypted: new TextDecoder('latin1').decode(bytes).includes('/Encrypt'), text: (await (await doc.getPage(1)).getTextContent()).items.map(i => i.str).join('') };
    });
  } finally { await context.close(); }
}
for (const tool of ['/compress-pdf/', '/unlock-pdf/', '/pagenum-pdf/']) {
  await test(`${tool}: the same file (a 4.6 MB image) comes out decrypted and readable — no restrictions message`, async () => {
    const r = await decryptedOut(tool);
    if (r.toast) throw new Error(`no file: "${r.toast}"`);
    if (r.encrypted) throw new Error('the output is still encrypted');
    if (!r.text.includes('Restricted exam sheet')) throw new Error(`text: ${r.text.slice(0, 80)}`);
  });
}
await test('/pdf-to-word/: with a REAL open password and a large image, the password message — qpdf\'s failure says nothing on its own', async () => {
  const file = await restrictedWithLargeImage('user');
  const { blob, toast } = await processOn(browser, '/pdf-to-word/', file);
  fs.rmSync(file, { force: true });
  if (blob) throw new Error(`produced a file (${blob.type}) without the password`);
  if (!PASSWORD_TOAST.test(toast)) throw new Error(`expected the password message, got: "${toast}"`);
});
fs.rmSync(RESTRICTED, { force: true }); fs.rmSync(RESTRICTED.replace('-aes.pdf', '.pdf'), { force: true });

// A linearized ("fast web view") restricted PDF names /Encrypt only near its
// start (EXTRACT-85E1, a homeschool math worksheet, 2026-10-30): the preflight
// read only the end and never flagged it. Extract and Split must give pages
// that READ — not merely a file.
async function linearizedRestricted() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Math worksheet page ${i}: 3 + 4 = ___`, { x: 72, y: 780, size: 14, font });
    const side = 200;    // noise, so the file passes 64 KB and the tail never holds /Encrypt
    const img = doc.context.stream(crypto.randomBytes(side * side * 3), { Type: 'XObject', Subtype: 'Image', Width: side, Height: side, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
    page.node.setXObject(PDFName.of('Im1'), doc.context.register(img));
  }
  const plain = path.join(os.tmpdir(), `pdfree-linear-${process.pid}.pdf`), out = plain.replace('.pdf', '-aes256.pdf');
  fs.writeFileSync(plain, await doc.save({ useObjectStreams: false }));
  execFileSync('qpdf', ['--linearize', '--encrypt', '', 'owner-pw', '256', '--modify=none', '--extract=n', '--', plain, out]);
  fs.rmSync(plain, { force: true });
  const bytes = fs.readFileSync(out), latin = bytes.toString('latin1');
  if (latin.lastIndexOf('/Encrypt') > 65536 || bytes.length - latin.lastIndexOf('/Encrypt') <= 65536) throw new Error('fixture: /Encrypt must sit near the start only');
  return out;
}
const LINEAR = await linearizedRestricted();
async function pagesOf(browser, toolPath, prepare) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => { const o = URL.createObjectURL.bind(URL); URL.createObjectURL = b => { if (b instanceof Blob && /pdf|zip/.test(b.type)) window.__out = b; return o(b); }; });
    await page.goto(`${BASE_URL}${toolPath}`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', LINEAR);
    await page.waitForTimeout(3000);
    const meta = await page.evaluate(async () => (await import('/js/files.js')).selectedFiles[0]?._pdfMeta);
    if (prepare) await prepare(page);
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__out, null, { timeout: 60000 });
    const texts = await page.evaluate(async () => {
      await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
      const read = async data => { const d = await window.pdfjsLib.getDocument({ data }).promise; const t = []; for (let i = 1; i <= d.numPages; i++) t.push((await (await d.getPage(i)).getTextContent()).items.map(x => x.str).join('')); return t; };
      const bytes = new Uint8Array(await window.__out.arrayBuffer());
      if (window.__out.type.includes('pdf')) return read(bytes);
      await (await import('/js/lazyLibs.js')).loadJSZip();
      const zip = await window.JSZip.loadAsync(bytes), out = [];
      for (const n of Object.keys(zip.files).sort()) out.push(...await read(await zip.file(n).async('uint8array')));
      return out;
    });
    return { meta, texts };
  } finally { await context.close(); }
}
await test('a linearized restricted PDF: its encryption seen on adding (its /Encrypt only near the start) — and quietly removed', async () => {
  const { meta } = await pagesOf(browser, '/split-pdf/');
  // seen: AES-256 and its restrictions read; removed: the lock flags cleared again
  if (meta?.aesVersion !== 'AES-256' || meta.isEncrypted) throw new Error(`preflight: ${JSON.stringify(meta)}`);
});
await test('/extract-pdf/: pages 1–2 of it come out readable — not EXTRACT-85E1', async () => {
  const { texts } = await pagesOf(browser, '/extract-pdf/', async page => { await page.fill('#extRangeInput', '1-2'); await page.click('#extRangeApply'); });
  if (texts.length !== 2 || !/page 1/.test(texts[0]) || !/page 2/.test(texts[1])) throw new Error(JSON.stringify(texts));
});
await test('/split-pdf/: every page readable', async () => {
  const { texts } = await pagesOf(browser, '/split-pdf/');
  if (texts.length !== 3 || texts.some((t, i) => !t.includes(`page ${i + 1}`))) throw new Error(JSON.stringify(texts));
});
fs.rmSync(LINEAR, { force: true });

await browser.close();
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
