// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/pdf2jpg-cbz.e2e.mjs — PDF to JPG's CBZ output (comic-book
//  archive for comic and manga readers), in a real browser (2026-10-14).
//
//  A comic reader orders pages by a plain name sort, so the archive must
//  hold 001.jpg, 002.jpg… (not -page10 before -page2), be a .cbz with the
//  comic-book type, and stay an archive even for a single page.
//  Run: node tests/e2e/pdf2jpg-cbz.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();
console.log(`\npdf2jpg — CBZ E2E (${BASE_URL}):`);
try {
  await test('5 pages as CBZ: a .cbz of 001.jpg…005.jpg, real JPEGs, comic-book type', async () => {
    const page = await (await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true })).newPage();
    await page.addInitScript(() => {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = b => { if (b instanceof Blob && b.size > 0 && !/^image\//.test(b.type)) window.__out = b; return orig(b); };
    });
    await page.goto(BASE_URL + '/pdf2jpg/', { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', path.join(__dirname, '..', 'fixtures', 'nup', 'five-pages.pdf'));
    await page.waitForSelector('label[data-fmt="cbz"]', { timeout: 30000 });
    await page.click('label[data-fmt="cbz"]');
    await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled);
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#mergeBtn')]);
    if (!download.suggestedFilename().endsWith('.cbz')) throw new Error(`file name ${download.suggestedFilename()}`);
    await page.waitForFunction(() => window.__out, null, { timeout: 30000 });
    const r = await page.evaluate(async () => {
      const zip = await window.JSZip.loadAsync(await window.__out.arrayBuffer());
      const names = Object.keys(zip.files).sort();
      const first = new Uint8Array(await zip.file(names[0]).async('arraybuffer'));
      return { type: window.__out.type, names, jpeg: first[0] === 0xff && first[1] === 0xd8 };
    });
    if (r.type !== 'application/vnd.comicbook+zip') throw new Error(`type ${r.type}`);
    if (r.names.join() !== '001.jpg,002.jpg,003.jpg,004.jpg,005.jpg') throw new Error(r.names.join());
    if (!r.jpeg) throw new Error('not a JPEG inside');
  });
  await test('keyboard selection downloads only page 2 as JPEG', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
    try {
      const page = await context.newPage();
      await page.goto(BASE_URL + '/pdf2jpg/');
      await page.setInputFiles('#fileInput', path.join(__dirname, '..', 'fixtures', 'normal-3page.pdf'));
      await page.locator('#p2jNone').click();
      const thumbnail = page.getByRole('button', { name: 'Page 2', exact: true });
      await thumbnail.press('Space');
      if (await thumbnail.getAttribute('aria-pressed') !== 'true') throw new Error('Page 2 was not selected');
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        page.locator('#mergeBtn').click(),
      ]);
      if (download.suggestedFilename() !== 'normal-3page-page2.jpg') throw new Error(download.suggestedFilename());
      const bytes = await readFile(await download.path());
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Expected JPEG bytes');
    } finally {
      await context.close();
    }
  });
} finally {
  await browser.close();
}
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
