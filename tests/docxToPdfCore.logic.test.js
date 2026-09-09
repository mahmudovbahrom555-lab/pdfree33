// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 PDFree Contributors

// ============================================================
//  tests/docxToPdfCore.logic.test.js
//
//  Pure-logic test for docxToPdfCore.js's _normalizeBulletPrefix().
//  Copied verbatim from the source (same convention as
//  fillUI.logic.test.js) so it runs in plain Node without a DOM.
//
//  Real bug this guards against: Word's default bullet-list styles
//  set the ::before glyph via a Private-Use-Area codepoint from the
//  "Symbol"/"Wingdings" font (confirmed live: U+F0B7 for a plain
//  default bullet list, font-family "Symbol"). Emitted as plain text
//  with no font override, pdfmake's default font has no glyph for a
//  Symbol-font PUA codepoint — every bulleted list rendered a visible
//  "missing glyph" tofu box instead of a bullet.
//
//  Uses String.fromCodePoint(...) for every PUA/symbol codepoint
//  throughout this file (both the copied map and the test cases) —
//  deliberately avoids embedding literal Private-Use-Area characters
//  in source, since they're invisible/unverifiable in a normal editor.
// ============================================================

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function expect(actual) {
  return {
    toBe: (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
  };
}

const cp = String.fromCodePoint;

// ── Copied verbatim from js/docxToPdfCore.js (logic only; literal
//    characters replaced with fromCodePoint calls for source clarity —
//    the real file uses the literal glyphs, functionally identical) ──
const SYMBOL_BULLET_MAP = {
  0xf0b7: cp(0x2022), // Symbol "l" — the default Word bullet (bullet)
  0xf0a7: cp(0x25aa), // Wingdings solid square
  0xf0d8: cp(0x25b8), // Wingdings small right arrow
  0xf075: cp(0x25cb), // Wingdings open circle
  0xf0fc: cp(0x2713), // Wingdings check mark
};
function _normalizeBulletPrefix(str) {
  return Array.from(str).map(ch => {
    const codePoint = ch.codePointAt(0);
    if (SYMBOL_BULLET_MAP[codePoint]) return SYMBOL_BULLET_MAP[codePoint];
    if (codePoint >= 0xe000 && codePoint <= 0xf8ff) return cp(0x2022);
    return ch;
  }).join('');
}
// ────────────────────────────────────────────────────────────────

console.log('\n📄 docxToPdfCore — _normalizeBulletPrefix:');

test('Symbol-font default Word bullet (U+F0B7) maps to a real bullet (U+2022)', () => {
  expect(_normalizeBulletPrefix(cp(0xf0b7))).toBe(cp(0x2022));
});

test('Wingdings solid square (U+F0A7) maps to U+25AA, not left untranslated', () => {
  expect(_normalizeBulletPrefix(cp(0xf0a7))).toBe(cp(0x25aa));
});

test('an unmapped-but-still-Private-Use-Area codepoint falls back to a plain bullet, not a tofu box', () => {
  expect(_normalizeBulletPrefix(cp(0xe500))).toBe(cp(0x2022));
});

test('plain, non-PUA text passes through unchanged', () => {
  expect(_normalizeBulletPrefix('-')).toBe('-');
  expect(_normalizeBulletPrefix(cp(0x2022))).toBe(cp(0x2022));
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
