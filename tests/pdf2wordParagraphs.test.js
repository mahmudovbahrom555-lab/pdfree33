// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/pdf2wordParagraphs.test.js — regression tests for
//  _p2wBuildParagraphs() (js/processor.js), the pass-2 heuristic that
//  turns grouped pdf.js text lines into docx.js Paragraph/Table
//  instances. Previously module-private with zero coverage.
//
//  Fixtures are inline arrays shaped like _p2wBuildPageData()'s output
//  (lines of {y, rtl, items:[{str,x,width,fontSize,bold,italic}]}),
//  matching tests/pdf2wordTables.test.js's established precedent of
//  hand-built line/row fixtures rather than parsing a real PDF —
//  _p2wBuildParagraphs never re-parses the PDF itself, so a real PDF
//  isn't needed to exercise it.
//
//  Cases below match _p2wBuildParagraphs()'s actual documented rules
//  (js/processor.js:2990-3480), not invented thresholds:
//    heading (font size)   — maxFont >= median*1.3/1.7/2.2 -> H3/H2/H1
//    heading (bold line)   — _isBoldHeadingLine: whole line bold, text
//                             length in (3, 100] -> H2, or H1 if all-caps
//    paragraph-break gap   — lastMaxFont * 2.0 (LTR/Cyrillic),
//                             lastMaxFont * 1.3 (RTL),
//                             lastMaxFont * 3.5 (CJK continuation, no
//                             terminal punctuation), else lastMaxFont*2.0
//                             (including CJK that DOES end in 。！？…)
//    list detection         — BULLET_RE / NUMBERED_RE never merge into
//                             the surrounding paragraph, marker stripped
//    numbered-clause guard  — detectTables() candidates filtered by
//                             looksLikeProseNotData/looksLikeEnumeratedList
//                             before ever becoming a Table (real fix,
//                             see tests/pdf2wordTables.test.js)
//    useTables:false        — ERI retry path; no Table instances result
//    decimal-number guard   — NUMBERED_RE's (?!\d) lookahead: "3.14 is pi"
//                             must stay prose, pinned here at the full
//                             pipeline level too, not just the regex
//                             (see tests/pdf2wordLists.test.js)
//    border-grid gridSpan   — a hand-built borderGrids entry (shaped like
//                             real detectTableGrids() output, colDividers
//                             included) drives the 'grid' event handler
//                             end-to-end, confirming a row with a missing
//                             internal divider becomes a real docx
//                             columnSpan (see tests/pdf2wordBorders.test.js
//                             for the lower-level detectTableGrids()/
//                             _activeDividersForY coverage)
//
// Run: node tests/pdf2wordParagraphs.test.js
//
// js/processor.js eagerly touches window/document/Worker at module-load
// time (a real, non-test-specific worker-readiness pattern, not something
// to change) — minimal stubs let it import cleanly under plain Node.
// _p2wBuildParagraphs also gates its per-page loop on the module-level
// isProcessing flag (only ever true inside the real doProcess()
// orchestration) — _setProcessingForTests() is a small test-only seam
// added alongside it for exactly this purpose (js/processor.js:89-95).
global.window = { PDFREE_LOCALE: {} };
global.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add(){}, remove(){}, contains(){ return false; } }, appendChild(){}, removeChild(){}, setAttribute(){} }),
  body: { appendChild(){}, removeChild(){} },
};
global.Worker = class { postMessage(){} terminate(){} addEventListener(){} };

const docx = await import('docx');
global.window.docx = docx;

const { _p2wBuildParagraphs, _setProcessingForTests } = await import('../js/processor.js');
_setProcessingForTests(true);

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe: (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toContain: (e) => { if (!actual.includes(e)) throw new Error(`Expected ${JSON.stringify(actual)} to contain ${JSON.stringify(e)}`); },
    toBeUndefined: () => { if (actual !== undefined) throw new Error(`Expected undefined, got ${JSON.stringify(actual)}`); },
  };
}

// ── Fixture builders ────────────────────────────────────────────────────
const mkItem = (str, x, fontSize = 12, extra = {}) => ({
  str, x, width: str.length * fontSize * 0.5, fontSize, bold: false, italic: false, ...extra,
});
const mkLine = (items, y, rtl = false) => ({ y, rtl, items: Array.isArray(items) ? items : [items] });
const baseCs = (totalPages = 1) => ({
  totalPages, fullPageFallbacks: 0, totalLines: 0, rtlLines: 0,
  mathChars: 0, totalChars: 0, totalTables: 0, totalGapVisuals: 0, totalInlineVisuals: 0,
});
function mkPageData(lines, pageH = 792, borderGrids = [], pageW = undefined) {
  return [{ lines, rotatedItems: [], borderGrids, pageH, pageW, items: lines.flatMap(l => l.items) }];
}
async function build(lines, median = 12, opts = {}, borderGrids = [], pageW = undefined) {
  return _p2wBuildParagraphs({}, mkPageData(lines, 792, borderGrids, pageW), median, new Set(), baseCs(1), opts);
}

