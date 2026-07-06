// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

// ============================================================
//  tests/watermarkUI.logic.test.js
//
//  Pure-logic tests for watermarkUI.js.  All tested functions
//  are copied verbatim (or as thin wrappers) from the source so
//  the suite runs in Node.js without a DOM.
//
//  Covers:
//    • _escAttr       — attribute-safe HTML escaping
//    • opacityNorm    — slider value (0-100) → PDF opacity (0-1)
//    • opacityDisplay — opacity (0-1) → display string (e.g. "30%")
//    • colorConstruct — COLOR_MAP + opacity → rgba() string
//    • previewScale   — fontSize * canvas-scale → canvas font size
//    • positionCoords — position label → (x, y) on preview canvas
//    • rotationAngle  — position label → rotation in radians
//    • tileGrid       — tile mode grid coordinates
//    • validation     — getParams.validate from toolRegistrations
//    • defaultParams  — shape of getWatermarkParams() return value
//    • fontSizeParse  — parseInt with radix + NaN fallback
// ============================================================

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      r.then(() => { console.log(`  ✓ ${name}`); passed++; })
       .catch(e => { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; });
    } else {
      console.log(`  ✓ ${name}`); passed++;
    }
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`); failed++;
  }
}

function expect(actual) {
  return {
    toBe:              (e) => { if (actual !== e)  throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toEqual:           (e) => { if (JSON.stringify(actual) !== JSON.stringify(e)) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy:        ()  => { if (!actual)       throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
    toBeFalsy:         ()  => { if (actual)        throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`); },
    toBeNull:          ()  => { if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`); },
    toBeCloseTo:       (e, p = 5) => {
      const d = Math.abs(actual - e);
      if (d >= Math.pow(10, -p) / 2) throw new Error(`Expected ~${e}, got ${actual}`);
    },
    toContain:         (v) => { if (!actual.includes(v)) throw new Error(`Expected to contain ${JSON.stringify(v)}, got ${JSON.stringify(actual)}`); },
    toHaveLength:      (n) => { if (actual.length !== n)  throw new Error(`Expected length ${n}, got ${actual.length}`); },
    toBeGreaterThan:   (n) => { if (actual <= n)  throw new Error(`Expected ${actual} > ${n}`); },
    toBeLessThanOrEqualTo: (n) => { if (actual > n) throw new Error(`Expected ${actual} <= ${n}`); },
  };
}

// ── Pure copies from watermarkUI.js ───────────────────────────

// Color map — copied verbatim from watermarkUI.js
const COLOR_MAP = {
  gray: 'rgba(128,128,128,',
  red:  'rgba(200,0,0,',
  blue: 'rgba(0,60,200,',
};

// Attribute-safe HTML escaping — the fixed version from watermarkUI.js
function _escAttr(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Opacity normalization: slider integer (0–100) → PDF decimal (0–1)
function normalizeOpacity(sliderValue) {
  return sliderValue / 100;
}

// Opacity display: internal decimal → percentage string label
function opacityDisplay(opacity) {
  return Math.round(opacity * 100) + '%';
}

// Build full rgba() color string (as used in preview and PDF)
function buildColor(colorName, opacity) {
  return (COLOR_MAP[colorName] || COLOR_MAP.gray) + opacity + ')';
}

// Preview canvas font size: PDF points → canvas pixels
// Canvas W=200, A4 width=595pt, scale factor 2.2 for readability
const PREVIEW_W = 200;
const PREVIEW_H = 260;
const A4_W      = 595;

function previewFontSize(fontSize) {
  const scale = PREVIEW_W / A4_W;
  return Math.round(fontSize * scale * 2.2);
}

// Position → (x, y) center of watermark on preview canvas
function positionCoords(position) {
  const W = PREVIEW_W, H = PREVIEW_H;
  let x = W / 2, y = H / 2;
  if (position === 'top')    y = 30;
  if (position === 'bottom') y = H - 30;
  return { x, y };
}

// Position → rotation in radians (-25° for center/tile, 0 for top/bottom)
function positionRotation(position) {
  if (position === 'center' || position === 'tile') {
    return -25 * Math.PI / 180;
  }
  return 0;
}

// Tile grid: generate all (cx, cy) cell centers for the 2×4 tile grid
function tileGridCenters() {
  const centers = [];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 2; col++) {
      centers.push({ x: 50 + col * 100, y: 40 + row * 60 });
    }
  }
  return centers;
}

// Validate watermark params — copied from toolRegistrations.js
function validateWatermark(p) {
  return !p.text?.trim() ? 'Please enter watermark text' : null;
}

// Font size parse with radix + NaN fallback — the fixed version
function parseFontSize(rawValue, fallback = 40) {
  return parseInt(rawValue, 10) || fallback;
}

// Default params shape (mirrors getWatermarkParams() at module initialisation)
function defaultParams() {
  return {
    text:     'CONFIDENTIAL',
    opacity:  0.3,
    position: 'center',
    fontSize: 40,
    color:    'gray',
  };
}

// ── _escAttr ──────────────────────────────────────────────────

console.log('\n_escAttr (attribute-safe HTML escaping):');

test('plain string passes through unchanged', () => expect(_escAttr('hello world')).toBe('hello world'));
test('& → &amp;',                            () => expect(_escAttr('a&b')).toBe('a&amp;b'));
test('" → &quot;',                           () => expect(_escAttr('"quoted"')).toBe('&quot;quoted&quot;'));
test('< → &lt;',                             () => expect(_escAttr('<tag>')).toBe('&lt;tag&gt;'));
test('> → &gt;',                             () => expect(_escAttr('a>b')).toBe('a&gt;b'));
test('null → ""',                            () => expect(_escAttr(null)).toBe(''));
test('undefined → ""',                       () => expect(_escAttr(undefined)).toBe(''));
test('number coerced to string',             () => expect(_escAttr(42)).toBe('42'));
test('empty string stays empty',             () => expect(_escAttr('')).toBe(''));
test('XSS payload fully escaped', () => {
  const r = _escAttr('<img src=x onerror="alert(1)">');
  expect(r).toContain('&lt;');
  expect(r).toContain('&gt;');
  expect(r).toContain('&quot;');
});
test('text with all special chars', () => {
  expect(_escAttr('a&b"c<d>e')).toBe('a&amp;b&quot;c&lt;d&gt;e');
});
test('Unicode passthrough (no escaping needed)', () => {
  expect(_escAttr('Ünïcödé 汉字 العربية')).toBe('Ünïcödé 汉字 العربية');
});
test('emoji passthrough',  () => expect(_escAttr('🔒 DRAFT 🔒')).toBe('🔒 DRAFT 🔒'));

// ── Opacity normalisation ─────────────────────────────────────

console.log('\nOpacity normalisation (slider → decimal):');

test('30 → 0.30', () => expect(normalizeOpacity(30)).toBeCloseTo(0.30));
test('5  → 0.05', () => expect(normalizeOpacity(5)).toBeCloseTo(0.05));
test('80 → 0.80', () => expect(normalizeOpacity(80)).toBeCloseTo(0.80));
test('100 → 1.00', () => expect(normalizeOpacity(100)).toBeCloseTo(1.00));
test('0 → 0.00',  () => expect(normalizeOpacity(0)).toBeCloseTo(0.00));
test('50 → 0.50', () => expect(normalizeOpacity(50)).toBeCloseTo(0.50));

// ── Opacity display ───────────────────────────────────────────

console.log('\nOpacity display (decimal → label string):');

test('0.3 → "30%"',  () => expect(opacityDisplay(0.3)).toBe('30%'));
test('0.05 → "5%"',  () => expect(opacityDisplay(0.05)).toBe('5%'));
test('0.80 → "80%"', () => expect(opacityDisplay(0.80)).toBe('80%'));
test('0 → "0%"',     () => expect(opacityDisplay(0)).toBe('0%'));
test('1 → "100%"',   () => expect(opacityDisplay(1)).toBe('100%'));
// Round-trip: slider 30 → normalise → display
test('round-trip: slider 30 → 30%', () => {
  expect(opacityDisplay(normalizeOpacity(30))).toBe('30%');
});
test('round-trip: slider 5 → 5%', () => {
  expect(opacityDisplay(normalizeOpacity(5))).toBe('5%');
});

// ── Color construction ────────────────────────────────────────

console.log('\nColor construction (COLOR_MAP + opacity → rgba):');

test('gray at 0.3 → correct rgba string', () =>
  expect(buildColor('gray', 0.3)).toBe('rgba(128,128,128,0.3)'));
test('red at 0.5 → correct rgba string', () =>
  expect(buildColor('red', 0.5)).toBe('rgba(200,0,0,0.5)'));
test('blue at 0.1 → correct rgba string', () =>
  expect(buildColor('blue', 0.1)).toBe('rgba(0,60,200,0.1)'));
test('unknown color falls back to gray', () =>
  expect(buildColor('purple', 0.4)).toBe('rgba(128,128,128,0.4)'));
test('null color falls back to gray', () =>
  expect(buildColor(null, 0.3)).toBe('rgba(128,128,128,0.3)'));
test('opacity=0 produces transparent color', () =>
  expect(buildColor('gray', 0)).toBe('rgba(128,128,128,0)'));
test('opacity=1 produces fully opaque color', () =>
  expect(buildColor('red', 1)).toBe('rgba(200,0,0,1)'));
test('color string starts with rgba(', () => {
  const c = buildColor('blue', 0.5);
  expect(c.startsWith('rgba(')).toBeTruthy();
});
test('color string ends with closing )', () => {
  const c = buildColor('blue', 0.5);
  expect(c.endsWith(')')).toBeTruthy();
});

// ── Preview scale math ────────────────────────────────────────

console.log('\nPreview scale math (PDF pt → canvas px):');

// scale = 200/595 ≈ 0.3361, factor = 2.2
// fs = round(fontSize * scale * 2.2)
const SCALE_FACTOR = (PREVIEW_W / A4_W) * 2.2;

test('fontSize 40 → expected canvas px', () => {
  const expected = Math.round(40 * SCALE_FACTOR);
  expect(previewFontSize(40)).toBe(expected);
});
test('fontSize 16 (min) → positive integer', () => {
  const px = previewFontSize(16);
  expect(px > 0).toBeTruthy();
});
test('fontSize 80 (max) → positive integer', () => {
  const px = previewFontSize(80);
  expect(px > 0).toBeTruthy();
});
test('larger fontSize → larger canvas px', () => {
  expect(previewFontSize(80) > previewFontSize(16)).toBeTruthy();
});
test('result is always a whole number (Math.round)', () => {
  expect(Number.isInteger(previewFontSize(40))).toBeTruthy();
  expect(Number.isInteger(previewFontSize(16))).toBeTruthy();
  expect(Number.isInteger(previewFontSize(80))).toBeTruthy();
});
test('scale is proportional to A4 width', () => {
  // scale = 200/595; at fontSize=595, px ≈ round(595 * (200/595) * 2.2) = round(440) = 440
  expect(previewFontSize(595)).toBe(Math.round(595 * SCALE_FACTOR));
});

// ── Position coordinates ──────────────────────────────────────

console.log('\nPosition coordinates on preview canvas (200×260):');

test('center: x=100, y=130', () => {
  const { x, y } = positionCoords('center');
  expect(x).toBe(100);
  expect(y).toBe(130);
});
test('top: x=100, y=30', () => {
  const { x, y } = positionCoords('top');
  expect(x).toBe(100);
  expect(y).toBe(30);
});
test('bottom: x=100, y=230', () => {
  const { x, y } = positionCoords('bottom');
  expect(x).toBe(100);
  expect(y).toBe(PREVIEW_H - 30);  // 230
});
test('tile falls through to default (center coords)', () => {
  // tile draws its own grid, but positionCoords doesn't affect tile branch
  const { x, y } = positionCoords('tile');
  expect(x).toBe(100);
  expect(y).toBe(130);
});
test('bottom y is greater than center y', () => {
  expect(positionCoords('bottom').y > positionCoords('center').y).toBeTruthy();
});
test('top y is less than center y', () => {
  expect(positionCoords('top').y < positionCoords('center').y).toBeTruthy();
});

// ── Rotation angle ────────────────────────────────────────────

console.log('\nRotation angle (position → radians):');

const DEG25_RAD = -25 * Math.PI / 180;

test('center → -25° in radians', () => {
  expect(positionRotation('center')).toBeCloseTo(DEG25_RAD);
});
test('tile → -25° in radians', () => {
  expect(positionRotation('tile')).toBeCloseTo(DEG25_RAD);
});
test('top → 0 radians (horizontal)', () => {
  expect(positionRotation('top')).toBe(0);
});
test('bottom → 0 radians (horizontal)', () => {
  expect(positionRotation('bottom')).toBe(0);
});
test('-25 degrees is approximately -0.4363 radians', () => {
  expect(positionRotation('center')).toBeCloseTo(-0.4363, 3);
});
test('center rotation is negative (counter-clockwise)', () => {
  expect(positionRotation('center') < 0).toBeTruthy();
});

// ── Tile grid ─────────────────────────────────────────────────

console.log('\nTile grid (2×4 cell centers):');

const TILE_CELLS = tileGridCenters();

test('tile grid has 8 cells (2 cols × 4 rows)', () => {
  expect(TILE_CELLS).toHaveLength(8);
});
test('first cell: (50, 40)', () => {
  expect(TILE_CELLS[0]).toEqual({ x: 50, y: 40 });
});
test('second cell (col 1, row 0): (150, 40)', () => {
  expect(TILE_CELLS[1]).toEqual({ x: 150, y: 40 });
});
test('third cell (col 0, row 1): (50, 100)', () => {
  expect(TILE_CELLS[2]).toEqual({ x: 50, y: 100 });
});
test('last cell (col 1, row 3): (150, 220)', () => {
  expect(TILE_CELLS[7]).toEqual({ x: 150, y: 220 });
});
test('all cells have x in [50, 150]', () => {
  const xs = TILE_CELLS.map(c => c.x);
  expect(Math.min(...xs)).toBe(50);
  expect(Math.max(...xs)).toBe(150);
});
test('all cells have y in [40, 220]', () => {
  const ys = TILE_CELLS.map(c => c.y);
  expect(Math.min(...ys)).toBe(40);
  expect(Math.max(...ys)).toBe(220);
});
test('x-spacing between columns is 100', () => {
  const row0Xs = TILE_CELLS.filter((_, i) => i < 2).map(c => c.x);
  expect(row0Xs[1] - row0Xs[0]).toBe(100);
});
test('y-spacing between rows is 60', () => {
  const col0Ys = TILE_CELLS.filter((_, i) => i % 2 === 0).map(c => c.y);
  expect(col0Ys[1] - col0Ys[0]).toBe(60);
});

// ── Validation ────────────────────────────────────────────────

console.log('\nValidation (getParams.validate from toolRegistrations):');

test('"CONFIDENTIAL" → null (valid)',          () => expect(validateWatermark({ text: 'CONFIDENTIAL' })).toBeNull());
test('"DRAFT" → null (valid)',                 () => expect(validateWatermark({ text: 'DRAFT' })).toBeNull());
test('"" → error message',                    () => expect(validateWatermark({ text: '' })).toBe('Please enter watermark text'));
test('whitespace-only → error message',       () => expect(validateWatermark({ text: '   ' })).toBe('Please enter watermark text'));
test('null text → error message',             () => expect(validateWatermark({ text: null })).toBe('Please enter watermark text'));
test('undefined text → error message',        () => expect(validateWatermark({ text: undefined })).toBe('Please enter watermark text'));
test('missing text key → error message',      () => expect(validateWatermark({})).toBe('Please enter watermark text'));
test('single char → valid',                   () => expect(validateWatermark({ text: 'X' })).toBeNull());
test('60-char string → valid (max length)',   () => {
  const s = 'A'.repeat(60);
  expect(validateWatermark({ text: s })).toBeNull();
});
test('Unicode text → valid',                  () => expect(validateWatermark({ text: '机密' })).toBeNull());
test('emoji text → valid',                    () => expect(validateWatermark({ text: '🔒 PRIVATE' })).toBeNull());
test('tab-only text → error message',         () => expect(validateWatermark({ text: '\t\t' })).toBe('Please enter watermark text'));

// ── Default params shape ──────────────────────────────────────

console.log('\nDefault params shape (getWatermarkParams() output):');

const DEF = defaultParams();

test('text defaults to "CONFIDENTIAL"',   () => expect(DEF.text).toBe('CONFIDENTIAL'));
test('opacity defaults to 0.3',           () => expect(DEF.opacity).toBeCloseTo(0.3));
test('position defaults to "center"',     () => expect(DEF.position).toBe('center'));
test('fontSize defaults to 40',           () => expect(DEF.fontSize).toBe(40));
test('color defaults to "gray"',          () => expect(DEF.color).toBe('gray'));
test('has exactly 5 keys', () => {
  expect(Object.keys(DEF)).toHaveLength(5);
});
test('opacity is a number in range [0, 1]', () => {
  expect(DEF.opacity >= 0 && DEF.opacity <= 1).toBeTruthy();
});
test('fontSize is within allowed range [16, 80]', () => {
  expect(DEF.fontSize >= 16 && DEF.fontSize <= 80).toBeTruthy();
});
test('position is one of the 4 valid values', () => {
  const valid = ['center', 'top', 'bottom', 'tile'];
  expect(valid.includes(DEF.position)).toBeTruthy();
});
test('color is one of the 3 valid values', () => {
  const valid = ['gray', 'red', 'blue'];
  expect(valid.includes(DEF.color)).toBeTruthy();
});

// ── Font size parsing (parseInt fix) ─────────────────────────

console.log('\nFont size parsing (parseInt with radix + NaN fallback):');

test('"40" → 40',          () => expect(parseFontSize('40')).toBe(40));
test('"16" → 16 (min)',    () => expect(parseFontSize('16')).toBe(16));
test('"80" → 80 (max)',    () => expect(parseFontSize('80')).toBe(80));
test('"36" → 36',          () => expect(parseFontSize('36')).toBe(36));
test('NaN string → 40 (fallback)', () => expect(parseFontSize('abc')).toBe(40));
test('empty string → 40 (fallback)', () => expect(parseFontSize('')).toBe(40));
test('"0" → 40 (falsy 0 → fallback)', () => expect(parseFontSize('0')).toBe(40));
test('custom fallback used on NaN', () => expect(parseFontSize('xyz', 24)).toBe(24));
test('integer number passed as string', () => expect(parseFontSize('52')).toBe(52));
test('leading zeros: "040" → 40 (base 10 explicit)', () => expect(parseFontSize('040')).toBe(40));

// ── Edge cases ────────────────────────────────────────────────

console.log('\nEdge cases:');

test('opacity 0 → rgba string is transparent', () => {
  const c = buildColor('gray', 0);
  expect(c).toContain(',0)');
});
test('opacity 1 → fully opaque', () => {
  const c = buildColor('red', 1);
  expect(c).toBe('rgba(200,0,0,1)');
});
test('escaping "CONFIDENTIAL" has no special chars', () => {
  expect(_escAttr('CONFIDENTIAL')).toBe('CONFIDENTIAL');
});
test('escaping text with ampersand (e.g. "R&D")', () => {
  expect(_escAttr('R&D')).toBe('R&amp;D');
});
test('very long text validates as valid (no length check in validate)', () => {
  const long = 'X'.repeat(200);
  expect(validateWatermark({ text: long })).toBeNull();
});
test('text with leading/trailing spaces is valid (trim only for empty check)', () => {
  // '  DRAFT  '.trim() = 'DRAFT' → truthy → valid
  expect(validateWatermark({ text: '  DRAFT  ' })).toBeNull();
});
test('RTL text validates as valid', () => {
  expect(validateWatermark({ text: 'سري' })).toBeNull(); // Arabic "secret"
});
test('newline-only text → error (trims to empty)', () => {
  expect(validateWatermark({ text: '\n\n' })).toBe('Please enter watermark text');
});
test('zero opacity round-trips correctly', () => {
  expect(opacityDisplay(normalizeOpacity(0))).toBe('0%');
});
test('tile grid cells are all within preview canvas bounds', () => {
  for (const { x, y } of tileGridCenters()) {
    expect(x >= 0 && x <= PREVIEW_W).toBeTruthy();
    expect(y >= 0 && y <= PREVIEW_H).toBeTruthy();
  }
});

// ── Summary ───────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
  if (failed > 0) process.exit(1);
}, 50);
