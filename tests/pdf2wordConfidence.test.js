// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/pdf2wordConfidence.test.js — regression tests for
//  _p2wConfidence() (js/processor.js), the pure function behind the
//  "confidence" badge shown in the pdf2word UI. Exported specifically
//  for this test — previously module-private with zero coverage.
//
//  Cases below match _p2wConfidence()'s actual penalty rules exactly
//  (js/processor.js:3484-3530), not invented thresholds:
//    scanned pages   — up to -50, scaled by fraction of pages
//    math formulas   — mathChars/totalChars > 0.03 -> -25
//    small fonts     — medianFontSize < 9 -> -10
//    heavy RTL       — rtlLines/totalLines > 0.3 -> -10
//    dense visuals   — totalInlineVisuals > 5 -> -5
//  level: >=80 'high', >=55 'medium', else 'low'
//
// Run: node tests/pdf2wordConfidence.test.js
//
// js/processor.js eagerly touches window/document/Worker at module-load
// time (a real, non-test-specific worker-readiness pattern, not something
// to change) — minimal stubs let it import cleanly under plain Node.
global.window = { PDFREE_LOCALE: {} };
global.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add(){}, remove(){}, contains(){ return false; } }, appendChild(){}, removeChild(){}, setAttribute(){} }),
  body: { appendChild(){}, removeChild(){} },
};
global.Worker = class { postMessage(){} terminate(){} addEventListener(){} };

const { _p2wConfidence } = await import('../js/processor.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe: (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeGreaterThanOrEqual: (e) => { if (!(actual >= e)) throw new Error(`Expected ${actual} >= ${e}`); },
  };
}

/** Baseline "clean" stats — no penalties should apply. */
function baseCs(overrides = {}) {
  return {
    totalPages: 3, totalTables: 0, totalGapVisuals: 0, totalInlineVisuals: 0,
    fullPageFallbacks: 0, totalChars: 1000, mathChars: 0, totalLines: 100, rtlLines: 0,
    ...overrides,
  };
}

console.log('\n_p2wConfidence — clean document:');

test('clean 3-page text document scores 100, level high, no warnings', () => {
  const r = _p2wConfidence(baseCs(), 12);
  expect(r.score).toBe(100);
  expect(r.level).toBe('high');
  expect(r.warnings.length).toBe(0);
  expect(r.detected[0]).toBe('3 pages');
});

test('singular page count uses "1 page" not "1 pages"', () => {
  const r = _p2wConfidence(baseCs({ totalPages: 1 }), 12);
  expect(r.detected[0]).toBe('1 page');
});

console.log('\n_p2wConfidence — individual penalties:');

test('scanned pages: all pages are fallback images -> capped at -50', () => {
  const r = _p2wConfidence(baseCs({ totalPages: 4, fullPageFallbacks: 4 }), 12);
  // (4/4)*60 = 60, capped at 50
  expect(r.score).toBe(50);
  expect(r.warnings.includes('Scanned pages — text layer missing')).toBe(true);
});

test('scanned pages: partial fallback scales proportionally, not capped', () => {
  const r = _p2wConfidence(baseCs({ totalPages: 10, fullPageFallbacks: 1 }), 12);
  // (1/10)*60 = 6, rounded
  expect(r.score).toBe(94);
});

test('math formulas: >3% math/Greek chars triggers exactly -25', () => {
  const r = _p2wConfidence(baseCs({ totalChars: 1000, mathChars: 31 }), 12);
  expect(r.score).toBe(75);
  expect(r.warnings.includes('Mathematical formulas may not convert accurately')).toBe(true);
});

test('math formulas: exactly at the 3% boundary does NOT trigger (strictly greater-than)', () => {
  const r = _p2wConfidence(baseCs({ totalChars: 1000, mathChars: 30 }), 12);
  expect(r.score).toBe(100);
});

test('small median font (<9pt) triggers exactly -10', () => {
  const r = _p2wConfidence(baseCs(), 8.9);
  expect(r.score).toBe(90);
  expect(r.warnings.includes('Small fonts — text grouping may be imprecise')).toBe(true);
});

