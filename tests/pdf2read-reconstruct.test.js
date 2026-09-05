// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/pdf2read-reconstruct.test.js — regression tests for
//  _rpBuildPageBlocks() (js/processor.js), the block-builder behind the
//  "Read PDF" reflow reading view: a THIRD consumer of the exact same
//  detectors pdf2word (_p2wBuildParagraphs) and pdf2ppt
//  (_p2pBuildSlideShapes) already reuse (detectTables, detectColumnRegions,
//  BULLET_RE/NUMBERED_RE/LETTERED_RE, heading font-ratio/bold-heading
//  detection, repeatTextSet/repeatPatternSet footer suppression), emitting
//  plain reading blocks instead of docx.js objects or PPTX shapes.
//
// Run: node tests/pdf2read-reconstruct.test.js

// processor.js has module-level code that touches window/document/Worker
// regardless of which exported function is actually called — same mocks
// tests/pdf2ppt-reconstruct.test.js already needs for the identical reason.
global.window = { PDFREE_LOCALE: {} };
global.document = {
  addEventListener: () => {}, removeEventListener: () => {}, getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add(){}, remove(){}, contains(){ return false; } }, appendChild(){}, removeChild(){}, setAttribute(){} }),
  body: { appendChild(){}, removeChild(){} },
};
global.Worker = class { postMessage(){} terminate(){} addEventListener(){} };

const docx = await import('docx');
global.window.docx = docx;

const { _rpBuildPageBlocks } = await import('../js/processor.js');

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

console.log('\n_rpBuildPageBlocks — heading + body paragraph become separate blocks:');

await test('a large-font heading and a wrapped 2-line paragraph become 2 blocks, paragraph joined into ONE flowing string', () => {
  const lines = [
    mkLine(mkItem('Quarterly Report', 50, 20), 740),
    mkLine(mkItem('Revenue grew fourteen percent this quarter,', 50, 12), 700),
    mkLine(mkItem('driven mostly by the enterprise segment.', 50, 12), 686),
  ];
  const { blocks, scanned } = _rpBuildPageBlocks(mkPage(lines), 12, new Set(), new Set());
  expect(scanned).toBe(false);
  expect(blocks.length).toBe(2);
  expect(blocks[0].type).toBe('heading');
  expect(blocks[0].text).toBe('Quarterly Report');
  expect(blocks[1].type).toBe('paragraph');
  // The two original PDF lines are joined into one continuous string, not
  // kept as 2 separate blocks — a PDF's own line break is just where the
  // fixed-width source column wrapped, not a real paragraph break, and
  // preserving it would defeat the whole point of a reflowing view.
  expect(blocks[1].text).toBe('Revenue grew fourteen percent this quarter, driven mostly by the enterprise segment.');
});

console.log('\n_rpBuildPageBlocks — lists: bullet/lettered markers stripped, numbered markers kept:');

await test('a bullet line becomes a list-item with the bullet glyph stripped', () => {
  const lines = [mkLine(mkItem('• Verify your email address', 50, 12), 700)];
  const { blocks } = _rpBuildPageBlocks(mkPage(lines), 12, new Set(), new Set());
  expect(blocks.length).toBe(1);
  expect(blocks[0].type).toBe('list-item');
  expect(blocks[0].ordinal).toBe('bullet');
  expect(blocks[0].text).toBe('Verify your email address');
});

await test('a numbered line keeps its own marker text — real sequence info a reading view should not discard', () => {
  const lines = [mkLine(mkItem('1. Complete the account setup form', 50, 12), 700)];
  const { blocks } = _rpBuildPageBlocks(mkPage(lines), 12, new Set(), new Set());
  expect(blocks.length).toBe(1);
  expect(blocks[0].type).toBe('list-item');
  expect(blocks[0].ordinal).toBe('number');
  expect(blocks[0].text).toBe('1. Complete the account setup form');
});

await test('an indented lettered sub-item strips its marker (bullet-style); a flush-left initial-led sentence does not become a list', () => {
  const lines = [
    mkLine(mkItem('1. Complete the account setup form', 50, 12), 700),
    mkLine(mkItem('a. Verify your email address', 75, 12), 686), // indented past baseline (50) + 10pt gate
    mkLine(mkItem('A. Smith wrote the original proposal.', 50, 12), 660), // same margin as baseline — not a list
  ];
  const { blocks } = _rpBuildPageBlocks(mkPage(lines), 12, new Set(), new Set());
  const letteredItem = blocks.find(b => b.type === 'list-item' && b.ordinal === 'bullet');
  expect(letteredItem.text).toBe('Verify your email address');
  const notAList = blocks.find(b => b.type === 'paragraph' && b.text.includes('Smith'));
  expect(notAList.text).toBe('A. Smith wrote the original proposal.');
});

console.log('\n_rpBuildPageBlocks — tables (text-detected and border-grid):');

