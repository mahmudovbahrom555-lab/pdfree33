// tests/dotLeaders.test.js — js/cleanScanWorker.js's _eraseDotLeaders: a
// contents page's dotted leaders erased before Chinese/Japanese OCR, an
// ellipsis, a glyph and uneven marks kept (2026-10-29). The function is pure
// pixel math; it is cut out of the worker's source with its constants (the
// worker needs OffscreenCanvas and pdf-lib, which Node has not).
// Run: node tests/dotLeaders.test.js
import { readFileSync } from 'fs';

const src = readFileSync(new URL('../js/cleanScanWorker.js', import.meta.url), 'utf8');
const start = src.indexOf('const _LEADER_MIN');
const end = src.indexOf('\n}\n', src.indexOf('function _eraseDotLeaders')) + 2;
const _eraseDotLeaders = new Function(`${src.slice(start, end)}\nreturn _eraseDotLeaders;`)();

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

// a white RGBA page; `dot(p, x, y, r)` inks an r×r square
const page = (w = 1000, h = 200) => ({ d: new Uint8ClampedArray(w * h * 4).fill(255), w, h });
function dot({ d, w }, x, y, r = 4) {
  for (let yy = y; yy < y + r; yy++) for (let xx = x; xx < x + r; xx++) { const o = (yy * w + xx) * 4; d[o] = d[o + 1] = d[o + 2] = 0; }
}
const inkAt = ({ d, w }, x, y) => d[(y * w + x) * 4] < 128;

console.log('\ndot leaders:');

test('twelve evenly spaced dots on a line are erased', () => {
  const p = page();
  for (let i = 0; i < 12; i++) dot(p, 100 + i * 12, 100);
  _eraseDotLeaders(p.d, p.w, p.h);
  for (let i = 0; i < 12; i++) assert(!inkAt(p, 101 + i * 12, 101), `dot ${i} left`);
});

test('an ellipsis in a sentence (six dots) stays', () => {
  const p = page();
  for (let i = 0; i < 6; i++) dot(p, 100 + i * 12, 100);
  _eraseDotLeaders(p.d, p.w, p.h);
  for (let i = 0; i < 6; i++) assert(inkAt(p, 101 + i * 12, 101), `dot ${i} erased`);
});

test('a glyph beside a leader stays, the leader goes', () => {
  const p = page();
  dot(p, 40, 85, 30);
  for (let i = 0; i < 12; i++) dot(p, 80 + i * 12, 100);
  _eraseDotLeaders(p.d, p.w, p.h);
  assert(inkAt(p, 55, 100), 'the glyph was erased');
  assert(!inkAt(p, 81, 101), 'the leader stayed');
});

test('unevenly spaced marks stay', () => {
  const p = page();
  const xs = [100, 110, 135, 140, 180, 186, 230, 260, 265, 300, 330, 336];
  for (const x of xs) dot(p, x, 100, 3);
  _eraseDotLeaders(p.d, p.w, p.h);
  assert(xs.filter(x => inkAt(p, x + 1, 101)).length >= 10, 'uneven marks were erased');
});

console.log(`\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
process.exit(failed ? 1 : 0);
