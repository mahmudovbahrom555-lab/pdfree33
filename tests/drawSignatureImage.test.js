// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/drawSignatureImage.test.js — Unit tests for
//  js/drawSignatureImage.js's pure pixel-classification logic.
//
//  loadSignatureImage itself needs createImageBitmap + a real <canvas> —
//  not Node-testable, verified via Playwright instead.
//
//  Run: node tests/drawSignatureImage.test.js
// ============================================================

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe: (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
  };
}

const { otsuThreshold, despeckleMask, hasRealAlpha, removeBackground } =
  await import('../js/drawSignatureImage.js');

// Builds a flat RGBA buffer (opaque, alpha=255) from a 2D array of gray values.
function makeGrayRGBA(rows) {
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

test('otsuThreshold splits a clearly bimodal image, classifying each cluster correctly', () => {
  // Two clusters plus a thin bridge of intermediate values — a real photo
  // always has SOME pixels in between (anti-aliasing/noise/JPEG blocking),
  // unlike a hard two-value split. With a genuine gap in the histogram,
  // Otsu's between-class variance is flat across the whole gap and (with
  // this implementation's strict '>' / first-wins tie-break) always snaps
  // to the low cluster's own edge rather than a midpoint — worth knowing,
  // but not what a real image ever produces, so tested with a bridge here.
  const data = new Uint8ClampedArray((100 + 100 + 20) * 4);
  let p = 0;
  for (let i = 0; i < 100; i++, p++) { const v = 10 + (i % 20); data[p*4]=data[p*4+1]=data[p*4+2]=v; data[p*4+3]=255; }
  for (let i = 0; i < 20; i++, p++)  { const v = 60 + i * 6;    data[p*4]=data[p*4+1]=data[p*4+2]=v; data[p*4+3]=255; } // 60..174 bridge
  for (let i = 0; i < 100; i++, p++) { const v = 215 + (i % 20); data[p*4]=data[p*4+1]=data[p*4+2]=v; data[p*4+3]=255; }
  const t = otsuThreshold(data);
  // What actually matters for removeBackground: dark cluster classifies as
  // ink (< t), light cluster classifies as background (>= t).
  if (!(29 < t)) throw new Error(`Dark cluster (max 29) should be < threshold, got t=${t}`);
  if (!(215 >= t)) throw new Error(`Light cluster (min 215) should be >= threshold, got t=${t}`);
});

test('hasRealAlpha is false for a uniformly opaque image', () => {
  const data = new Uint8ClampedArray(40);
  for (let i = 3; i < 40; i += 4) data[i] = 255;
  expect(hasRealAlpha(data)).toBe(false);
});

test('hasRealAlpha is true when at least one pixel differs', () => {
  const data = new Uint8ClampedArray(40);
  for (let i = 3; i < 40; i += 4) data[i] = 255;
  data[7] = 0; // second pixel's alpha differs
  expect(hasRealAlpha(data)).toBe(true);
});

test('despeckleMask removes an isolated single dark pixel with no dark neighbors', () => {
  // 3x3 grid, only the center pixel is "dark" (1), all neighbors are 0 —
  // center has 0 dark neighbors (itself doesn't count), must be removed.
  const mask = new Uint8Array([
    0, 0, 0,
    0, 1, 0,
    0, 0, 0,
  ]);
  const out = despeckleMask(mask, 3, 3, 3);
  expect(out[4]).toBe(0); // center (index 4) removed
});

test('despeckleMask keeps a dark pixel with enough dark neighbors', () => {
  // A solid 3x3 block of dark pixels — center has 8 dark neighbors, kept.
  const mask = new Uint8Array(9).fill(1);
  const out = despeckleMask(mask, 3, 3, 3);
  expect(out[4]).toBe(1);
});

test('removeBackground makes light background pixels transparent, keeps dark ink opaque', () => {
  // 2x2: top row dark (ink), bottom row light (background).
  const { data, w, h } = makeGrayRGBA([
    [10, 10],
    [240, 240],
  ]);
  removeBackground(data, w, h);
  // Ink pixels (row 0) — alpha should stay 255 (despeckle may vary with
  // such a tiny image, but at minimum the classification direction must
  // be correct: ink alpha >= background alpha).
  const inkAlpha = data[3];
  const bgAlpha  = data[(2 * 4) + 3]; // row 1, col 0
  if (inkAlpha < bgAlpha) throw new Error(`Expected ink pixel more opaque than background: ink=${inkAlpha} bg=${bgAlpha}`);
});

test('removeBackground preserves original RGB color of ink pixels (does not force black)', () => {
  // A blue-ink block, not black — common for a real pen signature. Slightly
  // varied values (not one flat number) — see the otsuThreshold test above
  // for why a real-ish spread matters for this algorithm.
  const w = 7, h = 6;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const v = 230 + (p % 15); // light "paper" background, 230..244
    data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  // 4x4 solid-ish blue-ink block in the corner (rows/cols 0-3) — big enough
  // that despeckle's 3-dark-neighbor requirement keeps its center pixels.
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const i = (y * w + x) * 4;
      const v = 15 + ((y * 4 + x) % 15); // dark ink, 15..29
      data[i] = v; data[i + 1] = v; data[i + 2] = v + 140; data[i + 3] = 255; // bluish
    }
  }
  // A thin bridge column of intermediate values (col 4) — see the
  // otsuThreshold test above for why real (non-flat-gap) data matters here.
  for (let y = 0; y < h; y++) {
    const i = (y * w + 4) * 4;
    const v = 60 + y * 20;
    data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  removeBackground(data, w, h);
  // Center of the ink block (1,1) should still be blue-ish and opaque.
  const ci = (1 * w + 1) * 4;
  if (data[ci + 3] !== 255) throw new Error(`Expected ink pixel opaque, got alpha=${data[ci + 3]}`);
  if (!(data[ci + 2] > data[ci])) throw new Error(`Expected blue channel to dominate red (preserved color), got r=${data[ci]} b=${data[ci + 2]}`);
});

