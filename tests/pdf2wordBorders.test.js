// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/pdf2wordBorders.test.js — regression tests for
//  detectTableGrids() in js/pdf2wordBorders.js.
//
//  This module previously had ZERO test coverage. It gained a real bug
//  today: a real 19-page contract's page-18 tariff table (merged cells —
//  a product-name cell spanning 3 price rows) was rejected outright,
//  because the old algorithm required EVERY internal row/column divider
//  to span the table's FULL width/height, and a merged cell's divider is
//  legitimately absent for the rows/columns it merges across. Confirmed
//  by inspecting the real page's operator list directly: its outer
//  left/right border verticals spanned the whole frame, but internal
//  column dividers only existed as partial-length segments for some rows.
//
//  Fixed by finding the table's OUTER rectangle first (still validated as
//  strictly as before), then accepting ANY internal divider inside that
//  frame regardless of its length ("split-and-merge" — see the module's
//  header comment). That relaxation also required two new safety nets,
//  both covered below:
//    • a page's own crop-box outline can now itself pass the "frame"
//      check (its edges trivially span "the full width/height" — of the
//      page) and would otherwise swallow every real table on the page as
//      "internal dividers" of one giant page-sized grid — excluded via
//      an explicit page-dimension check.
//    • nested/overlapping candidate frames are resolved by preferring the
//      LARGEST: once the outer frame's full-height verticals exist, every
//      adjacent 2-row slice inside it also technically qualifies as its
//      own tiny "frame" on its own, and preferring the smallest would
//      shred one real table into dozens of fragments instead of finding it.
//
// Run: node tests/pdf2wordBorders.test.js

const { detectTableGrids } = await import('../js/pdf2wordBorders.js');

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

// ── Synthetic operator-list builder ─────────────────────────────────────
// Mirrors just enough of pdf.js's OperatorList shape for
// _extractSegments() in pdf2wordBorders.js: constructPath (fn 91) with
// P_RECT (19) for a full rectangle in one op, or P_MOVETO+P_LINETO
// (13,14) for a single axis-aligned line segment.
const OPS_PATH = 91;
const P_MOVETO = 13, P_LINETO = 14, P_RECT = 19;

function rectOp(x, y, w, h) {
  return { fn: OPS_PATH, args: [[P_RECT], [x, y, w, h], [x, x + w, y, y + h]] };
}
function lineOp(x1, y1, x2, y2) {
  return {
    fn: OPS_PATH,
    args: [[P_MOVETO, P_LINETO], [x1, y1, x2, y2],
      [Math.min(x1, x2), Math.max(x1, x2), Math.min(y1, y2), Math.max(y1, y2)]],
  };
}
function fakePage(ops, { width = 600, height = 800 } = {}) {
  return {
    getOperatorList: async () => ({
      fnArray:   ops.map(o => o.fn),
      argsArray: ops.map(o => o.args),
    }),
    getViewport: () => ({ width, height }),
  };
}

// ── Baseline: simple empty-template grid (pre-existing use case) ───────────
console.log('\ndetectTableGrids — simple empty-template grid (baseline, must still work):');

await test('a 3-row × 2-col grid with full-span internal dividers is detected', async () => {
  const ops = [
    rectOp(40, 40, 160, 120),   // outer: x 40–200, y 40–160
    lineOp(40, 80, 200, 80),    // internal row divider (full width)
    lineOp(40, 120, 200, 120),  // internal row divider (full width)
    lineOp(120, 40, 120, 160),  // internal column divider (full height)
  ];
  const grids = await detectTableGrids(fakePage(ops));
  expect(grids.length).toBe(1);
  expect(grids[0].rowCount).toBe(3);
  expect(grids[0].colCount).toBe(2);
});

// ── The actual bug: merged-cell table with a partial internal divider ──────
console.log('\ndetectTableGrids — merged-cell table (the real page-18 tariff table shape):');

await test('an internal column divider that only spans PART of the height is still ' +
     'accepted as a real column boundary (previously required full-height span)', async () => {
  const ops = [
    rectOp(40, 40, 200, 160),    // outer: x 40–240, y 40–200
    lineOp(40, 80, 240, 80),     // row divider (full width)
    lineOp(40, 120, 240, 120),   // row divider (full width)
    lineOp(40, 160, 240, 160),   // row divider (full width)
    // Column divider drawn ONLY for the bottom two rows (y 40–120) — the
    // top row's cell is merged across both columns, exactly like the real
    // contract's "Организованный рынок АО РФБ «Тошкент»*" cell spanning
    // multiple price rows. The OLD algorithm required this to span the
    // full 40–200 height and rejected the whole table when it didn't.
    lineOp(140, 40, 140, 120),
  ];
  const grids = await detectTableGrids(fakePage(ops));
  expect(grids.length).toBe(1);
  expect(grids[0].rowCount).toBe(4);
  expect(grids[0].colCount).toBe(2); // the partial divider still counts as a real column
});

// ── Safety net: the page's own border must not swallow everything ──────────
console.log('\ndetectTableGrids — page-border false positive:');

await test('a rectangle matching the full page size is NOT treated as a table, even ' +
     'with internal-looking dividers', async () => {
  const ops = [
    rectOp(0, 0, 600, 800),      // exactly the page's own crop-box outline
    lineOp(0, 300, 600, 300),
    lineOp(0, 500, 600, 500),
    lineOp(300, 0, 300, 800),
  ];
  const grids = await detectTableGrids(fakePage(ops, { width: 600, height: 800 }));
  expect(grids.length).toBe(0);
});

await test('a real table drawn well inside the page is still found once the page ' +
     'border itself is excluded', async () => {
  const ops = [
    rectOp(0, 0, 600, 800),      // page border — must be ignored
    rectOp(40, 40, 160, 120),    // real table, comfortably inside the page
    lineOp(40, 80, 200, 80),
    lineOp(40, 120, 200, 120),
    lineOp(120, 40, 120, 160),
  ];
  const grids = await detectTableGrids(fakePage(ops, { width: 600, height: 800 }));
  expect(grids.length).toBe(1);
  expect(grids[0].rowCount).toBe(3);
  expect(grids[0].colCount).toBe(2);
});

// ── Guard rails: too little to call a table ─────────────────────────────────
console.log('\ndetectTableGrids — guard rails:');

await test('no line segments at all → no grids', async () => {
  const grids = await detectTableGrids(fakePage([]));
  expect(grids.length).toBe(0);
});

await test('a plain unrelated box with no internal divider (1 row) is below MIN_ROWS', async () => {
  const ops = [rectOp(40, 40, 60, 30)];
  const grids = await detectTableGrids(fakePage(ops));
  expect(grids.length).toBe(0);
});

// ── Summary ──────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
