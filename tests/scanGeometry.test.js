// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/scanGeometry.test.js — Unit tests for js/scanGeometry.js's
//  pure geometry math (orderQuadPoints, defaultInsetQuad).
//
//  detectDocumentQuad/warpToRect depend on a loaded OpenCV.js `cv`
//  global and a real <canvas> — not Node-testable (no polyfill, real
//  WASM runtime needed). Verified via real Playwright instead (see
//  the 2026-08-22 QA pass using Chromium's fake-camera flags).
//
//  Run: node tests/scanGeometry.test.js
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

const { orderQuadPoints, defaultInsetQuad, detectSpineX, isValidQuadShape,
        chooseCropViewLayout, rotatedViewPoint, unrotatedImagePoint } = await import('../js/scanGeometry.js');

// Builds a flat RGBA buffer from a 1D array of per-column gray values,
// repeated down every row — matches detectSpineX's "column-average
// luminance" model with a trivial single-row-worth-of-signal image.
function makeColumns(cols, h = 10) {
  const w = cols.length;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = cols[x];
      data[i + 3] = 255;
    }
  }
  return data;
}

console.log('\norderQuadPoints:');

test('orders 4 unordered points into tl/tr/br/bl correctly', () => {
  // Deliberately scrambled input order, plus a slight irregularity
  // (not a perfect rectangle) — realistic for a hand-held photo.
  const scrambled = [
    { x: 90, y: 10 },  // actually top-right
    { x: 10, y: 12 },  // actually top-left
    { x: 95, y: 88 },  // actually bottom-right
    { x: 8,  y: 90 },  // actually bottom-left
  ];
  const q = orderQuadPoints(scrambled);
  expect(q.tl.x).toBe(10); expect(q.tl.y).toBe(12);
  expect(q.tr.x).toBe(90); expect(q.tr.y).toBe(10);
  expect(q.br.x).toBe(95); expect(q.br.y).toBe(88);
  expect(q.bl.x).toBe(8);  expect(q.bl.y).toBe(90);
});

test('a perfect square in already-correct order stays correct', () => {
  const square = [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
  ];
  const q = orderQuadPoints(square);
  expect(q.tl.x).toBe(0);   expect(q.tl.y).toBe(0);
  expect(q.tr.x).toBe(100); expect(q.tr.y).toBe(0);
  expect(q.br.x).toBe(100); expect(q.br.y).toBe(100);
  expect(q.bl.x).toBe(0);   expect(q.bl.y).toBe(100);
});

test('throws on anything other than exactly 4 points', () => {
  let threw = false;
  try { orderQuadPoints([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]); }
  catch { threw = true; }
  expect(threw).toBe(true);
});

console.log('\ndefaultInsetQuad:');

test('insets each edge by the given fraction of width/height', () => {
  const q = defaultInsetQuad(1000, 500, 0.1);
  expect(q.tl.x).toBe(100); expect(q.tl.y).toBe(50);
  expect(q.tr.x).toBe(900); expect(q.tr.y).toBe(50);
  expect(q.br.x).toBe(900); expect(q.br.y).toBe(450);
  expect(q.bl.x).toBe(100); expect(q.bl.y).toBe(450);
});

test('defaults to a 5% margin when none is given', () => {
  const q = defaultInsetQuad(200, 200);
  expect(q.tl.x).toBe(10); expect(q.tl.y).toBe(10);
  expect(q.br.x).toBe(190); expect(q.br.y).toBe(190);
});

test('the result is always inside the original bounds, never outside', () => {
  const q = defaultInsetQuad(640, 480, 0.05);
  for (const corner of [q.tl, q.tr, q.br, q.bl]) {
    if (corner.x < 0 || corner.x > 640 || corner.y < 0 || corner.y > 480) {
      throw new Error(`Corner ${JSON.stringify(corner)} is outside the 640x480 frame`);
    }
  }
});

console.log('\ndetectSpineX:');

test('finds a clear dark gutter band in the middle of the page', () => {
  const w = 100;
  const cols = new Array(w).fill(230); // bright page on both sides
  for (let x = 48; x <= 52; x++) cols[x] = 40; // dark gutter shadow, centered
  const { xFrac, confident } = detectSpineX(makeColumns(cols), w, 10);
  expect(confident).toBe(true);
  expect(xFrac).toBeCloseTo(0.5, 0.03);
});

test('an off-center gutter is still found at its real position', () => {
  const w = 100;
  const cols = new Array(w).fill(230);
  for (let x = 33; x <= 37; x++) cols[x] = 35; // gutter at ~35%, not dead center
  const { xFrac, confident } = detectSpineX(makeColumns(cols), w, 10);
  expect(confident).toBe(true);
  expect(xFrac).toBeCloseTo(0.35, 0.03);
});

test('a flat page with no real gutter reports low confidence', () => {
  const w = 100;
  const cols = new Array(w).fill(230); // uniform — nothing to find
  const { confident } = detectSpineX(makeColumns(cols), w, 10);
  expect(confident).toBe(false);
});

test('minor noise (not a real gutter) still reports low confidence', () => {
  const w = 100;
  const cols = new Array(w).fill(0).map((_, i) => 225 + (i % 3)); // +/-3 jitter, no real dip
  const { confident } = detectSpineX(makeColumns(cols), w, 10);
  expect(confident).toBe(false);
});

test('a dark band near the outer edge (not the gutter) is ignored — search is limited to the middle 60%', () => {
  const w = 100;
  const cols = new Array(w).fill(230);
  for (let x = 0; x < 5; x++) cols[x] = 10; // dark strip right at the left edge (e.g. warp artifact)
  const { xFrac } = detectSpineX(makeColumns(cols), w, 10);
  // Should NOT report the edge artifact — falls back to the (flat, low-confidence) middle
  if (xFrac < 0.2) throw new Error(`Expected the edge artifact at x<0.05 to be excluded, got xFrac=${xFrac}`);
});

