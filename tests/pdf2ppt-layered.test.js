// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/pdf2ppt-layered.test.js — PDF→PowerPoint "editable text": the page
//  drawn without its text, the text laid back as boxes (js/pdf2pptLayered.js).
//  Run: node tests/pdf2ppt-layered.test.js
// ============================================================

import { strict as assert } from 'assert';
import { captureText, lineRunsForSlide, cutsForLine, groupRuns, fittedFontSize, eraseUnpaintedRuns, styledParts } from '../js/pdf2pptLayered.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const item = (str, x, width, extra = {}) => ({ str, x, width, y: 384, fontSize: 14.6, bold: false, italic: false, ...extra });
const line = (items, extra = {}) => ({ y: items[0].y, rtl: false, items, ...extra });

console.log('\nlineRunsForSlide — one box per run of a line:');

test('table cells are separate runs: a space item spanning the gap joins nothing', () => {
  // a Japanese balance sheet (presentations corpus): "総資産（百万円）17,722 20,813" was one box
  const ln = line([item('総資産 （百万円）', 100.57, 121.5), item(' ', 222.09, 80.3), item('17,722', 304.3, 51.2),
    item(' ', 355.5, 25.8), item('20,813', 381.95, 51.2)]);
  assert.deepEqual(lineRunsForSlide(ln, cutsForLine(ln, [{ y: 288, h: 136, colXs: [96, 280, 360, 436] }])).map(r => r.text),
    ['総資産 （百万円）', '17,722', '20,813']);
});

test('a justified line, one word per item at even widened gaps, is one run', () => {
  // an English manual (presentations corpus): every word became its own box
  const words = ['Thank', 'you', 'for', 'downloading'];
  let x = 50;
  const ln = line(words.map(w => { const it = item(w, x, w.length * 6, { fontSize: 12 }); x += w.length * 6 + 7.2; return it; }));
  assert.equal(lineRunsForSlide(ln).length, 1);
  assert.equal(lineRunsForSlide(ln)[0].text, 'Thank you for downloading');
});

test('cells at uneven or wide gaps stay separate runs', () => {
  const ln = line([item('Name', 50, 30, { fontSize: 12 }), item('Qty', 120, 20, { fontSize: 12 }), item('Price', 200, 30, { fontSize: 12 })]);
  assert.equal(lineRunsForSlide(ln).length, 3);
});

test('a table rule splits cells that sit closer than 0.6 em', () => {
  const ln = line([item('Total', 50, 30), item('12', 82, 12)]);
  assert.equal(lineRunsForSlide(ln).length, 1);
  assert.equal(lineRunsForSlide(ln, [81]).length, 2);
});

test('touching Chinese pieces stay one word', () => {
  const ln = line([item('從業', 50, 24, { fontSize: 12 }), item('評價', 74, 24, { fontSize: 12 }), item('職', 98, 12, { fontSize: 12 })]);
  assert.equal(lineRunsForSlide(ln)[0].text, '從業評價職');
});

test('right-to-left words keep their logical order and the spaces between them', () => {
  // logical order runs right to left; the space items are the only separators
  const ln = line([item('وزير', 300, 20), item(' ', 296, 4), item('امور', 270, 26), item(' ', 266, 4), item('خارجه', 236, 30)], { rtl: true });
  const [run] = lineRunsForSlide(ln);
  assert.equal(run.text, 'وزير امور خارجه');
  assert.equal(run.rtl, true);
});

test('a Symbol-font bullet becomes a bullet character, not an empty box', () => {
  const ln = line([item('\uF0B7', 90, 5.5, { fontSize: 12 })]);
  assert.equal(lineRunsForSlide(ln)[0].text, '•');
});

console.log('\ngroupRuns — lines of one paragraph become one box:');

const run = (text, x0, y, extra = {}) => ({ text, x0, x1: x0 + 200, y, fontSize: 12, bold: false, italic: false, color: '000000', rtl: false, ...extra });

test('lines at a steady pitch with one left edge are one left-aligned box', () => {
  const [b, ...rest] = groupRuns([run('one', 108, 500), run('two', 108, 476.6), run('three', 108, 453.2)]);
  assert.equal(rest.length, 0);
  assert.deepEqual(b.lines, ['one', 'two', 'three']);
  assert.equal(b.align, 'left');
  assert.ok(Math.abs(b.pitch - 23.4) < 1e-9);
});

test('a bullet beside a paragraph does not make it centred', () => {
  // the bullet is its own run at x 90; it must not count as one of the lines
  const blocks = groupRuns([run('•', 90, 500, { x1: 95.5 }), run('first', 108, 500), run('second', 108, 476.6)]);
  assert.equal(blocks.find(b => b.lines.includes('first')).align, 'left');
});

test('centred lines (one centre, different left edges) are one centred box', () => {
  const blocks = groupRuns([run('Title line', 200, 500, { x1: 400 }), run('a sub line', 250, 485, { x1: 350 })]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].align, 'center');
});

