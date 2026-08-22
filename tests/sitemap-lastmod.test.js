// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/sitemap-lastmod.test.js — regression guard for the 2026-08-22
//  CI shallow-clone bug (see gsc_crawled_not_indexed_2026_08 memory)
//
//  scripts/build.py's _git_lastmod() runs `git log -- <path>` per source
//  file to compute each sitemap <url>'s real <lastmod>. If CI ever checks
//  out with a shallow clone again (e.g. someone removes deploy.yml's
//  `fetch-depth: 0`, thinking it's unnecessary) — or build.py's sitemap
//  generation breaks in some other way that collapses every date to one —
//  `git log` silently finds no history for most files and every affected
//  page's <lastmod> falls back to "today," producing a sitemap where
//  nearly every URL shares one date. That's a pattern Google explicitly
//  treats as an unreliable freshness signal and may discount — a real SEO
//  regression, not just a cosmetic one, and it happened silently in
//  production before anyone noticed.
//
//  This test can't detect "is fetch-depth: 0 present" directly (that's a
//  CI config check, not a data check) — instead it checks the actual
//  OUTPUT shape the bug produces: real site history naturally spans dozens
//  of distinct dates with no single date dominating. Thresholds below are
//  set with real margin under the current healthy baseline (17 distinct
//  dates, max single-date share 22.7% as of 2026-08-22) while still being
//  decisively tripped by the bug's signature (collapses to ~1-3 dates,
//  ~95%+ on one).
// ============================================================

import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');
const SITEMAP   = path.join(ROOT, 'dist', 'sitemap.xml');

let passed = 0, failed = 0;
function test(name, fn) {
  try   { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const inCI = !!(process.env.CI || process.env.GITHUB_ACTIONS);
if (!existsSync(SITEMAP) && !inCI) {
  console.log('  – skipped: sitemap lastmod check (dist/sitemap.xml not built — run scripts/build.py first; mandatory in CI)');
} else {
  test('dist/sitemap.xml exists', () => {
    if (!existsSync(SITEMAP)) {
      throw new Error('dist/sitemap.xml does not exist in CI — the build step must have failed or been skipped before tests ran');
    }
  });

  if (existsSync(SITEMAP)) {
    const xml = readFileSync(SITEMAP, 'utf8');
    const dates = [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map(m => m[1]);

    test('sitemap has a substantial number of <lastmod> entries', () => {
      if (dates.length < 100) throw new Error(`only ${dates.length} <lastmod> entries found — sitemap generation may itself be broken`);
    });

    const counts = new Map();
    for (const d of dates) counts.set(d, (counts.get(d) ?? 0) + 1);
    const distinctCount = counts.size;
    const [topDate, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['(none)', 0];
    const topShare = dates.length ? topCount / dates.length : 0;

    console.log(`  ℹ ${dates.length} <lastmod> entries, ${distinctCount} distinct dates, most common: ${topDate} (${(topShare * 100).toFixed(1)}%)`);

    test('lastmod dates are not collapsed to a single value (CI shallow-clone regression signature)', () => {
      if (distinctCount < 5) {
        throw new Error(`only ${distinctCount} distinct lastmod date(s) across ${dates.length} URLs — looks like the CI shallow-clone bug (git log finding no history) has recurred. Check .github/workflows/deploy.yml's checkout step still has fetch-depth: 0.`);
      }
    });

    test('no single lastmod date dominates the sitemap (CI shallow-clone regression signature)', () => {
      if (topShare > 0.6) {
        throw new Error(`${topDate} accounts for ${(topShare * 100).toFixed(1)}% of all ${dates.length} sitemap URLs — looks like the CI shallow-clone bug (git log finding no history, falling back to today) has recurred. Check .github/workflows/deploy.yml's checkout step still has fetch-depth: 0.`);
      }
    });
  }
}

// ── Summary ────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