console.log('\nchooseCropViewLayout:');

test('a tall portrait photo in a clearly landscape-shaped box prefers rotating', () => {
  // 1080x1920 photo, box that's actually WIDER than tall (e.g. a landscape
  // phone orientation, or very little vertical chrome room left) — this is
  // the case where rotating the portrait photo to landscape gives a real,
  // unambiguous win (~78% bigger), not just a marginal one.
  const { rotated, scale } = chooseCropViewLayout(1080, 1920, 500, 250);
  expect(rotated).toBe(true);
  // rotated fit: min(500/1920, 250/1080) = min(0.2604, 0.2315) = 0.2315
  expect(scale).toBeCloseTo(250 / 1080, 0.001);
});

test('a landscape photo in a tall box prefers rotating (symmetric case)', () => {
  const { rotated, scale } = chooseCropViewLayout(1920, 1080, 250, 500);
  expect(rotated).toBe(true);
  expect(scale).toBeCloseTo(250 / 1080, 0.001);
});

test('a near-square photo in a near-square box does not rotate (no real benefit)', () => {
  const { rotated } = chooseCropViewLayout(1000, 1100, 350, 350);
  expect(rotated).toBe(false);
});

test('a portrait photo in a box that is ALSO portrait-shaped enough does not rotate', () => {
  // box itself is taller than wide, roughly matching the photo's own
  // orientation — rotating would not meaningfully help here.
  const { rotated, scale } = chooseCropViewLayout(1000, 1400, 300, 500);
  expect(rotated).toBe(false);
  expect(scale).toBeCloseTo(Math.min(300 / 1000, 500 / 1400), 0.001);
});

test('the benefit threshold prevents flip-flopping near parity', () => {
  // Construct a box where rotated and unrotated scales are nearly equal —
  // should NOT rotate despite rotated being marginally bigger.
  const { rotated } = chooseCropViewLayout(1000, 1050, 400, 420, 1.15);
  expect(rotated).toBe(false);
});

console.log('\nrotatedViewPoint / unrotatedImagePoint (round-trip + known values):');

test('the original top-left corner maps to the rotated wrapper\'s top-right edge', () => {
  // imgW=1080, imgH=1920, scale=0.2 → wrapper's rotated bounds are
  // imgH*scale=384 wide, imgW*scale=216 tall.
  const p = rotatedViewPoint(0, 0, 1080, 0.2);
  expect(p.x).toBe(0);
  expect(p.y).toBeCloseTo(1080 * 0.2, 0.001);
});

test('the original bottom-right corner maps to the rotated wrapper\'s bottom-left edge', () => {
  const p = rotatedViewPoint(1080, 1920, 1080, 0.2);
  expect(p.x).toBeCloseTo(1920 * 0.2, 0.001);
  expect(p.y).toBeCloseTo(0, 0.001);
});

test('round-trips exactly for an arbitrary interior point', () => {
  const imgW = 1080, scale = 0.234;
  const orig = { x: 412.5, y: 1337.2 };
  const screen = rotatedViewPoint(orig.x, orig.y, imgW, scale);
  const back = unrotatedImagePoint(screen.x, screen.y, imgW, scale);
  expect(back.x).toBeCloseTo(orig.x, 0.001);
  expect(back.y).toBeCloseTo(orig.y, 0.001);
});

test('round-trips for all 4 corners of a real portrait image size', () => {
  const imgW = 1080, imgH = 1920, scale = 0.171875; // an arbitrary realistic scale value
  const corners = [
    { x: 0, y: 0 }, { x: imgW, y: 0 }, { x: imgW, y: imgH }, { x: 0, y: imgH },
  ];
  for (const c of corners) {
    const screen = rotatedViewPoint(c.x, c.y, imgW, scale);
    const back = unrotatedImagePoint(screen.x, screen.y, imgW, scale);
    expect(back.x).toBeCloseTo(c.x, 0.01);
    expect(back.y).toBeCloseTo(c.y, 0.01);
  }
});

// ── isValidQuadShape ─────────────────────────────────────────────

test('a normal axis-aligned rectangle is valid', () => {
  expect(isValidQuadShape(defaultInsetQuad(1000, 1000))).toBe(true);
});

test('a normal skewed (perspective-photographed) quad is valid', () => {
  const quad = {
    tl: { x: 90, y: 120 }, tr: { x: 520, y: 100 },
    br: { x: 540, y: 700 }, bl: { x: 70, y: 720 },
  };
  expect(isValidQuadShape(quad)).toBe(true);
});

test('a self-intersecting "bowtie" quad (tl/tr swapped past each other) is invalid', () => {
  const quad = {
    tl: { x: 500, y: 100 }, tr: { x: 100, y: 100 }, // crossed with the row below
    br: { x: 500, y: 500 }, bl: { x: 100, y: 500 },
  };
  expect(isValidQuadShape(quad)).toBe(false);
});

test('a degenerate quad with all 4 corners bunched together is invalid', () => {
  const quad = {
    tl: { x: 200, y: 200 }, tr: { x: 201, y: 200 },
    br: { x: 201, y: 201 }, bl: { x: 200, y: 201 },
  };
  expect(isValidQuadShape(quad)).toBe(false);
});

test('a valid quad stays valid after ordinary corner-handle dragging', () => {
  // Simulates a user nudging one corner (tl) — still convex, still a
  // reasonable size.
  const quad = {
    tl: { x: 60, y: 90 }, tr: { x: 900, y: 50 },
    br: { x: 950, y: 950 }, bl: { x: 50, y: 900 },
  };
  expect(isValidQuadShape(quad)).toBe(true);
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
