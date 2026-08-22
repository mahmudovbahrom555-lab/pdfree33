// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/redirects-parity.test.js — GUESS_REDIRECTS safety + staleness guards
//
//  src/index.js's REDIRECTS table is { ...GUESS_REDIRECTS, ...MANUAL_REDIRECTS },
//  where GUESS_REDIRECTS is derived automatically from data/tools-config.json
//  on every deploy and MANUAL_REDIRECTS is a hand-maintained list of cases
//  the generator can't derive (renamed slugs, blog aliases, genuinely
//  ambiguous bare-slug ties).
//
//  Three checks live here:
//   1. FAILING — no redirect key may equal a real, existing page. This is
//      the actually-dangerous case: a future tool whose EN slug happens to
//      collide with another tool's translated slug (or vice versa) would
//      otherwise silently 301 a real, working page away from itself.
//   2. WARNING — bare (no locale-prefix) slugs shared identically by 2+
//      locales/tools. _buildGuessRedirects already refuses to guess a
//      target for these (safer to stay 404 than pick the wrong language),
//      but that skip is otherwise invisible — surfaced here so a human can
//      decide whether it deserves a MANUAL_REDIRECTS tie-break (as
//      dividir-pdf/pdf-password/pdf-metadata already have).
//   3. WARNING — MANUAL_REDIRECTS entries GUESS_REDIRECTS now derives too.
//      MANUAL_REDIRECTS always wins on overlap, so a stale manual entry
//      would keep winning over a now-correct generated one forever unless
//      flagged. See src/index.js's own comment above these exports for why
//      each was added.
// ============================================================

import { MANUAL_REDIRECTS, GUESS_REDIRECTS, AMBIGUOUS_BARE_SLUGS, toolsConfig } from '../src/index.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try   { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

console.log(`\nMANUAL_REDIRECTS: ${Object.keys(MANUAL_REDIRECTS).length} entries`);
console.log(`GUESS_REDIRECTS:   ${Object.keys(GUESS_REDIRECTS).length} entries`);

// ── 1. No redirect may shadow a real page (FAILING) ──────────────────────

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
// (draw's real per-locale pages are already covered above via its
// hardcoded slug map living only inside _buildGuessRedirects, not
// toolsConfig — draw guesses always redirect TO a real page, never collide
// as a source, so nothing extra to add here for it.)
realPages.add('/compare-pdf/');
realPages.add('/scan-document/');

test('no GUESS_REDIRECTS key shadows a real tool page', () => {
  const collisions = Object.keys(GUESS_REDIRECTS)
    .filter(k => k.endsWith('/'))
    .filter(k => realPages.has(k));
  if (collisions.length) {
    throw new Error(`${collisions.length} generated redirect(s) point away from what is also a real page: ${collisions.join(', ')}`);
  }
});

test('no MANUAL_REDIRECTS key shadows a real tool page', () => {
  const collisions = Object.keys(MANUAL_REDIRECTS)
    .filter(k => k.endsWith('/'))
    .filter(k => realPages.has(k));
  if (collisions.length) {
    throw new Error(`${collisions.length} manual redirect(s) point away from what is also a real page: ${collisions.join(', ')}`);
  }
});

// ── 2. Ambiguous bare-slug guesses without a tie-break (WARNING) ─────────

const unresolvedAmbiguities = AMBIGUOUS_BARE_SLUGS.filter(
  ({ slug }) => !(`/${slug}` in MANUAL_REDIRECTS) && !(`/${slug}/` in MANUAL_REDIRECTS)
);
if (AMBIGUOUS_BARE_SLUGS.length === 0) {
  console.log('  ✓ no ambiguous bare-slug guesses found');
} else if (unresolvedAmbiguities.length === 0) {
  console.log(`  ✓ ${AMBIGUOUS_BARE_SLUGS.length} ambiguous bare-slug guess(es) found, all already have a MANUAL_REDIRECTS tie-break`);
} else {
  console.log(`  ⚠ ${unresolvedAmbiguities.length} ambiguous bare-slug guess(es) with NO tie-break yet — currently 404, consider a MANUAL_REDIRECTS entry:`);
  for (const { slug, targets } of unresolvedAmbiguities) {
    console.log(`    ⚠ /${slug}/ could mean: ${targets.join(' OR ')}`);
  }
}

// ── 3. MANUAL_REDIRECTS entries now redundant with GUESS_REDIRECTS (WARNING) ─

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

// ── Summary ────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
