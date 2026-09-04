// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/pdf2ppt-reconstruct.test.js — regression tests for
//  _p2pBuildSlideShapes() (js/processor.js), the Stage 1 "Editable text
//  (beta)" mode engine for pdf2ppt: reuses pdf2word's own detectors
//  (detectTables, detectColumnRegions, BULLET_RE/NUMBERED_RE/LETTERED_RE,
//  the same heading font-ratio/bold-heading detection, the same
//  repeatTextSet/repeatPatternSet footer suppression) to decide which
//  parts of a page become real, positioned text shapes vs. a single
//  cropped image region — see that function's own block comment
//  (js/processor.js) for the exact, deliberately disclosed Stage 1 scope.
//
// Run: node tests/pdf2ppt-reconstruct.test.js

global.window = { PDFREE_LOCALE: {} };
global.document = {
  addEventListener: () => {}, removeEventListener: () => {}, getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add(){}, remove(){}, contains(){ return false; } }, appendChild(){}, removeChild(){}, setAttribute(){} }),
  body: { appendChild(){}, removeChild(){} },
};
global.Worker = class { postMessage(){} terminate(){} addEventListener(){} };

const docx = await import('docx');
global.window.docx = docx;

const { _p2pBuildSlideShapes } = await import('../js/processor.js');

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

// ── Fixture builders — matches _p2wBuildPageData's real item/line shape ────
const mkItem = (str, x, fontSize = 12, extra = {}) => ({
  str, x, width: str.length * fontSize * 0.5, fontSize, bold: false, italic: false, ...extra,
});
const mkLine = (items, y) => ({ y, rtl: false, items: Array.isArray(items) ? items : [items] });
const mkPage = (lines, pageH = 792, pageW = 612, borderGrids = []) => ({ lines, pageH, pageW, borderGrids });

console.log('\n_p2pBuildSlideShapes — heading + body paragraph become separate text shapes:');

await test('a large-font heading and a normal-size paragraph become 2 distinct text shapes', () => {
  const lines = [
    mkLine(mkItem('Quarterly Report', 50, 20), 740),          // 20 >= median(12)*1.3 -> heading
    mkLine(mkItem('Revenue grew fourteen percent this quarter.', 50, 12), 700),
    mkLine(mkItem('driven by the enterprise segment overall.', 50, 12), 686),
  ];
  const { textShapes, imageRegions, scanned } = _p2pBuildSlideShapes(mkPage(lines), 12, new Set(), new Set());
  expect(scanned).toBe(false);
  expect(imageRegions.length).toBe(0);
  expect(textShapes.length).toBe(2);
  expect(textShapes[0].heading).toBe(true);
  expect(textShapes[0].runs[0].text).toBe('Quarterly Report');
  expect(textShapes[1].heading).toBe(false);
  expect(textShapes[1].runs.length).toBe(2); // the 2 body lines merged into one paragraph shape
});

console.log('\n_p2pBuildSlideShapes — flat bulleted/numbered/lettered lists become their own shapes, not merged into body:');

await test('a bullet line between two prose lines becomes its own shape with bullet:"bullet", marker stripped', () => {
  const lines = [
    mkLine(mkItem('Onboarding steps:', 50, 12), 700),
    mkLine(mkItem('• Verify your email address', 50, 12), 686),
    mkLine(mkItem('Thanks for signing up.', 50, 12), 672),
  ];
  const { textShapes } = _p2pBuildSlideShapes(mkPage(lines), 12, new Set(), new Set());
  expect(textShapes.length).toBe(3);
  expect(textShapes[1].bullet).toBe('bullet');
  expect(textShapes[1].runs[0].text).toBe('Verify your email address');
});

await test('a numbered line becomes its own shape with bullet:"number", marker stripped', () => {
  const lines = [
    mkLine(mkItem('Steps to deploy:', 50, 12), 700),
    mkLine(mkItem('1. Run the build script', 50, 12), 686),
    mkLine(mkItem('2. Push to the main branch', 50, 12), 672),
  ];
  const { textShapes } = _p2pBuildSlideShapes(mkPage(lines), 12, new Set(), new Set());
  expect(textShapes.length).toBe(3);
  expect(textShapes[1].bullet).toBe('number');
  expect(textShapes[1].runs[0].text).toBe('Run the build script');
  expect(textShapes[2].bullet).toBe('number');
  expect(textShapes[2].runs[0].text).toBe('Push to the main branch');
});

