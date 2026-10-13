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
//  on the device. Reproduced here the same way — select two PDFs, change one
//  on disk, press Merge — the user must be told which file and what to do.
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
  await test('Merge names the file that changed after it was selected and says what to do', async () => {
    const changed = path.join(dir, 'report.pdf'), other = path.join(dir, 'second.pdf');
    copyFileSync(path.join(GT, 'en-web.pdf'), changed);
    copyFileSync(path.join(GT, 'ru-web.pdf'), other);
    const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
    await page.goto(`${BASE_URL}/merge-pdf/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', [changed, other]);
    await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    appendFileSync(changed, '\n% saved again by another app\n');
    await page.click('#mergeBtn');
    await page.waitForFunction(() => /report\.pdf/.test(document.querySelector('#toast')?.innerText || ''), null, { timeout: 30000 })
      .catch(async () => { throw new Error(`toast: ${await page.evaluate(() => document.querySelector('#toast')?.innerText)}`); });
    const toast = await page.evaluate(() => document.querySelector('#toast').innerText);
    if (/permission problems|reference to a file/.test(toast)) throw new Error(`raw browser text shown: ${toast}`);
    if (!/add it again/i.test(toast)) throw new Error(`no next step: ${toast}`);
  });

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