// ── docx.js internal-shape helpers ──────────────────────────────────────
// docx.js Paragraph/Table instances expose their OOXML tree via
// {rootKey, root}. These walk that tree to pull out what the tests need,
// rather than re-serializing to XML.
const isTable = (x) => x && x.rootKey === 'w:tbl';
function pPr(paragraph) {
  return paragraph.root.find(n => n && n.rootKey === 'w:pPr');
}
function headingStyle(paragraph) {
  const pr = pPr(paragraph);
  const styleNode = pr?.root.find(n => n && n.rootKey === 'w:pStyle');
  return styleNode?.root?.[0]?.root?.val;
}
function isListItem(paragraph) {
  const pr = pPr(paragraph);
  return !!pr?.root.some(n => n && n.rootKey === 'w:numPr');
}
function paragraphText(paragraph) {
  return paragraph.root
    .filter(n => n && n.rootKey === 'w:r')
    .map(r => {
      const t = r.root.find(n => n && n.rootKey === 'w:t');
      return t?.root.find(x => typeof x === 'string') || '';
    })
    .join('');
}
// tbl (a Table instance) -> [[{text, span}]] — one array of cells per row.
function tableRows(tbl) {
  return tbl.root
    .filter(n => n && n.rootKey === 'w:tr')
    .map(tr => tr.root
      .filter(n => n && n.rootKey === 'w:tc')
      .map(tc => {
        const tcPr = tc.root.find(n => n && n.rootKey === 'w:tcPr');
        const gsNode = tcPr?.root.find(n => n && n.rootKey === 'w:gridSpan');
        const span = gsNode?.root?.[0]?.root?.val ?? 1;
        const p = tc.root.find(n => n && n.rootKey === 'w:p');
        return { text: p ? paragraphText(p) : '', span };
      }));
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n_p2wBuildParagraphs — heading detection by font size (median=12):');

await test('font exactly 1.3x median promotes to Heading3', async () => {
  // 12*1.3 !== 15.6 in JS float math (15.600000000000001) — use the same
  // expression the source computes, not a hand-typed decimal, so this
  // actually tests the inclusive ">=" boundary instead of tripping over
  // float precision.
  const lines = [mkLine(mkItem('Section Title', 50, 12 * 1.3), 700)];
  const { paragraphs } = await build(lines);
  expect(headingStyle(paragraphs[0])).toBe('Heading3');
});

await test('font just under 1.3x median (15.59) does NOT promote', async () => {
  const lines = [mkLine(mkItem('Section Title', 50, 15.59), 700)];
  const { paragraphs } = await build(lines);
  expect(headingStyle(paragraphs[0])).toBeUndefined();
});

await test('font exactly 1.7x median promotes to Heading2', async () => {
  const lines = [mkLine(mkItem('Chapter Title', 50, 12 * 1.7), 700)];
  const { paragraphs } = await build(lines);
  expect(headingStyle(paragraphs[0])).toBe('Heading2');
});

await test('font exactly 2.2x median promotes to Heading1', async () => {
  const lines = [mkLine(mkItem('Document Title', 50, 12 * 2.2), 700)];
  const { paragraphs } = await build(lines);
  expect(headingStyle(paragraphs[0])).toBe('Heading1');
});

console.log('\n_p2wBuildParagraphs — heading detection via _isBoldHeadingLine (same-size-bold):');

await test('whole-line bold, non-all-caps, length in (3,100] -> Heading2', async () => {
  const lines = [mkLine(mkItem('Клиент не вправе:', 50, 12, { bold: true }), 700)];
  const { paragraphs } = await build(lines);
  expect(headingStyle(paragraphs[0])).toBe('Heading2');
});

await test('whole-line bold, all-caps -> Heading1', async () => {
  const lines = [mkLine(mkItem('ФОРС-МАЖОР', 50, 12, { bold: true }), 700)];
  const { paragraphs } = await build(lines);
  expect(headingStyle(paragraphs[0])).toBe('Heading1');
});

await test('boundary: 4-char bold line (len>3) promotes to heading', async () => {
  const lines = [mkLine(mkItem('Тест', 50, 12, { bold: true }), 700)];
  const { paragraphs } = await build(lines);
  expect(headingStyle(paragraphs[0])).toBe('Heading2');
});

await test('boundary: 3-char bold line (len==3) does NOT promote', async () => {
  const lines = [mkLine(mkItem('Тес', 50, 12, { bold: true }), 700)];
  const { paragraphs } = await build(lines);
  expect(headingStyle(paragraphs[0])).toBeUndefined();
});

await test('non-boundary: partial-line bold (inline emphasis) does NOT trigger heading', async () => {
  const lines = [mkLine([
    mkItem('Important: ', 50, 12, { bold: true }),
    mkItem('the rest of this sentence is plain body text, not a heading.', 120, 12, { bold: false }),
  ], 700)];
  const { paragraphs } = await build(lines);
  expect(headingStyle(paragraphs[0])).toBeUndefined();
});

await test('whole-line bold but over 100 chars does NOT promote', async () => {
  const longText = 'Б'.repeat(101);
  const lines = [mkLine(mkItem(longText, 50, 12, { bold: true }), 700)];
  const { paragraphs } = await build(lines);
  expect(headingStyle(paragraphs[0])).toBeUndefined();
});

await test('a bold line containing a comma-grouped currency amount does NOT promote — financial ledger subtotal row, not a heading', async () => {
  // Real case: Atlas_DR's md_corpus/003-multipage-ledger had
  // "Subtotal thru 04/23 28,971.05 21,945.70" wrongly promoted to Heading2
  // before this guard (same failure mode, same source document as
  // tests/pdf2excel.logic.test.js's sparse-column detectTables() fix).
  const lines = [mkLine(mkItem('Subtotal thru 04/23 28,971.05 21,945.70', 50, 12, { bold: true }), 700)];
  const { paragraphs } = await build(lines);
  expect(headingStyle(paragraphs[0])).toBeUndefined();
});

console.log('\n_p2wBuildParagraphs — paragraph-break Y-gap thresholds (median=12, fontSize=12):');

await test('LTR/Cyrillic: gap just under 2.0x (23.99) merges into one paragraph', async () => {
  const lines = [
    mkLine(mkItem('Первая строка абзаца здесь.', 50, 12), 700),
    mkLine(mkItem('Продолжение того же абзаца.', 50, 12), 700 - 23.99),
  ];
  const { paragraphs } = await build(lines);
  expect(paragraphs.length).toBe(1);
  const txt = paragraphText(paragraphs[0]);
  expect(txt).toContain('Первая строка абзаца здесь.');
  expect(txt).toContain('Продолжение того же абзаца.');
});

await test('LTR/Cyrillic: gap just over 2.0x (24.01) breaks into two paragraphs', async () => {
  const lines = [
    mkLine(mkItem('Первая строка абзаца здесь.', 50, 12), 700),
    mkLine(mkItem('Это уже новый абзац текста.', 50, 12), 700 - 24.01),
  ];
  const { paragraphs } = await build(lines);
  expect(paragraphs.length).toBe(2);
});

await test('RTL: gap just under 1.3x (15.59) merges into one paragraph', async () => {
  const lines = [
    mkLine(mkItem('السطر الأول من الفقرة هنا', 50, 12), 700, true),
    mkLine(mkItem('استمرار نفس الفقرة يظهر هنا', 50, 12), 700 - 15.59, true),
  ];
  const { paragraphs } = await build(lines);
  expect(paragraphs.length).toBe(1);
});

await test('RTL: gap just over 1.3x (15.61) breaks into two paragraphs', async () => {
  const lines = [
    mkLine(mkItem('السطر الأول من الفقرة هنا', 50, 12), 700, true),
    mkLine(mkItem('هذه فقرة جديدة تماما هنا', 50, 12), 700 - 15.61, true),
  ];
  const { paragraphs } = await build(lines);
  expect(paragraphs.length).toBe(2);
});

await test('CJK continuation (no terminal punctuation): gap just under 3.5x (41.99) merges', async () => {
  const lines = [
    mkLine(mkItem('これは最初の行のテキストです', 50, 12), 700),
    mkLine(mkItem('これは同じ段落の続きの行です', 50, 12), 700 - 41.99), // no 。！？ at end of line 1
  ];
  const { paragraphs } = await build(lines);
  expect(paragraphs.length).toBe(1);
});

await test('CJK continuation (no terminal punctuation): gap just over 3.5x (42.01) breaks', async () => {
  const lines = [
    mkLine(mkItem('これは最初の行のテキストです', 50, 12), 700),
    mkLine(mkItem('これは新しい段落のようです', 50, 12), 700 - 42.01),
  ];
  const { paragraphs } = await build(lines);
  expect(paragraphs.length).toBe(2);
});

await test('CJK line ending in terminal punctuation uses the 2.0x threshold, not 3.5x', async () => {
  // Regression target: if the !lastEndsSent check were dropped, this gap
  // (30, which is > 2.0x=24 but < 3.5x=42) would wrongly merge instead of
  // breaking — this pins the branch selection, not just the multiplier.
  const lines = [
    mkLine(mkItem('これは文の最初の行です。', 50, 12), 700), // ends with 。
    mkLine(mkItem('これは明らかに新しい段落です', 50, 12), 700 - 30),
  ];
  const { paragraphs } = await build(lines);
  expect(paragraphs.length).toBe(2);
});

console.log('\n_p2wBuildParagraphs — list detection never merges into surrounding paragraphs:');

await test('a bullet line between two prose lines stays a separate list Paragraph, marker stripped', async () => {
  const lines = [
    mkLine(mkItem('Первый абзац текста здесь.', 50, 12), 700),
    mkLine(mkItem('• Пункт списка один', 50, 12), 690),   // gap=10, well under merge threshold
    mkLine(mkItem('Второй абзац продолжается тут.', 50, 12), 680),
  ];
  const { paragraphs } = await build(lines);
  expect(paragraphs.length).toBe(3);
  expect(isListItem(paragraphs[1])).toBe(true);
  const txt = paragraphText(paragraphs[1]);
  expect(txt).toContain('Пункт списка один');
  if (txt.includes('•')) throw new Error('bullet marker should be stripped from list paragraph text');
});

await test('a numbered line between two prose lines stays separate, marker stripped', async () => {
  const lines = [
    mkLine(mkItem('Первый абзац текста здесь.', 50, 12), 700),
    mkLine(mkItem('1. Пункт номер один тут', 50, 12), 690),
    mkLine(mkItem('Второй абзац продолжается тут.', 50, 12), 680),
  ];
  const { paragraphs } = await build(lines);
  expect(paragraphs.length).toBe(3);
  expect(isListItem(paragraphs[1])).toBe(true);
  const txt = paragraphText(paragraphs[1]);
  expect(txt).toContain('Пункт номер один тут');
  if (/^\d/.test(txt)) throw new Error('numbered marker should be stripped from list paragraph text');
});

await test('a numbered line where the marker and text are SEPARATE items with no space between them still becomes a list item', async () => {
  // Real-world pdf.js extraction shape found via scripts/pdf2word_capability_map.mjs:
  // LibreOffice's rendered auto-number and the item text often come out as two
  // separate text items whose visual gap is purely positional (X-offset), with
  // no space character joining them — "1." immediately followed by "Numbered
  // item 1" once concatenated. This used to fall through to plain-paragraph
  // text (js/processor.js's NUMBERED_RE required a literal trailing \s+).
  const lines = [
    mkLine(mkItem('Первый абзац текста здесь.', 50, 12), 700),
    mkLine([mkItem('1.', 50, 12), mkItem('Пункт номер один тут', 65, 12)], 690),
    mkLine(mkItem('Второй абзац продолжается тут.', 50, 12), 680),
  ];
  const { paragraphs } = await build(lines);
  expect(paragraphs.length).toBe(3);
  expect(isListItem(paragraphs[1])).toBe(true);
  const txt = paragraphText(paragraphs[1]);
  expect(txt).toContain('Пункт номер один тут');
});

await test('a decimal number at the start of a line is NOT treated as a numbered-list marker', async () => {
  // Regression guard for the NUMBERED_RE fix above: loosening the marker
  // regex to also match a no-space "1.Text" shape must NOT also start
  // matching ordinary decimal numbers like "3.14 is pi" — that's exactly
  // why the fix used a negative lookahead (?!\d) instead of just widening
  // \s+ to \s*. Pinned here at the full _p2wBuildParagraphs level, not
  // just the regex in isolation (already covered in
  // tests/pdf2wordLists.test.js), so a future regression in how lines get
  // fed into NUMBERED_RE would be caught too, not only a regex-level one.
  const lines = [
    mkLine(mkItem('Первый абзац текста здесь.', 50, 12), 700),
    mkLine(mkItem('3.14 is the value of pi used throughout this section', 50, 12), 690),
    mkLine(mkItem('Второй абзац продолжается тут.', 50, 12), 680),
  ];
  const { paragraphs } = await build(lines);
  expect(isListItem(paragraphs.find(p => paragraphText(p).includes('3.14')))).toBe(false);
  // Also confirm it didn't get split into its own paragraph as a false
  // "heading" or "list" boundary — normal Y-gap merging still applies.
  expect(paragraphs.length).toBe(1);
});

console.log('\n_p2wBuildParagraphs — numbered-legal-clause false positive stays prose, not a table:');

// Same shape as tests/pdf2wordTables.test.js's rows_clause6 fixture (copied
// from a real 19-page contract), but expressed as pdf.js line items (clause
// number + prose as two separately-positioned items per line) and run
// through the full _p2wBuildParagraphs pipeline this time, not just the
// underlying guard in isolation.
await test('numbered legal clauses (2-column X-aligned) never become a Table', async () => {
  const clauses = [
    ['2.4.15.', 'имеются санкционные, комплаенс- или иные правовые ограничения.'],
    ['2.5.', 'Инвестиционный посредник не имеет право:'],
    ['2.5.1.', 'Оказывать услуги Инвестиционного посредника на рынке ценных бумаг без соответствующей лицензии или'],
  ];
  const lines = clauses.map(([num, text], i) =>
    mkLine([mkItem(num, 50, 12), mkItem(text, 120, 12)], 700 - i * 20));
  const { paragraphs, cs } = await build(lines);
  expect(paragraphs.some(isTable)).toBe(false);
  expect(cs.totalTables).toBe(0);
});

console.log('\n_p2wBuildParagraphs — useTables:false (ERI retry path) never produces a Table:');

await test('a genuine 2-column table becomes a Table when useTables is true', async () => {
  const rows = [['Name', 'Amount'], ['Alice', '100'], ['Bob', '200'], ['Carol', '300']];
  const lines = rows.map(([a, b], i) =>
    mkLine([mkItem(a, 50, 12), mkItem(b, 200, 12)], 700 - i * 20));
  const { paragraphs, cs } = await build(lines, 12, { useTables: true });
  expect(paragraphs.some(isTable)).toBe(true);
  expect(cs.totalTables).toBe(1);
});

await test('the same table fixture with useTables:false produces zero Table instances', async () => {
  const rows = [['Name', 'Amount'], ['Alice', '100'], ['Bob', '200'], ['Carol', '300']];
  const lines = rows.map(([a, b], i) =>
    mkLine([mkItem(a, 50, 12), mkItem(b, 200, 12)], 700 - i * 20));
  const { paragraphs, cs } = await build(lines, 12, { useTables: false });
  expect(paragraphs.some(isTable)).toBe(false);
  expect(cs.totalTables).toBe(0);
  if (paragraphs.length === 0) throw new Error('text content should not be silently dropped in the paragraphs-only retry');
});

console.log('\n_p2wBuildParagraphs — border-grid merged cell becomes a real gridSpan (end-to-end):');

// End-to-end regression for the gridSpan fix (js/pdf2wordBorders.js +
// js/processor.js's _activeDividersForY/_groupGridCellsWithSpans): a
// hand-built borderGrids entry shaped like the real detectTableGrids()
// output for a 3-row/3-col table whose middle row has a cell merged across
// the first two columns (colDividers' x=200 divider is present for rows 1
// and 3 but absent for row 2) — the exact real-page-18-tariff-table shape
// tests/pdf2wordBorders.test.js already covers at the detectTableGrids()
// level. This drives it through the FULL _p2wBuildParagraphs pipeline
// instead, confirming the 'grid' event handler actually wires
// _activeDividersForY/_groupGridCellsWithSpans's output into a real docx
// Table with a genuine columnSpan, not just that the helpers work in
// isolation.
await test('a border-grid row with a missing internal divider renders as one spanning ' +
     'cell (real w:gridSpan), and unmerged rows stay as separate cells', async () => {
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
  const { paragraphs } = await build(lines, 11, {}, [grid]);
  const tbl = paragraphs.find(isTable);
  if (!tbl) throw new Error('expected a Table instance in the output');
  const rows = tableRows(tbl);
  expect(rows.length).toBe(3);

  expect(rows[0].length).toBe(3);
  expect(rows[0].map(c => c.text).join('|')).toBe('Header|Q1|Q2');
  if (rows[0].some(c => c.span > 1)) throw new Error('row 1 has no merge — every cell should have span 1');

  expect(rows[1].length).toBe(2);
  expect(rows[1][0].text).toBe('Merged Region');
  expect(rows[1][0].span).toBe(2);
  expect(rows[1][1].text).toBe('Note');
  expect(rows[1][1].span).toBe(1);

  expect(rows[2].length).toBe(3);
  expect(rows[2].map(c => c.text).join('|')).toBe('Row3A|Row3B|Row3C');
  if (rows[2].some(c => c.span > 1)) throw new Error('row 3 has no merge — every cell should have span 1');
});

// ── Summary ──────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
