// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/analyticsEvent.test.js — real unit tests for
//  src/index.js's _classifyUserAgent/_dataPointFromEvent, the two
//  pure functions behind the 2026-08-20 Analytics Engine review
//  (device/browser capture, country capture, blob/index mapping).
//  Added specifically because the whole review that day had to
//  reverse-engineer blob1/blob2/blob3's real mapping from live
//  production data, after wrong assumptions produced a confidently-
//  wrong first read of the Rage Click data (blob1 was assumed to be
//  `target`, but it's ALWAYS locale) — this pins that mapping down
//  so it can't silently drift again.
//
//  Both functions are pure (no Workers-runtime dependency — no KV,
//  no Durable Objects, just plain string/object logic), so a real
//  import + Node's own assert works fine; no Miniflare needed.
//
//  Run: node tests/analyticsEvent.test.js
// ============================================================

import { _classifyUserAgent, _dataPointFromEvent } from '../src/index.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe:       (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toEqual:    (e) => { if (JSON.stringify(actual) !== JSON.stringify(e)) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
  };
}

console.log('\n_classifyUserAgent — device/browser bucketing:');

test('iPhone Safari → mobile/safari', () => {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  expect(_classifyUserAgent(ua)).toEqual({ device: 'mobile', browser: 'safari' });
});

test('Android phone Chrome → mobile/chrome', () => {
  const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
  expect(_classifyUserAgent(ua)).toEqual({ device: 'mobile', browser: 'chrome' });
});

test('Android tablet (no "Mobile" token) Chrome → tablet/chrome', () => {
  const ua = 'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
  expect(_classifyUserAgent(ua)).toEqual({ device: 'tablet', browser: 'chrome' });
});

test('iPad classic UA → tablet/safari', () => {
  const ua = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  expect(_classifyUserAgent(ua)).toEqual({ device: 'tablet', browser: 'safari' });
});

test('macOS Safari → desktop/safari', () => {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
  expect(_classifyUserAgent(ua)).toEqual({ device: 'desktop', browser: 'safari' });
});

test('Windows Chrome → desktop/chrome (Chrome UA also contains "Safari" — must not misclassify)', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
  expect(_classifyUserAgent(ua)).toEqual({ device: 'desktop', browser: 'chrome' });
});

test('Windows Edge → desktop/edge (Edge UA also contains "Chrome" and "Safari" — must not misclassify)', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0';
  expect(_classifyUserAgent(ua)).toEqual({ device: 'desktop', browser: 'edge' });
});

test('Windows Firefox → desktop/firefox', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0';
  expect(_classifyUserAgent(ua)).toEqual({ device: 'desktop', browser: 'firefox' });
});

test('Windows Opera → desktop/opera (Opera UA also contains "Chrome" and "Safari" — must not misclassify)', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 OPR/110.0.0.0';
  expect(_classifyUserAgent(ua)).toEqual({ device: 'desktop', browser: 'opera' });
});

test('empty/missing UA does not throw — falls back to desktop/other', () => {
  expect(_classifyUserAgent('')).toEqual({ device: 'desktop', browser: 'other' });
  expect(_classifyUserAgent(undefined)).toEqual({ device: 'desktop', browser: 'other' });
});

console.log('\n_dataPointFromEvent — blob/index mapping (pins the real layout, see 2026-08-20 review):');

test('locale/tool/session ALWAYS land in blob1/blob2/blob3, in that fixed order', () => {
  const dp = _dataPointFromEvent('Tool Success', { locale: 'en', tool: 'merge', session: 'abc-123' });
  expect(dp.blobs[0]).toBe('en');
  expect(dp.blobs[1]).toBe('merge');
  expect(dp.blobs[2]).toBe('abc-123');
});

test('an event with no `tool` prop (e.g. Rage Click) still reserves blob2 as empty — never shifts other fields left', () => {
  // This is the exact mistake that produced a wrong first read of the Rage
  // Click data during the 2026-08-20 review: assuming blob1 was `target`
  // when Rage Click has no `tool`, so blob1 is (as always) locale, and
  // `target` actually lands in blob4 as "target=...".
  const dp = _dataPointFromEvent('Rage Click', { locale: 'en', session: 'abc-123', target: '#mergeBtn' });
  expect(dp.blobs[0]).toBe('en');       // locale
  expect(dp.blobs[1]).toBe('');         // tool — absent, but the SLOT is still reserved
  expect(dp.blobs[2]).toBe('abc-123');  // session
  expect(dp.blobs[3]).toBe('target=#mergeBtn');
});

test('numeric-looking prop values go into doubles, not blobs', () => {
  const dp = _dataPointFromEvent('Homepage Scroll Depth', { locale: 'en', session: 's1', depth: '75' });
  expect(dp.doubles[0]).toBe(75);
  expect(dp.blobs.some(b => b.includes('depth'))).toBe(false);
});

test('index1 carries the event name', () => {
  const dp = _dataPointFromEvent('Quick Retry', { locale: 'en', tool: 'pdf2jpg', session: 's1' });
  expect(dp.indexes[0]).toBe('Quick Retry');
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
