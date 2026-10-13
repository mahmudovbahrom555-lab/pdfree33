// tests/nupLayout.test.js — js/nupLayout.js, the geometry of pages per sheet.
// Run: node tests/nupLayout.test.js

import { strict as assert } from 'assert';

globalThis.self = globalThis;
await import('../js/nupLayout.js');
const { layout } = self.NupLayout;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const A4 = { width: 595.28, height: 841.89, rotate: 0 };
const A4L = { width: 841.89, height: 595.28, rotate: 0 };
// a Chinese e-invoice: 240 × 140 mm
const INVOICE = { width: 680.31, height: 396.85, rotate: 0 };
const near = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;
const placed = l => l.sheets.flat();

test('sheets = ⌈pages / per sheet⌉, every page placed exactly once, in order', () => {
  for (const [n, k] of [[1, 2], [9, 4], [16, 16], [17, 16], [10, 6], [5, 9]]) {
    const l = layout(Array(n).fill(A4), { perSheet: k, paper: 'a4' });
    assert.equal(l.sheets.length, Math.ceil(n / k), `${n} pages, ${k} per sheet`);
    assert.deepEqual(placed(l).map(p => p.page), [...Array(n).keys()]);
  }
});

test('every page stays on the sheet, inside the margins, without distortion', () => {
  for (const k of [2, 4, 6, 9, 16]) {
    for (const pages of [[A4, A4L, A4], [INVOICE, A4, INVOICE, A4L]]) {
      const l = layout(pages, { perSheet: k, paper: 'a4', margin: 18 });
      for (const { page, box } of placed(l)) {
        assert.ok(box.x >= 18 - 1e-6 && box.y >= 18 - 1e-6, `k=${k} page ${page} inside the margin`);
        assert.ok(box.x + box.w <= l.width - 18 + 1e-6 && box.y + box.h <= l.height - 18 + 1e-6, `k=${k} page ${page}`);
        const src = pages[page];
        assert.ok(near(box.w / box.h, src.width / src.height, 1e-6), `k=${k} page ${page} keeps its proportions`);
      }
    }
  }
});

test('two portrait pages: side by side on a landscape sheet (~70 %), not stacked (~50 %)', () => {
  const l = layout([A4, A4], { perSheet: 2, paper: 'a4' });
  assert.ok(l.width > l.height, 'landscape sheet');
  assert.deepEqual([l.rows, l.cols], [1, 2]);
  const scale = placed(l)[0].box.w / A4.width;
  assert.ok(scale > 0.65, `scale ${scale.toFixed(2)}`);
});

test('one landscape page among portrait ones: still side by side (tie on the smallest → larger on average)', () => {
  const l = layout([A4, A4, A4, A4L, A4], { perSheet: 2, paper: 'a4' });
  assert.ok(l.width > l.height, 'landscape sheet');
});

test('four portrait pages: 2 × 2 on a portrait sheet', () => {
  const l = layout(Array(4).fill(A4), { perSheet: 4, paper: 'a4' });
  assert.ok(l.height > l.width);
  assert.deepEqual([l.rows, l.cols], [2, 2]);
});

test('two invoices on A4: stacked on a portrait sheet, at their own size (never enlarged)', () => {
  const l = layout([INVOICE, INVOICE], { perSheet: 2, paper: 'a4', margin: 14, gutter: 10, maxScale: 1 });
  assert.ok(l.height > l.width, 'portrait sheet');
  assert.deepEqual([l.rows, l.cols], [2, 1]);
  const scale = placed(l)[0].box.w / INVOICE.width;
  assert.ok(scale <= 1 && scale > 0.8, `scale ${scale.toFixed(2)}`);
  // first invoice on top
  assert.ok(placed(l)[0].box.y > placed(l)[1].box.y);
});

test('a small page is not enlarged with maxScale 1, fills its cell without it', () => {
  const card = { width: 200, height: 120, rotate: 0 };
  const capped = layout([card, card], { perSheet: 2, paper: 'a4', maxScale: 1 });
  assert.ok(near(placed(capped)[0].box.w, 200));
  const filled = layout([card, card], { perSheet: 2, paper: 'a4' });
  assert.ok(placed(filled)[0].box.w > 300);
});

test('row order fills left to right, then down; column order fills down first', () => {
  const row = layout(Array(4).fill(A4), { perSheet: 4, paper: 'a4' }).sheets[0];
  assert.ok(row[0].box.x < row[1].box.x && near(row[0].box.y, row[1].box.y), 'page 2 right of page 1');
  assert.ok(row[2].box.y < row[0].box.y, 'page 3 on the next row');
  const col = layout(Array(4).fill(A4), { perSheet: 4, paper: 'a4', order: 'column' }).sheets[0];
  assert.ok(near(col[0].box.x, col[1].box.x) && col[1].box.y < col[0].box.y, 'page 2 under page 1');
});

test('right to left: page 1 in the top-right cell (Arabic, Persian, Hebrew)', () => {
  const s = layout(Array(4).fill(A4), { perSheet: 4, paper: 'a4', rtl: true }).sheets[0];
  assert.ok(s[0].box.x > s[1].box.x && near(s[0].box.y, s[1].box.y));
  assert.ok(s[0].box.y > s[2].box.y);
});

test('a page shown at /Rotate 90 is laid out by its shown size and drawn turned', () => {
  const turned = { width: 595.28, height: 841.89, rotate: 90 };   // shows landscape
  const l = layout([turned, turned], { perSheet: 2, paper: 'a4' });
  const { box, draw } = placed(l)[0];
  assert.ok(box.w > box.h, 'shown landscape');
  assert.equal(draw.rotate, -90);
  assert.ok(near(draw.x, box.x) && near(draw.y, box.y + box.h), 'turned about its corner into the box');
  assert.ok(near(draw.width, box.h) && near(draw.height, box.w), 'content drawn at its own (unturned) size');
  for (const [r, dx, dy] of [[180, 1, 1], [270, 1, 0]]) {
    const d = placed(layout([{ ...turned, rotate: r }], { perSheet: 2, paper: 'a4' }))[0];
    assert.equal(d.draw.rotate, -r);
    assert.ok(near(d.draw.x, d.box.x + dx * d.box.w) && near(d.draw.y, d.box.y + dy * d.box.h), `rotate ${r}`);
  }
});

test('a binding margin moves the pages right by its width', () => {
  const plain = placed(layout(Array(2).fill(INVOICE), { perSheet: 2, paper: 'a4', orientation: 'portrait', margin: 14, maxScale: 1 }))[0];
  const bound = placed(layout(Array(2).fill(INVOICE), { perSheet: 2, paper: 'a4', orientation: 'portrait', margin: 14, marginLeft: 14 + 85, maxScale: 1 }))[0];
  assert.ok(bound.box.x > plain.box.x);
  assert.ok(bound.box.x >= 99 - 1e-6, 'clear of the binding strip');
});

test('unknown grid, paper or no pages is an error, not a broken PDF', () => {
  assert.throws(() => layout([A4], { perSheet: 3, paper: 'a4' }), /NUP_BAD_GRID/);
  assert.throws(() => layout([A4], { perSheet: 2, paper: 'b5' }), /NUP_BAD_PAPER/);
  assert.throws(() => layout([], { perSheet: 2, paper: 'a4' }), /NUP_NO_PAGES/);
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
