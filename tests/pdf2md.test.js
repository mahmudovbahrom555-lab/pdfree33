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
  // Canvas-shaped enough for the display-formula-crop path in
  // _p2mdExtractText (page.render + crop + toBlob) — drawImage/getContext
  // are no-ops, toBlob resolves a real (tiny, content-irrelevant) Blob so
  // the "did this line become an image block" assertion path works without
  // a real Canvas implementation in Node.
  createElement: () => ({
    style: {}, classList: { add(){}, remove(){}, contains(){ return false; } },
    appendChild(){}, removeChild(){}, setAttribute(){},
    width: 0, height: 0,
    getContext: () => ({ drawImage(){} }),
    toBlob: (cb) => cb(new Blob(['fake-png'], { type: 'image/png' })),
  }),
  body: { appendChild(){}, removeChild(){} },
};
global.Worker = class { postMessage(){} terminate(){} addEventListener(){} };

// _p2mdExtractText/_p2mdRender/_detectPageImages moved to js/pdf2mdCore.js
// (browser-independent core, reused by packages/pdf2md-core/). Default
// isCancelled (never-cancel) matches this test's previous reliance on
// _setProcessingForTests(true) keeping module-level isProcessing truthy.
const { _p2mdExtractText, _p2mdRender, _detectPageImages } = await import('../js/pdf2mdCore.js');

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

// Real pdf.js's PageViewport.convertToViewportPoint maps PDF user-space
// (bottom-left origin) to canvas pixel space (top-left origin) — a plain
// scale + Y-flip for an unrotated page, which is all the fake needs to
// mimic for the display-formula-crop path's corner-transform to produce a
// sane (non-zero, non-NaN) crop rect.
function _fakeViewport(scale, pageWidth, pageHeight = 800) {
  return {
    width: pageWidth * scale, height: pageHeight * scale,
    convertToViewportPoint: (x, y) => [x * scale, (pageHeight - y) * scale],
  };
}

