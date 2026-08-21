// ============================================================
//  tests/ereaderRunner.logic.test.js — orchestration-level regression
//  coverage for the page-sampling logic behind processor.js's
//  _runEreader, per the 2026-08-21 QA critique: manual browser QA of
//  one document isn't a regression guard. The rest of the crop/pixel
//  math is already covered by tests/ereaderCrop.test.js; this file
//  covers ereaderSampleIndices specifically, which decides WHICH pages
//  get sampled to compute the one global crop rect — a real
//  correctness invariant (miss the first/last page and a cover page or
//  back-matter page's different margins can throw off the whole
//  document's crop). Lives in js/ereaderCrop.js, not processor.js,
//  because it's pure page-index math with no worker/DOM dependency —
//  importing processor.js directly in Node fails (it pulls in
//  DOM-dependent modules like ui.js/feedback.js).
//
//  A real end-to-end Playwright run (preview → convert → download) was
//  done manually against a 7-page and a 556-page real PDF, on local
//  dist/ AND production — not wired into CI, matching this project's
//  standing decision (see [[test_coverage_plan]]) that real browser
//  automation stays a manual pre-ship check, not an automated gate.
//
//  Run: node tests/ereaderRunner.logic.test.js
// ============================================================

const { ereaderSampleIndices } = await import('../js/ereaderCrop.js');

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

console.log('\nereaderSampleIndices — global-crop sample selection:');

test('pageCount under the cap: every page is sampled, none skipped', () => {
  const result = ereaderSampleIndices(5, 12);
  expect(result.length).toBe(5);
  expect(JSON.stringify(result)).toBe(JSON.stringify([1, 2, 3, 4, 5]));
});

test('a 556-page book (real corpus file used in manual QA): capped at max, sorted, no duplicates', () => {
  const result = ereaderSampleIndices(556, 12);
  expect(result.length).toBe(12);
  const sorted = [...result].sort((a, b) => a - b);
  expect(JSON.stringify(result)).toBe(JSON.stringify(sorted));
  expect(new Set(result).size).toBe(result.length);
});

test('always includes the first page — a crop rect that ignores the cover/title page would misdetect margins', () => {
  const result = ereaderSampleIndices(556, 12);
  expect(result[0]).toBe(1);
});

test('always includes the last page — same reasoning for the back matter', () => {
  const result = ereaderSampleIndices(556, 12);
  expect(result[result.length - 1]).toBe(556);
});

test('every sampled index is a valid 1-indexed page number, never 0 or beyond pageCount', () => {
  const result = ereaderSampleIndices(556, 12);
  for (const i of result) {
    if (i < 1 || i > 556) throw new Error(`Index ${i} out of range for a 556-page document`);
  }
});

test('pageCount exactly at the cap: still every page, still no duplicates', () => {
  const result = ereaderSampleIndices(12, 12);
  expect(result.length).toBe(12);
  expect(new Set(result).size).toBe(12);
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
