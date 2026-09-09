// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 PDFree Contributors

// ============================================================
//  tests/decryptPdf.logic.test.js
//
//  Pure-logic test for decryptPdf.js's _toByteTruncatedPassword().
//
//  Real bug this guards against: a PDF encrypted with a non-ASCII
//  password (Cyrillic, Turkish, CJK, accented Latin) — correctly, by
//  our own Protect tool (see pdfEncrypt.js's _padPwd(), and
//  tests/worker.integration.test.js's Unicode-password tests) or by
//  any spec-compliant reader — could not be unlocked here even with
//  the exact correct password. The password was passed straight into
//  qpdf-wasm's argv, which Emscripten UTF-8-encodes; the classic PDF
//  security handler's key derivation instead expects each UTF-16 code
//  unit truncated to a single byte. Confirmed live before fixing: the
//  byte-truncated form of a Cyrillic password decrypted the file
//  correctly, the plain UTF-8 form was rejected as "incorrect
//  password" — the mirror-image of the Protect encoding bug, on the
//  decrypt side.
// ============================================================

import { _toByteTruncatedPassword } from '../js/decryptPdf.js';

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

console.log('\n🔓 decryptPdf — _toByteTruncatedPassword:');

test('ASCII password is byte-identical (no regression for the common case)', () => {
  expect(_toByteTruncatedPassword('test123')).toBe('test123');
});

test('Cyrillic password truncates each code unit to its low byte, matching pdfEncrypt.js\'s _padPwd', () => {
  // п=U+043F а=U+0430 р=U+0440 о=U+043E л=U+043B — same word/expected
  // bytes as tests/worker.integration.test.js's _padPwd test, confirming
  // encrypt-side and decrypt-side now agree on the same convention.
  const result = _toByteTruncatedPassword('парол');
  const codes = Array.from(result).map(c => c.charCodeAt(0));
  expect(codes.join(',')).toBe([0x3f, 0x30, 0x40, 0x3e, 0x3b].join(','));
});

test('empty password stays empty', () => {
  expect(_toByteTruncatedPassword('')).toBe('');
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
