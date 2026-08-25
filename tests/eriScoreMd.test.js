// tests/eriScoreMd.test.js — js/eriScoreMd.js (Atlas structural check,
// adapted for pdf2md's Markdown output). Unlike tests/eriScore.test.js
// (which pins values against Python's eri_core as a cross-language parity
// net), this module has no Python counterpart to check against — it's a new
// adaptation, not a port — so these are direct logic tests against
// synthetic `blocks` arrays shaped exactly like js/pdf2mdCore.js's real
// _p2mdExtractText() output.
//
// Run: node tests/eriScoreMd.test.js

import { strict as assert } from 'assert';
import { dissectMarkdown, evaluateMarkdownStructural } from '../js/eriScoreMd.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const para = (text) => ({ type: 'para', runs: [{ text, bold: false, italic: false, formula: false }] });
const heading = (text, level = 1) => ({ type: 'heading', level, text });
const table = (rows) => ({ type: 'table', rows });

// A real, terminally-punctuated sentence long enough (>50 chars, checkFlow's
// own "short lines aren't judged" threshold) to actually be scored.
const CLEAN_SENTENCE = 'This is a normal, complete sentence that ends properly.';
// Same length class, but deliberately cut off mid-thought — no terminal
// punctuation/digit at the end, matching checkFlow's own TERMINAL set.
const FRAGMENTED_SENTENCE = 'This sentence was extracted from a layout that got cut off somewhere odd';

test('dissectMarkdown: para block becomes a Para with joined run text', () => {
  const a = dissectMarkdown([para('Hello world')]);
  assert.equal(a.paras.length, 1);
  assert.equal(a.paras[0].text, 'Hello world');
  assert.equal(a.paras[0].inTextbox, false);
  assert.equal(a.paras[0].brCount, 0);
});

test('dissectMarkdown: heading block becomes a Para from its flat text', () => {
  const a = dissectMarkdown([heading('Section Title')]);
  assert.equal(a.paras.length, 1);
  assert.equal(a.paras[0].text, 'Section Title');
});

test('dissectMarkdown: table block becomes a Tbl with rows/cols/chars, always regular', () => {
  const a = dissectMarkdown([table([['a', 'b'], ['1', '2']])]);
  assert.equal(a.tables.length, 1);
  assert.equal(a.tables[0].rows, 2);
  assert.equal(a.tables[0].cols, 2);
  assert.equal(a.tables[0].chars, 4);
  assert.equal(a.tables[0].regular, true); // GFM tables have no merged-cell concept
  assert.equal(a.tables[0].inTextbox, false); // GFM tables have no text-box concept
});

test('dissectMarkdown: image/formula-latex/list blocks are excluded from paras/tables', () => {
  const a = dissectMarkdown([
    { type: 'image', blob: {}, filename: 'x.png', alt: '' },
    { type: 'formula-latex', latex: 'x=1' },
    { type: 'list', text: '- item' },
  ]);
  assert.equal(a.paras.length, 0);
  assert.equal(a.tables.length, 0);
});

test('evaluateMarkdownStructural: clean document with no tables scores 100', () => {
  const blocks = [heading('Title'), para(CLEAN_SENTENCE), para(CLEAN_SENTENCE)];
  const result = evaluateMarkdownStructural(blocks);
  assert.equal(result.doc, 'structural-md');
  assert.equal(result.eri, 100);
  assert.equal(result.components.tables, 1);
  assert.equal(result.components.flow, 1);
  assert.deepEqual(result.findings.tables, []);
});

test('evaluateMarkdownStructural: fragmented paragraphs lower the flow score with a real finding', () => {
  const blocks = Array.from({ length: 10 }, () => para(FRAGMENTED_SENTENCE));
  const result = evaluateMarkdownStructural(blocks);
  assert.ok(result.components.flow < 1, `expected flow < 1, got ${result.components.flow}`);
  assert.ok(result.findings.flow.some(f => f.includes('cut off without terminal punctuation')),
    `expected a fragmentation finding, got ${JSON.stringify(result.findings.flow)}`);
  assert.ok(result.eri < 100, `expected eri < 100, got ${result.eri}`);
});

test('evaluateMarkdownStructural: 3+ single-row multi-column tables read as misdetected layout', () => {
  // checkTablesStruct only counts a table as "real" (vs. noise) once its
  // total cell chars exceed 30 (js/eriChecks.js's own `t.chars > 30` gate)
  // — each row here is deliberately well over that.
  const blocks = [
    table([['First Column Header', 'Second Column Header', 'Third Column Header']]),
    table([['Another Long Label', 'Another Long Value', 'Another Long Unit']]),
    table([['Yet More Header Text', 'Yet More Value Text', 'Yet More Unit Text']]),
  ];
  const result = evaluateMarkdownStructural(blocks);
  assert.ok(result.components.tables < 1, `expected tables < 1, got ${result.components.tables}`);
  assert.ok(result.findings.tables.some(f => f.includes('strip-table')),
    `expected a strip-table finding, got ${JSON.stringify(result.findings.tables)}`);
});

test('evaluateMarkdownStructural: a normal (non-1-row) table never triggers the strip-table finding', () => {
  const blocks = [table([['Name', 'Value'], ['a', '1'], ['b', '2']])];
  const result = evaluateMarkdownStructural(blocks);
  assert.equal(result.components.tables, 1);
  assert.deepEqual(result.findings.tables, []);
});

test('evaluateMarkdownStructural: weights are tables 0.36 / flow 0.64 (renormalized from Atlas defaults, paragraphs channel dropped)', () => {
  // A document with a perfect flow score but a penalized tables score should
  // land ERI closer to (1 - 0.36*penalty)*100 than a 50/50 split would give.
  const blocks = [
    para(CLEAN_SENTENCE),
    table([['a', 'b', 'c']]),
    table([['d', 'e', 'f']]),
    table([['g', 'h', 'i']]),
  ];
  const result = evaluateMarkdownStructural(blocks);
  const expected = 100 * (0.36 * result.components.tables + 0.64 * result.components.flow);
  assert.ok(Math.abs(result.eri - Math.round(expected * 10) / 10) < 0.2,
    `eri=${result.eri} doesn't match the expected 0.36/0.64 weighting (expected ~${expected})`);
});

test('evaluateMarkdownStructural: never throws on an empty document (no paras, no tables)', () => {
  const result = evaluateMarkdownStructural([]);
  assert.equal(result.error, '');
  assert.ok(Number.isFinite(result.eri));
});

test('evaluateMarkdownStructural: a custom weights object is honored and renormalized', () => {
  const blocks = [table([['a', 'b', 'c']]), table([['d', 'e', 'f']]), table([['g', 'h', 'i']])];
  const tablesOnly = evaluateMarkdownStructural(blocks, { tables: 1, flow: 0 });
  // flow has no paras here (score defaults per checkFlow's own "no text
  // paragraphs to analyze" -> 0), so weighting 100% onto tables must NOT
  // collapse the result to 0 the way an unweighted average would.
  assert.ok(tablesOnly.eri > 0, `expected eri > 0 when weighted fully onto tables, got ${tablesOnly.eri}`);
});

const total = passed + failed;
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${total} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