function makeFakePage(items, pageWidth = 600) {
  return {
    getViewport: ({ scale = 1 } = {}) => scale === 1
      ? { width: pageWidth, height: 800 }
      : _fakeViewport(scale, pageWidth),
    getTextContent: async () => ({ items, styles: { F1: { fontFamily: 'sans-serif' } } }),
    getOperatorList: async () => {},
    commonObjs: { get: () => undefined },
    render: () => ({ promise: Promise.resolve() }),
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
function makeFakePageWithFontNames(items, fontNameMap, pageWidth = 600) {
  return {
    getViewport: ({ scale = 1 } = {}) => scale === 1
      ? { width: pageWidth, height: 800 }
      : _fakeViewport(scale, pageWidth),
    getTextContent: async () => ({
      items,
      styles: Object.fromEntries(Object.keys(fontNameMap).map(f => [f, { fontFamily: 'sans-serif' }])),
    }),
    getOperatorList: async () => {},
    commonObjs: { get: (fontName) => ({ name: fontNameMap[fontName] }) },
    render: () => ({ promise: Promise.resolve() }),
    cleanup: () => {},
  };
}

function makeFakePdfDocWithFontNames(items, fontNameMap, pageWidth = 600) {
  return { numPages: 1, getPage: async () => makeFakePageWithFontNames(items, fontNameMap, pageWidth) };
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

await test('detects bold via LaTeX Computer Modern\'s "BX" naming (CMBX), which contains no literal "bold"/"heavy"/"black"', async () => {
  // Found on a real arXiv two-column paper: a section heading used font
  // "XSNTAV+CMBX9" (Computer Modern Bold Extended) -- the old
  // /bold|heavy|black/i regex never matches "CMBX9" at all, silently
  // scoring the heading as non-bold.
  const items = [
    makeItem('Plain body text ', 50, 700, 10, 'F-Regular'),
    makeItem('Section Title', 250, 700, 10, 'F-CM-Bold'),
  ];
  const pdfDoc = makeFakePdfDocWithFontNames(items, {
    'F-Regular': 'ABCDEF+CMR10',
    'F-CM-Bold': 'XSNTAV+CMBX9',
  });
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('**Section Title**')).toBeTruthy();
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

await test('a bold line containing a comma-grouped currency amount is NOT promoted — real financial ledger subtotal/closing-balance rows, not a heading', async () => {
  // Real case: Atlas_DR's md_corpus/003-multipage-ledger had
  // "Subtotal thru 04/23 28,971.05 21,945.70" and
  // "04/30 Closing Balance 38,744.05" both wrongly promoted to H2 before
  // this guard.
  const items = [
    makeItem('Subtotal thru 04/23 28,971.05 21,945.70', 50, 700, 10, 'F-Bold'),
    ...fillerItems(4, 680),
  ];
  const pdfDoc = makeFakePdfDocWithFonts(items, { 'F-Bold': true, 'F1': false });
  const blocks = await _p2mdExtractText(pdfDoc);
  expect(blocks.some(b => b.type === 'heading')).toBe(false);
});

console.log('\nNumbered-heading vs numbered-list disambiguation:');

await test('an isolated bold numbered line ("1. Introduction") followed by a paragraph becomes a heading, not a list item', async () => {
  const items = [
    makeItem('1. Introduction', 50, 700, 10, 'F-Bold'),
    ...fillerItems(4, 680),
  ];
  const pdfDoc = makeFakePdfDocWithFonts(items, { 'F-Bold': true, 'F1': false });
  const blocks = await _p2mdExtractText(pdfDoc);
  expect(blocks.some(b => b.type === 'list')).toBe(false);
  const heading = blocks.find(b => b.type === 'heading');
  expect(!!heading).toBeTruthy();
  expect(heading.text.includes('1. Introduction')).toBeTruthy();
});

await test('a real numbered list (consecutive numbered lines) stays a list even when bold, not promoted to headings', async () => {
  const items = [
    makeItem('1. First bold step', 50, 700, 10, 'F-Bold'),
    makeItem('2. Second bold step', 50, 680, 10, 'F-Bold'),
    makeItem('3. Third bold step', 50, 660, 10, 'F-Bold'),
  ];
  const pdfDoc = makeFakePdfDocWithFonts(items, { 'F-Bold': true });
  const blocks = await _p2mdExtractText(pdfDoc);
  expect(blocks.filter(b => b.type === 'list').length).toBe(3);
  expect(blocks.some(b => b.type === 'heading')).toBe(false);
});

await test('a plain (non-bold, non-oversized) numbered line stays a list item — unchanged regression guard', async () => {
  const items = [makeItem('1. First numbered item', 50, 700), ...fillerItems(4, 680)];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const list = blocks.find(b => b.type === 'list');
  expect(!!list).toBeTruthy();
  expect(blocks.some(b => b.type === 'heading')).toBe(false);
});

console.log('\nImage detection (position via operator-list CTM tracking):');

// Fake operator-list opcodes — must match the real pdfjs 3.x numeric values
// _detectPageImages hardcodes (see its own comment): save=10, restore=11,
// transform=12, paintFormXObjectBegin=74, paintFormXObjectEnd=75,
// paintImageXObject=85.
const OP_SAVE = 10, OP_RESTORE = 11, OP_TRANSFORM = 12, OP_FORM_BEGIN = 74, OP_FORM_END = 75, OP_PAINT = 85;
function makeOpList(fnArray, argsArray) { return { fnArray, argsArray }; }

await test('a simple unrotated image (transform + paint) gets the correct bounding box', async () => {
  // cm [200,0,0,150,50,600] places the unit square at x=50,y=600, 200x150.
  const opList = makeOpList([OP_TRANSFORM, OP_PAINT], [[200, 0, 0, 150, 50, 600], ['img1']]);
  const found = _detectPageImages(opList);
  expect(found.length).toBe(1);
  expect(found[0].x).toBe(50);
  expect(found[0].yTop).toBe(750);   // PDF Y increases upward — top = y + height
  expect(found[0].width).toBe(200);
  expect(found[0].height).toBe(150);
});

await test('a 90°-rotated image gets a correct (non-zero) bounding box — NOT Math.abs(ctm.a)/Math.abs(ctm.d)', async () => {
  // cm [0,100,-150,0,300,400] is a pure rotation+scale with a==0 and d==0 —
  // the naive Math.abs(ctm[0])/Math.abs(ctm[3]) approach (rejected during
  // review) would compute a 0×0 box here and silently drop the image
  // entirely. The correct 4-corner-transform approach must not.
  const opList = makeOpList([OP_TRANSFORM, OP_PAINT], [[0, 100, -150, 0, 300, 400], ['img-rot']]);
  const found = _detectPageImages(opList);
  expect(found.length).toBe(1);
  expect(found[0].x).toBe(150);
  expect(found[0].yTop).toBe(500);
  expect(found[0].width).toBe(150);
  expect(found[0].height).toBe(100);
});

await test('save/restore nesting isolates a transform to its own scope', async () => {
  // Inner image is scaled+placed inside a save/restore pair; after restore,
  // a second image painted with NO further transform must use the
  // OUTER (identity) CTM, not leak the inner one.
  const opList = makeOpList(
    [OP_SAVE, OP_TRANSFORM, OP_PAINT, OP_RESTORE, OP_TRANSFORM, OP_PAINT],
    [[], [50, 0, 0, 50, 0, 0], ['img-inner'], [], [60, 0, 0, 60, 0, 0], ['img-outer']]
  );
  const found = _detectPageImages(opList);
  expect(found.length).toBe(2);
  expect(found[0].width).toBe(50);
  expect(found[1].width).toBe(60); // NOT 50*60 or otherwise contaminated by the inner scope
});

await test('an image inside a Form XObject composes the form\'s own placement matrix on top of the outer CTM', async () => {
  // Form XObject begin carries its own [a,b,c,d,e,f] placement matrix
  // (args[0]) applied like an implicit extra "cm" — pdf.js flattens a form's
  // operators into the page's own operator list bracketed by these two ops
  // (see js/pdf2wordBorders.js's detectTableGrids, which solves the exact
  // same problem for table-border lines). A naive save/restore-only stack
  // that ignores paintFormXObjectBegin's own matrix would place this image
  // at the wrong (unshifted) position.
  const opList = makeOpList(
    [OP_SAVE, OP_FORM_BEGIN, OP_TRANSFORM, OP_PAINT, OP_FORM_END, OP_RESTORE],
    [[], [[1, 0, 0, 1, 20, 20]], [100, 0, 0, 80, 0, 0], ['img-in-form'], [], []]
  );
  const found = _detectPageImages(opList);
  expect(found.length).toBe(1);
  expect(found[0].x).toBe(20);
  expect(found[0].yTop).toBe(100);
  expect(found[0].width).toBe(100);
  expect(found[0].height).toBe(80);
});

await test('an icon/bullet-sized image (below the 40pt floor) is filtered out', async () => {
  const opList = makeOpList([OP_TRANSFORM, OP_PAINT], [[20, 0, 0, 15, 0, 0], ['img-tiny']]);
  const found = _detectPageImages(opList);
  expect(found.length).toBe(0);
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

await test('a Greek letter in an ordinary font is wrapped as a formula (real STEM variable, e.g. θ), on an otherwise-Latin page', async () => {
  const items = [
    makeItem('The value ', 50, 700),
    makeItem('θ', 150, 700),
    makeItem(' is small.', 170, 700),
  ];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('$θ$')).toBeTruthy();
});

await test('a genuinely Greek-LANGUAGE page (high Greek character density) does NOT get its Greek letters wrapped as formula', async () => {
  const items = [
    makeItem('Αυτό είναι ένα κείμενο γραμμένο εξ ολοκλήρου στα ελληνικά χωρίς μαθηματικούς τύπους.', 50, 700),
  ];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('$')).toBe(false);
});

await test('a real English sentence carrying ONE Greek-letter acronym (e.g. "flat ΛCDM") as a single merged text item is NOT wrapped whole', async () => {
  // Regression guard for a real false positive found on a real arXiv paper:
  // pdf.js can return an entire justified sentence as ONE text item, and a
  // bare "does this item contain any Greek codepoint" check flagged the
  // WHOLE ~50-character item as formula over one embedded acronym letter,
  // silently swallowing a readable sentence into an unrelated image crop.
  const items = [makeItem('an impressive agreement with the standard flat ΛCDM model for angular scales', 50, 700)];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  expect(blocks.some(b => b.type === 'image')).toBe(false);
  const md = _p2mdRender(blocks);
  expect(md.includes('$')).toBe(false);
  expect(md.includes('ΛCDM')).toBeTruthy();
});

console.log('\nDisplay-formula crop (standalone equation line -> image, see js/processor.js\'s FORMULA_MIN_FRACTION comment):');

await test('a narrow, all-formula standalone line becomes an image block, not $...$ text', async () => {
  const items = [makeItem('E=mc2', 250, 700, 14, 'F-Math')];
  const pdfDoc = makeFakePdfDocWithFontNames(items, { 'F-Math': 'ABCDEF+CMMI10' });
  const blocks = await _p2mdExtractText(pdfDoc);
  const img = blocks.find(b => b.type === 'image');
  expect(!!img).toBeTruthy();
  // Best-effort raw text as alt — non-vision text consumers still get a signal — but
  // labeled "approx." rather than presented as a faithful transcription (see
  // js/processor.js's rawAlt/altText comment).
  expect(img.alt).toBe('formula (approx., may not preserve exact layout): E=mc2');
  expect(/formula\d+\.png$/.test(img.filename)).toBeTruthy();
  const md = _p2mdRender(blocks);
  expect(md.includes('$E=mc2$')).toBe(false); // consumed by the image, not also flattened as text
  expect(md.includes('![formula (approx., may not preserve exact layout): E=mc2](')).toBeTruthy();
});

await test('an all-formula line WIDER than the page-fraction cap stays as $...$ text, not an image', async () => {
  const items = [
    makeItem('∑(x)', 50, 700, 10, 'F-Math'),
    makeItem('∫(y)dy', 480, 700, 10, 'F-Math'),
  ];
  const pdfDoc = makeFakePdfDocWithFontNames(items, { 'F-Math': 'ABCDEF+CMMI10' });
  const blocks = await _p2mdExtractText(pdfDoc);
  expect(blocks.some(b => b.type === 'image')).toBe(false);
  const md = _p2mdRender(blocks);
  expect(md.includes('$')).toBeTruthy();
});

await test('a short formula run mixed into a longer prose line (existing inline case) is unaffected — stays $...$, no image', async () => {
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
  expect(blocks.some(b => b.type === 'image')).toBe(false);
  const md = _p2mdRender(blocks);
  expect(md.includes('$x=y+z$')).toBeTruthy();
});

// ── Hyphen-orphan repair (joinHyphenatedLineEnd wired into _flushPara) ──
// Unit coverage for the pure decision function itself lives in
// tests/textLayoutUtils.test.js — these are end-to-end: real pdf.js-shaped
// two-line input, through the full paragraph-merge + run-join pipeline.

await test('a word broken across two lines by a soft PDF line-wrap hyphen is rejoined, hyphen dropped', async () => {
  const items = [
    makeItem('This word is informa-', 50, 700, 10, 'F-Plain'),
    makeItem('tion that continues normally.', 50, 688, 10, 'F-Plain'),
  ];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('This word is information that continues normally.')).toBeTruthy();
  expect(md.includes('informa-')).toBe(false);
});

await test('a real hard-hyphenated compound word broken at its own hyphen keeps the hyphen (exception dictionary)', async () => {
  const items = [
    makeItem('We used a well-', 50, 700, 10, 'F-Plain'),
    makeItem('known approach for this.', 50, 688, 10, 'F-Plain'),
  ];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('We used a well-known approach for this.')).toBeTruthy();
});

await test('an ALL-CAPS stem (acronym) keeps its hyphen even outside the exception dictionary', async () => {
  const items = [
    makeItem('The system is NASA-', 50, 700, 10, 'F-Plain'),
    makeItem('approved for launch.', 50, 688, 10, 'F-Plain'),
  ];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('The system is NASA-approved for launch.')).toBeTruthy();
});

await test('a line ending in a hyphen followed by a CAPITALIZED next line is NOT joined (new sentence, not a broken word)', async () => {
  const items = [
    makeItem('The results were inconclusive-', 50, 700, 10, 'F-Plain'),
    makeItem('Further study is needed.', 50, 688, 10, 'F-Plain'),
  ];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('inconclusive- Further') || md.includes('inconclusive-\nFurther')).toBeTruthy();
});

