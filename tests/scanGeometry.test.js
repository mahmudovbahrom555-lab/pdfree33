// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/scanGeometry.test.js — Unit tests for js/scanGeometry.js's
//  pure geometry math (orderQuadPoints, defaultInsetQuad).
//
//  detectDocumentQuad/warpToRect depend on a loaded OpenCV.js `cv`
//  global and a real <canvas> — not Node-testable (no polyfill, real
//  WASM runtime needed). Verified via real Playwright instead (see
//  the 2026-08-22 QA pass using Chromium's fake-camera flags).
//
//  Run: node tests/scanGeometry.test.js
// ============================================================

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe:       (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeCloseTo: (e, eps = 0.01) => { if (Math.abs(actual - e) > eps) throw new Error(`Expected ~${e}, got ${actual}`); },
  };
}

const { orderQuadPoints, defaultInsetQuad } = await import('../js/scanGeometry.js');

console.log('\norderQuadPoints:');

test('orders 4 unordered points into tl/tr/br/bl correctly', () => {
  // Deliberately scrambled input order, plus a slight irregularity
  // (not a perfect rectangle) — realistic for a hand-held photo.
  const scrambled = [
    { x: 90, y: 10 },  // actually top-right
    { x: 10, y: 12 },  // actually top-left
    { x: 95, y: 88 },  // actually bottom-right
    { x: 8,  y: 90 },  // actually bottom-left
  ];
  const q = orderQuadPoints(scrambled);
  expect(q.tl.x).toBe(10); expect(q.tl.y).toBe(12);
  expect(q.tr.x).toBe(90); expect(q.tr.y).toBe(10);
  expect(q.br.x).toBe(95); expect(q.br.y).toBe(88);
  expect(q.bl.x).toBe(8);  expect(q.bl.y).toBe(90);
});

test('a perfect square in already-correct order stays correct', () => {
  const square = [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
  ];
  const q = orderQuadPoints(square);
  expect(q.tl.x).toBe(0);   expect(q.tl.y).toBe(0);
  expect(q.tr.x).toBe(100); expect(q.tr.y).toBe(0);
  expect(q.br.x).toBe(100); expect(q.br.y).toBe(100);
  expect(q.bl.x).toBe(0);   expect(q.bl.y).toBe(100);
});

test('throws on anything other than exactly 4 points', () => {
  let threw = false;
  try { orderQuadPoints([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]); }
  catch { threw = true; }
  expect(threw).toBe(true);
});

console.log('\ndefaultInsetQuad:');

test('insets each edge by the given fraction of width/height', () => {
  const q = defaultInsetQuad(1000, 500, 0.1);
  expect(q.tl.x).toBe(100); expect(q.tl.y).toBe(50);
  expect(q.tr.x).toBe(900); expect(q.tr.y).toBe(50);
  expect(q.br.x).toBe(900); expect(q.br.y).toBe(450);
  expect(q.bl.x).toBe(100); expect(q.bl.y).toBe(450);
});

test('defaults to a 5% margin when none is given', () => {
  const q = defaultInsetQuad(200, 200);
  expect(q.tl.x).toBe(10); expect(q.tl.y).toBe(10);
  expect(q.br.x).toBe(190); expect(q.br.y).toBe(190);
});

test('the result is always inside the original bounds, never outside', () => {
  const q = defaultInsetQuad(640, 480, 0.05);
  for (const corner of [q.tl, q.tr, q.br, q.bl]) {
    if (corner.x < 0 || corner.x > 640 || corner.y < 0 || corner.y > 480) {
      throw new Error(`Corner ${JSON.stringify(corner)} is outside the 640x480 frame`);
    }
  }
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
