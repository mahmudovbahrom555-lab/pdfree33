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

// Flattens any block type's text content — 'heading'/'list' carry `.text`,
// 'para' carries `.runs` (array of {text,bold,italic}, see _lineRuns/
// _flushPara), 'table' carries `.rows` (array of arrays of cell strings) —
// so a block-type change (e.g. detectTables() classifying a clean small
// grid as a table instead of prose, which is correct, separate behavior
// this file isn't testing) can't be mistaken for lost data.
function allText(blocks) {
  return blocks.map(b => {
    if (b.type === 'table') return b.rows.flat().join(' ');
    if (b.type === 'para')  return b.runs.map(r => r.text).join('');
    return b.text || '';
  }).join(' ');
}

// ── Fake pdf.js plumbing ──────────────────────────────────────────

function makeItem(str, x, y, fontSize = 10, fontName = 'F1') {
  return {
    str,
    transform: [fontSize, 0, 0, fontSize, x, y],
    width: str.length * fontSize * 0.5,
    height: fontSize,
    fontName,
    dir: 'ltr',
  };
}

function makeFakePage(items, pageWidth = 600) {
  return {
    getViewport: () => ({ width: pageWidth, height: 800 }),
    getTextContent: async () => ({ items, styles: { F1: { fontFamily: 'sans-serif' } } }),
    getOperatorList: async () => {},
    commonObjs: { get: () => undefined },
    cleanup: () => {},
  };
}

function makeFakePdfDoc(pagesItems, pageWidth = 600) {
  return {
    numPages: pagesItems.length,
    getPage: async (n) => makeFakePage(pagesItems[n - 1], pageWidth),
  };
}

// A page whose fonts all report the SAME generic CSS fallback family
// ("sans-serif") via content.styles — the exact scenario pdf2word's own
// comment documents as breaking fontFamily-string-only bold detection —
// but whose commonObjs correctly resolves each font's real embedded name
// (e.g. "...-Bold" vs "...-Regular"), the way real pdf.js does once
// getOperatorList() has run. Only a working _isFontBold (commonObjs-based)
// can tell these two items apart; the old fontFamily-only check could not.
function makeFakePageWithFonts(items, fontBoldMap) {
  return {
    getViewport: () => ({ width: 600, height: 800 }),
    getTextContent: async () => ({
      items,
      styles: Object.fromEntries(Object.keys(fontBoldMap).map(f => [f, { fontFamily: 'sans-serif' }])),
    }),
    getOperatorList: async () => {},
    commonObjs: { get: (fontName) => ({ name: fontBoldMap[fontName] ? 'ABCDEF+NotoSans-Bold' : 'ABCDEF+NotoSans-Regular' }) },
    cleanup: () => {},
  };
}

function makeFakePdfDocWithFonts(items, fontBoldMap) {
  return { numPages: 1, getPage: async () => makeFakePageWithFonts(items, fontBoldMap) };
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

console.log('\nBold detection (commonObjs, not just fontFamily):');

await test('detects bold via page.commonObjs even when fontFamily is a generic fallback for both fonts', async () => {
  // Both fonts report the SAME "sans-serif" fontFamily in content.styles —
  // exactly the scenario that broke the old fontFamily-only check. Only
  // commonObjs (real embedded font name) tells "F-Bold" and "F-Regular"
  // apart here.
  const items = [
    makeItem('Plain text is here ', 50, 700, 10, 'F-Regular'),
    makeItem('important', 250, 700, 10, 'F-Bold'),
    makeItem(' word.', 350, 700, 10, 'F-Regular'),
  ];
  const pdfDoc = makeFakePdfDocWithFonts(items, { 'F-Regular': false, 'F-Bold': true });
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('**important**')).toBeTruthy();
  // Surrounding plain text must NOT be swept into the bold run.
  expect(md.includes('**Plain')).toBe(false);
  expect(md.includes('word.**')).toBe(false);
});

console.log('\nPer-run bold/italic in rendered Markdown:');

await test('a single bold word in the middle of a plain paragraph stays bold — rest stays plain (not old all-or-nothing)', async () => {
  const items = [
    makeItem('The quick ', 50, 700, 10, 'F-Plain'),
    makeItem('brown', 200, 700, 10, 'F-Bold'),
    makeItem(' fox jumps.', 280, 700, 10, 'F-Plain'),
  ];
  const pdfDoc = makeFakePdfDocWithFonts(items, { 'F-Plain': false, 'F-Bold': true });
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('The quick **brown** fox jumps.')).toBeTruthy();
});

await test('a fully bold line renders as one merged run, not one **wrap** per word', async () => {
  const items = [
    makeItem('All of this ', 50, 700, 10, 'F-Bold'),
    makeItem('is bold.', 180, 700, 10, 'F-Bold'),
  ];
  const pdfDoc = makeFakePdfDocWithFonts(items, { 'F-Bold': true });
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  // Exactly one "**" pair, not several — confirms adjacent same-format
  // items merged into a single run instead of wrapping each item alone.
  expect((md.match(/\*\*/g) || []).length).toBe(2);
  expect(md.includes('**All of this is bold.**')).toBeTruthy();
});

await test('a bold run with its own embedded leading/trailing spaces still wraps CommonMark-valid (markers touch real text, not whitespace)', async () => {
  // Item 2 deliberately carries its own leading/trailing space characters
  // (unusual, but pdf.js items can) — wrapRun must trim them OUTSIDE the
  // ** markers rather than wrapping "** bold phrase **", which most
  // Markdown parsers won't render as bold at all (whitespace immediately
  // inside the delimiters).
  const items = [
    makeItem('before', 50, 700, 10, 'F-Plain'),
    makeItem(' bold phrase ', 150, 700, 10, 'F-Bold'),
    makeItem('after', 300, 700, 10, 'F-Plain'),
  ];
  const pdfDoc = makeFakePdfDocWithFonts(items, { 'F-Plain': false, 'F-Bold': true });
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  // The exact valid form: markers directly against "bold phrase", not
  // "** bold phrase **" (which fails to parse as emphasis in CommonMark).
  expect(md.includes('**bold phrase**')).toBeTruthy();
  expect(md.includes('** bold') || md.includes('phrase **')).toBe(false);
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
