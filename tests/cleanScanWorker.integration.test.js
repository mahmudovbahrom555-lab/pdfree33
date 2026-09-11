// ============================================================
//  tests/cleanScanWorker.integration.test.js
//
//  Node-testable slice of js/cleanScanWorker.js: _buildIntegralImage and
//  _windowStats are plain pixel-array math with no Canvas dependency —
//  every other function in that file (_toGrayscaleCanvas, _applyClean,
//  _applyEnhance, etc.) needs a real OffscreenCanvas 2D context, which
//  doesn't exist in Node and isn't worth adding a canvas-polyfill
//  devDependency for. Those are verified instead via a real-browser
//  Playwright script against a real photographed page — not part of
//  `npm test`, same precedent as the other *Worker.js integration tests
//  needing something Node can't provide.
//
//  Same extraction technique as tests/fillOrderWorker.integration.test.js:
//  read the worker source as text, strip importScripts/self.onmessage,
//  eval via AsyncFunction, pull out just the pure functions we need.
//
//  Run: node tests/cleanScanWorker.integration.test.js
// ============================================================

const { readFileSync } = await import('fs');
const { join, dirname } = await import('path');
const { fileURLToPath } = await import('url');
const __dir = dirname(fileURLToPath(import.meta.url));

const workerSrc = readFileSync(join(__dir, '../js/cleanScanWorker.js'), 'utf8')
  .replace(/importScripts\([^)]+\);?/g, '')
  .replace(/self\.onmessage\s*=[\s\S]*?^};/m, '');

const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const workerModule = new AsyncFunction(workerSrc + '\nreturn { _buildIntegralImage, _windowStats };');
const { _buildIntegralImage, _windowStats } = await workerModule();

// ── Test runner ───────────────────────────────────────────────

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.stack || e.message}`);
    failed++;
  }
}

function expect(actual) {
  return {
    toBe: (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeCloseTo: (e, eps = 0.01) => { if (Math.abs(actual - e) > eps) throw new Error(`Expected ${actual} ≈ ${e} (±${eps})`); },
    toBeGreaterThan: (n) => { if (!(actual > n)) throw new Error(`Expected ${actual} > ${n}`); },
    toBeLessThan: (n) => { if (!(actual < n)) throw new Error(`Expected ${actual} < ${n}`); },
  };
}

// Builds a fake RGBA buffer (data[i] used as gray level, R=G=B) from a
// row-major grid of grayscale pixel values — _buildIntegralImage only
// reads data[i] (the R channel) at stride 4, matching real ImageData.
function fakeRGBA(values) {
  const d = new Uint8ClampedArray(values.length * 4);
  values.forEach((v, i) => { d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255; });
  return d;
}

// Brute-force mean/stddev over the same clipped window _windowStats
// computes via the integral image — the independent reference this
// suite checks the O(1) summed-area-table path against.
function bruteForceStats(values, w, h, cx, cy, r) {
  const x0 = Math.max(0, cx - r), y0 = Math.max(0, cy - r);
  const x1 = Math.min(w - 1, cx + r), y1 = Math.min(h - 1, cy + r);
  let sum = 0, sumSq = 0, n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const v = values[y * w + x];
      sum += v; sumSq += v * v; n++;
    }
  }
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
}

console.log('\n🧼 cleanScanWorker — _buildIntegralImage / _windowStats:');

test('uniform image: local mean equals the constant value, stddev is 0', () => {
  const w = 10, h = 10;
  const values = Array(w * h).fill(200);
  const ii = _buildIntegralImage(fakeRGBA(values), w, h);
  const { mean, std } = _windowStats(ii, 5, 5, 3);
  expect(mean).toBeCloseTo(200);
  expect(std).toBeCloseTo(0);
});

test('matches brute-force mean/stddev on a random grid, interior window (no clipping)', () => {
  const w = 20, h = 20;
  const values = Array.from({ length: w * h }, () => Math.floor(Math.random() * 256));
  const ii = _buildIntegralImage(fakeRGBA(values), w, h);
  const { mean, std } = _windowStats(ii, 10, 10, 4);
  const ref = bruteForceStats(values, w, h, 10, 10, 4);
  expect(mean).toBeCloseTo(ref.mean, 1e-6);
  expect(std).toBeCloseTo(ref.std, 1e-6);
});

test('matches brute-force stats at a corner, where the window must clip to the image edge', () => {
  const w = 20, h = 20;
  const values = Array.from({ length: w * h }, () => Math.floor(Math.random() * 256));
  const ii = _buildIntegralImage(fakeRGBA(values), w, h);
  const { mean, std } = _windowStats(ii, 0, 0, 5);
  const ref = bruteForceStats(values, w, h, 0, 0, 5);
  expect(mean).toBeCloseTo(ref.mean, 1e-6);
  expect(std).toBeCloseTo(ref.std, 1e-6);
});

test('the whole point of a LOCAL window: a dark patch surrounded by light reads differently near vs far from it', () => {
  // 30x30, all 240 (bright page) except a 6x6 dark block (200..210) in
  // the top-left — same idea as real ink on paper. A pixel just inside
  // the dark block should see a low local mean; a pixel far away in the
  // bright region should see a local mean near the page's own brightness
  // — exactly the property a single global threshold can't express.
  const w = 30, h = 30;
  const values = Array(w * h).fill(240);
  for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) values[y * w + x] = 200;
  const ii = _buildIntegralImage(fakeRGBA(values), w, h);
  const nearDark = _windowStats(ii, 4, 4, 3);
  const farBright = _windowStats(ii, 25, 25, 3);
  expect(nearDark.mean).toBeLessThan(farBright.mean);
  expect(farBright.std).toBeCloseTo(0);
});

console.log('\n' + '─'.repeat(50));
console.log(`cleanScanWorker integration tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
