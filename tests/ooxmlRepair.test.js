// tests/ooxmlRepair.test.js — joinSplitSurrogates: a character past U+FFFF
// whose two UTF-16 halves were UTF-8-encoded apart (CESU-8) is written back as
// its one 4-byte UTF-8 sequence; anything else is left byte for byte.
// The writers' own chunking is reproduced in the browser by
// tests/e2e/ooxml-surrogates.e2e.mjs.
//
// Run: node tests/ooxmlRepair.test.js

import { strict as assert } from 'assert';
import { joinSplitSurrogates } from '../js/ooxmlRepair.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
const enc = s => new TextEncoder().encode(s);
// "𝑠" (U+1D460 = D835 DC60) encoded half by half, as JSZip wrote it
const SPLIT = [0xED, 0xA0, 0xB5, 0xED, 0xB1, 0xA0];

test('a split pair becomes the one character it is', () => {
  const bytes = new Uint8Array([...enc('<w:t>('), ...SPLIT, ...enc(')</w:t>')]);
  const fixed = joinSplitSurrogates(bytes);
  assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(fixed), '<w:t>(𝑠)</w:t>');
});

test('valid UTF-8 — Han, Arabic, a properly encoded 𝑎 — is left alone (null: nothing to fix)', () => {
  assert.equal(joinSplitSurrogates(enc('中文 العربية 𝑎 plain')), null);
});

test('several split pairs in one part are all joined', () => {
  const bytes = new Uint8Array([...SPLIT, ...enc(' and '), ...SPLIT]);
  assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(joinSplitSurrogates(bytes)), '𝑠 and 𝑠');
});

test('a lone half with no partner is not guessed at', () => {
  const bytes = new Uint8Array([...enc('a'), 0xED, 0xA0, 0xB5, ...enc('b')]);
  assert.equal(joinSplitSurrogates(bytes), null);
});

console.log(`\n${'─'.repeat(40)}\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
process.exit(failed ? 1 : 0);
