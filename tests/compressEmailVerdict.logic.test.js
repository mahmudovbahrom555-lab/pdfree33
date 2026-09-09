// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/compressEmailVerdict.logic.test.js — regression coverage for
//  compressUI.js's renderEmailVerdict() bucket thresholds. Gmail's 25MB
//  and Outlook's 20MB caps apply to the base64-ENCODED attachment size
//  (confirmed at support.google.com/mail/answer/6584), which inflates
//  raw file size by 4/3. The original code compared raw bytes directly
//  against 20/25MB, so a ~24.9MB raw file showed a green "fits Gmail"
//  verdict while actually encoding to ~33MB and getting silently
//  converted to a Drive link instead of attaching.
//
//  Run: node tests/compressEmailVerdict.logic.test.js
// ============================================================

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

// Copied verbatim (bucket-selection logic only) from js/compressUI.js's
// renderEmailVerdict(), per this project's no-DOM logic-test convention.
function _emailVerdictBucket(compressedSize) {
  const mb            = compressedSize / (1024 * 1024);
  const outlookSafeMb = 20 * 3 / 4; // 15
  const gmailSafeMb   = 25 * 3 / 4; // 18.75
  if (mb < outlookSafeMb) return 'ok';
  if (mb < gmailSafeMb) return 'warn_outlook';
  return 'warn_gmail';
}

console.log('\ncompress-email — verdict thresholds account for base64 encoding overhead:');

test('14 MB (well under Outlook-safe raw threshold) → ok', () => {
  expect(_emailVerdictBucket(14 * 1024 * 1024)).toBe('ok');
});

test('19 MB raw (would encode to ~25.3MB, over Gmail) → warn_gmail, not ok', () => {
  // This is the exact false-positive the old 20MB/25MB raw thresholds produced.
  expect(_emailVerdictBucket(19 * 1024 * 1024)).toBe('warn_gmail');
});

test('16 MB raw (encodes to ~21.3MB — over Outlook, under Gmail) → warn_outlook', () => {
  expect(_emailVerdictBucket(16 * 1024 * 1024)).toBe('warn_outlook');
});

test('18.75 MB boundary (encodes to exactly 25MB) → warn_gmail, not ok (conservative)', () => {
  expect(_emailVerdictBucket(18.75 * 1024 * 1024)).toBe('warn_gmail');
});

test('30 MB (well over every real limit) → warn_gmail', () => {
  expect(_emailVerdictBucket(30 * 1024 * 1024)).toBe('warn_gmail');
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
