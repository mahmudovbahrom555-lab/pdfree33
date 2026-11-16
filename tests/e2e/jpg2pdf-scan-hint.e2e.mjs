// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/jpg2pdf-scan-hint.e2e.mjs — JPG→PDF offers the Document
//  Scanner for a photo of a paper page (2026-11-16).
//
//  A user's report: "converted, but it is still a photo, not a PDF" — the
//  PDF was made and downloaded, it just showed the photo as it was. Under
//  the result, one photo (JPEG/WebP/HEIC) now gets a quiet line to the
//  scanner; a click carries the PHOTO (not the PDF) to the scanner page in
//  the person's language, where its crop review opens on it. PNG
//  (mostly screenshots) and two or more photos get no line.
//
//  Run: node tests/e2e/jpg2pdf-scan-hint.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const FIX = path.join(__dirname, '..', 'fixtures');
const JPEG = path.join(FIX, 'gray-scan.jpg');
const PNG = path.join(FIX, 'draw', 'photo.png');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();

async function convert(fromPath, files, viewport) {
  const context = await browser.newContext({ serviceWorkers: 'block', ...(viewport ? { viewport } : {}) });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const events = [];
  // analytics skips automated browsers (js/analytics.js) — this test reads it
  await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  await page.route('**/api/analytics', route => {
    try { events.push(JSON.parse(route.request().postData() || '{}')); } catch { /* not JSON */ }
    return route.fulfill({ status: 200, body: 'OK' });
  });
  await page.goto(BASE_URL + fromPath, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', files);
  await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.click('#mergeBtn');
  await page.waitForSelector('#successCard', { state: 'visible', timeout: 60000 });
  await page.waitForTimeout(300);
  return { page, errors, events };
}

const hint = page => page.$('#nextStepRow a.next-step-row[data-cross-sell-to="scanDocument"]');

async function followHint(page, to) {
  await Promise.all([
    page.waitForURL(u => u.pathname === to, { timeout: 30000 }),
    page.click('#nextStepRow a.next-step-row'),
  ]);
  await page.waitForSelector('.scan-cam-modal--open', { timeout: 60000 });
}

await test('one JPEG: the hint shows, is counted once, and the photo opens in the scanner\'s crop review', async () => {
  const { page, errors, events } = await convert('/jpg2pdf/', [JPEG]);
  if (!(await hint(page))) throw new Error('no scanner hint under the result');
  const notices = events.filter(e => e.event === 'Tool Notice' && e.props?.notice === 'scan_hint');
  if (notices.length !== 1) throw new Error(`scan_hint notices: ${notices.length}`);
  const title = await page.$eval('#nextStepRow .next-step-row__title', el => el.textContent);
  if (!/Document Scanner/.test(title)) throw new Error(title);
  await followHint(page, '/scan-document/');
  const files = await page.evaluate(async () => (await import('/js/files.js')).selectedFiles.map(f => [f.name, f.type]));
  if (files.length !== 1 || files[0][1] !== 'image/jpeg' || files[0][0] !== 'gray-scan.jpg') throw new Error(JSON.stringify(files));
  if (!events.some(e => e.event === 'Tool Notice' && e.props?.tool === 'scanDocument' && e.props?.notice === 'photo_from_jpg2pdf'))
    throw new Error('scanner did not mark the photo it received');
  if (errors.length) throw new Error(errors.join('; '));
});

await test('the click is counted as a cross-sell to the scanner', async () => {
  const { page, events } = await convert('/jpg2pdf/', [JPEG]);
  await followHint(page, '/scan-document/');
  // the click's event went out before the navigation
  const before = events.filter(e => e.event === 'Cross Sell Click');
  if (!before.some(e => e.props?.from === 'jpg2pdf' && e.props?.to === 'scanDocument')) throw new Error(JSON.stringify(before));
});

await test('Chinese page: the hint is in Chinese and the scanner opens in Chinese with the photo', async () => {
  const { page, errors } = await convert('/zh/jpg-zhuan-pdf/', [JPEG]);
  const title = await page.$eval('#nextStepRow .next-step-row__title', el => el.textContent);
  if (!/文档扫描仪/.test(title)) throw new Error(title);
  await followHint(page, '/zh/wendang-saomiao/');
  const lang = await page.evaluate(() => document.documentElement.lang);
  if (!/^zh/.test(lang)) throw new Error(`lang ${lang}`);
  if (!/拍照/.test(await page.$eval('#sdTakePhotoBtn', el => el.textContent))) throw new Error('no Chinese camera button');
  if (errors.length) throw new Error(errors.join('; '));
});

await test('a PNG gets no hint', async () => {
  const { page } = await convert('/jpg2pdf/', [PNG]);
  if (await hint(page)) throw new Error('hint shown for a PNG');
  if (await page.isVisible('#nextStepRow')) throw new Error('#nextStepRow visible');
});

await test('two photos get no hint', async () => {
  const { page } = await convert('/jpg2pdf/', [JPEG, path.join(FIX, 'cmyk-gradient.jpg')]);
  if (await hint(page)) throw new Error('hint shown for two photos');
});

await test('phone 390×664: a tap on the hint reaches the hint, not the sticky button', async () => {
  const { page } = await convert('/jpg2pdf/', [JPEG], { width: 390, height: 664 });
  const link = await hint(page);
  if (!link) throw new Error('no hint');
  await link.scrollIntoViewIfNeeded();
  const hit = await page.evaluate(() => {
    const r = document.querySelector('#nextStepRow a.next-step-row').getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { ok: !!el?.closest('#nextStepRow a.next-step-row'), h: r.height, what: el?.id || el?.className };
  });
  if (!hit.ok) throw new Error(`tap lands on ${hit.what}`);
  if (hit.h < 44) throw new Error(`target ${hit.h}px high`);
});

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
