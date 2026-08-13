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
//  A second real bug was found in a follow-up round of synthetic-PDF
//  testing (a German sales report with a merged region column): once a
//  grid can hold real, densely-populated data (not just an empty
//  template's header row, the ONLY case _assignLineToGridCols() used to
//  see), the ±4px matching slack in _assignLineToGridCols() (processor.js)
//  turned out to be big enough to misassign left-aligned cell text back
//  into the PREVIOUS column when it started only ~3px past its own
//  column's divider — a normal amount of cell padding. Fixed by shrinking
//  the slack to ±2px (GRID_SLACK in processor.js), matching the actual
//  worst-case rounding error from colXs's own 4px coordinate snapping.
//
//  A third real bug was found via scripts/pdf2word_capability_map.mjs's
//  Section 5.1 table-structure measurement: on a real 3-row/3-col table
//  with a compact ~12px row height and one merged cell, the merged column
//  divider's segments (present for 2 of 3 rows, ~12px each) were each
//  individually SHORTER than INTERNAL_MIN_OVERLAP (20px) — the old
//  `.some(...)` check required ANY ONE segment to independently clear that
//  floor, so the entire divider was dropped, silently collapsing 3
//  detected columns to 2 and merging two UNRELATED cells' text together
//  ("Header"+"Q1" as one string) instead of just losing the one cell that
//  was actually merged. Fixed by summing every segment's overlap instead
//  of requiring one to clear the floor alone. The same capability-map run
//  also showed there was no real gridSpan (merged-cell) EMISSION at all —
//  a merged source cell just became one cell with text plus an empty
//  neighbor, not a real spanning cell — so `colDividers`
//  (js/pdf2wordBorders.js) and `_activeDividersForY`/
//  `_groupGridCellsWithSpans` (js/processor.js) were added to detect,
//  per row, which internal dividers are genuinely absent and emit a real
//  docx `columnSpan` for that row's cell.
//
// Run: node tests/pdf2wordBorders.test.js

// processor.js touches Worker/document at module load time (it's built for
// the browser) — same minimal stub pdf2excel.logic.test.js uses.
global.document = {
  documentElement: { lang: 'en' },
  getElementById:  () => null,
  querySelector:   () => null,
  addEventListener: () => {},
  createElement:   () => ({ style: {}, setAttribute() {}, appendChild() {} }),
};
global.window    = globalThis;
global.Worker    = class { postMessage() {} terminate() {} addEventListener() {} };

const { detectTableGrids } = await import('../js/pdf2wordBorders.js');
const { _assignLineToGridCols, _activeDividersForY, _groupGridCellsWithSpans } = await import('../js/processor.js');

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

// ── A third real bug, found via scripts/pdf2word_capability_map.mjs: a
// divider broken into segments each individually SHORTER than
// INTERNAL_MIN_OVERLAP (20px) was dropped entirely, even though the
// divider is clearly real. A real 3-row/3-col table with one merged cell
// and a compact ~12px row height had its column divider present for 2 of
// 3 rows (each segment ~12px, below the old `.some()` floor) — so the
// WHOLE divider vanished, collapsing 3 columns to 2 and silently merging
// two UNRELATED cells' text together ("Header"+"Q1" as one cell) instead
// of just losing the one cell that was actually merged. Fixed by summing
// all of a divider's segment overlaps instead of requiring any single one
// to independently clear the floor.
await test('a column divider broken into multiple SHORT segments (each below ' +
     'INTERNAL_MIN_OVERLAP alone, but summing above it) is still detected — ' +
     'does not collapse 3 columns into 2', async () => {
  const ops = [
    rectOp(40, 704, 200, 48),      // outer: x 40–240, y 704–752 (3 rows, 16px each)
    lineOp(40, 720, 240, 720),     // row divider (full width)
    lineOp(40, 736, 240, 736),     // row divider (full width)
    // Column divider present for rows 1 and 3 (each a 16px segment,
    // individually under the 20px floor) but ABSENT for row 2 (the merged
    // row) — exactly the real page's shape.
    lineOp(140, 736, 140, 752),    // row 1: y 736–752 (16px)
    lineOp(140, 704, 140, 720),    // row 3: y 704–720 (16px)
  ];
  const grids = await detectTableGrids(fakePage(ops));
  expect(grids.length).toBe(1);
  expect(grids[0].rowCount).toBe(3);
  expect(grids[0].colCount).toBe(2); // divider correctly found despite no single segment clearing the old floor
});