await test('a math-font run ending in a hyphen-like glyph is never rewritten (formula protection)', async () => {
  const items = [
    makeItem('a-', 50, 700, 10, 'F-Math'),
    makeItem('b continues the expression.', 50, 688, 10, 'F-Plain'),
  ];
  const pdfDoc = makeFakePdfDocWithFontNames(items, {
    'F-Math':  'ABCDEF+CMMI10',
    'F-Plain': 'ABCDEF+NotoSans',
  });
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  // formula run stays intact ($a-$), never silently merged into the next word
  expect(md.includes('$a-$')).toBeTruthy();
});

// ── Markdown-special-character escaping (_escapeMdText, js/pdf2mdCore.js) ──
// Real bug found via scripts/pdf2md_benchmark.mjs's first real-document run:
// a real academic paper's footnote marker ("*indicates the corresponding
// author") produced Markdown with an unbalanced "**" count — the literal
// "*" from the source PDF was never escaped before being emitted.

await test('a literal "*" in ordinary (non-bold) extracted text is escaped, not left to corrupt Markdown', async () => {
  const items = [makeItem('See the *footnote marker for details.', 50, 700), ...fillerItems(4, 680)];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('\\*footnote')).toBeTruthy();
  expect(md.includes('*footnote') && !md.includes('\\*footnote')).toBe(false);
});

