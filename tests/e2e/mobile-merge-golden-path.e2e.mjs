// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/mobile-merge-golden-path.e2e.mjs — real-browser, real-mobile-
//  viewport golden-path regression gate: add 2 files -> click #mergeBtn ->
//  catch the real download -> verify it's a genuinely valid, correctly-
//  paged PDF. Written specifically to catch the incident class this repo's
//  owner is defending against (see /Users/murodjon/.claude/plans/
//  typed-plotting-wave.md): a deploy that silently breaks the merge flow
//  with NO visible error — console clean, page looks normal, button just
//  quietly does nothing, or downloads a corrupt/empty file. A stuck mobile
//  Service Worker can only be rescued by self-healing code that is already
//  running (see memory pwa_direct_version_check_2026_09) — the actual fix
//  is to never ship the breakage in the first place, which is what this
//  gate + the staged-rollout mechanism in deploy.yml are for.
//
//  Dual purpose via PDFREE_BASE_URL (same convention as embed-sdk.e2e.mjs):
//    - default http://localhost:8934 (local dist/) — cheap/fast pre-check,
//      wired into deploy.yml alongside the other 3 local E2E gates.
//    - a Cloudflare `versions upload` preview URL — the real pre-cutover
//      gate, run against Cloudflare's actual Worker/Assets serving layer,
//      not a bare local http.server.
//
//  Requires: dist/ already built (`python3 scripts/build.py`) and served
//  at PDFREE_BASE_URL (default http://localhost:8934).
//
//  Run: node tests/e2e/mobile-merge-golden-path.e2e.mjs
//       PDFREE_BASE_URL=<preview-url> node tests/e2e/mobile-merge-golden-path.e2e.mjs
// ============================================================

import { chromium, devices } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL  = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const FILE_1    = path.join(__dirname, '..', 'fixtures', 'normal-1page.pdf');
const FILE_2    = path.join(__dirname, '..', 'fixtures', 'normal-3page.pdf');
const EXPECTED_PAGE_COUNT = 4; // 1 + 3

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

// Known-benign noise only — everything else fails the test. Same posture as
// embed-sdk.e2e.mjs's isRealCspViolation(): an explicit, narrow allowlist
// confirmed by hand, not a blanket ignore.
//
// The 501/net::ERR_FAILED entries are specific to running against a bare
// `python3 -m http.server` (used for the local pre-check gate) — that
// static server has no POST support at all, so js/analytics.js's real
// `fetch('/api/analytics', {method:'POST'})` call always 501s there.
// Confirmed this is NOT a real bug: src/index.js (the actual Cloudflare
// Worker, what both production and the preview-URL gate run against) has
// a real `POST /api/analytics` handler — this noise only exists on the
// local-only leg of this test.
function isBenignConsoleText(text) {
  return /cloudflareinsights\.com|favicon\.ico|ERR_FAILED|Unsupported method|501 \(Unsupported/.test(text);
}

console.log(`\nmobile golden-path E2E — merge 2 files → real download → real page count (${BASE_URL}):`);

let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  console.error('Could not launch Chromium — run `npx playwright install --with-deps chromium` first.');
  console.error(e.message);
  process.exit(1);
}

// One attempt. Besides console/page errors it records every failed request
// and every HTTP error status, so a failure says WHY (2026-11-05: twice on CI,
// #132 and #139, "importScripts … failed to load" for a worker script served
// by CI's local python http.server — never reproduced locally).
async function goldenPath() {
  const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  const page = await context.newPage();
  const consoleErrors = [], failedRequests = [], httpErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isBenignConsoleText(msg.text())) consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  page.on('requestfailed', (req) => failedRequests.push(`${req.url()} — ${req.failure()?.errorText}`));
  page.on('response', (res) => { if (res.status() >= 400 && res.url().startsWith(BASE_URL)) httpErrors.push(`${res.status()} ${res.url()}`); });
  // workers' own requests (importScripts) don't all reach page events
  context.on('requestfailed', (req) => { const line = `${req.url()} — ${req.failure()?.errorText}`; if (!failedRequests.includes(line)) failedRequests.push(line); });

  try {
    await page.goto(`${BASE_URL}/merge-pdf/`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', [FILE_1, FILE_2]);

    await page.waitForFunction(
      () => document.querySelectorAll('#fileList .file-item').length >= 2,
      { timeout: 15000 },
    );
    await page.waitForFunction(
      () => document.getElementById('mergeBtn') && !document.getElementById('mergeBtn').disabled,
      { timeout: 15000 },
    );

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('#mergeBtn'),
    ]);

    const downloadPath = await download.path();
    if (!downloadPath) throw new Error('download.path() was empty — no real file was produced');

    const bytes = await fs.readFile(downloadPath);
    if (bytes.length === 0) throw new Error('downloaded file is empty (0 bytes)');

    const PDFLib = await import('pdf-lib');
    const { PDFDocument } = PDFLib;
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(EXPECTED_PAGE_COUNT);

    await page.waitForFunction(
      () => document.getElementById('toast')?.classList.contains('show'),
      { timeout: 5000 },
    ).catch(() => { throw new Error('success toast (#toast.show) never appeared — user gets no visible confirmation'); });

    if (consoleErrors.length > 0) {
      throw new Error(`console/page errors during the golden path (silent-failure signal):\n${consoleErrors.join('\n')}`);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e, consoleErrors, failedRequests, httpErrors };
  } finally {
    await context.close();
  }
}

