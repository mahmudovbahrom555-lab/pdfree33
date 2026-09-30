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
//  Requires dist/ served at PDFREE_BASE_URL (default http://localhost:8934).
//  Run: node tests/e2e/password-guard.e2e.mjs
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

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
      URL.createObjectURL = b => { if (b instanceof Blob && /pdf|zip/.test(b.type) && b.size > 0) window.__blob = b; return orig(b); };
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
      if (PASSWORD_TOAST.test(toast)) break;
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

await browser.close();
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