await test('a literal "*" immediately before a real bold run is escaped, leaving the bold markers correctly paired', async () => {
  // The exact real-world shape that caught this: plain text ending in a
  // literal "*" (a footnote/citation marker), followed elsewhere on the
  // page by a genuinely bold run — before the fix, the source "*" was
  // emitted raw, an UNESCAPED asterisk sitting right next to the bold
  // run's own "**" markers. Counting every "*" char (escaped or not, as an
  // earlier version of this test did) is the wrong check — "\*" is exactly
  // one correctly-neutralized literal character, not half of a broken
  // pair. The real invariant: no UNESCAPED "*" should be left unpaired.
  const items = [
    makeItem('Results were significant *', 50, 700, 10, 'F-Plain'),
    makeItem('Important', 50, 688, 10, 'F-Bold'),
    makeItem(' finding follows.', 200, 688, 10, 'F-Plain'),
  ];
  const pdfDoc = makeFakePdfDocWithFonts(items, { 'F-Plain': false, 'F-Bold': true });
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('significant \\*')).toBeTruthy();
  const unescapedStarCount = (md.match(/(?<!\\)\*/g) || []).length;
  expect(unescapedStarCount % 2).toBe(0);
});

await test('a literal "*" in a heading is escaped', async () => {
  const items = [makeItem('Section *1: Overview', 50, 700, 22), ...fillerItems(6)];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('# Section \\*1: Overview')).toBeTruthy();
});

