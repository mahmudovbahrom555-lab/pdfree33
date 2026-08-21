// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/protect.e2e.mjs — real-browser regression test for the
//  password-loss bug found + fixed 2026-08-21 (commit 873f63c,
//  js/protectUI.js's initProtectOptions).
//
//  Separate from the main `npm test` chain (tests/*.test.js) on
//  purpose: those are pure-Node, dependency-free, and run on every
//  commit/pre-commit hook. This one needs a real Chromium (via the
//  `playwright` devDependency) and a running static server for dist/,
//  so it's wired into CI as its own gate — see .github/workflows/
//  deploy.yml's "E2E — protect password persists across batch file
//  add" step, which runs AFTER build+lint+unit-tests and BEFORE
//  deploy, so a regression here blocks the deploy instead of shipping
//  and being caught after the fact.
//
//  tests/protect.logic.test.js already pins the FIXED STATE MACHINE
//  in isolation (a hand-simulated harness, since protectUI.js has
//  heavy real-DOM/i18n dependencies not practical to import in plain
//  Node — see that file's own header). This test instead drives the
//  REAL js/protectUI.js through a REAL browser end to end: real
//  <input> focus/typing, the real 'pdfree:files-added' event, the
//  real batch-file-add code path (files.js's addFiles(), not a stand-in)
//  — catching integration-level regressions the unit test structurally
//  cannot (e.g. a future refactor that changes the id() used as the
//  "already rendered" marker, or that moves the guard to the wrong
//  function).
//
//  Requires: dist/ already built (`python3 scripts/build.py`) and
//  served at PDFREE_BASE_URL (default http://localhost:8934).
//
//  Run: node tests/e2e/protect.e2e.mjs
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL  = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const FILE_1    = path.join(__dirname, '..', 'fixtures', 'normal-3page.pdf');
const FILE_2    = path.join(__dirname, '..', 'fixtures', 'normal-1page.pdf');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe: (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
  };
}

const BLOB_HOOK = () => {
  window.__blob = null;
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) { if (blob instanceof Blob) window.__blob = blob; return orig(blob); };
};

console.log(`\nprotect E2E — password survives a batch file add (real browser, ${BASE_URL}):`);

let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  console.error('Could not launch Chromium — run `npx playwright install --with-deps chromium` first.');
  console.error(e.message);
  process.exit(1);
}

await test('typing a password, then adding a 2nd file to the batch queue, does not clear it', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.goto(`${BASE_URL}/protect-pdf/`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', FILE_1);
    await page.waitForSelector('#protUserPwd', { state: 'visible', timeout: 15000 });

    await page.fill('#protUserPwd', 'e2e-regression-pass');
    const before = await page.inputValue('#protUserPwd');
    expect(before).toBe('e2e-regression-pass');

    // Real batch-add: protect is multi:true/batch:true, so this re-fires
    // 'pdfree:files-added' through the REAL files.js addFiles() path.
    await page.setInputFiles('#fileInput', FILE_2);
    await page.waitForTimeout(800);

    const after = await page.inputValue('#protUserPwd');
    expect(after).toBe('e2e-regression-pass');
  } finally {
    await context.close();
  }
});

await test('single-file happy path still produces a real protected PDF (guard does not break normal use)', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.addInitScript(BLOB_HOOK);
    await page.goto(`${BASE_URL}/protect-pdf/`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', FILE_1);
    await page.waitForSelector('#protUserPwd', { state: 'visible', timeout: 15000 });
    await page.fill('#protUserPwd', 'e2e-happy-path');
    await page.evaluate(() => { window.__blob = null; });
    await page.click('#mergeBtn');

    let result = null;
    for (let i = 0; i < 40; i++) {
      result = await page.evaluate(() => window.__blob ? { size: window.__blob.size, type: window.__blob.type } : null).catch(() => null);
      if (result) break;
      await page.waitForTimeout(500);
    }
    if (!result) throw new Error('conversion did not complete in time');
    expect(result.type).toBe('application/pdf');
    if (!(result.size > 0)) throw new Error(`Expected a non-empty PDF, got size ${result.size}`);
  } finally {
    await context.close();
  }
});

await browser.close();

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
