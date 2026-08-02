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

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

const { buildIndex, search } = await import('../js/search.js');
const { TOOLS } = await import('../js/config.js');

const index = buildIndex(TOOLS, 'en');

function topKey(query, idx = index) {
  const results = search(query, idx);
  return results.length ? results[0].key : null;
}

// Loads a js/locales/<lc>.js file (a plain script that assigns to
// window.PDFREE_LOCALE as a side effect) in an isolated sandbox and
// returns its search_tags object, without polluting the real `window`
// or clobbering other locale files loaded the same way in this process.
function loadLocaleSearchTags(lc) {
  const source  = readFileSync(path.join(ROOT, `js/locales/${lc}.js`), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.window.PDFREE_LOCALE?.search_tags || {};
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

// ── Localized search (regression: non-English queries found nothing —
//    buildIndex only ever scanned English tags/names, see js/i18n.js's
//    EN.search_tags contract and js/locales/<lc>.js's search_tags) ──
console.log('\nLocalized search (RU, via real js/locales/ru.js data):');

const ruTags  = loadLocaleSearchTags('ru');
const ruIndex = buildIndex(TOOLS, 'ru', ruTags);

test('ru.js actually defines search_tags for draw-pdf (not just the {} scaffold)', () => {
  expect(Array.isArray(ruTags['draw-pdf']) && ruTags['draw-pdf'].length > 0).toBeTruthy();
});

test('exact Russian tag match finds draw-pdf', () => {
  expect(topKey('рисовать', ruIndex)).toBe('draw-pdf');
});

test('a typo of a Russian tag still finds draw-pdf (the reported bug)', () => {
  expect(topKey('рисовт', ruIndex)).toBe('draw-pdf');
});

test('Russian query for merge finds merge, not an unrelated tool', () => {
  expect(topKey('объединить', ruIndex)).toBe('merge');
});

test('English tags still work on a Russian-language index (bilingual fallback)', () => {
  expect(topKey('compress', ruIndex)).toBe('compress');
});

// ── Summary ───────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