test('median font exactly at 9pt does NOT trigger the small-font penalty', () => {
  const r = _p2wConfidence(baseCs(), 9);
  expect(r.score).toBe(100);
});

test('heavy RTL (>30% of lines) triggers exactly -10', () => {
  const r = _p2wConfidence(baseCs({ totalLines: 100, rtlLines: 31 }), 12);
  expect(r.score).toBe(90);
  expect(r.warnings.includes('Right-to-left text — layout may vary in Word')).toBe(true);
});

test('RTL exactly at the 30% boundary does NOT trigger (strictly greater-than)', () => {
  const r = _p2wConfidence(baseCs({ totalLines: 100, rtlLines: 30 }), 12);
  expect(r.score).toBe(100);
});

test('dense inline visuals (>5) triggers exactly -5', () => {
  const r = _p2wConfidence(baseCs({ totalInlineVisuals: 6 }), 12);
  expect(r.score).toBe(95);
  expect(r.warnings.includes('Dense visual content — some elements may shift')).toBe(true);
});

test('exactly 5 inline visuals does NOT trigger the dense-visuals penalty', () => {
  const r = _p2wConfidence(baseCs({ totalInlineVisuals: 5 }), 12);
  expect(r.score).toBe(100);
});

console.log('\n_p2wConfidence — combined penalties and level thresholds:');

test('multiple penalties stack additively', () => {
  // small font (-10) + heavy RTL (-10) + dense visuals (-5) = -25
  const r = _p2wConfidence(baseCs({ totalLines: 100, rtlLines: 40, totalInlineVisuals: 8 }), 8);
  expect(r.score).toBe(75);
  expect(r.warnings.length).toBe(3);
});

test('score floors at 0, never goes negative', () => {
  const r = _p2wConfidence(baseCs({
    totalPages: 5, fullPageFallbacks: 5,       // -50 (capped)
    totalChars: 1000, mathChars: 500,           // -25
    totalLines: 100, rtlLines: 90,              // -10
    totalInlineVisuals: 20,                     // -5
  }), 5); // -10 for small font too
  expect(r.score).toBe(0);
  expect(r.level).toBe('low');
});

test('level boundary: score 80 is "high"', () => {
  // fullPageFallbacks 1/3 of totalPages -> (1/3)*60 = 20 exactly -> 100-20=80
  const r = _p2wConfidence(baseCs({ totalPages: 3, fullPageFallbacks: 1 }), 12);
  expect(r.score).toBe(80);
  expect(r.level).toBe('high');
});

test('level boundary: score 79 is "medium"', () => {
  // (1/3)*60=20 -> 80 is high; add the -5 dense-visual penalty to land on 75... need 79 exactly.
  // Easier: totalPages=100, fullPageFallbacks=35 -> (35/100)*60=21 -> 79.
  const r = _p2wConfidence(baseCs({ totalPages: 100, fullPageFallbacks: 35 }), 12);
  expect(r.score).toBe(79);
  expect(r.level).toBe('medium');
});

test('level boundary: score 55 is "medium"', () => {
  // (75/100)*60 = 45 -> 100-45=55
  const r = _p2wConfidence(baseCs({ totalPages: 100, fullPageFallbacks: 75 }), 12);
  expect(r.score).toBe(55);
  expect(r.level).toBe('medium');
});

test('level boundary: score 54 is "low"', () => {
  // (77/100)*60 = 46.2 -> round(46.2)=46 -> 100-46=54
  const r = _p2wConfidence(baseCs({ totalPages: 100, fullPageFallbacks: 77 }), 12);
  expect(r.score).toBe(54);
  expect(r.level).toBe('low');
});

test('detected list reports table and visual counts when present', () => {
  const r = _p2wConfidence(baseCs({ totalTables: 2, totalGapVisuals: 1, totalInlineVisuals: 2 }), 12);
  expect(r.detected.includes('2 tables')).toBe(true);
  expect(r.detected.includes('3 diagrams/images')).toBe(true);
});

// ── Summary ──────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
