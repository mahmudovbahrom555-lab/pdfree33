// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/pdf2wordColumns.test.js — regression tests for
//  detectColumnRegions()/lineRegionIndex()/pageIsRtl() in
//  js/pdf2wordColumns.js, and _splitCrossColumnLines() in js/processor.js
//  (which consumes them — tested together since the latter has no meaning
//  without the former).
//
//  Positive fixtures use left-edge X positions and per-column line counts
//  DERIVED FROM REAL MEASUREMENTS (tests/fixtures/columns/*.pdf, page 2 of
//  each, extracted via pdf.js during the column-aware-reading-order
//  planning session — see tests/fixtures/columns/SOURCES.md), not invented:
//    2608.11433: col1~54 (41 lines), col2~321 (20 lines)
//    2608.11441: col1~71 (41 lines), col2~305 (14 lines)
//    2608.11629: col1~59 (59 lines), col2~315 (22 lines)
//    2608.11694: col1~75 (50 lines), col2~307 (12 lines)
//    2608.11947: col1~71 (50 lines), col2~306 (25 lines)
//  Column gutter (~200-250pt on a 595-612pt page) is what makes the
//  TOLERANCE=40 clustering constant safe — each column's own internal
//  spread (indentation, footnotes) measured well under 40pt in every case.
//
//  _splitCrossColumnLines() exists because of a real finding made while
//  building the end-to-end column-reading-order tests: _p2wBuildPageData's
//  Y-proximity line-grouping has no concept of columns, and for a genuine
//  2-column page both columns commonly land at near-identical Y per row
//  (same font/line-height page-wide) — measured directly against the 5 real
//  papers above: 70-85% of "lines" held items from BOTH columns merged into
//  one object. Without splitting those back apart before _p2wBuildParagraphs
//  ever sees them, column-aware dispatch has nothing meaningful left to
//  split — a merged line routes whole to one column, corrupting both.
//
// Run: node tests/pdf2wordColumns.test.js

const { detectColumnRegions, lineRegionIndex, pageIsRtl } = await import('../js/pdf2wordColumns.js');

// processor.js touches Worker/document at module load time (it's built for
// the browser) — same minimal stub pdf2wordBorders.test.js/
// pdf2excel.logic.test.js use.
global.document = {
  documentElement: { lang: 'en' },
  getElementById:  () => null,
  querySelector:   () => null,
  addEventListener: () => {},
  createElement:   () => ({ style: {}, setAttribute() {}, appendChild() {} }),
};
global.window = globalThis;
global.Worker = class { postMessage() {} terminate() {} addEventListener() {} };
const { _splitCrossColumnLines } = await import('../js/processor.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe: (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeNull: () => { if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`); },
  };
}

// Builds a synthetic page of `lines`, one line per Y step, with `count`
// lines whose first item sits at `leftX` — matching _p2wBuildPageData's
// {y, items:[{x,...}]} shape closely enough for detectColumnRegions, which
// only reads line.items[0].x and line.y.
function mkColumn(leftX, count, yStart, yStep = 12, jitter = 0) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const x = leftX + (jitter ? (i % 3) * jitter : 0); // small realistic indentation variance
    out.push({ y: yStart - i * yStep, rtl: false, items: [{ x, str: 'x' }] });
  }
  return out;
}

console.log('\ndetectColumnRegions — real-data-shaped 2-column pages:');

test('2608.11433 shape (col1~54 x41, col2~321 x20) is detected as 2 columns', () => {
  const lines = [...mkColumn(54, 41, 750, 12, 15), ...mkColumn(321, 20, 750, 24)];
  const regions = detectColumnRegions(lines, 612);
  expect(regions === null).toBe(false);
  expect(regions.length).toBe(2);
});

test('2608.11629 shape (col1~59 x59, col2~315 x22) is detected as 2 columns', () => {
  const lines = [...mkColumn(59, 59, 758, 12, 10), ...mkColumn(315, 22, 758, 32)];
  const regions = detectColumnRegions(lines, 595);
  expect(regions === null).toBe(false);
  expect(regions.length).toBe(2);
});

