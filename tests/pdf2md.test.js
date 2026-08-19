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

// Same shape as makeFakePageWithFonts, but resolves each font to an arbitrary
// commonObjs name instead of a fixed Bold/Regular pair — needed to simulate a
// real math font (e.g. "ABCDEF+CMMI10") the way pdf.js resolves embedded
// LaTeX fonts, for formula-detection tests.
function makeFakePageWithFontNames(items, fontNameMap) {
  return {
    getViewport: () => ({ width: 600, height: 800 }),
    getTextContent: async () => ({
      items,
      styles: Object.fromEntries(Object.keys(fontNameMap).map(f => [f, { fontFamily: 'sans-serif' }])),
    }),
    getOperatorList: async () => {},
    commonObjs: { get: (fontName) => ({ name: fontNameMap[fontName] }) },
    cleanup: () => {},
  };
}

function makeFakePdfDocWithFontNames(items, fontNameMap) {
  return { numPages: 1, getPage: async () => makeFakePageWithFontNames(items, fontNameMap) };
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

console.log('\nHeading level detection (font-size ratio vs. page median):');

// Enough size-10 filler lines that the median stays anchored at 10 despite
// one larger heading line — matches _p2mdExtractText's real median (computed
// across ALL text on the page, not just the line under test).
function fillerItems(n, startY = 600) {
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push(makeItem(`Filler body sentence number ${i + 1} of ordinary length.`, 50, startY - i * 20));
  }
  return items;
}

await test('a line at >=2.2x median font size becomes an H1', async () => {
  const items = [makeItem('Top Level Heading Text', 50, 700, 22), ...fillerItems(6)];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const heading = blocks.find(b => b.type === 'heading');
  expect(!!heading).toBeTruthy();
  expect(heading.level).toBe(1);
});

await test('a line at >=1.7x (but <2.2x) median font size becomes an H2', async () => {
  const items = [makeItem('Second Level Heading Text', 50, 700, 17), ...fillerItems(6)];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const heading = blocks.find(b => b.type === 'heading');
  expect(!!heading).toBeTruthy();
  expect(heading.level).toBe(2);
});

await test('a line at >=1.3x (but <1.7x) median font size becomes an H3', async () => {
  const items = [makeItem('Third Level Heading Text', 50, 700, 13), ...fillerItems(6)];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const heading = blocks.find(b => b.type === 'heading');
  expect(!!heading).toBeTruthy();
  expect(heading.level).toBe(3);
});

await test('a line below 1.3x median font size stays a normal paragraph, not a heading', async () => {
  const items = [makeItem('Not Quite Big Enough To Be A Heading', 50, 700, 11), ...fillerItems(6)];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  expect(blocks.some(b => b.type === 'heading')).toBe(false);
});

console.log('\nList detection (bullet / numbered / plain):');

await test('a bulleted line becomes a Markdown list item', async () => {
  const items = [makeItem('• First bulleted item', 50, 700), ...fillerItems(4, 680)];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const list = blocks.find(b => b.type === 'list');
  expect(!!list).toBeTruthy();
  expect(list.text.startsWith('- ')).toBeTruthy();
});

await test('a numbered line becomes a Markdown ordered-list item', async () => {
  const items = [makeItem('1. First numbered item', 50, 700), ...fillerItems(4, 680)];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const list = blocks.find(b => b.type === 'list');
  expect(!!list).toBeTruthy();
  expect(/^\d+\.\s/.test(list.text)).toBeTruthy();
});

await test('an ordinary sentence starting with a number followed by a decimal is NOT mistaken for a list (e.g. "3.14 is pi")', async () => {
  const items = [makeItem('3.14 is an approximation of pi.', 50, 700), ...fillerItems(4, 680)];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  expect(blocks.some(b => b.type === 'list')).toBe(false);
});

console.log('\nTable structure detection:');

await test('a clean multi-row, multi-column grid of text becomes a table block', async () => {
  const items = [];
  const rows = [['Name', 'Role', 'Score'], ['Alice', 'Engineer', '92'], ['Bob', 'Designer', '87'], ['Carol', 'Analyst', '81']];
  rows.forEach((row, r) => {
    items.push(makeItem(row[0], 50, 700 - r * 20));
    items.push(makeItem(row[1], 200, 700 - r * 20));
    items.push(makeItem(row[2], 350, 700 - r * 20));
  });
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const table = blocks.find(b => b.type === 'table');
  expect(!!table).toBeTruthy();
  expect(table.rows.length).toBe(4);
  const md = _p2mdRender(blocks);
  expect(md.includes('| --- | --- | --- |')).toBeTruthy();
  expect(md.includes('Alice')).toBeTruthy();
});

console.log('\nWatermark / repeated-header suppression:');

await test('a short line repeated on all 3+ pages is suppressed from the output entirely', async () => {
  const pagesItems = [1, 2, 3].map(p => [
    makeItem('CONFIDENTIAL DRAFT', 250, 750),
    ...fillerItems(3, 700).map(it => ({ ...it, str: it.str.replace('number', `on page ${p} number`) })),
  ]);
  const pdfDoc = makeFakePdfDoc(pagesItems);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('CONFIDENTIAL DRAFT')).toBe(false);
  expect(md.includes('page 1')).toBeTruthy();
  expect(md.includes('page 3')).toBeTruthy();
});

console.log('\nEmbedded page-number suppression:');

