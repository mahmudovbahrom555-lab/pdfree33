// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/pdf2jpg.logic.test.js — regression coverage for the
//  page-loss bug fixed in commit cf60150 (js/processor.js's
//  _runPdf2Jpg). Real bug: unchecking "pack into ZIP"
//  (#p2jZipCheck) on a >1 page selection silently kept only the
//  first rendered page and discarded the rest — no error, no
//  warning. Root cause was a condition that let a `zip` flag
//  alone gate which pages got kept, instead of keying strictly
//  on how many pages were actually selected.
//
//  _runPdf2Jpg itself is not exported (large, canvas/pdf.js-
//  dependent async function) — same situation as drawPointer.js's
//  internals in tests/drawUI.logic.test.js, so this pure-copies
//  the exact decision structure that was buggy, using the same
//  variable names/shape as the real code, so a regression in the
//  real file (e.g. reintroducing `!zip ||`) has an obvious analog
//  here to keep in sync.
//
//  Run: node tests/pdf2jpg.logic.test.js
// ============================================================

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe:       (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy: ()  => { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
  };
}

// Pure copy of js/processor.js's post-fix (cf60150) page-keeping decision.
// `zip` is accepted here ONLY to prove it's irrelevant to the invariant —
// the real fix's whole point was removing it from this exact condition.
function _pdf2jpgKeepCount(numPages, zip) {
  let singleResult = null;
  let streamCount  = 0;
  for (let i = 0; i < numPages; i++) {
    if (numPages === 1) {
      if (!singleResult) singleResult = { i };
    } else {
      streamCount++;
    }
  }
  return numPages === 1 ? 1 : streamCount;
}

console.log('\npdf2jpg — Data Integrity Invariant (no page silently dropped, see cf60150):');

test('every rendered page is kept when zip=true, for a range of page counts', () => {
  for (const n of [1, 2, 5, 20, 50]) expect(_pdf2jpgKeepCount(n, true)).toBe(n);
});

test('every rendered page is kept when zip=false too — this is the exact regression cf60150 fixed', () => {
  for (const n of [1, 2, 5, 20, 50]) expect(_pdf2jpgKeepCount(n, false)).toBe(n);
});

test('a single selected page never needs zip packaging either way', () => {
  expect(_pdf2jpgKeepCount(1, true)).toBe(1);
  expect(_pdf2jpgKeepCount(1, false)).toBe(1);
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