test('detected regions correctly bucket a mid-column-1 point and a mid-column-2 point', () => {
  const lines = [...mkColumn(71, 41, 760, 12, 10), ...mkColumn(305, 14, 760, 35)];
  const regions = detectColumnRegions(lines, 595);
  expect(lineRegionIndex({ items: [{ x: 90 }] }, regions)).toBe(0);
  expect(lineRegionIndex({ items: [{ x: 320 }] }, regions)).toBe(1);
});

console.log('\ndetectColumnRegions — Y-disjoint extra cluster is merged into its neighbor, not a whole-page rejection:');

// Real shape found on a real arXiv paper (Atlas_DR's md_corpus/
// 002-two-column-paper, page 1): the main left column (x≈54) spans the
// lower/middle of the page; a differently-indented block (x≈119 — e.g. an
// abstract paragraph with its own margin) sits ABOVE it, Y-disjoint from
// it; the real right column (x≈318) spans a Y range that overlaps the
// COMBINED (merged) left-side range almost perfectly. Before this fix,
// detectColumnRegions rejected the whole page the moment it compared the
// FIRST adjacent x-pair (54 vs 119, which don't Y-overlap) — even though
// the true 54/318 pair is a clean 2-column match.
test('a real-shaped 3-cluster page (main column + Y-disjoint indent-shifted block + real second column) still detects 2 columns', () => {
  const colMain  = mkColumn(54, 30, 468, 12);   // Y 120-468 (lower/mid page)
  const colIndent = mkColumn(119, 20, 760, 12); // Y 532-760 (upper page, Y-disjoint from colMain)
  const colRight = mkColumn(318, 32, 490, 12);  // Y 118-490 (overlaps colMain's combined range)
  const regions = detectColumnRegions([...colMain, ...colIndent, ...colRight], 612);
  expect(regions === null).toBe(false);
  expect(regions.length).toBe(2);
});

test('a genuine 3-column layout (all three Y-overlapping) still correctly detects 3 columns, not wrongly merged', () => {
  const lines = [...mkColumn(50, 15, 760, 12), ...mkColumn(230, 15, 760, 12), ...mkColumn(410, 15, 760, 12)];
  const regions = detectColumnRegions(lines, 612);
  expect(regions === null).toBe(false);
  expect(regions.length).toBe(3);
});

console.log('\ndetectColumnRegions — must return null (prefer false negatives):');

test('a single-column page with normal indentation variance is NOT split', () => {
  // All left edges within TOLERANCE of one another — a nested list/quote
  // indent (~20-30pt) is common and must not register as a second column.
  const lines = mkColumn(72, 60, 750, 12, 25);
  expect(detectColumnRegions(lines, 612)).toBeNull();
});

test('a single stray title line above single-column body is NOT split (title cluster too small)', () => {
  const lines = [{ y: 780, rtl: false, items: [{ x: 220, str: 'Title' }] }, ...mkColumn(72, 50, 760, 12)];
  expect(detectColumnRegions(lines, 612)).toBeNull();
});

test('two X-clusters that do not overlap in Y (e.g. a top block + an unrelated ' +
     'differently-indented block below it, not real parallel columns) are NOT split', () => {
  const top = mkColumn(72, 20, 780, 10);           // y: 780..590, top half of page
  const bottom = mkColumn(300, 20, 400, 10);        // y: 400..210, bottom half — no Y overlap with top
  expect(detectColumnRegions([...top, ...bottom], 612)).toBeNull();
});

test('too few lines in the second cluster (not a real column, just a couple of stray items) is NOT split', () => {
  const lines = [...mkColumn(72, 50, 760, 12), ...mkColumn(320, 3, 700, 40)];
  expect(detectColumnRegions(lines, 612)).toBeNull();
});

test('more than 3 X-clusters (likely noise, not a real multi-column layout) is NOT split', () => {
  const lines = [
    ...mkColumn(60, 10, 760, 12), ...mkColumn(180, 10, 760, 12),
    ...mkColumn(300, 10, 760, 12), ...mkColumn(420, 10, 760, 12),
  ];
  expect(detectColumnRegions(lines, 612)).toBeNull();
});

test('too little content overall to judge (a near-empty page) is NOT split', () => {
  const lines = [...mkColumn(72, 3, 760, 12), ...mkColumn(300, 3, 760, 12)];
  expect(detectColumnRegions(lines, 612)).toBeNull();
});

