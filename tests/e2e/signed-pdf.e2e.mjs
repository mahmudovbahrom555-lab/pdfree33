// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/signed-pdf.e2e.mjs — a digitally signed PDF is announced before a
//  tool writes a new copy of it (class C28, 2026-11-05).
//
//  Any re-save changes the bytes a signature covers, so the copy's signature
//  is no longer valid (pdfsig on real files). Matrix from the audit: one
//  signature, two, a certification signature; a picture of a signature, an
//  empty signature field and an ordinary PDF must NOT ask. Cancel and Esc
//  start nothing; "Make the copy" goes on; a batch names only the signed
//  files; a converter to another format doesn't ask; the dialog on a phone.
//
//  Fixtures: tests/fixtures/signed/ (make.py — pyHanko, throw-away certificate).
//  Run: node tests/e2e/signed-pdf.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const FIX = path.join(__dirname, '..', 'fixtures');
const f = n => path.join(FIX, n);

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();
async function open(urlPath, files, viewport = { width: 1280, height: 900 }) {
  const page = await (await browser.newContext({ serviceWorkers: 'block', viewport })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE_URL + urlPath, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', files.map(f));
  await page.waitForSelector('#fileList .file-item', { timeout: 30000 });
  await page.waitForTimeout(1500);   // detection runs after the add
  return { page, errors };
}
const dialog = page => page.locator('.sig-confirm [role="alertdialog"]');
// a result = the success card shown (blob URLs alone also back thumbnails)
const SUCCESS = () => { const c = document.querySelector('#successCard'); return !!c && c.offsetParent !== null && !c.hidden; };
const produced = page => page.evaluate(SUCCESS);
async function waitResult(page) { await page.waitForFunction(SUCCESS, null, { timeout: 90000 }); }

try {
  await test('one signature: badge in the list; Cancel starts nothing; asked again; Make the copy → result', async () => {
    const { page, errors } = await open('/compress-pdf/', ['signed/signed-one.pdf']);
    if (!(await page.locator('.file-item-signed').count())) throw new Error('no signed badge');
    await page.click('#mergeBtn');
    await dialog(page).waitFor({ timeout: 10000 });
    if (!(await dialog(page).textContent()).includes('signed-one.pdf')) throw new Error('file not named in the dialog');
    if (await page.evaluate(() => document.activeElement?.id) !== 'sigConfirmCancel') throw new Error('Cancel is not the focused default');
    await page.click('#sigConfirmCancel');
    await page.waitForTimeout(2500);
    if (await produced(page)) throw new Error('a file was produced after Cancel');
    await page.click('#mergeBtn');
    await dialog(page).waitFor({ timeout: 10000 });
    await page.click('#sigConfirmGo');
    await waitResult(page);
    if (errors.length) throw new Error(errors.join('; '));
  });

  await test('Esc cancels', async () => {
    const { page } = await open('/rotate-pdf/', ['signed/signed-one.pdf']);
    await page.click('#mergeBtn');
    await dialog(page).waitFor({ timeout: 10000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(2000);
    if (await dialog(page).count()) throw new Error('dialog still open');
    if (await produced(page)) throw new Error('a file was produced after Esc');
  });

  await test('certification signature: the dialog says the document is certified', async () => {
    const { page } = await open('/watermark-pdf/', ['signed/signed-certified.pdf']);
    await page.click('#mergeBtn');
    await dialog(page).waitFor({ timeout: 10000 });
    if (!/certified/i.test(await dialog(page).textContent())) throw new Error('no certified note');
  });

  await test('batch of a signed and an ordinary file: one dialog naming only the signed one, then a result', async () => {
    const { page, errors } = await open('/merge-pdf/', ['signed/signed-two.pdf', 'normal-1page.pdf']);
    await page.click('#mergeBtn');
    await dialog(page).waitFor({ timeout: 10000 });
    const txt = await dialog(page).textContent();
    if (!txt.includes('signed-two.pdf') || txt.includes('normal-1page.pdf')) throw new Error('dialog lists: ' + txt);
    await page.click('#sigConfirmGo');
    await waitResult(page);
    if (errors.length) throw new Error(errors.join('; '));
  });

  for (const [name, file] of [['a picture of a signature', 'signed/image-signature.pdf'], ['an empty signature field', 'signed/field-empty.pdf'], ['an ordinary PDF', 'normal-3page.pdf']]) {
    await test(`${name}: no badge, no dialog, the result comes`, async () => {
      const { page } = await open('/compress-pdf/', [file]);
      if (await page.locator('.file-item-signed').count()) throw new Error('badge shown');
      await page.click('#mergeBtn');
      await waitResult(page);
      if (await dialog(page).count()) throw new Error('dialog shown');
    });
  }

  await test('a converter to another format (PDF→JPG) does not ask', async () => {
    const { page } = await open('/pdf2jpg/', ['signed/signed-one.pdf']);
    await page.click('#mergeBtn');
    await waitResult(page);
    if (await dialog(page).count()) throw new Error('dialog shown');
  });

  await test('phone (390×664): the dialog fits, buttons ≥ 44 px, no sideways scroll', async () => {
    const { page } = await open('/compress-pdf/', ['signed/signed-one.pdf'], { width: 390, height: 664 });
    await page.click('#mergeBtn');
    await dialog(page).waitFor({ timeout: 10000 });
    const r = await page.evaluate(() => {
      const card = document.querySelector('.sig-confirm__card').getBoundingClientRect();
      const btns = [...document.querySelectorAll('.sig-confirm__btn')].map(b => b.getBoundingClientRect());
      return { fits: card.left >= 0 && card.right <= innerWidth && card.top >= 0 && card.bottom <= innerHeight,
        small: btns.filter(b => b.height < 44).length, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    if (!r.fits || r.small || r.overflow) throw new Error(JSON.stringify(r));
  });
} finally {
  await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
