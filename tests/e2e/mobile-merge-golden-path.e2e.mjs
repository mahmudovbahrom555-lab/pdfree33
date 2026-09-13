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

await test('add 2 files on a real mobile viewport, click #mergeBtn, get a real valid merged PDF, no silent errors', async () => {
  const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isBenignConsoleText(msg.text())) consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  try {
    await page.goto(`${BASE_URL}/merge-pdf/`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', [FILE_1, FILE_2]);

    // "nothing visibly happened" checks — the file list actually renders
    // both files, and the button actually leaves its disabled state —
    // before we even get to the download.
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

    // Opportunistic "silently broken" catch-alls — directly targeting the
    // incident class this test exists for.
    await page.waitForFunction(
      () => document.getElementById('toast')?.classList.contains('show'),
      { timeout: 5000 },
    ).catch(() => { throw new Error('success toast (#toast.show) never appeared — user gets no visible confirmation'); });

    if (consoleErrors.length > 0) {
      throw new Error(`console/page errors during the golden path (silent-failure signal):\n${consoleErrors.join('\n')}`);
    }
  } finally {
    await context.close();
  }
});

await browser.close();

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
