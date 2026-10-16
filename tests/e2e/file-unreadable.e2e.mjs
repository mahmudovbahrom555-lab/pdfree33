// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/file-unreadable.e2e.mjs — a file that changed after it was
//  selected (2026-10-13).
//
//  A user's Merge failed with Chrome's raw "The requested file could not be
//  read, typically due to permission problems that have occurred after a
//  reference to a file was acquired." (MERGE-C308 — the unclassified bucket).
//  Chrome refuses to read a File whose file on disk changed since it was
//  picked: saved again by another app, moved, deleted, a cloud-drive file not
//  on the device. Since 2026-10-16 every added file is copied when it is
//  added, and such a file is simply processed: change or delete it on disk
//  after adding it, press the button — the result comes out.
//
//  And a file removed from the list right after the button was pressed (the
//  click waits a frame and the password check, the list not locked yet):
//  PDF→JPG ran on an empty list — "Cannot read properties of undefined
//  (reading 'size')", PDF2JPG-2431, 8 times in two weeks from India.
//
//  Run: node tests/e2e/file-unreadable.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';
import { appendFileSync, copyFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const GT = path.join(__dirname, '..', 'corpus', 'groundtruth');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const dir = mkdtempSync(path.join(tmpdir(), 'pdfree-unreadable-'));
const browser = await chromium.launch();
try {
  // Each added file is copied when it is added (files.js _keepCopy), so a file
  // changed, deleted or swapped on disk afterwards is still processed — the
  // error above (MERGE-C308), and ORGANIZE-1455 (2026-10-16: a merged PDF
  // opened in Organize, pages arranged, then "Couldn't read"), never come up.
  const result = async (page, run) => {
    await page.addInitScript(() => {
      const o = URL.createObjectURL.bind(URL);
      URL.createObjectURL = x => { if (x instanceof Blob && x.size > 500 && /pdf|zip/.test(x.type)) window.__result = x; return o(x); };
      document.addEventListener('pdfree:error', e => { window.__error = e.detail.message; });
    });
    await run();
    await page.waitForFunction(() => window.__result || window.__error, null, { timeout: 90000 });
    const error = await page.evaluate(() => window.__error);
    if (error) throw new Error(error);
  };

  await test('Merge still merges a file changed on disk after it was added', async () => {
    const changed = path.join(dir, 'report.pdf'), other = path.join(dir, 'second.pdf');
    copyFileSync(path.join(GT, 'en-web.pdf'), changed);
    copyFileSync(path.join(GT, 'ru-web.pdf'), other);
    const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
    await result(page, async () => {
      await page.goto(`${BASE_URL}/merge-pdf/`, { waitUntil: 'load' });
      await page.setInputFiles('#fileInput', [changed, other]);
      await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 30000 });
      await page.waitForTimeout(1500);
      appendFileSync(changed, '\n% saved again by another app\n');
      await page.click('#mergeBtn');
    });
  });

  for (const [tool, url, prep] of [
    ['Organize', '/organize-pdf/', null],
    ['Compress (the file goes to a worker)', '/compress-pdf/', () => {
      const i = document.querySelector('input[name="compressPreset"][value="medium"]');
      i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true }));
    }],
  ]) {
    await test(`${tool} still runs on a file deleted from disk after it was added`, async () => {
      const gone = path.join(dir, `gone-${url.replace(/\W/g, '')}.pdf`);
      copyFileSync(path.join(GT, 'en-web.pdf'), gone);
      const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
      await result(page, async () => {
        await page.goto(BASE_URL + url, { waitUntil: 'load' });
        await page.setInputFiles('#fileInput', gone);
        await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 30000 });
        await page.waitForTimeout(2000);
        rmSync(gone);
        if (prep) await page.evaluate(prep);
        await page.click('#mergeBtn');
      });
    });
  }

  await test('a file removed right after Convert was pressed is not processed — no error', async () => {
    const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${BASE_URL}/pdf2jpg/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', path.join(GT, 'en-web.pdf'));
    await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => { document.querySelector('#mergeBtn').click(); document.querySelector('.file-item-del').click(); });
    await page.waitForTimeout(3000);
    const toast = await page.evaluate(() => document.querySelector('#toast')?.innerText || '');
    if (/reading 'size'|Error ID/.test(toast) || errors.length) throw new Error(`toast: ${toast} | errors: ${errors}`);
  });
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