await test('an indented lettered sub-item becomes its own shape; a flush-left initial-led sentence does not', () => {
  const lines = [
    mkLine(mkItem('1. Complete the account setup form', 50, 12), 700),
    mkLine(mkItem('a. Verify your email address', 75, 12), 686), // indented past baseline (50) + 10pt gate
    mkLine(mkItem('A. Smith wrote the original proposal.', 50, 12), 660), // same margin as baseline — not a list
  ];
  const { textShapes } = _p2pBuildSlideShapes(mkPage(lines), 12, new Set(), new Set());
  const lettered = textShapes.find(s => s.runs[0].text === 'Verify your email address');
  expect(lettered.bullet).toBe('bullet');
  const initial = textShapes.find(s => s.runs.some(r => r.text.includes('A. Smith')));
  if (initial.bullet) throw new Error('a flush-left "A. Smith..." sentence must not be treated as a lettered list item');
});

console.log('\n_p2pBuildSlideShapes — Stage 2: a detected table becomes a real tableShapes entry, not an image or loose text:');

await test('a real label|value table (no visible border) produces a tableShapes entry with its rows intact', () => {
  const labels = ['Revenue', 'Cost of goods', 'Gross profit', 'Net income'];
  const values = ['$482,000', '$210,500', '$271,500', '$173,200'];
  const lines = [
    mkLine(mkItem('Financial Summary', 50, 16), 750),
    ...labels.map((label, i) => mkLine([mkItem(label, 50, 11), mkItem(values[i], 300, 11)], 700 - i * 16)),
    mkLine(mkItem('Prepared by the finance team.', 50, 12), 600),
  ];
  const { textShapes, tableShapes, imageRegions, scanned } = _p2pBuildSlideShapes(mkPage(lines), 12, new Set(), new Set());
  expect(scanned).toBe(false);
  expect(imageRegions.length).toBe(0);
  expect(tableShapes.length).toBe(1);
  expect(tableShapes[0].rows.length).toBe(4);
  expect(tableShapes[0].rows[0].map(c => c.text).join('|')).toBe('Revenue|$482,000');
  expect(tableShapes[0].rows[3].map(c => c.text).join('|')).toBe('Net income|$173,200');
  const tableText = textShapes.map(s => s.runs.map(r => r.text).join(' ')).join(' ');
  if (tableText.includes('482,000')) throw new Error('table cell content leaked into a text shape instead of becoming a real table');
  if (!textShapes.some(s => s.runs[0].text === 'Financial Summary')) throw new Error('the heading above the table should still be a real text shape');
  if (!textShapes.some(s => s.runs[0].text === 'Prepared by the finance team.')) throw new Error('the paragraph below the table should still be a real text shape');
});

await test('a border-grid row with a missing internal divider produces a real colspan cell, unmerged rows stay separate', () => {
  // Exact same fixture shape as tests/pdf2wordParagraphs.test.js's own
  // gridSpan regression test (real page-18-tariff-table shape, already
  // covered at the detectTableGrids() level by tests/pdf2wordBorders.test.js)
  // — proves the SAME reused helpers (_assignLineToGridCols/
  // _activeDividersForY/_groupGridCellsWithSpans) wire correctly into this
  // pptx-shaped output too, not just docx's.
  const lines = [
    mkLine([mkItem('Header', 80, 11), mkItem('Q1', 220, 11), mkItem('Q2', 380, 11)], 700),
    mkLine([mkItem('Merged Region', 80, 11), mkItem('Note', 380, 11)], 680),
    mkLine([mkItem('Row3A', 80, 11), mkItem('Row3B', 220, 11), mkItem('Row3C', 380, 11)], 660),
  ];
  const grid = {
    x: 60, y: 650, w: 400, h: 60, colCount: 3, rowCount: 3,
    colXs: [60, 200, 340, 460],
    rowYs: [710, 690, 670, 650],
    colDividers: [
      { x: 200, spans: [[690, 710], [650, 670]] }, // present for row1 & row3, absent for row2
      { x: 340, spans: [[650, 710]] },              // present for all rows
    ],
  };
  const { tableShapes } = _p2pBuildSlideShapes(mkPage(lines, 792, 612, [grid]), 11, new Set(), new Set());
  expect(tableShapes.length).toBe(1);
  const rows = tableShapes[0].rows;
  expect(rows.length).toBe(3);

  expect(rows[0].map(c => c.text).join('|')).toBe('Header|Q1|Q2');
  if (rows[0].some(c => c.span > 1)) throw new Error('row 1 has no merge — every cell should have span 1');

  expect(rows[1].length).toBe(2);
  expect(rows[1][0].text).toBe('Merged Region');
  expect(rows[1][0].span).toBe(2);
  expect(rows[1][1].text).toBe('Note');

  expect(rows[2].map(c => c.text).join('|')).toBe('Row3A|Row3B|Row3C');
  if (rows[2].some(c => c.span > 1)) throw new Error('row 3 has no merge — every cell should have span 1');
});

