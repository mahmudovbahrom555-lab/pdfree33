// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

// ============================================================
//  tests/watermarkUI.logic.test.js
//
//  Pure-logic tests for watermarkUI.js and watermarkLayout.js.
//  All tested functions are copied verbatim (or as thin wrappers)
//  so the suite runs in Node.js without a DOM or ES module loader.
//
//  Covers:
//    • computeWatermarkLayout — canonical layout engine (watermarkLayout.js)
//    • _escAttr       — attribute-safe HTML escaping
//    • opacityNorm    — slider value (0-100) → PDF opacity (0-1)
//    • opacityDisplay — opacity (0-1) → display string (e.g. "30%")
//    • colorConstruct — COLOR_MAP + opacity → rgba() string
//    • previewScale   — worker-accurate font size scaling (no 2.2 multiplier)
//    • positionCoords — position label → (x, y) on preview canvas
//                       (matches watermarkLayout.js y-positions, flipped to canvas)
//    • rotationAngle  — position label → rotation in radians
//    • tileLayout     — canvas-coord tile grid mirroring computeWatermarkLayout
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
    toBeLessThan:      (n) => { if (actual >= n)  throw new Error(`Expected ${actual} < ${n}`); },
    toBeLessThanOrEqualTo: (n) => { if (actual > n) throw new Error(`Expected ${actual} <= ${n}`); },
    toBeGreaterThanOrEqualTo: (n) => { if (actual < n) throw new Error(`Expected ${actual} >= ${n}`); },
  };
}

// ── computeWatermarkLayout — copied from watermarkLayout.js ───
// Inline copy so the suite runs in Node.js without ES module loader.

const TILE_GAP_Y = 120;

function computeWatermarkLayout({ pageWidth, pageHeight, fontSize, position }) {
  if (position === 'tile') {
    const tileGapX = pageWidth / 2.5;
    const cols     = Math.ceil(pageWidth  / tileGapX) + 2;
    const rows     = Math.ceil(pageHeight / TILE_GAP_Y) + 2;
    const size     = fontSize * 0.7;
    const cells    = [];
    for (let row = -1; row < rows; row++) {
      for (let col = -1; col < cols; col++) {
        cells.push({
          x:     col * tileGapX + (row % 2) * (tileGapX / 2),
          y:     row * TILE_GAP_Y,
          angle: -25 * Math.PI / 180,
          size,
        });
      }
    }
    return cells;
  }
  const y = position === 'top'    ? pageHeight - 50
          : position === 'bottom' ? 30
          :                         pageHeight / 2;
  return [{
    x:     pageWidth / 2,
    y,
    angle: position === 'center' ? -25 * Math.PI / 180 : 0,
    size:  fontSize,
  }];
}

// ── Pure copies from watermarkUI.js ───────────────────────────

// Color map — copied verbatim from watermarkUI.js
const COLOR_MAP = {
  gray: 'rgba(128,128,128,',
  red:  'rgba(200,0,0,',
  blue: 'rgba(0,60,200,',
};

// Attribute-safe HTML escaping — copied from watermarkUI.js
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

// ── Preview geometry constants ─────────────────────────────────
// Default page: A4 (595 × 842 PDF pts).  Preview display width: 200px.
// These match the module defaults (_pageW=595, _pageH=842, displayW=200).

const PAGE_W    = 595;    // A4 width in PDF pts
const PAGE_H    = 842;    // A4 height in PDF pts
const DISPLAY_W = 280;    // preview CSS width (px) — matches PREVIEW_W in watermarkUI.js
const DISPLAY_H = Math.round(DISPLAY_W * PAGE_H / PAGE_W);  // 396 for A4

// ── Preview font size ──────────────────────────────────────────
// Non-tile: fontSize * (displayW / pageW)           [no extra multiplier]
// Tile:     fontSize * 0.7 * (displayW / pageW)     [worker uses fontSize*0.7]

function previewFontSizeCenter(fontSize, pageW = PAGE_W) {
  return fontSize * (DISPLAY_W / pageW);
}

function previewFontSizeTile(fontSize, pageW = PAGE_W) {
  return fontSize * 0.7 * (DISPLAY_W / pageW);
}

// ── Position → (x, y) on preview canvas ───────────────────────
// Mirrors worker.js y-positions, flipped to canvas coordinates (y=0 at top):
//   center: PDF y = height/2   → canvas y = DISPLAY_H / 2
//   top:    PDF y = height-50  → canvas y = 50 * scaleY
//   bottom: PDF y = 30         → canvas y = DISPLAY_H - 30 * scaleY
// x is always DISPLAY_W / 2 (textAlign:'center')

