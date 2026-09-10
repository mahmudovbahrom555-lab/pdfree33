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

const { contentBBox, reconcileGlobalCrop, padBBox, composeWithAspect, DEVICE_PRESETS,
        detectColumnGutter, reconcileColumnSplit } =
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

// ── detectColumnGutter ───────────────────────────────────────────
console.log('\ndetectColumnGutter:');

test('detects a clear central gutter between two text columns', () => {
  const w = 400, h = 600;
  const rgba = makeWhitePage(w, h);
  paintRect(rgba, w, 40, 60, 180, 540);  // left column
  paintRect(rgba, w, 220, 60, 360, 540); // right column — gap 180-220 is central
  const cropRect = { top: 0.05, bottom: 0.95, left: 0.05, right: 0.95 };
  const result = detectColumnGutter(rgba, w, h, cropRect);
  expect(result.hasGutter).toBe(true);
  expect(result.centerFrac).toBeCloseTo(0.5, 0.03);
});

test('reports no gutter for a single full-width column', () => {
  const w = 400, h = 600;
  const rgba = makeWhitePage(w, h);
  paintRect(rgba, w, 40, 60, 360, 540); // one solid block, no gap
  const cropRect = { top: 0.05, bottom: 0.95, left: 0.05, right: 0.95 };
  const result = detectColumnGutter(rgba, w, h, cropRect);
  expect(result.hasGutter).toBe(false);
  expect(result.centerFrac).toBe(null);
});

test('rejects a gap narrower than the minimum gutter width (noise, not a real column break)', () => {
  const w = 400, h = 600;
  const rgba = makeWhitePage(w, h);
  paintRect(rgba, w, 40, 60, 198, 540);
  paintRect(rgba, w, 201, 60, 360, 540); // only a 3px gap — below the ~5-6px floor
  const cropRect = { top: 0.05, bottom: 0.95, left: 0.05, right: 0.95 };
  const result = detectColumnGutter(rgba, w, h, cropRect);
  expect(result.hasGutter).toBe(false);
});

test('ignores real blank gaps that fall outside the central search band (ordinary margins, not a gutter)', () => {
  const w = 400, h = 600; // crop band (0.25-0.75 of the 360px-wide crop) is x=110..290
  const rgba = makeWhitePage(w, h);
  paintRect(rgba, w, 40, 60, 100, 540);  // left content — blank sliver 100-110 is outside the band
  paintRect(rgba, w, 110, 60, 290, 540); // content fills the entire band solidly — no in-band gap
  paintRect(rgba, w, 310, 60, 360, 540); // right content — blank gap 290-310 is also outside the band
  const cropRect = { top: 0.05, bottom: 0.95, left: 0.05, right: 0.95 };
  const result = detectColumnGutter(rgba, w, h, cropRect);
  expect(result.hasGutter).toBe(false);
});

test('does not mistake a single narrow centered content block for 2-column (regression)', () => {
  // A sparse page (e.g. a title/section-break page) with only a short, centered
  // line of text and nothing else — no real second column, but the whitespace
  // on either side of the text happens to fall inside the central band, which
  // used to be mistaken for a genuine inter-column gutter (found via direct
  // synthetic-pixel repro, not just observed once — see js/ereaderCrop.js's
  // GUTTER_OUTER_INK_MIN comment). Both "gutter" sides here are actually just
  // the outer margins of one single content block — neither side has any real
  // column content near the crop's own edges.
  const w = 400, h = 600;
  const rgba = makeWhitePage(w, h);
  paintRect(rgba, w, 160, 60, 240, 100); // one short centered title line only
  const cropRect = { top: 0.05, bottom: 0.95, left: 0.05, right: 0.95 };
  const result = detectColumnGutter(rgba, w, h, cropRect);
  expect(result.hasGutter).toBe(false);
});

test('rejects gutter search entirely on a narrow crop (a single short line, not a 2-column page)', () => {
  // Real repro (not just theoretical): a 6-page "title-only" book (each page
  // just a short line like "Chapter 1") rendered through the actual pdf.js
  // pipeline gave contentBBox() a tight per-page crop spanning only ~17% of
  // the page width — and detectColumnGutter, searching for a gutter *inside*
  // that narrow crop, found the ordinary inter-word gap ("Chapter" | "1")
  // and mistook it for a column break. A genuine 2-column layout's own
  // per-page crop measured ~83% of page width in the same real pipeline —
  // this test's 0.42-0.59 cropRect (17% wide) matches the real failing case
  // almost exactly. The band/outer-ink checks alone don't catch this (both
  // "sides" of an inter-word gap have real letter ink), so the width guard
  // is the primary fix, checked first.
  const w = 400, h = 600;
  const rgba = makeWhitePage(w, h);
  paintRect(rgba, w, 168, 250, 196, 270); // "Chapter" — left word block
  paintRect(rgba, w, 204, 250, 236, 270); // "1" — right word block, gap 196-204 in between
  const cropRect = { top: 0.40, bottom: 0.48, left: 0.42, right: 0.59 }; // ~17% of width, matches the real repro
  const result = detectColumnGutter(rgba, w, h, cropRect);
  expect(result.hasGutter).toBe(false);
});

test('still detects a real 2-column gutter when column text is sparse, not a solid block', () => {
  // Real body text isn't a 100% solid rectangle — simulate ~40% ink coverage
  // per column (horizontal stripes) to confirm the outer-ink-density check
  // (added for the regression above) doesn't require unrealistically dense
  // text to still recognize a genuine 2-column layout.
  const w = 400, h = 600;
  const rgba = makeWhitePage(w, h);
  for (let y = 60; y < 540; y += 5) {
    paintRect(rgba, w, 40, y, 180, y + 2);  // left column, striped
    paintRect(rgba, w, 220, y, 360, y + 2); // right column, striped
  }
  const cropRect = { top: 0.05, bottom: 0.95, left: 0.05, right: 0.95 };
  const result = detectColumnGutter(rgba, w, h, cropRect);
  expect(result.hasGutter).toBe(true);
  expect(result.centerFrac).toBeCloseTo(0.5, 0.03);
});

// ── reconcileColumnSplit ─────────────────────────────────────────
console.log('\nreconcileColumnSplit:');

test('enables split when most sampled pages show a gutter, using the median center', () => {
  const gutters = [
    { hasGutter: true, centerFrac: 0.49 },
    { hasGutter: true, centerFrac: 0.50 },
    { hasGutter: true, centerFrac: 0.51 },
    { hasGutter: false, centerFrac: null }, // one outlier (e.g. a full-bleed figure page)
  ];
  const result = reconcileColumnSplit(gutters);
  expect(result.enabled).toBe(true);
  expect(result.centerFrac).toBeCloseTo(0.50, 0.01);
});

test('does not enable split when only a minority of pages show a gutter', () => {
  const gutters = [
    { hasGutter: true, centerFrac: 0.5 },
    { hasGutter: false, centerFrac: null },
    { hasGutter: false, centerFrac: null },
    { hasGutter: false, centerFrac: null },
  ];
  const result = reconcileColumnSplit(gutters);
  expect(result.enabled).toBe(false);
  expect(result.centerFrac).toBe(null);
});

test('empty input returns disabled', () => {
  const result = reconcileColumnSplit([]);
  expect(result.enabled).toBe(false);
  expect(result.centerFrac).toBe(null);
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