console.log('\n_p2pBuildSlideShapes — multi-column and scanned pages fall back per Stage 1\'s disclosed scope:');

await test('a scanned page (no extractable text) reports scanned:true with no shapes', () => {
  const { textShapes, imageRegions, scanned } = _p2pBuildSlideShapes(mkPage([]), 12, new Set(), new Set());
  expect(scanned).toBe(true);
  expect(textShapes.length).toBe(0);
  expect(imageRegions.length).toBe(0);
});

await test('a genuine 2-column page becomes ONE whole-page image region (Stage 1 scope — no per-column text reconstruction)', () => {
  // detectColumnRegions() needs >=10 lines total before it even attempts
  // detection (MIN_LINES_ABS*2, js/pdf2wordColumns.js) — a too-sparse
  // fixture here would trivially return null for an unrelated reason (not
  // enough content to judge), not prove anything about column handling.
  const leftLines = [
    'The archive project began in January', 'with a full inventory of the collection.',
    'Volunteers catalogued over three thousand', 'items across the first two months, sorting',
    'each piece by decade and by donor family.', 'A digital scan was made of every fragile',
    'document before it returned to storage.', 'The team also built a searchable index',
    'so researchers could query by keyword.', 'Weekly progress reports went to the board.',
  ];
  const rightLines = [
    'Funding for the second phase was', 'approved by the board in March, covering',
    'a new climate-controlled storage wing.', 'Construction on the new wing is expected',
    'to finish by next spring, weather allowing.', 'The architect presented three designs.',
    'Residents voted to preserve the original', 'facade while modernizing the interior.',
    'A temporary storage tent was rented for', 'the transition period between phases.',
  ];
  const lines = leftLines.map((t, i) => mkLine([mkItem(t, 60, 10), mkItem(rightLines[i], 330, 10)], 740 - i * 16));
  const { textShapes, imageRegions, scanned } = _p2pBuildSlideShapes(mkPage(lines), 10, new Set(), new Set());
  expect(scanned).toBe(false);
  expect(textShapes.length).toBe(0);
  expect(imageRegions.length).toBe(1);
});

console.log('\n_p2pBuildSlideShapes — page-number footer pattern (repeatPatternSet) is suppressed, not emitted as a shape:');

await test('a "Page N of M"-shaped line near the page edge is suppressed when its digit-normalized form is a known repeat pattern', () => {
  const lines = [
    mkLine(mkItem('Body content for this slide goes here.', 50, 12), 700),
    mkLine(mkItem('More detail continues on this same line set.', 50, 12), 686),
    mkLine(mkItem('Page 3 of 4', 270, 9), 40),
  ];
  const { textShapes } = _p2pBuildSlideShapes(mkPage(lines), 12, new Set(), new Set(['Page # of #']));
  const found = textShapes.some(s => s.runs.some(r => r.text.includes('Page 3 of 4')));
  if (found) throw new Error('a known page-number pattern near the edge must be suppressed, not emitted as its own text shape');
});

// ── Summary ──────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