await test('a literal "*" in a bulleted list item is escaped, marker itself stays unescaped', async () => {
  const items = [makeItem('• Item with a *marker in it', 50, 700)];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('- Item with a \\*marker in it')).toBeTruthy();
});

await test('bold/italic formatting markers this code adds itself are never escaped (only source text is)', async () => {
  const items = [makeItem('All of this is bold.', 50, 700, 10, 'F-Bold')];
  const pdfDoc = makeFakePdfDocWithFonts(items, { 'F-Bold': true });
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('**All of this is bold.**')).toBeTruthy();
});

await test('a literal underscore/backtick/bracket in extracted text is also escaped', async () => {
  const items = [makeItem('The variable my_var uses `code` and [brackets].', 50, 700), ...fillerItems(4, 680)];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('my\\_var')).toBeTruthy();
  expect(md.includes('\\`code\\`')).toBeTruthy();
  expect(md.includes('\\[brackets\\]')).toBeTruthy();
});

// ── "No extractable text" OCR hint — reachable for a real scan, not just ──
// a fully-empty page. Real gap found via scripts/pdf2md_benchmark.mjs's own
// scanned.pdf case: the hint used to only fire when `blocks` was completely
// empty, but a genuine full-page scan successfully extracts as a real
// embedded IMAGE block in the browser (canvasFactory is always available
// there) — leaving the most realistic real-world scanned-document shape
// with zero guidance. Full end-to-end fixture (not just _detectPageImages
// in isolation, unlike the earlier image-detection tests above): a page
// with NO text items at all, but a real image paint op + a resolvable
// page.objs.get(), so the image genuinely makes it through
// _p2mdExtractImageBlob into a real 'image' block.
function makeFakeImageOnlyPage(pageWidth = 600, pageHeight = 800) {
  const opList = { fnArray: [OP_TRANSFORM, OP_PAINT], argsArray: [[200, 0, 0, 150, 50, 600], ['img1']] };
  return {
    getViewport: ({ scale = 1 } = {}) => scale === 1
      ? { width: pageWidth, height: pageHeight }
      : _fakeViewport(scale, pageWidth, pageHeight),
    getTextContent: async () => ({ items: [], styles: {} }),
    getOperatorList: async () => opList,
    commonObjs: { get: () => undefined },
    objs: { get: (id, cb) => cb({ bitmap: {}, width: 200, height: 150 }) },
    render: () => ({ promise: Promise.resolve() }),
    cleanup: () => {},
  };
}