// ── colDividers / _activeDividersForY / _groupGridCellsWithSpans: gridSpan ──
console.log('\ndetectTableGrids/_activeDividersForY — gridSpan (merged-cell) emission:');

await test('colDividers exposes the internal divider\'s real Y-spans, not just its X', async () => {
  const ops = [
    rectOp(40, 704, 200, 48),
    lineOp(40, 716, 240, 716),
    lineOp(40, 728, 240, 728),
    lineOp(40, 740, 240, 740),
    lineOp(140, 740, 140, 752),
    lineOp(140, 704, 140, 716),
  ];
  const grids = await detectTableGrids(fakePage(ops));
  expect(grids[0].colDividers.length).toBe(1);
  expect(grids[0].colDividers[0].x).toBe(140);
  expect(grids[0].colDividers[0].spans.length).toBe(2); // the two separate row segments, not merged into one
});

await test('_activeDividersForY: a row whose Y falls in the merged band reports the divider inactive', () => {
  const grid = {
    rowYs: [752, 740, 728, 716, 704],           // 3 body rows, top row is the merged one
    colDividers: [{ x: 140, spans: [[704, 716], [740, 752]] }], // present for rows 1 & 3, absent for row 2
  };
  expect(_activeDividersForY(grid, 746)[0]).toBe(true);  // row 1 (740–752): divider present
  expect(_activeDividersForY(grid, 734)[0]).toBe(false); // row 2 (728–740): divider absent — merged row
  expect(_activeDividersForY(grid, 710)[0]).toBe(true);  // row 3 (704–716): divider present
});

await test('_groupGridCellsWithSpans merges cells across an inactive divider into one spanning cell', () => {
  // 3 raw per-column cells (as _assignLineToGridCols would produce for a
  // 3-column grid) with the middle one empty — no text item fell there,
  // since the merged cell's text was assigned to column 0.
  const grouped = _groupGridCellsWithSpans(['Merged Region', '', 'Note'], [false, true]);
  expect(grouped.length).toBe(2);
  expect(grouped[0].text).toBe('Merged Region');
  expect(grouped[0].span).toBe(2);
  expect(grouped[1].text).toBe('Note');
  expect(grouped[1].span).toBe(1);
});

await test('_groupGridCellsWithSpans leaves an ordinary fully-divided row untouched (span 1 everywhere)', () => {
  const grouped = _groupGridCellsWithSpans(['Header', 'Q1', 'Q2'], [true, true]);
  expect(grouped.length).toBe(3);
  for (const g of grouped) expect(g.span).toBe(1);
  expect(grouped.map(g => g.text).join('|')).toBe('Header|Q1|Q2');
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

// ── _assignLineToGridCols: real bug found via a German merged-report fixture ──
console.log('\n_assignLineToGridCols — column-boundary slack:');

await test('left-aligned text starting just past its OWN column divider stays in ' +
     'that column, not the previous one (real bug: "Kategorie" drawn 3px past a ' +
     'divider at x=164 was misassigned back into the x=72-164 column)', () => {
  const colXs = [72, 164, 272, 352, 444];
  const items = [
    { x: 77,  str: 'Region' },      // 5px past the x=72 divider — column 0
    { x: 167, str: 'Kategorie' },   // 3px past the x=164 divider — column 1
    { x: 277, str: 'Menge' },       // column 2
    { x: 357, str: 'Umsatz' },      // column 3
  ];
  const cells = _assignLineToGridCols(items, colXs);
  expect(cells.length).toBe(4);
  expect(cells[0]).toBe('Region');
  expect(cells[1]).toBe('Kategorie');
  expect(cells[2]).toBe('Menge');
  expect(cells[3]).toBe('Umsatz');
});

await test('an item exactly on a boundary still resolves to a single column (no throw, no dupe)', () => {
  const colXs = [0, 100, 200];
  const cells = _assignLineToGridCols([{ x: 100, str: 'X' }], colXs);
  expect(cells.length).toBe(2);
  expect(cells[0] + cells[1]).toBe('X'); // appears in exactly one cell
});

// ── Summary ──────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