function positionCoords(position, displayW = DISPLAY_W, displayH = DISPLAY_H, pageH = PAGE_H) {
  const scaleY = displayH / pageH;
  const x = displayW / 2;
  let y;
  if      (position === 'top')    y = 50 * scaleY;
  else if (position === 'bottom') y = displayH - 30 * scaleY;
  else                            y = displayH / 2;   // center (tile falls here too, unused)
  return { x, y };
}

// Position → rotation in radians (-25° for center, 0 for top/bottom)
function positionRotation(position) {
  return (position === 'center') ? -25 * Math.PI / 180 : 0;
}

// ── Tile layout canvas coords ──────────────────────────────────
// Tests how watermarkUI.js converts computeWatermarkLayout() PDF coords
// to canvas coords (x * scaleX, H - y * scaleY).  The tileLayout()
// helper below is the combined PDF→canvas transform, not a copy of
// computeWatermarkLayout itself (see the computeWatermarkLayout section above).

function tileLayout(pageW = PAGE_W, pageH = PAGE_H, displayW = DISPLAY_W, displayH = DISPLAY_H) {
  const scaleX   = displayW / pageW;
  const scaleY   = displayH / pageH;
  const tileGapX = pageW / 2.5;
  const tileGapY = 120;
  const cols     = Math.ceil(pageW / tileGapX) + 2;
  const rows     = Math.ceil(pageH / tileGapY) + 2;
  const cells    = [];
  for (let row = -1; row < rows; row++) {
    for (let col = -1; col < cols; col++) {
      const pdfX = col * tileGapX + (row % 2) * (tileGapX / 2);
      const pdfY = row * tileGapY;
      cells.push({
        cx: pdfX * scaleX,
        cy: displayH - pdfY * scaleY,
        row, col,
      });
    }
  }
  return { tileGapX, tileGapY, cols, rows, cells };
}

// Validate watermark params — copied from toolRegistrations.js
function validateWatermark(p) {
  return !p.text?.trim() ? 'Please enter watermark text' : null;
}

// Font size parse with radix + NaN fallback — from watermarkUI.js
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

// ── computeWatermarkLayout ────────────────────────────────────

console.log('\ncomputeWatermarkLayout (watermarkLayout.js — canonical layout engine):');

