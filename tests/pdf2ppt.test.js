// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/pdf2ppt.test.js — regression tests for _p2pMergeLineItems() /
//  _p2pMergeParagraphs() (js/processor.js), the two pure helpers that
//  build pdf2ppt's invisible search/copy text layer (a transparent text
//  box per line/paragraph, positioned to match the rasterized slide image
//  beneath it — see _p2pFitRect's own block comment for why the layer
//  exists and why it stays invisible-only, not visually-editable slides).
//  Previously zero test coverage for this whole tool.
//
// Run: node tests/pdf2ppt.test.js

global.window = { PDFREE_LOCALE: {} };
global.document = {
  addEventListener: () => {}, removeEventListener: () => {}, getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add(){}, remove(){}, contains(){ return false; } }, appendChild(){}, removeChild(){}, setAttribute(){} }),
  body: { appendChild(){}, removeChild(){} },
};
global.Worker = class { postMessage(){} terminate(){} addEventListener(){} };

const { _p2pMergeLineItems, _p2pMergeParagraphs } = await import('../js/processor.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe: (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeCloseTo: (e, tol = 0.01) => { if (Math.abs(actual - e) > tol) throw new Error(`Expected ~${e}, got ${actual}`); },
  };
}

// Mirrors _p2pExtractTextBlocks' own item shape (x/y in PDF points, origin
// bottom-left; y increases upward — same convention _p2wBuildPageData uses).
const mkItem = (text, x, y, fontSize = 12) => ({ text, x, y, width: text.length * fontSize * 0.5, height: fontSize, fontSize });

console.log('\n_p2pMergeLineItems — merges same-line items by X-gap:');

test('two close items on the same line merge into one block with a space', () => {
  // "Hello" at fontSize 12 (mkItem's width estimate: 5*12*0.5=30) ends at
  // x=80; maxGap is fontSize*0.6=7.2, so the second item must start under
  // x=87.2 to read as ordinary word-spacing, not a column break.
  const blocks = _p2pMergeLineItems([mkItem('Hello', 50, 700, 12), mkItem('world', 84, 700, 12)]);
  expect(blocks.length).toBe(1);
  expect(blocks[0].text).toBe('Hello world');
});

test('two far-apart items on the same line (a column break) stay separate blocks', () => {
  const blocks = _p2pMergeLineItems([mkItem('Left', 50, 700, 12), mkItem('Right', 400, 700, 12)]);
  expect(blocks.length).toBe(2);
});

console.log('\n_p2pMergeParagraphs — merges single-column consecutive lines into one paragraph box:');

test('two consecutive same-indent lines with ordinary line spacing merge into one paragraph', () => {
  const lineGroups = [
    _p2pMergeLineItems([mkItem('First line of text', 50, 700, 12)]),
    _p2pMergeLineItems([mkItem('Second line continues', 50, 686, 12)]), // gap=14, well under 12*1.8=21.6
  ];
  const blocks = _p2pMergeParagraphs(lineGroups);
  expect(blocks.length).toBe(1);
  expect(blocks[0].text).toBe('First line of text\nSecond line continues');
});

test('a heading followed by body text at a different font size stays as separate boxes', () => {
  const lineGroups = [
    _p2pMergeLineItems([mkItem('Heading Text', 50, 700, 20)]),
    _p2pMergeLineItems([mkItem('Body text right after it', 50, 675, 12)]),
  ];
  const blocks = _p2pMergeParagraphs(lineGroups);
  expect(blocks.length).toBe(2);
});

console.log('\n_p2pMergeParagraphs — real bug: merged block.y must represent the paragraph\'s ' +
            'TOP line, not silently stay at whatever the first line happened to set it to, once ' +
            'height grows to span the whole merged paragraph:');

// Real bug found via a live pdf2ppt run: a 7-line merged body paragraph's
// invisible text box ended up positioned ABOVE a title that sits higher on
// the actual page — Ctrl+F/drag-select landed on the wrong on-slide spot,
// even though the rendered slide IMAGE always looked correct (the text
// layer is invisible). Root cause: block.y stayed pinned to the FIRST
// merged line's own baseline while .height grew to span the whole
// paragraph — _runPdf2Ppt derives each shape's top edge as `y + height`,
// which overshoots downward by roughly the paragraph's own height once
// merged. Fixed by re-deriving .y from the already-correct, never-touched
// ._topY after the merge loop completes.
test('a merged multi-line paragraph\'s .y, combined with .height, still yields the correct top edge (y+height stays pinned to the true top line)', () => {
  // 3 lines, fontSize 8, 13pt apart (matches the real small-text.pdf repro
  // shape: dense small-font body text).
  const lineGroups = [
    _p2pMergeLineItems([mkItem('First line of the paragraph', 50, 700, 8)]),
    _p2pMergeLineItems([mkItem('Second line continues here', 50, 687, 8)]),
    _p2pMergeLineItems([mkItem('Third and final line of it', 50, 674, 8)]),
  ];
  const [block] = _p2pMergeParagraphs(lineGroups);
  const topEdge = block.y + block.height;
  // The true top edge is the FIRST line's own top (baseline 700 + its own
  // 8pt height) — must stay there regardless of how far the paragraph
  // grows downward while merging, not drift down as more lines are added.
  expect(topEdge).toBeCloseTo(708, 0.5);
});

test('a merged paragraph never ends up positioned ABOVE an earlier, unrelated single-line block on the page (the exact real repro)', () => {
  // Title first (higher on the page, larger font, own single-line block),
  // then a 3-line body paragraph below it — same shape as the real
  // small-text.pdf fixture this bug was found on.
  const lineGroups = [
    _p2pMergeLineItems([mkItem('Quarterly Financial Summary', 50, 740, 16)]),
    _p2pMergeLineItems([mkItem('Revenue grew fourteen percent this quarter', 50, 700, 8)]),
    _p2pMergeLineItems([mkItem('driven by the enterprise segment overall', 50, 687, 8)]),
    _p2pMergeLineItems([mkItem('and stronger renewal rates industry-wide', 50, 674, 8)]),
  ];
  const [title, body] = _p2pMergeParagraphs(lineGroups);
  const titleTop = title.y + title.height;
  const bodyTop  = body.y + body.height;
  // Higher PDF y = higher on the page. The title sits above the body in
  // the source, so its top edge must also read as "higher" (greater PDF y)
  // than the body's — this inverted before the fix (bodyTop > titleTop).
  if (bodyTop >= titleTop) {
    throw new Error(`body top (${bodyTop}) must be BELOW title top (${titleTop}) in PDF-y terms — got the paragraph positioned above the title`);
  }
});

// ── Summary ──────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
