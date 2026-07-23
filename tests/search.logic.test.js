// ============================================================
//  tests/search.logic.test.js — Unit tests for js/search.js
//  Запуск: node tests/search.logic.test.js
//
//  Тестирует реальный модуль (не реимплементацию):
//  buildIndex, search — including typo-tolerant fuzzy matching.
// ============================================================

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

function expect(actual) {
  return {
    toBe:       (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy: ()  => { if (!actual) throw new Error(`Expected truthy, got ${actual}`); },
    toBeFalsy:  ()  => { if (actual)  throw new Error(`Expected falsy, got ${actual}`); },
  };
}

const { buildIndex, search } = await import('../js/search.js');
const { TOOLS } = await import('../js/config.js');

const index = buildIndex(TOOLS, 'en');

function topKey(query) {
  const results = search(query, index);
  return results.length ? results[0].key : null;
}

// ── Exact / substring matching (pre-existing behavior) ──────
console.log('\nExact and substring matching:');

test('exact tag match wins', () => {
  expect(topKey('excel')).toBe('pdf2excel');
});

test('name-prefix match', () => {
  expect(topKey('compress')).toBe('compress');
});

test('query under 3 chars returns no results', () => {
  expect(search('pd', index).length).toBe(0);
});

// ── Fuzzy typo tolerance (regression: "exel" found nothing) ─
console.log('\nFuzzy typo tolerance:');

test('"exel" (missing letter) still finds PDF to Excel', () => {
  expect(topKey('exel')).toBe('pdf2excel');
});

test('"excell" (extra letter) still finds PDF to Excel', () => {
  expect(topKey('excell')).toBe('pdf2excel');
});

test('"unlok" still finds Unlock PDF', () => {
  expect(topKey('unlok')).toBe('unlock');
});

test('"roate" still finds Rotate PDF', () => {
  expect(topKey('roate')).toBe('rotate');
});

test('"flaten" still finds Flatten PDF', () => {
  expect(topKey('flaten')).toBe('flatten');
});

test('a precise tag typo outranks a loose coincidental name typo', () => {
  // "redct" is 1 edit from the redact tool's own name/tag "redact",
  // but was previously also drifting toward unrelated tools whose
  // name merely happened to contain a short word within edit distance.
  expect(topKey('redct')).toBe('redact');
});

test('exact match still beats a fuzzy match (no regression in ranking)', () => {
  expect(topKey('watermark')).toBe('watermark');
});

test('nonsense query beyond typo tolerance returns nothing', () => {
  expect(topKey('xyzxyzxyz')).toBeFalsy();
});

// ── Summary ───────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