await test('a real label|value table (no visible border) becomes a table block with its rows intact', () => {
  const labels = ['Revenue', 'Cost of goods', 'Gross profit', 'Net income'];
  const values = ['$482,000', '$210,500', '$271,500', '$173,200'];
  const lines = [
    mkLine(mkItem('Financial Summary', 50, 16), 750),
    ...labels.map((label, i) => mkLine([mkItem(label, 50, 11), mkItem(values[i], 300, 11)], 700 - i * 16)),
    mkLine(mkItem('Prepared by the finance team.', 50, 12), 600),
  ];
  const { blocks } = _rpBuildPageBlocks(mkPage(lines), 12, new Set(), new Set());
  const table = blocks.find(b => b.type === 'table');
  expect(!!table).toBe(true);
  expect(table.rows.length).toBe(4);
  expect(table.rows[0].map(c => c.text).join('|')).toBe('Revenue|$482,000');
  const tableText = blocks.filter(b => b.type !== 'table').map(b => b.text).join(' ');
  if (tableText.includes('482,000')) throw new Error('table cell content leaked into a paragraph/heading block instead of becoming a real table');
});

await test('a border-grid row with a missing internal divider produces a real colspan cell', () => {
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
      { x: 200, spans: [[690, 710], [650, 670]] },
      { x: 340, spans: [[650, 710]] },
    ],
  };
  const { blocks } = _rpBuildPageBlocks(mkPage(lines, 792, 612, [grid]), 11, new Set(), new Set());
  const table = blocks.find(b => b.type === 'table');
  expect(!!table).toBe(true);
  expect(table.rows.length).toBe(3);
  expect(table.rows[1].length).toBe(2);
  expect(table.rows[1][0].text).toBe('Merged Region');
  expect(table.rows[1][0].span).toBe(2);
});

// 10 lines per column — detectColumnRegions() requires MIN_LINES_ABS*2 (=10)
// total lines to judge a column split at all; fewer than that is a real,
// previously-hit fixture trap (see tests/pdf2ppt-reconstruct.test.js's own
// history), not a hypothetical.
const _leftColLines = [
  'The archive project began in January', 'with a full inventory of the collection.',
  'Volunteers catalogued over three thousand', 'items across the first two months, sorting',
  'each piece by decade and by donor family.', 'A digital scan was made of every fragile',
  'document before it returned to storage.', 'The team also built a searchable index',
  'so researchers could query by keyword.', 'Weekly progress reports went to the board.',
];
const _rightColLines = [
  'Funding for the second phase was', 'approved by the board in March, covering',
  'a new climate-controlled storage wing.', 'Construction on the new wing is expected',
  'to finish by next spring, weather allowing.', 'The architect presented three designs.',
  'Residents voted to preserve the original', 'facade while modernizing the interior.',
  'A temporary storage tent was rented for', 'the transition period between phases.',
];

console.log('\n_rpBuildPageBlocks — multi-column dispatch:');

await test('a genuine 2-column page reconstructs left column fully then right column fully, no interleaving', () => {
  const lines = _leftColLines.map((t, i) => mkLine([mkItem(t, 60, 10), mkItem(_rightColLines[i], 330, 10)], 740 - i * 16));
  const { blocks, scanned } = _rpBuildPageBlocks(mkPage(lines), 10, new Set(), new Set());
  expect(scanned).toBe(false);
  const paragraphs = blocks.filter(b => b.type === 'paragraph');
  expect(paragraphs.length).toBe(2);
  expect(paragraphs[0].text.includes('archive project')).toBe(true);
  expect(paragraphs[1].text.includes('second phase')).toBe(true);
});

console.log('\n_rpBuildPageBlocks — a grid straddling both columns falls back to one whole-page image block:');

await test('a border grid whose x/w spans across the detected column boundary makes the page un-splittable', () => {
  const lines = _leftColLines.map((t, i) => mkLine([mkItem(t, 60, 10), mkItem(_rightColLines[i], 330, 10)], 740 - i * 16));
  // A grid starting inside the left column and extending well into the
  // right column's territory — no single region fully contains it.
  const straddlingGrid = { x: 50, y: 400, w: 350, h: 100, colCount: 1, rowCount: 1, colXs: [50, 400], rowYs: [500, 400], colDividers: [] };
  const { blocks, scanned } = _rpBuildPageBlocks(mkPage(lines, 792, 612, [straddlingGrid]), 10, new Set(), new Set());
  expect(scanned).toBe(false);
  expect(blocks.length).toBe(1);
  expect(blocks[0].type).toBe('image');
});

console.log('\n_rpBuildPageBlocks — scanned pages fall back per the standing scope:');

await test('a scanned page (no extractable text) reports scanned:true with no blocks', () => {
  const { blocks, scanned } = _rpBuildPageBlocks(mkPage([]), 12, new Set(), new Set());
  expect(scanned).toBe(true);
  expect(blocks.length).toBe(0);
});

console.log('\n_rpBuildPageBlocks — a formula-heavy (Private-Use-Area) line is routed to an image block, not garbled text:');

await test('a line made mostly of PUA glyphs (LaTeX/math-font symbols with no real text mapping) becomes an image block', () => {
  const puaChar = String.fromCodePoint(0xE000);
  const formulaLine = puaChar.repeat(8);
  const lines = [
    mkLine(mkItem('Ordinary paragraph text before the formula.', 50, 12), 700),
    mkLine(mkItem(formulaLine, 50, 14), 680),
    mkLine(mkItem('Ordinary paragraph text after the formula.', 50, 12), 660),
  ];
  const { blocks } = _rpBuildPageBlocks(mkPage(lines), 12, new Set(), new Set());
  const imageBlock = blocks.find(b => b.type === 'image');
  expect(!!imageBlock).toBe(true);
  const anyParagraphHasGarbage = blocks.some(b => b.type === 'paragraph' && b.text.includes(puaChar));
  expect(anyParagraphHasGarbage).toBe(false);
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
