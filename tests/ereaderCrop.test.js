// ============================================================
//  tests/ereaderCrop.test.js — Unit tests for js/ereaderCrop.js
//  Запуск: node tests/ereaderCrop.test.js
// ============================================================

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

function expect(actual) {
  return {
    toBe:        (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeCloseTo: (e, eps = 0.01) => { if (Math.abs(actual - e) > eps) throw new Error(`Expected ~${e}, got ${actual}`); },
    toBeTruthy:  () => { if (!actual) throw new Error(`Expected truthy, got ${actual}`); },
  };
}

const { contentBBox, reconcileGlobalCrop, padBBox, composeWithAspect, DEVICE_PRESETS } =
  await import('../js/ereaderCrop.js');

// ── Helpers: build a synthetic white RGBA buffer with a black rect ──

function makeWhitePage(width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  return rgba;
}

function paintRect(rgba, width, x0, y0, x1, y1, gray = 0) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = gray;
    }
  }
}

// ── contentBBox ──────────────────────────────────────────────────
console.log('\ncontentBBox:');

test('detects a centered black square on a white page', () => {
  const w = 100, h = 100;
  const rgba = makeWhitePage(w, h);
  paintRect(rgba, w, 20, 30, 80, 70); // x:20-80, y:30-70
  const bbox = contentBBox(rgba, w, h);
  expect(bbox.left).toBeCloseTo(0.20, 0.02);
  expect(bbox.right).toBeCloseTo(0.80, 0.02);
  expect(bbox.top).toBeCloseTo(0.30, 0.02);
  expect(bbox.bottom).toBeCloseTo(0.70, 0.02);
});

test('a fully blank/white page returns the full-page box (safe "don\'t crop")', () => {
  const w = 50, h = 50;
  const rgba = makeWhitePage(w, h);
  const bbox = contentBBox(rgba, w, h);
  expect(bbox.top).toBe(0);
  expect(bbox.left).toBe(0);
  expect(bbox.bottom).toBe(1);
  expect(bbox.right).toBe(1);
});

test('a single stray dark pixel (scanner dust) does not move the bbox', () => {
  const w = 100, h = 100;
  const rgba = makeWhitePage(w, h);
  // One isolated noise pixel far from any real content.
  const i = (5 * w + 5) * 4;
  rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
  const bbox = contentBBox(rgba, w, h);
  expect(bbox.top).toBe(0);
  expect(bbox.left).toBe(0);
  expect(bbox.bottom).toBe(1);
  expect(bbox.right).toBe(1);
});

test('a real (wide) dark region is detected even at low density-floor edges', () => {
  const w = 200, h = 200;
  const rgba = makeWhitePage(w, h);
  paintRect(rgba, w, 10, 10, 190, 20); // a thin but wide horizontal bar (real content, not noise)
  const bbox = contentBBox(rgba, w, h);
  expect(bbox.left).toBeCloseTo(0.05, 0.02);
  expect(bbox.right).toBeCloseTo(0.95, 0.02);
});

// ── reconcileGlobalCrop ──────────────────────────────────────────
console.log('\nreconcileGlobalCrop:');

test('median resists a stray full-bleed outlier page (vs. union)', () => {
  const normal = { top: 0.1, bottom: 0.9, left: 0.1, right: 0.9 };
  const fullBleed = { top: 0, bottom: 1, left: 0, right: 1 }; // one photo/chart page
  const result = reconcileGlobalCrop([normal, normal, normal, fullBleed]);
  // Median of [0.1,0.1,0.1,0] -> 0.1 (4 samples: sorted [0,0.1,0.1,0.1], mid avg of index1,2 = 0.1)
  expect(result.top).toBeCloseTo(0.1, 0.02);
  expect(result.left).toBeCloseTo(0.1, 0.02);
});

test('median resists a stray near-blank outlier page (vs. intersection)', () => {
  const normal = { top: 0.1, bottom: 0.9, left: 0.1, right: 0.9 };
  const blank = { top: 0, bottom: 1, left: 0, right: 1 }; // near-blank chapter divider
  const result = reconcileGlobalCrop([normal, normal, normal, blank]);
  expect(result.bottom).toBeCloseTo(0.9, 0.02);
  expect(result.right).toBeCloseTo(0.9, 0.02);
});