test('tile A4: returns 66 cells (11 rows × 6 cols)', () => {
  const items = computeWatermarkLayout({ pageWidth: PAGE_W, pageHeight: PAGE_H, fontSize: 40, position: 'tile' });
  expect(items).toHaveLength(66);
});
test('tile: each item has x, y, angle, size fields', () => {
  const [first] = computeWatermarkLayout({ pageWidth: PAGE_W, pageHeight: PAGE_H, fontSize: 40, position: 'tile' });
  expect(typeof first.x).toBe('number');
  expect(typeof first.y).toBe('number');
  expect(typeof first.angle).toBe('number');
  expect(typeof first.size).toBe('number');
});
test('tile: size = fontSize * 0.7', () => {
  const [first] = computeWatermarkLayout({ pageWidth: PAGE_W, pageHeight: PAGE_H, fontSize: 40, position: 'tile' });
  expect(first.size).toBeCloseTo(40 * 0.7, 5);
});
test('tile: every cell has angle = -25° (PDF convention — canvas negates this)', () => {
  const items = computeWatermarkLayout({ pageWidth: PAGE_W, pageHeight: PAGE_H, fontSize: 40, position: 'tile' });
  const DEG25_PDF = -25 * Math.PI / 180;  // canvas applies ctx.rotate(-angle) = +25°
  items.forEach(it => expect(it.angle).toBeCloseTo(DEG25_PDF, 5));
});
test('tile: y coords are in PDF space (y=0 at bottom — row -1 has y < 0)', () => {
  const items = computeWatermarkLayout({ pageWidth: PAGE_W, pageHeight: PAGE_H, fontSize: 40, position: 'tile' });
  const row_minus1 = items.find((_, i) => i < 6);  // first 6 cells are row=-1
  expect(row_minus1.y).toBeLessThan(0);
});
test('center: returns exactly 1 item', () => {
  const items = computeWatermarkLayout({ pageWidth: PAGE_W, pageHeight: PAGE_H, fontSize: 40, position: 'center' });
  expect(items).toHaveLength(1);
});
test('center: x = pageWidth/2, y = pageHeight/2', () => {
  const [item] = computeWatermarkLayout({ pageWidth: PAGE_W, pageHeight: PAGE_H, fontSize: 40, position: 'center' });
  expect(item.x).toBeCloseTo(PAGE_W / 2, 5);
  expect(item.y).toBeCloseTo(PAGE_H / 2, 5);
});
test('center: angle = -25° (PDF convention — canvas negates to +25°)', () => {
  const [item] = computeWatermarkLayout({ pageWidth: PAGE_W, pageHeight: PAGE_H, fontSize: 40, position: 'center' });
  expect(item.angle).toBeCloseTo(-25 * Math.PI / 180, 5);
});
test('top: y = pageHeight - 50, angle = 0', () => {
  const [item] = computeWatermarkLayout({ pageWidth: PAGE_W, pageHeight: PAGE_H, fontSize: 40, position: 'top' });
  expect(item.y).toBeCloseTo(PAGE_H - 50, 5);
  expect(item.angle).toBe(0);
});
test('bottom: y = 30, angle = 0', () => {
  const [item] = computeWatermarkLayout({ pageWidth: PAGE_W, pageHeight: PAGE_H, fontSize: 40, position: 'bottom' });
  expect(item.y).toBeCloseTo(30, 5);
  expect(item.angle).toBe(0);
});
test('non-tile: size = fontSize (no 0.7 factor)', () => {
  for (const position of ['center', 'top', 'bottom']) {
    const [item] = computeWatermarkLayout({ pageWidth: PAGE_W, pageHeight: PAGE_H, fontSize: 40, position });
    expect(item.size).toBe(40);
  }
});
test('non-tile: x = pageWidth/2 for all positions (semantic center)', () => {
  for (const position of ['center', 'top', 'bottom']) {
    const [item] = computeWatermarkLayout({ pageWidth: PAGE_W, pageHeight: PAGE_H, fontSize: 40, position });
    expect(item.x).toBeCloseTo(PAGE_W / 2, 5);
  }
});

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
  expect(buildColor('blue', 0.5).startsWith('rgba(')).toBeTruthy();
});
test('color string ends with )', () => {
  expect(buildColor('blue', 0.5).endsWith(')')).toBeTruthy();
});

// ── Preview font size (worker-accurate, no 2.2 multiplier) ────

console.log('\nPreview font size (worker-accurate scaling):');

// Non-tile: scale = displayW / pageW  (no 2.2 — matches what user sees in PDF)
test('center fontSize 40, A4 → 40*(280/595)', () => {
  expect(previewFontSizeCenter(40)).toBeCloseTo(40 * (DISPLAY_W / 595), 3);
});
test('center fontSize 16 (min) → positive value', () => {
  expect(previewFontSizeCenter(16)).toBeGreaterThan(0);
});
test('center fontSize 80 (max) → positive value', () => {
  expect(previewFontSizeCenter(80)).toBeGreaterThan(0);
});
test('larger fontSize → larger canvas px (center)', () => {
  expect(previewFontSizeCenter(80)).toBeGreaterThan(previewFontSizeCenter(16));
});
test('center fs is proportional to pageW (Letter vs A4)', () => {
  // Letter: 612pt wide; same fontSize should produce smaller px on Letter
  expect(previewFontSizeCenter(40, 612)).toBeLessThan(previewFontSizeCenter(40, 595));
});

// Tile mode: worker applies fontSize * 0.7
test('tile fontSize 40, A4 → 0.7 × center value', () => {
  expect(previewFontSizeTile(40)).toBeCloseTo(previewFontSizeCenter(40) * 0.7, 5);
});
test('tile fontSize 40 is smaller than center fontSize 40', () => {
  expect(previewFontSizeTile(40)).toBeLessThan(previewFontSizeCenter(40));
});
test('tile fontSize 80 still positive', () => {
  expect(previewFontSizeTile(80)).toBeGreaterThan(0);
});

// ── Position coordinates (worker-accurate y-axis) ─────────────

console.log('\nPosition coordinates (worker-accurate, canvas y=0 at top):');

// A4 display: DISPLAY_H = 396, scaleY = 396/842 ≈ 0.4703
const SCALE_Y = DISPLAY_H / PAGE_H;

