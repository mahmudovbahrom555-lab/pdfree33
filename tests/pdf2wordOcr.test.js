// tests/pdf2wordOcr.test.js — ocrItemsFromPage(): recognizePage output → text
// items for pdf2readCore. The OCR itself is covered end to end by
// tests/e2e/pdf2word-ocr.e2e.mjs (network, not in CI); this is the geometry.
//
// Run: node tests/pdf2wordOcr.test.js

import { strict as assert } from 'assert';
import { ocrItemsFromPage } from '../js/pdf2wordOcr.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// Canvas px = PDF pt, y flipped on an 842pt page. Line boxes 24px high → 20pt
// type: runs split at 16pt gaps, columns at 30pt.
const page = lines => ({ vpTransform: [1, 0, 0, -1, 0, 842], lines });
const word = (text, x0, x1, bottom) => ({ text, kept: true, confidence: 90, bbox: { x0, x1, y0: bottom - 20, y1: bottom } });
const line = words => ({
  words,
  bbox: { x0: Math.min(...words.map(w => w.bbox.x0)), x1: Math.max(...words.map(w => w.bbox.x1)), y0: 80, y1: 104 },
  baseline: { x0: 0, y0: 98, x1: 600, y1: 98, has_baseline: true },
});

test('a line Tesseract joined across two columns keeps each column\'s own level', () => {
  // right column's words sit 10px higher than the left column's
  const items = ocrItemsFromPage(page([line([
    word('a', 560, 600, 96), word('b', 500, 550, 95), word('c', 440, 490, 96),
    word('d', 240, 300, 106), word('e', 170, 230, 106), word('f', 100, 160, 105),
  ])]));
  assert.equal(items.length, 2);
  assert.ok(Math.abs((items[0].y - items[1].y) - 10) < 0.01, `levels ${items.map(i => i.y)}`);
});

test('a wide word gap within one column does not move a run off its line', () => {
  const items = ocrItemsFromPage(page([line([
    word('a', 560, 600, 96), word('b', 500, 550, 99), word('c', 440, 490, 96),
    word('d', 420, 430, 101), word('e', 350, 400, 99), word('f', 290, 340, 101),
  ])]));
  assert.equal(items.length, 2);   // split at the 20pt gap, under a column's 30
  assert.equal(items[0].y, items[1].y);
  assert.equal(items[0].y, 842 - 98);
});

// Bold from stroke thickness (ink ÷ ink edge, recognizePage's `ink`/`stroke`):
// body strokes 2px thick, a heading's 3px. 5+ lines for a page median.
const inked = (w, dark, edge) => ({ ...w, ink: { dark, edge } });
const strokeLine = (words, y) => {
  const l = line(words);
  l.bbox = { ...l.bbox, y0: y - 24, y1: y };
  l.baseline = { ...l.baseline, y0: y - 6, y1: y - 6 };
  const dark = words.reduce((s, w) => s + w.ink.dark, 0), edge = words.reduce((s, w) => s + w.ink.edge, 0);
  return { ...l, stroke: dark / edge };
};
const body = y => strokeLine([inked(word('x', 440, 600, y - 2), 200, 100), inked(word('y', 100, 420, y - 2), 400, 200)], y);

test('a line set in thicker strokes than the page\'s body is bold', () => {
  const items = ocrItemsFromPage(page([
    strokeLine([inked(word('Heading', 100, 600, 98), 750, 250)], 100),
    body(140), body(170), body(200), body(230), body(260),
  ]));
  assert.equal(items[0].bold, true);
  assert.ok(items.slice(1).every(i => !i.bold));
});

test('a line joined across two columns: only the bold column\'s piece is bold', () => {
  const items = ocrItemsFromPage(page([
    strokeLine([
      inked(word('a', 560, 600, 98), 300, 100), inked(word('b', 500, 550, 98), 300, 100), inked(word('c', 440, 490, 98), 300, 100),
      inked(word('d', 240, 300, 98), 200, 100), inked(word('e', 170, 230, 98), 200, 100), inked(word('f', 100, 160, 98), 200, 100),
    ], 100),
    body(140), body(170), body(200), body(230), body(260),
  ]));
  assert.deepEqual(items.slice(0, 2).map(i => i.bold), [true, false]);
});

test('Chinese words are joined without spaces, Latin among them keeps its own', () => {
  // Tesseract's chi_sim "words": 为 什么 压缩 后 的 PDF 看 起来 ，
  const texts = ['为', '什么', '压缩', '后', '的', 'PDF', '看', '起来', '，'];
  const items = ocrItemsFromPage(page([line(texts.map((t, i) => word(t, 100 + i * 42, 140 + i * 42, 100)))]));
  assert.equal(items.length, 1);
  assert.equal(items[0].str, '为什么压缩后的 PDF 看起来，');
});

test('a Chinese line stays one run across a narrow glyph\'s wide gap (1.1 em)', () => {
  // 20pt type: 看 起 来 with 22pt between 看 and 起
  const items = ocrItemsFromPage(page([line([word('看', 100, 120, 100), word('起', 142, 162, 100), word('来', 166, 186, 100)])]));
  assert.equal(items.length, 1);
  assert.equal(items[0].str, '看起来');
});

test('Korean words keep their spaces', () => {
  const items = ocrItemsFromPage(page([line([word('파일을', 100, 160, 100), word('변환합니다', 166, 260, 100)])]));
  assert.equal(items[0].str, '파일을 변환합니다');
});

const total = passed + failed;
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${total} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
