// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 PDFree Contributors

// ============================================================
//  tests/decryptPdf.logic.test.js
//
//  Pure-logic test for decryptPdf.js's passwordAttempts() and
//  encryptionRevision(): the forms Unlock tries a typed password in.
//
//  A password outside ASCII turns into bytes differently in each writer:
//  UTF-8 for AES-256, PDFDoc in qpdf/Acrobat-like writers, each character
//  truncated to a byte in our Protect (pdfEncrypt.js's _padPwd), "?" for
//  non-Latin-1 characters in LibreOffice, the system code page in old
//  Windows / WPS-style writers. Unlock took only the truncated form, so
//  every non-Latin password was "incorrect" (2026-10-30). The real files:
//  tests/fixtures/unlock, tests/e2e/unlock-unicode.e2e.mjs.
// ============================================================

import { passwordAttempts, encryptionRevision } from '../js/decryptPdf.js';

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

const hexes = attempts => attempts.slice(1).map(a => a[1].replace('--password=', ''));

console.log('\n🔓 decryptPdf — passwordAttempts / encryptionRevision:');

test('ASCII password: one run, as given (no change for the common case)', () => {
  expect(JSON.stringify(passwordAttempts('test123', 4))).toBe(JSON.stringify([['--password=test123']]));
  expect(JSON.stringify(passwordAttempts('test123', null))).toBe(JSON.stringify([['--password=test123']]));
});

test('AES-256 (R5/R6): UTF-8 only', () => {
  expect(passwordAttempts('密码测试', 6).length).toBe(1);
  expect(passwordAttempts('пароль', 5).length).toBe(1);
});

test('Cyrillic, older handler: as given, truncated (Protect), "?" (LibreOffice), then the code pages (GBK and Shift-JIS hold Cyrillic too)', () => {
  const a = passwordAttempts('парол', 3);
  expect(a[0][0]).toBe('--password=парол');
  expect(a.slice(1).every(x => x[0] === '--password-mode=hex-bytes')).toBe(true);
  // п=U+043F а=U+0430 р=U+0440 о=U+043E л=U+043B — the bytes _padPwd writes
  expect(hexes(a).join(' ')).toBe('3f30403e3b 3f3f3f3f3f a7e1a7d1a7e2a7e0a7dd 8481847084828480847c efe0f0eeeb');
});

test('Chinese: GBK bytes as Windows cp936 has them', () => {
  const h = hexes(passwordAttempts('密码测试', 4));
  if (!h.includes('c3dcc2ebb2e2cad4')) throw new Error(`no GBK form in ${h}`);
});

test('Japanese: Shift-JIS bytes as Windows cp932 has them', () => {
  const h = hexes(passwordAttempts('パスワード', 4));
  if (!h.includes('83708358838f815b8368')) throw new Error(`no Shift-JIS form in ${h}`);
});

test('unknown revision: every form tried; forms with the same bytes once', () => {
  const h = hexes(passwordAttempts('密码', null));
  expect(new Set(h).size).toBe(h.length);
  if (h.length < 3) throw new Error(`too few forms: ${h}`);
});

test('a character outside a code page drops that form only', () => {
  const h = hexes(passwordAttempts('пароль密码', 4));
  if (h.some(x => x.startsWith('efe0'))) throw new Error('CP1251 form for a password with Han in it');
});

test('encryptionRevision reads /R of the Standard handler, not a reference', () => {
  const pdf = s => new TextEncoder().encode(s);
  expect(encryptionRevision(pdf('trailer<</Encrypt 9 0 R>> 9 0 obj<</Filter/Standard/V 5/R 6/O<00>>>endobj'))).toBe(6);
  expect(encryptionRevision(pdf('9 0 obj<</R 7 0 R/Filter /Standard /V 2 /R 3>>endobj'))).toBe(3);
  expect(encryptionRevision(pdf('no encryption here'))).toBe(null);
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