console.log('\npageIsRtl:');

test('a page where most lines are RTL reports true', () => {
  const lines = Array.from({ length: 10 }, (_, i) => ({ y: 700 - i * 10, rtl: i < 7, items: [{ x: 72 }] }));
  expect(pageIsRtl(lines)).toBe(true);
});

test('a page where most lines are LTR reports false', () => {
  const lines = Array.from({ length: 10 }, (_, i) => ({ y: 700 - i * 10, rtl: i < 3, items: [{ x: 72 }] }));
  expect(pageIsRtl(lines)).toBe(false);
});

test('exactly half RTL does not tip into true (strictly greater-than)', () => {
  const lines = Array.from({ length: 10 }, (_, i) => ({ y: 700 - i * 10, rtl: i < 5, items: [{ x: 72 }] }));
  expect(pageIsRtl(lines)).toBe(false);
});

console.log('\n_splitCrossColumnLines — the real bug this whole file exists to guard against:');

// Builds `count` MERGED lines — each one line object holding BOTH a
// col1-positioned item AND a col2-positioned item at the same Y — the exact
// shape _p2wBuildPageData's plain Y-proximity grouping produces on a real
// 2-column page (confirmed: 70-85% of lines, not a rare edge case).
function mkMergedLines(col1X, col2X, count, yStart, yStep = 12) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      y: yStart - i * yStep, rtl: false,
      items: [{ x: col1X, str: `C1-${i}` }, { x: col2X, str: `C2-${i}` }],
    });
  }
  return out;
}

test('a page of merged cross-column lines is split into clean per-column lines', () => {
  const lines = mkMergedLines(72, 320, 20, 760, 12);
  const before = lines.length;
  _splitCrossColumnLines(lines, 612);
  expect(lines.length).toBe(before * 2); // every merged line becomes exactly 2
  for (const ln of lines) {
    expect(ln.items.length).toBe(1); // no line still holds both columns' items
  }
  const col1Texts = lines.filter(l => l.items[0].x < 200).map(l => l.items[0].str);
  const col2Texts = lines.filter(l => l.items[0].x >= 200).map(l => l.items[0].str);
  expect(col1Texts.length).toBe(20);
  expect(col2Texts.length).toBe(20);
  if (!col1Texts.every(t => t.startsWith('C1-'))) throw new Error('column 1 split contains column 2 content');
  if (!col2Texts.every(t => t.startsWith('C2-'))) throw new Error('column 2 split contains column 1 content');
});

test('split lines preserve the original Y and rtl flag', () => {
  const lines = [{ y: 555, rtl: true, items: [{ x: 72, str: 'a' }, { x: 320, str: 'b' }] }, ...mkMergedLines(72, 320, 19, 740, 12)];
  _splitCrossColumnLines(lines, 612);
  const split = lines.filter(l => l.items[0].str === 'a' || l.items[0].str === 'b');
  expect(split.length).toBe(2);
  for (const ln of split) {
    expect(ln.y).toBe(555);
    expect(ln.rtl).toBe(true);
  }
});

test('a line that only ever touches one region is left as a single line, not split', () => {
  // 19 merged (both-column) lines plus one col1-only line — that one line
  // must survive as ONE line with 1 item, not get needlessly reshaped.
  const lines = [...mkMergedLines(72, 320, 19, 760, 12), { y: 400, rtl: false, items: [{ x: 72, str: 'only-col1' }] }];
  _splitCrossColumnLines(lines, 612);
  const found = lines.filter(l => l.items.some(i => i.str === 'only-col1'));
  expect(found.length).toBe(1);
  expect(found[0].items.length).toBe(1);
});

test('a single-column page (no confident columns detected) is left completely untouched', () => {
  const lines = Array.from({ length: 30 }, (_, i) => ({ y: 760 - i * 12, rtl: false, items: [{ x: 72 + (i % 3) * 10, str: `L${i}` }] }));
  const beforeJson = JSON.stringify(lines);
  _splitCrossColumnLines(lines, 612);
  expect(JSON.stringify(lines)).toBe(beforeJson);
});

// ── Summary ──────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