await test('a fully empty page (no text, no image) still gets the "no extractable text" hint — unchanged baseline', async () => {
  const pdfDoc = makeFakePdfDoc([[]]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('No extractable text was found')).toBeTruthy();
});

await test('a real full-page scan (no text, but a real extracted image) ALSO gets the OCR hint, alongside the image — not silently just the image', async () => {
  const pdfDoc = { numPages: 1, getPage: async () => makeFakeImageOnlyPage() };
  // No explicit canvasFactory — relies on _p2mdExtractText's own default
  // (browserCanvasFactory, since `document` exists in this test's fake
  // global), same as every other test in this file.
  const blocks = await _p2mdExtractText(pdfDoc);
  expect(blocks.some(b => b.type === 'image')).toBeTruthy(); // image itself still preserved
  const md = _p2mdRender(blocks);
  expect(md.includes('No extractable text was found')).toBeTruthy();
  expect(md.includes('images/')).toBeTruthy(); // real image reference still present, not replaced
});

await test('a page with real extractable text is NOT given the OCR hint, even if it also has images', async () => {
  const items = [makeItem('This page has real, genuine body text.', 50, 700), ...fillerItems(4, 680)];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('No extractable text was found')).toBe(false);
});

// ── NFC Unicode normalization — real bug found by scripts/*/agent research: ──
// a PDF commonly encodes diacritic-heavy scripts as decomposed (NFD)
// combining-character sequences; the DOCX path (eriAnatomy.js) already had to
// fix the identical bug class for real Vietnamese text, but pdf2md's own
// extraction never got the equivalent fix until now.

