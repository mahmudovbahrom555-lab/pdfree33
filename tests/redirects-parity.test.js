// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/redirects-parity.test.js — GUESS_REDIRECTS safety + staleness guards
//
//  src/index.js's REDIRECTS table is { ...GUESS_REDIRECTS, ...MANUAL_REDIRECTS },
//  where GUESS_REDIRECTS is derived automatically from data/tools-config.json
//  on every deploy (including auto-resolving bare-slug ties across locales
//  via LOCALE_TIE_BREAK_PRIORITY) and MANUAL_REDIRECTS is a hand-maintained
//  list of cases the generator can't derive (renamed slugs, blog aliases,
//  EN-only tools not in tools-config.json).
//
//  Checks, in order:
//   1. FAILING — no two tools share the same EN slug. A structural
//      precondition every Pattern-1 guess relies on being unique; catches a
//      tools-config.json data mistake before it can corrupt the redirect
//      table, rather than assuming it can never happen.
//   2. FAILING — _buildGuessRedirects never silently overwrote a key with a
//      different value during its own construction (INTERNAL_COLLISIONS).
//   3. FAILING — no GUESS_REDIRECTS key may equal a real, existing page.
//      Auto-generated and never human-reviewed, so this one gets a hard
//      gate: a future tool's slug colliding with another tool's real page
//      would otherwise silently 301 working content away from itself.
//   4. WARNING (not failing) — same check for MANUAL_REDIRECTS. Unlike
//      GUESS_REDIRECTS, a manual entry IS human-authored, so it's allowed to
//      deliberately alias/consolidate a real page on purpose (e.g. a page
//      that's real per tools-config.json but has since been superseded) —
//      MANUAL_REDIRECTS is itself the exception mechanism. Flagged for a
//      glance, not blocked.
//   5. WARNING — MANUAL_REDIRECTS entries GUESS_REDIRECTS now derives too
//      (would otherwise accumulate dead/stale overrides forever).
//   6. FAILING — every MANUAL_REDIRECTS target resolves to a real page
//      (checked against dist/, not the tools-config.json-derived realPages
//      set above — dist/ is the only complete ground truth, since targets
//      routinely include blog posts and landing pages tools-config.json
//      doesn't know about at all). Skipped with a message ONLY outside CI
//      (so `npm test` still runs standalone without a prior build, matching
//      this project's other tests) — inside CI (dist/ is always built
//      before tests run there), a missing dist/ instead FAILS this check,
//      since silently skipping would defeat it exactly when it matters:
//      gating an actual deploy.
//   7. Informational — bare-slug ties LOCALE_TIE_BREAK_PRIORITY resolved
//      automatically, and any left genuinely unresolved (should be none,
//      since the priority list covers all 13 locales — kept as a guard in
//      case a 14th locale is ever added to tools-config.json without a
//      matching priority-list update).
// ============================================================

import { existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import {
  MANUAL_REDIRECTS, GUESS_REDIRECTS, toolsConfig,
  LOCALE_TIE_BREAK_PRIORITY, AMBIGUOUS_BARE_SLUGS, TIE_BREAK_RESOLVED, INTERNAL_COLLISIONS,
} from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

let passed = 0, failed = 0;
function test(name, fn) {
  try   { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

console.log(`\nMANUAL_REDIRECTS: ${Object.keys(MANUAL_REDIRECTS).length} entries`);
console.log(`GUESS_REDIRECTS:   ${Object.keys(GUESS_REDIRECTS).length} entries`);
console.log(`LOCALE_TIE_BREAK_PRIORITY: ${LOCALE_TIE_BREAK_PRIORITY.join(' > ')}`);

// ── 1. EN slugs must be unique across tools ───────────────────────────────

test('every tool has a distinct EN slug', () => {
  const seen = new Map();
  const dupes = [];
  for (const t of toolsConfig.tools) {
    const en = t.slugs.en;
    if (seen.has(en)) dupes.push(`${en} (${seen.get(en)} vs ${t.toolKey})`);
    else seen.set(en, t.toolKey);
  }
  if (dupes.length) throw new Error(`duplicate EN slug(s): ${dupes.join(', ')}`);
});

// ── 2. No internal generation collisions ──────────────────────────────────

test('_buildGuessRedirects never overwrote a key with a different value internally', () => {
  if (INTERNAL_COLLISIONS.length) {
    const detail = INTERNAL_COLLISIONS.map(c => `${c.key}: ${c.existing} vs ${c.attempted}`).join('; ');
    throw new Error(`${INTERNAL_COLLISIONS.length} internal collision(s): ${detail}`);
  }
});

// ── 3 & 4. No redirect key may shadow a real page ─────────────────────────

const realPages = new Set();
for (const tool of toolsConfig.tools) {
  for (const [lc, slug] of Object.entries(tool.slugs)) {
    const dir = toolsConfig.languages[lc]?.dir;
    if (dir === undefined) continue;
    realPages.add(dir === '.' ? `/${slug}/` : `/${dir}/${slug}/`);
  }
}
// Tools absent from tools-config.json's `tools` list — mirrors the same
// special-cased real pages src/index.js's _buildGuessRedirects hand-adds.
realPages.add('/compare-pdf/');
realPages.add('/scan-document/');

test('no GUESS_REDIRECTS key shadows a real tool page (auto-generated — hard gate)', () => {
  const collisions = Object.keys(GUESS_REDIRECTS).filter(k => k.endsWith('/') && realPages.has(k));
  if (collisions.length) {
    throw new Error(`${collisions.length} generated redirect(s) point away from what is also a real page: ${collisions.join(', ')}`);
  }
});

const manualRealPageShadows = Object.keys(MANUAL_REDIRECTS).filter(k => k.endsWith('/') && realPages.has(k));
if (manualRealPageShadows.length === 0) {
  console.log('  ✓ no MANUAL_REDIRECTS key shadows a real tool page');
} else {
  console.log(`  ⚠ ${manualRealPageShadows.length} MANUAL_REDIRECTS key(s) shadow a real tool page (allowed — human-authored, may be intentional; confirm on review):`);
  for (const k of manualRealPageShadows) console.log(`    ⚠ ${k} -> ${MANUAL_REDIRECTS[k]}`);
}

// ── 5. MANUAL_REDIRECTS entries now redundant with GUESS_REDIRECTS ───────

const overlapKeys = Object.keys(MANUAL_REDIRECTS).filter(k => k in GUESS_REDIRECTS);
if (overlapKeys.length === 0) {
  console.log('  ✓ no MANUAL_REDIRECTS key is shadowing an auto-derived GUESS_REDIRECTS entry');
} else {
  console.log(`  ⚠ ${overlapKeys.length} MANUAL_REDIRECTS key(s) overlap with GUESS_REDIRECTS:`);
  for (const key of overlapKeys) {
    const manual = MANUAL_REDIRECTS[key];
    const guess  = GUESS_REDIRECTS[key];
    if (manual === guess) {
      console.log(`    ⚠ REDUNDANT  ${key} -> ${manual}  (now auto-derived identically — safe to delete from MANUAL_REDIRECTS)`);
    } else {
      console.log(`    ⚠ OVERRIDE   ${key} -> MANUAL wins with ${manual} instead of auto-derived ${guess}  (confirm this is still intentional)`);
    }
  }
}

// ── 6. Every MANUAL_REDIRECTS target must be a real page ──────────────────
// Checked against dist/, not the tools-config.json-derived `realPages` set
// above — MANUAL_REDIRECTS targets routinely include blog posts and landing
// pages (e.g. /blog/how-to-split-a-pdf/, /annotate-pdf/) that aren't tools
// and so aren't in tools-config.json at all; dist/ is the only complete
// ground truth for "does this page really exist."

const DIST = path.join(ROOT, 'dist');
const inCI = !!(process.env.CI || process.env.GITHUB_ACTIONS);
if (!existsSync(DIST) && !inCI) {
  console.log('  – skipped: MANUAL_REDIRECTS target-validity check (dist/ not built — run scripts/build.py first; this check is mandatory in CI, where dist/ is always built before tests run)');
} else {
  function pageExists(targetPath) {
    // targetPath like '/foo/bar/' → dist/foo/bar/index.html
    const rel = targetPath.replace(/^\/|\/$/g, '');
    const file = rel ? path.join(DIST, rel, 'index.html') : path.join(DIST, 'index.html');
    return existsSync(file);
  }
  test('every MANUAL_REDIRECTS target resolves to a real page in dist/', () => {
    if (!existsSync(DIST)) {
      throw new Error('dist/ does not exist in CI — the build step must have failed or been skipped before tests ran');
    }
    const broken = [...new Set(Object.values(MANUAL_REDIRECTS))].filter(t => !pageExists(t));
    if (broken.length) {
      throw new Error(`${broken.length} MANUAL_REDIRECTS target(s) don't exist in dist/: ${broken.join(', ')}`);
    }
  });
}

// ── 7. Bare-slug tie-break visibility ──────────────────────────────────────

if (TIE_BREAK_RESOLVED.length === 0) {
  console.log('  ✓ no bare-slug ties needed auto-resolution');
} else {
  console.log(`  ℹ ${TIE_BREAK_RESOLVED.length} bare-slug tie(s) auto-resolved via LOCALE_TIE_BREAK_PRIORITY:`);
  for (const { slug, winner, candidates } of TIE_BREAK_RESOLVED) {
    console.log(`    ℹ /${slug}/ -> ${winner}  (candidates were: ${candidates.join(', ')})`);
  }
}
test('no bare-slug ties are left genuinely unresolved', () => {
  if (AMBIGUOUS_BARE_SLUGS.length) {
    const detail = AMBIGUOUS_BARE_SLUGS.map(a => `/${a.slug}/ (${a.targets.join(' OR ')})`).join(', ');
    throw new Error(`${AMBIGUOUS_BARE_SLUGS.length} unresolved (no candidate locale in LOCALE_TIE_BREAK_PRIORITY): ${detail}`);
  }
});

// ── Summary ────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
