// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/drawPointer.test.js — Unit tests for js/drawPointer.js's
//  computeSmartGuides (pure geometry, no DOM).
//
//  Importing js/drawPointer.js in Node is safe: its module-level code only
//  declares state and functions — nothing DOM-touching runs until
//  initPointer()/initImageTool() etc. are actually called, which this test
//  never does.
//
//  Run: node tests/drawPointer.test.js
// ============================================================

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function expect(actual) {
  return {
    toEqual: (e) => {
      const a = JSON.stringify(actual), b = JSON.stringify(e);
      if (a !== b) throw new Error(`Expected ${b}, got ${a}`);
    },
  };
}

const { computeSmartGuides } = await import('../js/drawPointer.js');

test('shows a vertical guide when centered on the page horizontally', () => {
  const pageW = 600, pageH = 800;
  const dragged = { x0: 275, y0: 100, x1: 325, y1: 150 }; // center x = 300 = pageW/2
  const g = computeSmartGuides(dragged, [], pageW, pageH);
  expect(g.v).toEqual([300]);
  expect(g.h).toEqual([]);
});

test('shows a horizontal guide when centered on the page vertically', () => {
  const pageW = 600, pageH = 800;
  const dragged = { x0: 50, y0: 375, x1: 150, y1: 425 }; // center y = 400 = pageH/2
  const g = computeSmartGuides(dragged, [], pageW, pageH);
  expect(g.h).toEqual([400]);
});

test('no guides when nothing lines up within the snap threshold', () => {
  const g = computeSmartGuides({ x0: 10, y0: 10, x1: 60, y1: 60 }, [], 600, 800);
  expect(g.h).toEqual([]);
  expect(g.v).toEqual([]);
});

test('shows a vertical guide when left edges align with another layer', () => {
  const dragged = { x0: 100, y0: 200, x1: 180, y1: 260 };
  const other    = { x0: 100, y0: 400, x1: 200, y1: 450 }; // same x0 = 100
  const g = computeSmartGuides(dragged, [other], 900, 900); // page center (450,450) won't trigger
  if (!g.v.includes(100)) throw new Error(`Expected v guide at 100, got ${JSON.stringify(g.v)}`);
});

test('shows a horizontal guide when the dragged center aligns with another layer center', () => {
  const dragged = { x0: 100, y0: 190, x1: 160, y1: 210 }; // center y = 200
  const other    = { x0: 300, y0: 150, x1: 400, y1: 250 }; // center y = 200
  const g = computeSmartGuides(dragged, [other], 900, 900);
  if (!g.h.includes(200)) throw new Error(`Expected h guide at 200, got ${JSON.stringify(g.h)}`);
});

test('does not show a guide just outside the snap threshold', () => {
  const dragged = { x0: 100, y0: 200, x1: 180, y1: 260 };
  const other    = { x0: 110, y0: 400, x1: 210, y1: 450 }; // x0 differs by 10px > 6px threshold
  const g = computeSmartGuides(dragged, [other], 900, 900);
  if (g.v.includes(110)) throw new Error(`Should not snap at 10px away, got ${JSON.stringify(g.v)}`);
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
