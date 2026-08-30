// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/redactNer.test.js — Unit tests for js/redactNer.js's
//  mergeNerTokens (pure token-merging logic).
//
//  detectEntitiesBatch itself needs a loaded transformers.js pipeline —
//  not Node-testable, verified via live Playwright instead (real
//  Xenova/bert-base-NER inference tested directly this session; see
//  scandoc-style verification discipline this project already follows
//  for its other client-side ML feature, js/formulaOcr.js).
//
//  Token fixtures below are taken verbatim from real model output
//  (Xenova/bert-base-NER), not invented — captured via a live Playwright
//  test run during development.
//
//  Run: node tests/redactNer.test.js
// ============================================================

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function expect(actual) {
  return {
    toEqual: (e) => {
      const a = JSON.stringify(actual), b = JSON.stringify(e);
      if (a !== b) throw new Error(`Expected ${b}, got ${a}`);
    },
    toBe: (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
  };
}

const { mergeNerTokens } = await import('../js/redactNer.js');

test('a simple two-token PERSON name merges with a space', () => {
  const tokens = [
    { entity: 'B-PER', score: 0.9996, index: 3, word: 'John' },
    { entity: 'I-PER', score: 0.9995, index: 4, word: 'Smith' },
  ];
  expect(mergeNerTokens(tokens)).toEqual([{ text: 'John Smith', type: 'PER', minScore: 0.9995 }]);
});

test('a LOCATION spanning two tokens merges correctly', () => {
  const tokens = [
    { entity: 'B-LOC', score: 0.9583, index: 33, word: 'Baker' },
    { entity: 'I-LOC', score: 0.9935, index: 34, word: 'Street' },
  ];
  expect(mergeNerTokens(tokens)).toEqual([{ text: 'Baker Street', type: 'LOC', minScore: 0.9583 }]);
});

test('two back-to-back distinct PERSON entities (both B-) stay separate', () => {
  const tokens = [
    { entity: 'B-PER', score: 0.999, index: 1, word: 'Alice' },
    { entity: 'B-PER', score: 0.998, index: 2, word: 'Bob' },
  ];
  expect(mergeNerTokens(tokens)).toEqual([
    { text: 'Alice', type: 'PER', minScore: 0.999 },
    { text: 'Bob', type: 'PER', minScore: 0.998 },
  ]);
});

test('a wordpiece continuation ("##...") glues with no space', () => {
  const tokens = [
    { entity: 'B-PER', score: 0.97, index: 1, word: 'Sch' },
    { entity: 'I-PER', score: 0.96, index: 2, word: '##midt' },
  ];
  expect(mergeNerTokens(tokens)).toEqual([{ text: 'Schmidt', type: 'PER', minScore: 0.96 }]);
});

test('ORG entities are dropped entirely, even at high confidence', () => {
  const tokens = [
    { entity: 'B-ORG', score: 0.99, index: 1, word: 'Acme' },
    { entity: 'I-ORG', score: 0.98, index: 2, word: 'Corp' },
  ];
  expect(mergeNerTokens(tokens)).toEqual([]);
});

test('low-confidence spans (below the 0.5 floor) are filtered out', () => {
  const tokens = [
    { entity: 'B-PER', score: 0.3, index: 1, word: 'Maybe' },
  ];
  expect(mergeNerTokens(tokens)).toEqual([]);
});

test('a real multi-entity sentence produces the expected 3 spans (verbatim model output)', () => {
  // Captured from a real live run: "Contact: John Smith, ... Address: 221B
  // Baker Street, London."
  const tokens = [
    { entity: 'B-PER', score: 0.9995858073234558, index: 3, word: 'John' },
    { entity: 'I-PER', score: 0.9995320439338684, index: 4, word: 'Smith' },
    { entity: 'B-LOC', score: 0.9582750201225281, index: 33, word: 'Baker' },
    { entity: 'I-LOC', score: 0.9934511780738831, index: 34, word: 'Street' },
    { entity: 'B-LOC', score: 0.9994263052940369, index: 36, word: 'London' },
  ];
  const result = mergeNerTokens(tokens);
  expect(result.length).toBe(3);
  expect(result[0].text).toBe('John Smith');
  expect(result[1].text).toBe('Baker Street');
  expect(result[2].text).toBe('London');
});

test('an empty token list returns an empty span list', () => {
  expect(mergeNerTokens([])).toEqual([]);
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