test('center: x = displayW/2 = 100', () => {
  expect(positionCoords('center').x).toBe(DISPLAY_W / 2);
});
test('center: y = displayH/2', () => {
  expect(positionCoords('center').y).toBeCloseTo(DISPLAY_H / 2, 5);
});
test('top: y = 50 * scaleY (near top of canvas)', () => {
  expect(positionCoords('top').y).toBeCloseTo(50 * SCALE_Y, 3);
});
test('bottom: y = DISPLAY_H - 30*scaleY (near bottom of canvas)', () => {
  expect(positionCoords('bottom').y).toBeCloseTo(DISPLAY_H - 30 * SCALE_Y, 3);
});
test('all positions have x = DISPLAY_W/2', () => {
  for (const pos of ['center', 'top', 'bottom']) {
    expect(positionCoords(pos).x).toBe(DISPLAY_W / 2);
  }
});
test('bottom y > center y > top y', () => {
  const { y: cy } = positionCoords('center');
  const { y: ty } = positionCoords('top');
  const { y: by } = positionCoords('bottom');
  expect(by).toBeGreaterThan(cy);
  expect(cy).toBeGreaterThan(ty);
});
test('top y is near top of canvas (< 25px)', () => {
  expect(positionCoords('top').y).toBeLessThan(25);
});
test('bottom y is near bottom of canvas (within 20px)', () => {
  const { y } = positionCoords('bottom');
  expect(DISPLAY_H - y).toBeLessThan(20);
});

// ── Rotation angle ────────────────────────────────────────────

console.log('\nRotation angle (position → radians):');

const DEG25_RAD = -25 * Math.PI / 180;

test('center → -25° in radians', () => {
  expect(positionRotation('center')).toBeCloseTo(DEG25_RAD);
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
  expect(positionRotation('center')).toBeLessThan(0);
});

// ── Tile layout (mirrors worker.js) ──────────────────────────

console.log('\nTile layout (mirrors worker.js algorithm):');

const TILE = tileLayout();  // A4 defaults

// A4: tileGapX = 595/2.5 = 238, tileGapY = 120
// cols = ceil(595/238)+2 = ceil(2.5)+2 = 3+2 = 5
// rows = ceil(842/120)+2 = ceil(7.017)+2 = 8+2 = 10
// loop -1..<rows (-1..9 = 11 rows) × -1..<cols (-1..4 = 6 cols) = 66 cells

