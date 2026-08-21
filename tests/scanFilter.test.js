// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/scanFilter.test.js — Unit tests for js/scanFilter.js
//  (jpg2pdf's "Scan with Camera" pixel filter, copied from
//  js/cleanScanUI.js's live-preview pipeline — see that file's header
//  and js/scanFilter.js's header for why it's a copy, not an import).
//
//  Most of this module's functions wrap a real <canvas>/getContext('2d')
//  internally (drawImage/getImageData/putImageData) — there's no canvas
//  polyfill in this project (zero new deps), and Clean Scan itself has
//  never had a Node-level pixel test for the same reason. Only
//  medianFilterGray/boxBlurGray operate on a raw pixel array directly,
//  so those are what's exported and tested here — real regression
//  coverage for the two purely-algorithmic pieces. The full
//  filterScanPhoto() pipeline (grayscale → background-estimate →
//  flat-field-correct → these two → enhance) is verified via real
//  Playwright browser runs instead (2026-08-21 QA pass).
//
//  Run: node tests/scanFilter.test.js
// ============================================================

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe:       (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeCloseTo: (e, eps = 0.01) => { if (Math.abs(actual - e) > eps) throw new Error(`Expected ~${e}, got ${actual}`); },
  };
}

const { medianFilterGray, boxBlurGray } = await import('../js/scanFilter.js');

// Builds a flat RGBA buffer (grayscale-as-RGBA, R=G=B) from a 2D array of
// gray values so tests can express a small image as readable rows.
function makeGray(rows) {
  const h = rows.length, w = rows[0].length;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = rows[y][x];
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, w, h };
}

console.log('\nmedianFilterGray:');

test('a single bright speck surrounded by dark pixels is removed (denoise)', () => {
  const { data, w, h } = makeGray([
    [10, 10, 10],
    [10, 255, 10], // lone bright speck in the center
    [10, 10, 10],
  ]);
  const out = medianFilterGray(data, w, h);
  expect(out[1 * w + 1]).toBe(10); // median of the 3x3 window is 10, not 255
});

test('a flat image is unchanged', () => {
  const { data, w, h } = makeGray([
    [100, 100, 100],
    [100, 100, 100],
    [100, 100, 100],
  ]);
  const out = medianFilterGray(data, w, h);
  for (let i = 0; i < out.length; i++) expect(out[i]).toBe(100);
});

test('corner pixels (smaller neighborhood) still compute a sane median', () => {
  const { data, w, h } = makeGray([
    [0, 200],
    [200, 200],
  ]);
  const out = medianFilterGray(data, w, h);
  // top-left corner's window is {0,200,200} (only 3 in-bounds neighbors) → median 200
  expect(out[0]).toBe(200);
});

console.log('\nboxBlurGray:');

test('a flat image is unchanged by blurring (no edges to blur)', () => {
  const { data, w, h } = makeGray([
    [128, 128, 128, 128],
    [128, 128, 128, 128],
    [128, 128, 128, 128],
  ]);
  const out = boxBlurGray(data, w, h, 1);
  for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(128, 0.5);
});

test('a hard edge gets smoothed toward the average at the boundary', () => {
  const { data, w, h } = makeGray([
    [0, 0, 255, 255],
    [0, 0, 255, 255],
    [0, 0, 255, 255],
  ]);
  const out = boxBlurGray(data, w, h, 1);
  const centerLeftIdx  = 1 * w + 1; // column index 1, right at the edge
  const farLeftIdx     = 1 * w + 0; // column index 0, away from the edge
  // The pixel right at the edge should be pulled toward the average more
  // than a pixel further from the edge — i.e. blurring actually spread
  // some of the bright side's value leftward.
  if (!(out[centerLeftIdx] > out[farLeftIdx])) {
    throw new Error(`Expected edge-adjacent pixel (${out[centerLeftIdx]}) > far pixel (${out[farLeftIdx]})`);
  }
});

test('larger radius blurs more (smaller radius stays closer to the original edge)', () => {
  const { data, w, h } = makeGray([
    [0, 0, 0, 255, 255, 255],
    [0, 0, 0, 255, 255, 255],
    [0, 0, 0, 255, 255, 255],
  ]);
  const smallRadius = boxBlurGray(data, w, h, 1);
  const bigRadius    = boxBlurGray(data, w, h, 2);
  const idx = 1 * w + 2; // last pixel of the dark half, right at the boundary
  // A bigger blur radius pulls more of the bright half's value in, so the
  // boundary pixel should end up brighter with radius 2 than radius 1.
  if (!(bigRadius[idx] > smallRadius[idx])) {
    throw new Error(`Expected radius-2 value (${bigRadius[idx]}) > radius-1 value (${smallRadius[idx]})`);
  }
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