test('empty input returns full page', () => {
  const result = reconcileGlobalCrop([]);
  expect(result.top).toBe(0);
  expect(result.bottom).toBe(1);
});

// ── padBBox ────────────────────────────────────────────────────
console.log('\npadBBox:');

test('expands each edge by the padding fraction', () => {
  const bbox = { top: 0.3, bottom: 0.7, left: 0.2, right: 0.8 };
  const padded = padBBox(bbox, 0.05);
  expect(padded.top).toBeCloseTo(0.25);
  expect(padded.bottom).toBeCloseTo(0.75);
  expect(padded.left).toBeCloseTo(0.15);
  expect(padded.right).toBeCloseTo(0.85);
});

test('clamps at page edges instead of going negative / past 1', () => {
  const bbox = { top: 0.01, bottom: 0.99, left: 0.01, right: 0.99 };
  const padded = padBBox(bbox, 0.05);
  expect(padded.top).toBe(0);
  expect(padded.bottom).toBe(1);
  expect(padded.left).toBe(0);
  expect(padded.right).toBe(1);
});

// ── composeWithAspect ────────────────────────────────────────────
console.log('\ncomposeWithAspect:');

test('grows height when the cropped box is too wide for the target aspect', () => {
  // A US-Letter-like page (612x792pt), crop box spans the full width but
  // only the middle third vertically -> box aspect is much wider than 3:4.
  const cropRect = { top: 0.4, bottom: 0.6, left: 0, right: 1 };
  const result = composeWithAspect(cropRect, 612, 792, 3 / 4);
  expect(result.bottom - result.top > 0.2).toBeTruthy();
  // Left/right untouched since width wasn't the short dimension.
  expect(result.left).toBe(0);
  expect(result.right).toBe(1);
});

test('grows width when the cropped box is too narrow (tall) for the target aspect', () => {
  const cropRect = { top: 0, bottom: 1, left: 0.4, right: 0.6 };
  const result = composeWithAspect(cropRect, 612, 792, 3 / 4);
  expect(result.right - result.left > 0.2).toBeTruthy();
  expect(result.top).toBe(0);
  expect(result.bottom).toBe(1);
});

test('clamps expansion at the original page edge rather than exceeding it', () => {
  // Box already nearly fills the page — can't grow much before hitting 0/1.
  const cropRect = { top: 0.01, bottom: 0.99, left: 0.3, right: 0.7 };
  const result = composeWithAspect(cropRect, 612, 792, 3 / 4);
  expect(result.top >= 0).toBeTruthy();
  expect(result.bottom <= 1).toBeTruthy();
  expect(result.left >= 0).toBeTruthy();
  expect(result.right <= 1).toBeTruthy();
});

test('never crops further than the input box (only ever grows edges outward)', () => {
  const cropRect = { top: 0.2, bottom: 0.8, left: 0.1, right: 0.9 };
  const result = composeWithAspect(cropRect, 500, 500, 1); // square target
  expect(result.top <= cropRect.top).toBeTruthy();
  expect(result.bottom >= cropRect.bottom).toBeTruthy();
  expect(result.left <= cropRect.left).toBeTruthy();
  expect(result.right >= cropRect.right).toBeTruthy();
});

// ── DEVICE_PRESETS ────────────────────────────────────────────
console.log('\nDEVICE_PRESETS:');

test('has kindle, remarkable, kobo presets with sane aspect ratios', () => {
  expect(DEVICE_PRESETS.kindle.aspect > 0 && DEVICE_PRESETS.kindle.aspect < 1).toBeTruthy();
  expect(DEVICE_PRESETS.remarkable.aspect > 0 && DEVICE_PRESETS.remarkable.aspect < 1).toBeTruthy();
  expect(DEVICE_PRESETS.kobo.aspect > 0 && DEVICE_PRESETS.kobo.aspect < 1).toBeTruthy();
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