// A load failure of one of OUR OWN static files, with no HTTP error status,
// is a test-server network blip, not the app: retried once, loudly. A 404/500,
// a file missing from dist/ (fails both times) or any other error is not retried.
// (requests to other sites — the analytics beacon — fail in tests anyway and don't count)
const isNetworkBlip = (r) => r.httpErrors.length === 0
  && r.failedRequests.some(l => l.startsWith(BASE_URL))
  && r.consoleErrors.length > 0 && r.consoleErrors.every(t => /NetworkError|failed to load|Failed to load resource|importScripts/i.test(t));
const report = (r) => `${r.error.stack || r.error.message}
    failed requests: ${r.failedRequests.join('; ') || 'none'}
    HTTP errors: ${r.httpErrors.join('; ') || 'none'}`;

await test('add 2 files on a real mobile viewport, click #mergeBtn, get a real valid merged PDF, no silent errors', async () => {
  let r = await goldenPath();
  if (!r.ok && isNetworkBlip(r)) {
    console.warn(`  ⚠ RETRY — a static file failed to load from the test server (network, no HTTP error):\n    ${r.failedRequests.join('\n    ')}`);
    const first = r;
    r = await goldenPath();
    if (!r.ok) throw new Error(`failed twice.\n  first: ${report(first)}\n  second: ${report(r)}`);
  }
  if (!r.ok) throw new Error(report(r));
});

// The default file name is selected on entry, so typing replaces it (39 people in a
// week clicked the field three times in a second to select it, Rage Click 2026-11-11);
// once a name was typed, a tap only places the caret.
await test('output file name: one tap selects the default, typing replaces it, a second tap keeps it', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE_URL}/merge-pdf/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', [FILE_2, FILE_1]);
    await page.locator('#mergeFilenameInput').waitFor();
    await page.tap('#mergeFilenameInput');
    await page.keyboard.type('Quarterly report');
    if (await page.inputValue('#mergeFilenameInput') !== 'Quarterly report') throw new Error(`after typing: ${await page.inputValue('#mergeFilenameInput')}`);
    await page.tap('#mergeFilenameInput');
    await page.keyboard.press('End');
    await page.keyboard.type(' v2');
    if (await page.inputValue('#mergeFilenameInput') !== 'Quarterly report v2') throw new Error(`after the second tap: ${await page.inputValue('#mergeFilenameInput')}`);
  } finally {
    await ctx.close();
  }
});

// A double or triple click on the drop zone (a folder habit) opens the file
// picker once, not once per click (26 people rage-clicked it, analytics 2026-11-11).
await test('drop zone: a double or triple click opens the file picker once', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE_URL}/merge-pdf/`, { waitUntil: 'load' });
    for (const clicks of [2, 3]) {
      let opened = 0;
      const count = () => opened++;
      page.on('filechooser', count);
      await page.locator('#dropZone .drop-title').click({ clickCount: clicks });
      await page.waitForTimeout(800);
      page.off('filechooser', count);
      if (opened !== 1) throw new Error(`${clicks} clicks opened the picker ${opened} times`);
    }
  } finally {
    await ctx.close();
  }
});

// One PDF chosen: the list says what's missing instead of a silently grey
// button (user journey 2026-11-13); a second file clears it and enables Merge.
await test('merge with one PDF: the list says to add one more; a second removes the hint and enables Merge', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE_URL}/merge-pdf/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', [FILE_1]);
    await page.waitForFunction(() => /Add one more PDF/.test(document.getElementById('fileCount')?.textContent || ''), null, { timeout: 10000 });
    if (!await page.locator('#mergeBtn').isDisabled()) throw new Error('Merge enabled with one file');
    await page.setInputFiles('#fileInput', [FILE_2]);
    await page.waitForFunction(() => !/Add one more PDF/.test(document.getElementById('fileCount')?.textContent || ''), null, { timeout: 10000 });
    if (await page.locator('#mergeBtn').isDisabled()) throw new Error('Merge still disabled with two files');
  } finally {
    await ctx.close();
  }
});

await browser.close();

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
