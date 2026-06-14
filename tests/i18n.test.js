// SPDX-License-Identifier: AGPL-3.0-only
// Tests for js/i18n.js — t() and tp() translation functions.
// i18n.js reads window.PDFREE_LOCALE at import time, so the mock must be set first.

import { strict as assert } from 'assert';

global.window = {};   // no locale override → all strings fall back to EN

const { t, tp } = await import('../js/i18n.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try   { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

// ── t() ──────────────────────────────────────────────────────────

console.log('\nt():');

test('known key returns the EN string', () =>
  assert.equal(t('cancelled'), 'Processing cancelled'));

test('unknown key returns the key itself (safe fallback)', () =>
  assert.equal(t('__no_such_key__'), '__no_such_key__'));

test('interpolates a single {var}', () =>
  assert.equal(
    t('prog_rendering', { i: 3, n: 10 }),
    'Rendering page 3 of 10...'
  ));

test('missing variable becomes empty string (not undefined)', () =>
  assert.equal(
    t('prog_rendering', {}),
    'Rendering page  of ...'
  ));

test('extra variables beyond placeholders are ignored', () =>
  assert.equal(t('cancelled', { extra: 'x' }), 'Processing cancelled'));

test('interpolates multiple variables', () =>
  assert.equal(
    t('desc_merged', { total: 3, pages: 12, size: '1.2 MB' }),
    'Merged 3 files · 12 pages · 1.2 MB'
  ));

test('numeric variable 0 is coerced to "0" (not falsy-skipped)', () =>
  assert.equal(
    t('prog_rendering', { i: 0, n: 0 }),
    'Rendering page 0 of 0...'
  ));

test('variable in error_msg wraps correctly', () =>
  assert.equal(
    t('error_msg', { msg: 'File too large' }),
    'Error: File too large'
  ));

// ── tp() ─────────────────────────────────────────────────────────

console.log('\ntp():');

test('n=1 selects keyOne', () =>
  assert.equal(tp(1, 'word_page', 'word_pages'), 'page'));

test('n=2 selects keyMany', () =>
  assert.equal(tp(2, 'word_page', 'word_pages'), 'pages'));

test('n=0 selects keyMany (0 is not singular)', () =>
  assert.equal(tp(0, 'word_page', 'word_pages'), 'pages'));

test('n is injected as {n} in the translated string', () =>
  assert.equal(tp(3, 'split_info_page', 'split_info_pages'), '3 pages'));

test('n=1 with singular placeholder', () =>
  assert.equal(tp(1, 'split_info_page', 'split_info_pages'), '1 page'));

test('extra vars are passed through alongside n', () =>
  assert.equal(
    tp(2, 'skipped_files_one', 'skipped_files_many', { labels: 'a.pdf, b.pdf' }),
    '⚠️ 2 files skipped: a.pdf, b.pdf'
  ));

test('tp with unknown keys returns the key (same as t fallback)', () =>
  assert.equal(tp(1, '__k1__', '__k2__'), '__k1__'));

// ── Summary ───────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${total} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
