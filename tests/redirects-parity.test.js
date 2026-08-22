// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/redirects-parity.test.js — MANUAL_REDIRECTS staleness guard
//
//  src/index.js's REDIRECTS table is { ...GUESS_REDIRECTS, ...MANUAL_REDIRECTS },
//  where GUESS_REDIRECTS is derived automatically from data/tools-config.json
//  on every deploy and MANUAL_REDIRECTS is a hand-maintained list of cases
//  the generator can't derive (renamed slugs, blog aliases, genuinely
//  ambiguous bare-slug ties).
//
//  MANUAL_REDIRECTS always wins on key overlap — which means a manual entry
//  that GUESS_REDIRECTS has since learned to derive on its own becomes
//  invisible dead weight: nothing ever prompts anyone to remove it, and if
//  the real tool slug changes later, the stale manual entry would keep
//  winning over the now-correct generated one instead of tracking the
//  change. This test flags every such overlap so MANUAL_REDIRECTS stays
//  reviewed rather than silently growing forever.
//
//  Non-failing by design (warnings, not assertions) — an overlap isn't
//  necessarily wrong (a manual entry may deliberately override a generated
//  one with a different, more correct target), just worth a human glance.
// ============================================================

import { MANUAL_REDIRECTS, GUESS_REDIRECTS } from '../src/index.js';

const overlapKeys = Object.keys(MANUAL_REDIRECTS).filter(k => k in GUESS_REDIRECTS);

console.log(`\nMANUAL_REDIRECTS: ${Object.keys(MANUAL_REDIRECTS).length} entries`);
console.log(`GUESS_REDIRECTS:   ${Object.keys(GUESS_REDIRECTS).length} entries`);

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

// Always exits 0 — this is a visibility aid surfaced in every `npm test`
// run, not a hard gate. See file header for why.
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: 1 | ✓ 1 | 0 failed`);