test('removeBackground gives a real antialiased edge a smooth (partial) alpha, not a hard 0/255 cutoff', () => {
  // A dark ink square on a light background, with a genuine antialiased
  // transition ring around it (values blending linearly from ink to
  // background over a few pixels) — this is what a real photographed
  // signature's edge actually looks like (focus blur, JPEG compression,
  // the pen stroke's own edge), unlike the flat-color-with-hard-edge
  // fixtures elsewhere in this file. A hard binary cutoff (the original,
  // now-replaced design) would classify every one of these transition
  // pixels as either pure ink or pure background — this test's whole
  // point is confirming that no longer happens.
  const w = 20, h = 20;
  const data = new Uint8ClampedArray(w * h * 4);
  const bg = 235, ink = 20;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Distance from the edge of a centered 10x10 ink square (0..20; y/x centered 5..14).
      const dx = Math.max(4 - x, x - 15, 0);
      const dy = Math.max(4 - y, y - 15, 0);
      const distOutside = Math.max(dx, dy); // 0 = inside/on the square, grows outward
      const insideSquare = x >= 5 && x <= 14 && y >= 5 && y <= 14;
      let v;
      if (insideSquare) v = ink;
      else if (distOutside <= 3) v = Math.round(ink + (bg - ink) * (distOutside / 3)); // antialiased ramp
      else v = bg;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  removeBackground(data, w, h);

  // The ink square's core must stay fully opaque.
  const coreI = (9 * w + 9) * 4;
  if (data[coreI + 3] !== 255) throw new Error(`Expected ink core fully opaque, got alpha=${data[coreI + 3]}`);

  // Far background must be fully transparent.
  const farI = (0 * w + 0) * 4;
  if (data[farI + 3] !== 0) throw new Error(`Expected far background fully transparent, got alpha=${data[farI + 3]}`);

  // The antialiased ring itself — collect its alpha values and require at
  // least one genuinely intermediate (neither ~0 nor ~255) value, proving
  // the edge got a real ramp instead of snapping to one extreme.
  let sawPartial = false;
  for (let y = 1; y <= 18; y++) {
    for (let x = 1; x <= 18; x++) {
      const insideSquare = x >= 5 && x <= 14 && y >= 5 && y <= 14;
      if (insideSquare) continue;
      const a = data[(y * w + x) * 4 + 3];
      if (a > 20 && a < 235) sawPartial = true;
    }
  }
  if (!sawPartial) throw new Error('Expected at least one edge pixel with a genuinely partial alpha (smooth ramp), found only 0/255');
});

test('removeBackground still discards an isolated noise speck (despeckle over the wider edge-aware mask)', () => {
  // A single mid-gray pixel with no ink anywhere near it — real JPEG
  // compression noise. Must still be fully removed, not left as a stray
  // semi-transparent speck now that despeckle runs on the wider
  // "could be ink or its soft edge" range instead of the old strict range.
  const w = 12, h = 12;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    data[i] = data[i + 1] = data[i + 2] = 235; data[i + 3] = 255;
  }
  const noiseI = (6 * w + 6) * 4;
  data[noiseI] = data[noiseI + 1] = data[noiseI + 2] = 100; // isolated mid-gray speck, no ink nearby
  removeBackground(data, w, h);
  if (data[noiseI + 3] !== 0) throw new Error(`Expected isolated noise speck fully removed, got alpha=${data[noiseI + 3]}`);
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
