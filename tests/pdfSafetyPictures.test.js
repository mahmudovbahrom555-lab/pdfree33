// pdfSafetyPictures's page scale: 150 dpi, less for long documents, never a
// side over 2,500 px. The drawing itself is checked in a real browser
// (tests/e2e/pdf-safety-check.e2e.mjs).
import { pageScale } from '../js/pdfSafetyPictures.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const near = (a, b) => Math.abs(a - b) < 1e-9;

console.log('\npdfSafetyPictures pageScale:');
test('an A4 page in a short document: 150 dpi', () => assert(near(pageScale(5, 595, 842), 150 / 72), pageScale(5, 595, 842)));
test('long documents get less: 130 dpi over 20 pages, 110 over 40', () => {
  assert(near(pageScale(21, 595, 842), 130 / 72) && near(pageScale(41, 595, 842), 110 / 72), `${pageScale(21, 595, 842)} ${pageScale(41, 595, 842)}`);
});
test('a poster-sized page is held to 2,500 px on its long side', () => {
  const s = pageScale(1, 2384, 3370);   // A0
  assert(Math.round(3370 * s) === 2500, `${3370 * s}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