await test('a bare integer alone on its own line near the bottom of the page is dropped as a page number', async () => {
  const items = [
    ...fillerItems(4, 700),
    makeItem('42', 300, 100), // isolated single-item line near the bottom
  ];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  // The bare "42" page number must not appear as its own block; a "42" that
  // happened to be part of ordinary body text elsewhere would be a separate,
  // legitimate case this test isn't constructing.
  expect(blocks.some(b => b.type === 'para' && b.runs.some(r => r.text.trim() === '42'))).toBe(false);
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

console.log('\nBold-heading fallback (same-size-but-bold section titles, ported from pdf2word\'s _isBoldHeadingLine):');

await test('a same-size all-bold ALL-CAPS line followed by a paragraph becomes an H1', async () => {
  const items = [
    makeItem('SECTION OVERVIEW', 50, 700, 10, 'F-Bold'),
    ...fillerItems(4, 680),
  ];
  const pdfDoc = makeFakePdfDocWithFonts(items, { 'F-Bold': true, 'F1': false });
  const blocks = await _p2mdExtractText(pdfDoc);
  const heading = blocks.find(b => b.type === 'heading');
  expect(!!heading).toBeTruthy();
  expect(heading.level).toBe(1);
});

await test('a same-size all-bold mixed-case line followed by a paragraph becomes an H2, not H1', async () => {
  const items = [
    makeItem('Section Overview', 50, 700, 10, 'F-Bold'),
    ...fillerItems(4, 680),
  ];
  const pdfDoc = makeFakePdfDocWithFonts(items, { 'F-Bold': true, 'F1': false });
  const blocks = await _p2mdExtractText(pdfDoc);
  const heading = blocks.find(b => b.type === 'heading');
  expect(!!heading).toBeTruthy();
  expect(heading.level).toBe(2);
});

await test('a same-size all-bold line with nothing after it (end of page) is NOT promoted — the fallback requires a following line', async () => {
  const items = [
    ...fillerItems(4, 700),
    makeItem('Trailing Bold Signature', 50, 700 - 4 * 20, 10, 'F-Bold'),
  ];
  const pdfDoc = makeFakePdfDocWithFonts(items, { 'F-Bold': true, 'F1': false });
  const blocks = await _p2mdExtractText(pdfDoc);
  expect(blocks.some(b => b.type === 'heading')).toBe(false);
});

await test('a partial-line bold phrase (not the whole line) is never promoted via the bold-heading fallback', async () => {
  const items = [
    makeItem('Please note the ', 50, 700, 10, 'F-Plain'),
    makeItem('important detail', 220, 700, 10, 'F-Bold'),
    makeItem(' before continuing.', 380, 700, 10, 'F-Plain'),
    ...fillerItems(4, 680),
  ];
  const pdfDoc = makeFakePdfDocWithFonts(items, { 'F-Plain': false, 'F-Bold': true, 'F1': false });
  const blocks = await _p2mdExtractText(pdfDoc);
  expect(blocks.some(b => b.type === 'heading')).toBe(false);
});

await test('a long all-bold line (over the 100-char cap) is not promoted — too long to be a real heading', async () => {
  const longText = 'This is a long all-bold sentence that goes on for quite a while and should not be mistaken for a short section heading, since real headings are short.';
  const items = [
    makeItem(longText, 50, 700, 10, 'F-Bold'),
    ...fillerItems(4, 680),
  ];
  const pdfDoc = makeFakePdfDocWithFonts(items, { 'F-Bold': true, 'F1': false });
  const blocks = await _p2mdExtractText(pdfDoc);
  expect(blocks.some(b => b.type === 'heading')).toBe(false);
});

console.log('\nFormula detection (honest flattening — see js/processor.js\'s isFormula comment):');

await test('a run in a known LaTeX math font (resolved via commonObjs) is wrapped as inline $...$', async () => {
  const items = [
    makeItem('The formula is ', 50, 700, 10, 'F-Plain'),
    makeItem('x=y+z', 220, 700, 10, 'F-Math'),
    makeItem(' in this paper.', 320, 700, 10, 'F-Plain'),
  ];
  const pdfDoc = makeFakePdfDocWithFontNames(items, {
    'F-Plain': 'ABCDEF+NotoSans',
    'F-Math':  'ABCDEF+CMMI10',
  });
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('$x=y+z$')).toBeTruthy();
});

await test('a math-operator glyph in an ordinary font is wrapped, even with no math-font hint', async () => {
  const items = [
    makeItem('The sum ', 50, 700),
    makeItem('∑x', 150, 700),
    makeItem(' converges.', 220, 700),
  ];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('$∑x$')).toBeTruthy();
});

await test('an arrow in ordinary UI-style instruction text is NOT wrapped as a formula (deliberate false-negative)', async () => {
  const items = [makeItem('Click File → Export to continue.', 50, 700), ...fillerItems(4, 680)];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('$')).toBe(false);
});

await test('formula wins over bold — a math-font run that also matches the bold-name pattern renders as $...$, not **...**', async () => {
  const items = [
    makeItem('See equation ', 50, 700, 10, 'F-Plain'),
    makeItem('a+b=c', 250, 700, 10, 'F-MathBold'),
    makeItem(' below.', 350, 700, 10, 'F-Plain'),
  ];
  const pdfDoc = makeFakePdfDocWithFontNames(items, {
    'F-Plain':    'ABCDEF+NotoSans',
    'F-MathBold': 'ABCDEF+CMBSY10-Bold', // matches both MATH_FONT_RE and the bold heuristic
  });
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('$a+b=c$')).toBeTruthy();
  expect(md.includes('**a+b=c**')).toBe(false);
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