test('a paragraph with a hanging "a)" stays left-aligned, its indented lines in it', () => {
  // the first two lines' centres are 4 pt apart (x 40–440 and 58–430)
  const b = groupRuns([run('a) Completed by the team', 40, 500, { x1: 440 }), run('in consultation with', 58, 484, { x1: 430 }),
    run('the staff', 58, 468)]);
  assert.equal(b.length, 2);                       // "a)" line alone, the indented lines one box
  assert.ok(b.every(x => x.align === 'left'));
});

test('cells of a ruled table column stay separate boxes, a wrapped cell one box', () => {
  const grid = { x: 40, y: 400, w: 300, h: 110, rowYs: [510, 490, 450, 400] };
  const b = groupRuns([run('世界古典', 50, 495), run('古籍整理', 50, 476), run('研究所', 50, 462)], [grid]);
  assert.deepEqual(b.map(x => x.lines), [['世界古典'], ['古籍整理', '研究所']]);
});

test('a small label before a title on the same line is a box of its own', () => {
  const ln = line([item('RIS', 20, 10, { fontSize: 5 }), item('Next steps', 34, 80, { fontSize: 20 })]);
  assert.deepEqual(lineRunsForSlide(ln).map(r => r.text), ['RIS', 'Next steps']);
});

test('another colour, a size jump or a gap of over 2 em starts a new box', () => {
  assert.equal(groupRuns([run('a', 108, 500), run('b', 108, 486, { color: 'FFFFFF' })]).length, 2);
  assert.equal(groupRuns([run('a', 108, 500), run('b', 108, 486, { fontSize: 20 })]).length, 2);
  assert.equal(groupRuns([run('a', 108, 500), run('b', 108, 470)]).length, 2);
});

test('each box is marked with the language of its script', () => {
  assert.equal(groupRuns([run('中心化处理', 108, 500)])[0].lang, 'zh-CN');
  assert.equal(groupRuns([run('ヤマシタ', 108, 500)])[0].lang, 'ja-JP');
  assert.equal(groupRuns([run('گزارش', 108, 500)])[0].lang, 'fa-IR');
  assert.equal(groupRuns([run('Report', 108, 500)])[0].lang, undefined);
});

console.log('\nfittedFontSize — as wide on the slide as on the page:');

test('a wider substitute font shrinks the size, by 40 % at most', () => {
  const block = { fontSize: 12, x0: 0, x1: 100, lines: ['abc'] };
  assert.equal(fittedFontSize(block, () => 100), 12);
  assert.equal(fittedFontSize(block, () => 125), 12 * 0.8);
  assert.equal(fittedFontSize(block, () => 400), 12 * 0.6);
});

test('right-to-left words one item each, with no space items, get spaces by their gaps', () => {
  // a Persian title (presentations corpus): "اثیرابیدهسازی…" glued
  const ln = line([item('تاثیر', 400, 40), item('پیاده', 352, 44), item('سازی', 310, 38)], { rtl: true });
  assert.equal(lineRunsForSlide(ln)[0].text, 'تاثیر پیاده سازی');
});

console.log('\ncaptureText — the page without the text that comes back as boxes:');

function fakeCtx() {
  const drawn = [];
  const ctx = {
    m: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, fillStyle: '#ff0000', strokeStyle: '#000000',
    getTransform() { return this.m; },
    fillText(t, x, y) { drawn.push(t); }, strokeText(t) { drawn.push(t); },
  };
  return { ctx, drawn };
}

test('a glyph on a run is left out and its colour counted; one elsewhere is drawn', () => {
  const { ctx, drawn } = fakeCtx();
  const r = run('Hi', 100, 500);
  const { restore } = captureText(ctx, (x, y) => [x, y], [r]);
  ctx.fillText('H', 110, 500);
  ctx.fillText('X', 400, 100);          // an annotation's text, not a run
  restore();
  assert.deepEqual(drawn, ['X']);
  assert.equal(r.color, 'FF0000');
});

test('rotated text is drawn; a run none of whose glyphs is painted stays invisible (null colour)', () => {
  const { ctx, drawn } = fakeCtx();
  const r = run('hidden OCR text', 100, 500);
  const { restore } = captureText(ctx, (x, y) => [x, y], [r]);
  ctx.m = { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 };
  ctx.fillText('R', 110, 500);
  restore();
  assert.deepEqual(drawn, ['R']);
  assert.equal(r.color, null);
});