test('tileGapX = pageW / 2.5 = 238', () => {
  expect(TILE.tileGapX).toBeCloseTo(595 / 2.5, 5);
});
test('tileGapY = 120 (fixed, matching worker.js)', () => {
  expect(TILE.tileGapY).toBe(120);
});
test('cols = ceil(pageW / tileGapX) + 2 = 5 for A4', () => {
  expect(TILE.cols).toBe(5);
});
test('rows = ceil(pageH / tileGapY) + 2 = 10 for A4', () => {
  // ceil(842/120) = ceil(7.017) = 8; 8+2 = 10
  expect(TILE.rows).toBe(10);
});
test('total cells = 11 rows × 6 cols = 66 (loop -1..<rows, -1..<cols)', () => {
  // row loop: -1..9 = 11 values; col loop: -1..4 = 6 values
  expect(TILE.cells).toHaveLength(66);
});
test('row=-1,col=-1 cell exists (overflow boundary)', () => {
  const first = TILE.cells[0];
  expect(first.row).toBe(-1);
  expect(first.col).toBe(-1);
});
test('last cell is row=rows-1, col=cols-1', () => {
  const last = TILE.cells[65];
  expect(last.row).toBe(TILE.rows - 1);
  expect(last.col).toBe(TILE.cols - 1);
});
test('stagger: row=0 has x offset 0, row=1 has x offset tileGapX/2', () => {
  // row=0,col=0: pdfX = 0*238 + (0%2)*119 = 0;  canvasX = 0
  const row0col0 = TILE.cells.find(c => c.row === 0 && c.col === 0);
  expect(row0col0.cx).toBeCloseTo(0, 5);

  // row=1,col=0: pdfX = 0*238 + (1%2)*119 = 119; canvasX = 119*(200/595)
  const row1col0 = TILE.cells.find(c => c.row === 1 && c.col === 0);
  expect(row1col0.cx).toBeCloseTo(119 * (DISPLAY_W / PAGE_W), 3);
});
test('row=0 is at canvas bottom (cy ≈ DISPLAY_H)', () => {
  // pdfY = 0 → canvasY = DISPLAY_H - 0 = DISPLAY_H
  const row0col0 = TILE.cells.find(c => c.row === 0 && c.col === 0);
  expect(row0col0.cy).toBeCloseTo(DISPLAY_H, 5);
});
test('higher row → smaller canvasY (tiles move upward on canvas)', () => {
  const row0 = TILE.cells.find(c => c.row === 0 && c.col === 0);
  const row1 = TILE.cells.find(c => c.row === 1 && c.col === 0);
  const row2 = TILE.cells.find(c => c.row === 2 && c.col === 0);
  expect(row1.cy).toBeLessThan(row0.cy);
  expect(row2.cy).toBeLessThan(row1.cy);
});
test('y-spacing between rows = tileGapY * scaleY', () => {
  const scaleY = DISPLAY_H / PAGE_H;
  const row0 = TILE.cells.find(c => c.row === 0 && c.col === 0);
  const row1 = TILE.cells.find(c => c.row === 1 && c.col === 0);
  expect(row0.cy - row1.cy).toBeCloseTo(120 * scaleY, 3);
});
test('x-spacing between cols (same row) = tileGapX * scaleX', () => {
  const scaleX = DISPLAY_W / PAGE_W;
  const r0c0 = TILE.cells.find(c => c.row === 0 && c.col === 0);
  const r0c1 = TILE.cells.find(c => c.row === 0 && c.col === 1);
  expect(r0c1.cx - r0c0.cx).toBeCloseTo(238 * scaleX, 3);
});
test('some cells are within visible canvas (tile covers the page)', () => {
  const visible = TILE.cells.filter(c =>
    c.cx >= 0 && c.cx <= DISPLAY_W && c.cy >= 0 && c.cy <= DISPLAY_H);
  expect(visible.length).toBeGreaterThan(0);
});
test('cells outside canvas bounds exist (intentional overflow for tiling)', () => {
  const outside = TILE.cells.filter(c =>
    c.cx < 0 || c.cx > DISPLAY_W || c.cy < 0 || c.cy > DISPLAY_H);
  expect(outside.length).toBeGreaterThan(0);
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
  expect(validateWatermark({ text: 'A'.repeat(60) })).toBeNull();
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
  expect(['center', 'top', 'bottom', 'tile'].includes(DEF.position)).toBeTruthy();
});
test('color is one of the 3 valid values', () => {
  expect(['gray', 'red', 'blue'].includes(DEF.color)).toBeTruthy();
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
  expect(buildColor('gray', 0)).toContain(',0)');
});
test('opacity 1 → fully opaque', () => {
  expect(buildColor('red', 1)).toBe('rgba(200,0,0,1)');
});
test('escaping "CONFIDENTIAL" has no special chars', () => {
  expect(_escAttr('CONFIDENTIAL')).toBe('CONFIDENTIAL');
});
test('escaping text with ampersand (e.g. "R&D")', () => {
  expect(_escAttr('R&D')).toBe('R&amp;D');
});
test('very long text validates as valid (no length check in validate)', () => {
  expect(validateWatermark({ text: 'X'.repeat(200) })).toBeNull();
});
test('text with leading/trailing spaces is valid (trim only for empty check)', () => {
  expect(validateWatermark({ text: '  DRAFT  ' })).toBeNull();
});
test('RTL text validates as valid', () => {
  expect(validateWatermark({ text: 'سري' })).toBeNull();
});
test('newline-only text → error (trims to empty)', () => {
  expect(validateWatermark({ text: '\n\n' })).toBe('Please enter watermark text');
});
test('zero opacity round-trips correctly', () => {
  expect(opacityDisplay(normalizeOpacity(0))).toBe('0%');
});
test('tile font size is 70% of center font size (same fontSize)', () => {
  const center = previewFontSizeCenter(40);
  const tile   = previewFontSizeTile(40);
  expect(tile / center).toBeCloseTo(0.7, 5);
});
test('DISPLAY_H = round(280 * 842/595) = 396', () => {
  expect(DISPLAY_H).toBe(396);
});
test('tile covers entire visible canvas width with some margin', () => {
  // Total canvas width covered by cols (including overflow): cols * tileGapX * scaleX
  const scaleX   = DISPLAY_W / PAGE_W;
  const coverage = TILE.cols * TILE.tileGapX * scaleX;
  expect(coverage).toBeGreaterThan(DISPLAY_W);
});

// ── Summary ───────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
  if (failed > 0) process.exit(1);
}, 50);
