// ============================================================
//  tests/cleanScanWorker.integration.test.js
//
//  Node-testable slice of js/cleanScanWorker.js: only _otsuThreshold
//  is plain pixel-array math with no Canvas dependency — every other
//  function in that file (_toGrayscaleCanvas, _estimateBackground,
//  _flatFieldCorrect, _applyClean, _applyEnhance) needs a real
//  OffscreenCanvas 2D context, which doesn't exist in Node and isn't
//  worth adding a canvas-polyfill devDependency for. Those are verified
//  instead via a real-browser Playwright script (see
//  scripts/verify-clean-scan-algorithm.md for how to re-run it) — not
//  part of `npm test`, same precedent as the other *Worker.js
//  integration tests needing something Node can't provide.
//
//  Same extraction technique as tests/fillOrderWorker.integration.test.js:
//  read the worker source as text, strip importScripts/self.onmessage,
//  eval via AsyncFunction, pull out just the pure function we need.
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
const workerModule = new AsyncFunction(workerSrc + '\nreturn { _otsuThreshold };');
const { _otsuThreshold } = await workerModule();

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
    toBeCloseTo: (e, eps = 5) => { if (Math.abs(actual - e) > eps) throw new Error(`Expected ${actual} ≈ ${e} (±${eps})`); },
    toBeGreaterThan: (n) => { if (!(actual > n)) throw new Error(`Expected ${actual} > ${n}`); },
    toBeLessThan: (n) => { if (!(actual < n)) throw new Error(`Expected ${actual} < ${n}`); },
  };
}

// Builds a fake RGBA buffer (data[i] used as luminance, R=G=B) from an
// array of grayscale pixel values — _otsuThreshold only reads data[i]
// (the R channel) at stride 4, matching real ImageData.data layout.
function fakeRGBA(values) {
  const d = new Uint8ClampedArray(values.length * 4);
  values.forEach((v, i) => { d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255; });
  return d;
}

console.log('\n🧼 cleanScanWorker — _otsuThreshold:');

// Real scanned pixels always have some spread within each cluster
// (anti-aliasing, sensor noise, JPEG artifacts) — a perfectly flat,
// zero-variance synthetic cluster is an unrealistic edge case where
// Otsu's tie-breaking (first t achieving max variance) lands exactly on
// the cluster's own value rather than a midpoint. These fixtures use a
// small spread to match real-world input.
function spread(center, width, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(Math.max(0, Math.min(255, center + Math.round((Math.random() - 0.5) * width))));
  }
  return out;
}

test('splits a clean bimodal distribution near the midpoint between the two clusters', () => {
  const values = [...spread(20, 20, 500), ...spread(230, 20, 500)]; // dark "text" vs light "background"
  const t = _otsuThreshold(fakeRGBA(values));
  expect(t).toBeGreaterThan(20);
  expect(t).toBeLessThan(230);
});

test('a nearly-all-white page (typical clean scan) still finds the gap between the small dark cluster and the page background', () => {
  const values = [...spread(10, 15, 50), ...spread(245, 10, 950)];
  const t = _otsuThreshold(fakeRGBA(values));
  expect(t).toBeGreaterThan(15);
  expect(t).toBeLessThan(235);
});

test('a uniform single-value image still returns a valid, non-crashing threshold', () => {
  const values = Array(1000).fill(128);
  const t = _otsuThreshold(fakeRGBA(values));
  expect(t).toBeGreaterThan(-1);
  expect(t).toBeLessThan(256);
});

test('threshold correctly separates two well-separated realistic clusters', () => {
  const values = [...spread(60, 20, 300), ...spread(200, 20, 300)];
  const t = _otsuThreshold(fakeRGBA(values));
  expect(t).toBeGreaterThan(60);
  expect(t).toBeLessThan(200);
});

console.log('\n' + '─'.repeat(50));
console.log(`cleanScanWorker integration tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
