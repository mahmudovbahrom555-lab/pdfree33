// tests/blankPage.test.js — js/blankPage.js, Extract's "Without blank pages".
// Run: node tests/blankPage.test.js

const { isBlankPage } = await import('../js/blankPage.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// A small synthetic page; `pixel(x, y, rnd)` → gray. (Extract renders at
// 200 px wide; the real-PDF case is in tests/e2e/extract-noblank.e2e.mjs.)
function page(pixel) {
  const w = 60, h = 85;
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = pixel(x, y, rnd), i = (y * w + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  return [data, w, h];
}
const textLine = y => y % 8 === 0 && y > 10 && y < 75;   // lines of "text"

test('a white page → blank', () => {
  if (!isBlankPage(...page(() => 255))) throw new Error('white page not blank');
});
test('a scanned blank sheet: grey, noisy, a dark lid shadow along one edge → blank', () => {
  if (!isBlankPage(...page((x, y, r) => (x < 1 ? 40 : 205 + r() * 20)))) throw new Error('scanned blank not blank');
});
test('a page of text → not blank', () => {
  if (isBlankPage(...page((x, y) => (textLine(y) && x > 6 && x < 54 ? 30 : 255)))) throw new Error('text page called blank');
});
test('a nearly empty page with one short line (a page number, a signature line) → not blank', () => {
  if (isBlankPage(...page((x, y) => (y === 78 && x > 26 && x < 34 ? 20 : 255)))) throw new Error('page number page called blank');
});
test('a dark full-bleed photo page → not blank', () => {
  if (isBlankPage(...page((x, y, r) => 30 + (x + y) % 120 + r() * 40))) throw new Error('photo page called blank');
});

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
