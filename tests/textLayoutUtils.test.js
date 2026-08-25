// tests/textLayoutUtils.test.js — pure logic tests for js/textLayoutUtils.js,
// currently focused on joinHyphenatedLineEnd() (hyphen-orphan repair for
// pdf2md — see its own header comment for the full rationale). End-to-end
// coverage through the real pdf2md extraction pipeline lives in
// tests/pdf2md.test.js; this file is direct unit coverage of the decision
// function in isolation.
//
// Run: node tests/textLayoutUtils.test.js

import { strict as assert } from 'assert';
import { joinHyphenatedLineEnd } from '../js/textLayoutUtils.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

test('a soft line-wrap break is joined with the hyphen dropped', () => {
  const r = joinHyphenatedLineEnd('This word is informa-', 'tion continues here.');
  assert.ok(r, 'expected a join result, got null');
  assert.equal(r.hyphenKept, false);
  assert.equal(r.text, 'This word is information continues here.');
});

test('a known hard-hyphenated compound keeps its hyphen', () => {
  const r = joinHyphenatedLineEnd('a well-', 'known approach');
  assert.ok(r);
  assert.equal(r.hyphenKept, true);
  assert.equal(r.text, 'a well-known approach');
});

test('an ALL-CAPS stem (acronym) keeps its hyphen even when not in the dictionary', () => {
  const r = joinHyphenatedLineEnd('The system is NASA-', 'approved for launch.');
  assert.ok(r);
  assert.equal(r.hyphenKept, true);
  assert.equal(r.text, 'The system is NASA-approved for launch.');
});

test('a mixed-case stem NOT in the dictionary drops the hyphen (default: soft break)', () => {
  const r = joinHyphenatedLineEnd('a quasi-', 'experimental design');
  assert.ok(r);
  assert.equal(r.hyphenKept, false);
  assert.equal(r.text, 'a quasiexperimental design');
});

test('no hyphen at the end of the previous text -> null (not a candidate at all)', () => {
  assert.equal(joinHyphenatedLineEnd('This sentence ends normally.', 'Next sentence.'), null);
});

test('a hyphen followed by a CAPITALIZED next line -> null (new sentence/proper noun, not a broken word)', () => {
  assert.equal(joinHyphenatedLineEnd('Results were inconclusive-', 'Further study is needed.'), null);
});

test('a hyphen followed by a non-letter (digit, punctuation) -> null', () => {
  assert.equal(joinHyphenatedLineEnd('See figure-', '3 for details.'), null);
  assert.equal(joinHyphenatedLineEnd('End of clause-', '"quoted continuation"'), null);
});

test('a single-character stem -> null (too short to be a real word fragment)', () => {
  assert.equal(joinHyphenatedLineEnd('x-', 'ray imaging'), null);
});

test('URL/email-shaped text is never de-hyphenated even if it matches the stem/continuation shape', () => {
  assert.equal(joinHyphenatedLineEnd('Visit our website at example-', 'site.com for more.'), null);
  assert.equal(joinHyphenatedLineEnd('Contact john.doe-', 'test@example.com directly.'), null);
});

test('leading/trailing text around the matched word is preserved verbatim', () => {
  const r = joinHyphenatedLineEnd('  Prefix text informa-', 'tion, and a trailing clause.');
  assert.ok(r);
  assert.equal(r.text, '  Prefix text information, and a trailing clause.');
});

test('empty strings never throw and return null', () => {
  assert.equal(joinHyphenatedLineEnd('', ''), null);
  assert.equal(joinHyphenatedLineEnd('word-', ''), null);
  assert.equal(joinHyphenatedLineEnd('', 'word'), null);
});

test('a Cyrillic soft break is joined the same way as Latin', () => {
  const r = joinHyphenatedLineEnd('Это была насто-', 'ящая проблема.');
  assert.ok(r);
  assert.equal(r.hyphenKept, false);
  assert.equal(r.text, 'Это была настоящая проблема.');
});

const total = passed + failed;
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${total} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
