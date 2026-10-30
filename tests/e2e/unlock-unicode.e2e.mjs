// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/unlock-unicode.e2e.mjs — Unlock with a non-Latin password
//
//  A password in Cyrillic, Chinese or Japanese turns into bytes differently
//  in each writer: AES-256 (R6) takes UTF-8; qpdf and Acrobat-like writers
//  take PDFDoc where they can; our own Protect truncates each character to a
//  byte; LibreOffice 26.2 writes "?" for every character outside Latin-1;
//  old Windows / WPS-style writers use the system code page (GBK, Shift-JIS,
//  CP1251). Unlock took only the truncated form, so an AES-256 file with the
//  right Cyrillic or Chinese password was "incorrect" (2026-10-30).
//  Fixtures: tests/fixtures/unlock (make.py, cases.json). Each must open with
//  its password and the page text must come back; a wrong password must not.
//  Plus a round trip: our Protect with a Cyrillic + Chinese password → Unlock.
//  Requires dist/ served at PDFREE_BASE_URL (default http://localhost:8934).
//  Run: node tests/e2e/unlock-unicode.e2e.mjs
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'unlock');
const CASES = JSON.parse(fs.readFileSync(path.join(DIR, 'cases.json'), 'utf8'));

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// Runs a tool on `file` with `fill` on the page; returns the output PDF's
// page-1 text and whether it is still encrypted, or { toast } without one.
async function run(browser, toolPath, file, fill) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = b => { if (b instanceof Blob && /pdf/.test(b.type) && b.size > 0) window.__blob = b; return orig(b); };
    });
    await page.goto(`${BASE_URL}${toolPath}`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', file);
    await page.waitForTimeout(2500);
    await fill(page);
    await page.click('#mergeBtn');
    for (let i = 0; i < 80; i++) {
      await page.waitForTimeout(250);
      const s = await page.evaluate(() => ({ out: !!window.__blob, toast: (document.querySelector('#toast')?.innerText || '').trim() }));
      if (s.out) break;
      if (/incorrect|password|error/i.test(s.toast)) return { toast: s.toast };
    }
    return await page.evaluate(async () => {
      if (!window.__blob) return { toast: (document.querySelector('#toast')?.innerText || '').trim() };
      const bytes = new Uint8Array(await window.__blob.arrayBuffer());
      await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
      let text = '';
      try {
        const d = await window.pdfjsLib.getDocument({ data: bytes.slice() }).promise;
        text = (await (await d.getPage(1)).getTextContent()).items.map(i => i.str).join('');
      } catch (e) { text = 'NOT OPENED: ' + e.name; }
      const encrypted = new TextDecoder('latin1').decode(bytes).includes('/Encrypt');
      return { text, encrypted };
    });
  } finally {
    await context.close();
  }
}

console.log(`\nUnlock with non-Latin passwords (real browser, ${BASE_URL}):`);
const browser = await chromium.launch();

for (const c of CASES) {
  const file = path.join(DIR, c.file), name = c.file.replace(/\.pdf$/, '');
  await test(`${c.file} opens with "${c.password}"`, async () => {
    const r = await run(browser, '/unlock-pdf/', file, p => p.fill('#unlockPwd', c.password));
    if (r.toast !== undefined) throw new Error(`no file; toast: "${r.toast}"`);
    if (r.encrypted) throw new Error('the output is still encrypted');
    if (!r.text.includes(`Unlock fixture ${name}`)) throw new Error(`page text not back: "${r.text.slice(0, 80)}"`);
  });
}

for (const c of CASES.filter(x => /^qpdf-r6-zh|^codepage-r4-zh|^libreoffice-ru/.test(x.file))) {
  await test(`${c.file}: a wrong password is refused`, async () => {
    const r = await run(browser, '/unlock-pdf/', path.join(DIR, c.file), p => p.fill('#unlockPwd', 'x' + c.password));
    if (r.toast === undefined) throw new Error('unlocked with a wrong password');
    if (!/incorrect/i.test(r.toast)) throw new Error(`expected "incorrect", got: "${r.toast}"`);
  });
}

await test('round trip: Protect with "пароль密码" → Unlock with it', async () => {
  const src = path.join(DIR, 'qpdf-r6-ascii.pdf');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-rt-'));
  const plain = path.join(tmp, 'plain.pdf');
  // the plain file: Unlock's own output, saved through a fresh page
  const ctx = await browser.newContext({ serviceWorkers: 'block' }), page = await ctx.newPage();
  await page.addInitScript(() => {
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (b instanceof Blob && /pdf/.test(b.type) && b.size > 0) window.__blob = b; return orig(b); };
  });
  const take = async () => {
    for (let i = 0; i < 80 && !(await page.evaluate(() => !!window.__blob)); i++) await page.waitForTimeout(250);
    const b64 = await page.evaluate(async () => { const u = new Uint8Array(await window.__blob.arrayBuffer()); let s = ''; for (const x of u) s += String.fromCharCode(x); window.__blob = null; return btoa(s); });
    return Buffer.from(b64, 'base64');
  };
  await page.goto(`${BASE_URL}/unlock-pdf/`, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', src); await page.waitForTimeout(2500);
  await page.fill('#unlockPwd', 'secret-42'); await page.click('#mergeBtn');
  fs.writeFileSync(plain, await take());
  await page.goto(`${BASE_URL}/protect-pdf/`, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', plain); await page.waitForTimeout(2500);
  await page.fill('#protUserPwd', 'пароль密码'); await page.click('#mergeBtn');
  const protectedFile = path.join(tmp, 'protected.pdf');
  fs.writeFileSync(protectedFile, await take());
  await ctx.close();
  const r = await run(browser, '/unlock-pdf/', protectedFile, p => p.fill('#unlockPwd', 'пароль密码'));
  if (r.toast !== undefined) throw new Error(`no file; toast: "${r.toast}"`);
  if (!r.text.includes('Unlock fixture')) throw new Error(`page text not back: "${r.text.slice(0, 80)}"`);
});

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
