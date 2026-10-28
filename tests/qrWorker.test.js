// js/qrWorker.js's decodeAll: QR codes found on a rendered page, more than one
// per page, with jsQR as shipped in js/vendor/. Codes come from
// tests/fixtures/safety/qr-codes.json (made once with Python's qrcode).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
// the vendored UMD build, as a worker's importScripts() would run it
const umd = { exports: {} };
new Function('module', 'exports', readFileSync(join(__dir, '../js/vendor/jsQR.js'), 'utf8'))(umd, umd.exports);
const jsQR = umd.exports;
const src = readFileSync(join(__dir, '../js/qrWorker.js'), 'utf8')
  .replace(/importScripts\([^)]+\);?/g, '')
  .replace(/self\.onmessage\s*=[\s\S]*?^};/m, '');
const { decodeAll } = new Function('jsQR', `${src}\nreturn { decodeAll };`)(jsQR);
const codes = JSON.parse(readFileSync(join(__dir, 'fixtures/safety/qr-codes.json'), 'utf8'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// A white page with QR codes drawn at (x, y), each module `scale` pixels.
function page(width, height, placed, scale = 6) {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const { rows, x, y } of placed) {
    rows.forEach((row, r) => [...row].forEach((bit, c) => {
      if (bit !== '1') return;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const i = ((y + r * scale + dy) * width + (x + c * scale + dx)) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
      }
    }));
  }
  return rgba;
}

console.log('\nqrWorker decodeAll:');

test('one code on a page is read, with where it sits', () => {
  const found = decodeAll(page(800, 1000, [{ rows: codes.phish.rows, x: 500, y: 700 }]), 800, 1000);
  assert(found.length === 1 && found[0].data === codes.phish.payload, JSON.stringify(found));
  const [x0, y0] = found[0].box;
  assert(x0 > 0.55 && y0 > 0.65, `box ${found[0].box}`);
});

test('two codes on one page are both read', () => {
  const found = decodeAll(page(1000, 1200, [{ rows: codes.phish.rows, x: 60, y: 80 }, { rows: codes.plain.rows, x: 700, y: 900 }]), 1000, 1200);
  const data = found.map(f => f.data).sort();
  assert(data.length === 2 && data.includes(codes.phish.payload) && data.includes(codes.plain.payload), JSON.stringify(data));
});

test('a page with no code gives nothing', () => {
  assert(decodeAll(page(600, 800, []), 600, 800).length === 0, 'expected nothing');
});

test('an image over the size limit is refused, not read', () => {
  assert(decodeAll(new Uint8ClampedArray(3000 * 10 * 4), 3000, 10).length === 0, 'over the limit');
  assert(decodeAll(new Uint8ClampedArray(10), 100, 100).length === 0, 'wrong buffer length');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