await test('a decomposed (NFD) diacritic is normalized to its precomposed (NFC) form', async () => {
  // Built from explicit code points, never a pasted character (so the
  // test file's own encoding can't quietly precompose it first): base
  // "e" (U+0065) + a standalone COMBINING ACUTE ACCENT (U+0301) — the
  // exact decomposed shape a real PDF's text stream can legitimately
  // contain — must come out as the single precomposed "\u00e9" in the
  // rendered Markdown.
  const precomposedE = '\u00e9';
  const decomposedE   = 'e\u0301';
  const decomposedWord = `caf${decomposedE}`; // decomposed "caf\u0065\u0301"
  const precomposedWord = `caf${precomposedE}`;
  const items = [makeItem(`This is a ${decomposedWord} shop.`, 50, 700), ...fillerItems(4, 680)];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes(precomposedWord)).toBeTruthy(); // precomposed form present
  expect(md.includes(decomposedWord)).toBe(false);   // decomposed form gone
  expect(md.normalize('NFC') === md).toBeTruthy();   // whole output is already NFC-stable
});

// ── Footnote/marginal-text separation — real gap found by literature ──────
// research (GROBID, PDFBoT arXiv:2010.12647): bottom-of-page Y-band AND
// below-median font size, both required (precision-first, "prefer false
// negatives") — geometry pdf2mdCore.js already computes for other purposes
// (median font size for heading detection), just never applied here before.
// Default fake page height is 800 (see makeFakePage), so the bottom-15%
// band is y <= 120.

await test('a real footnote-shaped line (bottom of page, small font) is separated from body flow, not merged mid-paragraph', async () => {
  const items = [
    makeItem('This is the main body paragraph text on the page.', 50, 700, 10),
    ...fillerItems(3, 680),
    makeItem('1 This is a footnote at the bottom of the page.', 50, 50, 7), // y=50 (bottom band), fontSize=7 (< 10*0.85)
  ];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  // content preserved, not silently dropped...
  expect(md.includes('This is a footnote at the bottom of the page.')).toBeTruthy();
  // ...but rendered as its own italicized paragraph (the one, minimal visual
  // distinction from body text), not spliced into the body paragraph above it
  expect(md.includes('*1 This is a footnote at the bottom of the page.*')).toBeTruthy();
  expect(md.includes('main body paragraph text on the page. 1 This is a footnote')).toBe(false);
});

await test('body text near the bottom of the page (same font size as the rest) is NOT misclassified as a footnote', async () => {
  const items = [
    makeItem('This is the main body paragraph text on the page.', 50, 700, 10),
    ...fillerItems(3, 680),
    makeItem('This is still real body text near the bottom, same font size.', 50, 50, 10),
  ];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('*This is still real body text')).toBe(false);
  expect(md.includes('This is still real body text near the bottom, same font size.')).toBeTruthy();
});

await test('a small-font line NOT at the bottom of the page is NOT misclassified as a footnote (both signals required)', async () => {
  const items = [
    makeItem('This is the main body paragraph text on the page.', 50, 700, 10),
    makeItem('Small caption text mid-page.', 50, 400, 7), // small font, but well outside the bottom band
    ...fillerItems(3, 300),
  ];
  const pdfDoc = makeFakePdfDoc([items]);
  const blocks = await _p2mdExtractText(pdfDoc);
  const md = _p2mdRender(blocks);
  expect(md.includes('*Small caption text')).toBe(false);
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
