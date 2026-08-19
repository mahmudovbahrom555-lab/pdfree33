// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/pdf2md.test.js — regression tests for _p2mdExtractText()/
//  _p2mdRender() (js/processor.js), pdf2md's text extraction and
//  Markdown rendering pass. Previously module-private with zero
//  coverage — see the pdf2md analysis this fixes: pdf2md never called
//  pdf2word's column-split fix (_splitCrossColumnLines/
//  detectColumnRegions), so a genuine 2-column PDF interleaved both
//  columns' text mid-sentence, the exact bug pdf2word fixed. This file
//  exists specifically to pin that fix in pdf2md too, so it can't
//  silently regress.
//
//  _p2mdExtractText takes a pdfDoc directly (unlike pdf2word, which
//  splits parsing from block-building into two separately-testable
//  functions) — so this uses a minimal fake pdf.js PDFDocumentProxy
//  (getPage/getViewport/getTextContent/cleanup) shaped like real pdf.js
//  output, rather than pre-built line fixtures like
//  tests/pdf2wordParagraphs.test.js uses. The column-detection algorithm
//  itself (detectColumnRegions/pageIsRtl/_splitCrossColumnLines) is
//  already covered by tests/pdf2wordColumns.test.js — this file tests
//  that pdf2md actually WIRES that algorithm in and dispatches by
//  region in reading order, not the algorithm's own internals again.
//
// Run: node tests/pdf2md.test.js
global.window = { PDFREE_LOCALE: {} };
global.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add(){}, remove(){}, contains(){ return false; } }, appendChild(){}, removeChild(){}, setAttribute(){} }),
  body: { appendChild(){}, removeChild(){} },
};
global.Worker = class { postMessage(){} terminate(){} addEventListener(){} };

const { _p2mdExtractText, _p2mdRender, _setProcessingForTests } = await import('../js/processor.js');
_setProcessingForTests(true);

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe: (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy: () => { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
    toBeLessThan: (e) => { if (!(actual < e)) throw new Error(`Expected ${actual} < ${e}`); },
  };
}

// Flattens any block type's text content — 'para'/'heading'/'list' carry
// `.text`, 'table' carries `.rows` (array of arrays of cell strings) —
// so a block-type change (e.g. detectTables() classifying a clean small
// grid as a table instead of prose, which is correct, separate behavior
// this file isn't testing) can't be mistaken for lost data.
function allText(blocks) {
  return blocks.map(b => b.type === 'table' ? b.rows.flat().join(' ') : (b.text || '')).join(' ');
}

// ── Fake pdf.js plumbing ──────────────────────────────────────────

function makeItem(str, x, y, fontSize = 10) {
  return {
    str,
    transform: [fontSize, 0, 0, fontSize, x, y],
    width: str.length * fontSize * 0.5,
    height: fontSize,
    fontName: 'F1',
    dir: 'ltr',
  };
}

function makeFakePage(items, pageWidth = 600) {
  return {
    getViewport: () => ({ width: pageWidth, height: 800 }),
    getTextContent: async () => ({ items, styles: { F1: { fontFamily: 'sans-serif' } } }),
    cleanup: () => {},
  };
}

function makeFakePdfDoc(pagesItems, pageWidth = 600) {
  return {
    numPages: pagesItems.length,
    getPage: async (n) => makeFakePage(pagesItems[n - 1], pageWidth),
  };
}

// A real 2-column page: 12 rows, each with a left-column item (x=50) and a
// right-column item (x=350) at the SAME y — this is the exact merged-line
// shape _splitCrossColumnLines exists to un-merge (same Y per row is the
// common case on a real 2-column page, per its own doc comment). 12 rows
// clears detectColumnRegions' `lines.length >= MIN_LINES_ABS*2` (10) gate
// on the pre-split merged-line count, not just the post-split candidate
// count — matters because that gate runs once during _splitCrossColumnLines
// (on the still-merged 12 lines) and again during block-building dispatch
// (on the post-split 24 lines).
function twoColumnPageItems() {
  const items = [];
  for (let row = 0; row < 12; row++) {
    const y = 700 - row * 20;
    items.push(makeItem(`Left${row}`, 50, y));
    items.push(makeItem(`Right${row}`, 350, y));
  }
  return items;
}

// ── Tests ──────────────────────────────────────────────────────────

console.log('\n_p2mdExtractText — 2-column pages:');

await test('a genuine 2-column page reads left column fully, then right column (not interleaved by row)', async () => {
  const pdfDoc = makeFakePdfDoc([twoColumnPageItems()]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const text = allText(blocks);

  // Correct: every "LeftN" appears before every "RightN" in the output.
  const lastLeftIdx  = text.lastIndexOf('Left11');
  const firstRightIdx = text.indexOf('Right0');
  expect(lastLeftIdx).toBeTruthy();
  expect(firstRightIdx).toBeTruthy();
  expect(lastLeftIdx).toBeLessThan(firstRightIdx);
});

await test('a genuine 2-column page: all 12 left-column rows appear in order, uninterrupted by right-column text', async () => {
  const pdfDoc = makeFakePdfDoc([twoColumnPageItems()]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const text = allText(blocks);

  const leftPositions = [];
  for (let row = 0; row < 12; row++) leftPositions.push(text.indexOf(`Left${row}`));
  for (let i = 1; i < leftPositions.length; i++) {
    if (leftPositions[i] <= leftPositions[i - 1]) {
      throw new Error(`Left${i} did not come after Left${i - 1} — columns interleaved`);
    }
  }
});

await test('rendered Markdown: two-column page still produces valid, non-empty output', async () => {
  const pdfDoc = makeFakePdfDoc([twoColumnPageItems()]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.length > 0).toBeTruthy();
  expect(md.includes('Left0')).toBeTruthy();
  expect(md.includes('Right11')).toBeTruthy();
});

console.log('\n_p2mdExtractText — single-column pages (regression guard):');

await test('an ordinary single-column page is not affected by the column-split path', async () => {
  const items = [];
  for (let row = 0; row < 8; row++) {
    items.push(makeItem(`Line${row} of a normal single-column page.`, 50, 700 - row * 20));
  }
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const text = allText(blocks);
  for (let row = 0; row < 8; row++) expect(text.includes(`Line${row}`)).toBeTruthy();
  // Still in top-to-bottom order.
  expect(text.indexOf('Line0') < text.indexOf('Line7')).toBeTruthy();
});

await test('a short page (below the column-detection line-count floor) is not mistakenly split', async () => {
  // Only 3 rows total — even with 2 "columns" per row this can never clear
  // detectColumnRegions' minimum-lines gate, so it must fall through to the
  // single unsplit path (detectColumnRegions returning null is the "prefer
  // false negatives" common case this whole feature is built around).
  const items = [
    makeItem('LeftA', 50, 700), makeItem('RightA', 350, 700),
    makeItem('LeftB', 50, 680), makeItem('RightB', 350, 680),
    makeItem('LeftC', 50, 660), makeItem('RightC', 350, 660),
  ];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const text = allText(blocks);
  // Not asserting a specific order here (too little data for either
  // algorithm to be "correct") — only that nothing crashes and all text
  // still makes it into the output somewhere.
  for (const t of ['LeftA', 'RightA', 'LeftB', 'RightB', 'LeftC', 'RightC']) {
    expect(text.includes(t)).toBeTruthy();
  }
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