test('glyphs drawn filled and outlined (a faux bold) make their words bold; a line can mix both', () => {
  const { ctx } = fakeCtx();
  // "更值得一提的是，" regular, "《自然》刊文称" bold (FangSong drawn filled + stroked)
  const ln = line([item('更值得一提的是，', 100, 96, { fontSize: 12, y: 500 }), item('《自然》刊文称', 196, 84, { fontSize: 12, y: 500 })]);
  const [r] = lineRunsForSlide(ln);
  const { restore } = captureText(ctx, (x, y) => [x, y], [r]);
  for (const x of [110, 150]) ctx.fillText('字', x, 500);
  for (const x of [200, 240]) { ctx.fillText('字', x, 500); ctx.strokeText('字', x, 500); }
  restore();
  assert.equal(r.bold, false);
  assert.deepEqual(styledParts(r), [{ text: '更值得一提的是，', bold: false }, { text: '《自然》刊文称', bold: true }]);
  assert.equal(r.color, 'FF0000');                     // the fill's colour, not the outline's
});

test('styled parts keep the spaces between words and drop them at the ends', () => {
  const ln = line([item('Plain', 50, 30, { fontSize: 12 }), item('bold', 85, 24, { fontSize: 12, bold: true }), item('end', 113, 18, { fontSize: 12 })]);
  assert.deepEqual(styledParts(lineRunsForSlide(ln)[0]), [{ text: 'Plain', bold: false }, { text: ' bold', bold: true }, { text: ' end', bold: false }]);
});

test('an OCR guess leaves the glyphs under it drawn and stays invisible', () => {
  const { ctx, drawn } = fakeCtx();
  const r = run('place Cen rg', 100, 500, { partial: true });
  const { restore } = captureText(ctx, (x, y) => [x, y], [r]);
  ctx.fillText('E', 110, 500);
  restore();
  assert.deepEqual(drawn, ['E']);
  assert.equal(r.color, null);
});

console.log('\neraseUnpaintedRuns — scanned text out of the picture, only from a flat background:');

// a 60×30 picture, y down; PDF y up with the page 30 high: toPx(x, y) = [x, 30 - y]
function picture(fill) {
  const data = new Uint8ClampedArray(60 * 30 * 4);
  for (let y = 0; y < 30; y++) for (let x = 0; x < 60; x++) data.set(fill(x, y), (y * 60 + x) * 4);
  return { data, width: 60, height: 30 };
}
const toPx = (x, y) => [x, 30 - y];
const ink = (x, y) => x >= 12 && x <= 40 && y >= 12 && y <= 18;          // the scanned word

test('on a flat background the word is taken out and its box gets the ink colour', () => {
  const img = picture((x, y) => ink(x, y) ? [20, 40, 160, 255] : [250, 250, 245, 255]);
  const r = { text: 'word', x0: 12, x1: 40, y: 12, fontSize: 8, color: null };
  assert.equal(eraseUnpaintedRuns(img, [r], toPx), 1);
  assert.equal(r.color, '1428A0');
  const i = (15 * 60 + 20) * 4;
  assert.deepEqual([...img.data.slice(i, i + 3)], [250, 250, 245]);
});

test('on a photo (no flat band around it) the picture is left alone and the box stays invisible', () => {
  const img = picture((x, y) => ink(x, y) ? [20, 40, 160, 255] : [(x * 37) % 256, (y * 53) % 256, (x * y) % 256, 255]);
  const before = img.data.slice();
  const r = { text: 'Cen rg', x0: 12, x1: 40, y: 12, fontSize: 8, color: null };
  assert.equal(eraseUnpaintedRuns(img, [r], toPx), 0);
  assert.equal(r.color, null);
  assert.deepEqual(img.data, before);
});

test('an OCR run with unsure words left out is not taken out of the picture', () => {
  const img = picture((x, y) => ink(x, y) ? [20, 40, 160, 255] : [250, 250, 245, 255]);
  const r = { text: 'place Cen rg', x0: 12, x1: 40, y: 12, fontSize: 8, color: null, partial: true };
  assert.equal(eraseUnpaintedRuns(img, [r], toPx), 0);
  assert.equal(r.color, null);
});

test('an unsure OCR read, or a mark read as one character, is not taken out of the picture', () => {
  for (const r of [{ text: 'Sustainable sysfem', ocrConf: 82 }, { text: '市' }, { text: '一一一' }, { text: '-----' }]) {
    const img = picture((x, y) => ink(x, y) ? [20, 40, 160, 255] : [250, 250, 245, 255]);
    const run = { x0: 12, x1: 40, y: 12, fontSize: 8, color: null, ...r };
    assert.equal(eraseUnpaintedRuns(img, [run], toPx), 0, r.text);
  }
  const img = picture((x, y) => ink(x, y) ? [20, 40, 160, 255] : [250, 250, 245, 255]);
  assert.equal(eraseUnpaintedRuns(img, [{ text: '14', x0: 12, x1: 40, y: 12, fontSize: 8, color: null, ocrConf: 95 }], toPx), 1);
});

test('a run already drawn as text (it has a colour) is not touched', () => {
  const img = picture(() => [255, 255, 255, 255]);
  const r = { text: 'x', x0: 12, x1: 40, y: 12, fontSize: 8, color: '000000' };
  assert.equal(eraseUnpaintedRuns(img, [r], toPx), 0);
});

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
