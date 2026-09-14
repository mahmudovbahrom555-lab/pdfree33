// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/cacheControl.logic.test.js — real unit + integration tests for
//  src/index.js's _cacheControlFor() and its wiring into the Worker's
//  fetch handler.
//
//  Context: env.ASSETS.fetch() (Cloudflare's Workers Assets binding) serves
//  EVERY static file with `Cache-Control: public, max-age=31536000,
//  immutable` by default — confirmed directly against production —
//  regardless of whether the URL carries this project's own `?v=<hash>`
//  cache-busting query param. scripts/build.py's _inject_hashes() only
//  rewrites <script src>/<link href> attributes inside generated HTML, so
//  ~15 first-party Worker files (worker.js, mergeWorker.js, pdfEncrypt.js,
//  etc. — referenced via `new Worker(new URL(...))` or `importScripts(...)`
//  from inside .js source, never HTML) never get a cache-busting param at
//  all. Left unfixed, an already-visited browser would cache a stale copy
//  of one of these files for a full year past any future deploy that
//  changes its content — see memory staged_rollout_deploy_2026_09 for the
//  full discovery trail.
//
//  _cacheControlFor() mirrors selfhost/assets.js's already-tested
//  cacheControlFor(pathname, hasVersionQuery) (see tests/selfhost-server.test.js's
//  own 3 Cache-Control assertions for that reference implementation),
//  keyed off the response's content-type instead of a resolved file path.
//
//  Pure function tests need no Workers runtime; the integration test stubs
//  a minimal env.ASSETS to prove the fetch handler actually wires it in,
//  not just that the function is correct in isolation.
//
//  Run: node tests/cacheControl.logic.test.js
// ============================================================

import { _cacheControlFor } from '../src/index.js';
import worker from '../src/index.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe: (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
  };
}

console.log('\n_cacheControlFor — un-versioned worker/vendor JS cache-staleness fix:');

await test('HTML content-type gets no-cache, regardless of a version query param', () => {
  expect(_cacheControlFor('text/html; charset=utf-8', true)).toBe('no-cache');
  expect(_cacheControlFor('text/html; charset=utf-8', false)).toBe('no-cache');
});

await test('non-HTML with a version query param gets the long immutable cache', () => {
  expect(_cacheControlFor('text/javascript', true)).toBe('public, max-age=31536000, immutable');
});

await test('non-HTML with NO version query param gets a short cache, not immutable', () => {
  expect(_cacheControlFor('text/javascript', false)).toBe('public, max-age=3600');
});

await test('missing/empty content-type is treated as non-HTML', () => {
  expect(_cacheControlFor(null, false)).toBe('public, max-age=3600');
  expect(_cacheControlFor('', true)).toBe('public, max-age=31536000, immutable');
});

// ── Integration: prove the fetch handler actually wires this in ────────
function stubEnv(contentType) {
  return {
    ASSETS: {
      fetch: async () => new Response('stub body', { status: 200, headers: { 'content-type': contentType } }),
    },
  };
}

await test('a bare worker-file request (no ?v=) comes back with a short cache, not immutable', async () => {
  const req = new Request('https://pdfree.io/js/mergeWorker.js');
  const res = await worker.fetch(req, stubEnv('text/javascript'));
  expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
});

await test('a versioned request (?v=) still comes back immutable, unchanged from today', async () => {
  const req = new Request('https://pdfree.io/js/app.js?v=abc123');
  const res = await worker.fetch(req, stubEnv('text/javascript'));
  expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
});

await test('a tool page (HTML) still comes back no-cache, unchanged from today', async () => {
  const req = new Request('https://pdfree.io/merge-pdf/');
  const res = await worker.fetch(req, stubEnv('text/html; charset=utf-8'));
  expect(res.headers.get('Cache-Control')).toBe('no-cache');
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
