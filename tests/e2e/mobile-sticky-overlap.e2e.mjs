// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/mobile-sticky-overlap.e2e.mjs — real-browser regression test
//  for the mobile bug found + fixed 2026-09-10 (commit 0934fc9b), reported
//  live by the user on 2 physical devices: "select a file, nothing
//  happens."
//
//  Root cause: #mergeBtn's position:sticky (css/components.css) pins it to
//  a fixed VIEWPORT position. On a short mobile viewport, the page's
//  preceding content (nav + hero + drop-zone + privacy badge) happens to
//  total almost exactly one viewport height — so right after the first
//  file is added, #fileList rendered into the exact same on-screen band
//  the sticky button occupies, completely covering it (confirmed via
//  elementFromPoint: a real tap there hit the button, not the file). Fixed
//  by scrolling #fileList into view on the genuinely-first file add
//  (js/app.js's 'pdfree:files-added' listener, gated on files.js's
//  addFiles() reporting `wasEmpty` — NOT `selectedFiles.length === 1`,
//  which misses a first pick that selects several files at once).
//
//  This is a real, previously-shipped, user-reported bug — the same class
//  already bit this codebase once before (see css/components.css's own
//  comment on #btnInstallOcr/#glsDictionary, fixed with a similar margin
//  push). Encoding it as a live-browser CI gate, not just a unit test on
//  the wasEmpty flag alone (tests/files.logic.test.js already covers
//  that), so a future CSS change to .merge-btn's sticky offset/height, or
//  a refactor that drops the scroll-into-view call, fails the build
//  instead of shipping unnoticed.
//
//  Two tools checked (not all ~30 — this asserts the SHARED mechanism,
//  which a manual full-site audit already confirmed applies uniformly;
//  see the memory this test was written from): Merge (multi:true, the
//  originally-reported tool) and Watermark (a different preceding-content
//  height/options-panel shape, confirming the fix isn't accidentally
//  tuned to Merge's specific layout).
//
//  Requires: dist/ already built (`python3 scripts/build.py`) and served
//  at PDFREE_BASE_URL (default http://localhost:8934).
//
//  Run: node tests/e2e/mobile-sticky-overlap.e2e.mjs
// ============================================================

import { chromium, devices } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL  = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const FILE_1    = path.join(__dirname, '..', 'fixtures', 'normal-1page.pdf');
const FILE_2    = path.join(__dirname, '..', 'fixtures', 'normal-3page.pdf');

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

/** Zero overlap between #fileList and any position:fixed/sticky element,
 *  AND a real tap at #fileList's own center must land inside #fileList —
 *  the two checks together are what actually matter (an element can pass
 *  a naive bounding-box check yet still be the thing elementFromPoint
 *  resolves to, if something else sits at a higher stacking order). */
async function checkNoOverlap(page) {
  return page.evaluate(() => {
    const fl = document.getElementById('fileList');
    if (!fl) return { skipped: 'no #fileList on this tool' };
    const flRect = fl.getBoundingClientRect();
    if (flRect.height === 0) return { skipped: '#fileList empty on this tool' };

    let overlapArea = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (el === fl || fl.contains(el) || el.contains(fl)) continue;
      const style = getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const oy = Math.max(0, Math.min(flRect.bottom, r.bottom) - Math.max(flRect.top, r.top));
      const ox = Math.max(0, Math.min(flRect.right, r.right) - Math.max(flRect.left, r.left));
      overlapArea = Math.max(overlapArea, oy * ox);
    }

    const cx = flRect.left + flRect.width / 2, cy = flRect.top + flRect.height / 2;
    const topEl = document.elementFromPoint(cx, cy);
    const tapHitsFileList = fl.contains(topEl) || topEl === fl;

    return { overlapArea, tapHitsFileList };
  });
}

console.log(`\nmobile sticky-overlap E2E — newly-added file must be visible + tappable (real browser, ${BASE_URL}):`);

let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  console.error('Could not launch Chromium — run `npx playwright install --with-deps chromium` first.');
  console.error(e.message);
  process.exit(1);
}

for (const slug of ['merge-pdf', 'watermark-pdf']) {
  await test(`${slug}: single first file — no overlap, tap hits the file item`, async () => {
    const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
    const page = await context.newPage();
    try {
      await page.goto(`${BASE_URL}/${slug}/`, { waitUntil: 'load', timeout: 30000 });
      await page.setInputFiles('#fileInput', FILE_1);
      await page.waitForTimeout(1200); // let the smooth scroll finish

      const result = await checkNoOverlap(page);
      if (result.skipped) { console.log(`    (skipped: ${result.skipped})`); return; }
      if (result.overlapArea > 0) throw new Error(`#fileList overlaps a sticky/fixed element (area=${result.overlapArea}px²)`);
      expect(result.tapHitsFileList).toBe(true);
    } finally {
      await context.close();
    }
  });

  await test(`${slug}: multi-file FIRST pick (2 at once) — still no overlap`, async () => {
    // The exact case a naive `selectedFiles.length === 1` check would miss
    // — length jumps straight from 0 to 2, never passing through 1.
    const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
    const page = await context.newPage();
    try {
      await page.goto(`${BASE_URL}/${slug}/`, { waitUntil: 'load', timeout: 30000 });
      await page.setInputFiles('#fileInput', [FILE_1, FILE_2]);
      await page.waitForTimeout(1200);

      const result = await checkNoOverlap(page);
      if (result.skipped) { console.log(`    (skipped: ${result.skipped})`); return; }
      if (result.overlapArea > 0) throw new Error(`#fileList overlaps a sticky/fixed element (area=${result.overlapArea}px²)`);
      expect(result.tapHitsFileList).toBe(true);
    } finally {
      await context.close();
    }
  });

  await test(`${slug}: adding a 2nd file after manual scroll does not yank the viewport back`, async () => {
    const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
    const page = await context.newPage();
    try {
      await page.goto(`${BASE_URL}/${slug}/`, { waitUntil: 'load', timeout: 30000 });
      await page.setInputFiles('#fileInput', FILE_1);
      await page.waitForTimeout(1200);

      await page.evaluate(() => window.scrollTo(0, 50));
      await page.waitForTimeout(200);
      const scrollBefore = await page.evaluate(() => window.scrollY);

      await page.setInputFiles('#fileInput', [FILE_1, FILE_2]);
      await page.waitForTimeout(800);
      const scrollAfter = await page.evaluate(() => window.scrollY);

      expect(scrollAfter).toBe(scrollBefore);
    } finally {
      await context.close();
    }
  });
}

await browser.close();

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
