// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors
//
// ── pdf2wordBorders.js ────────────────────────────────────────────────────────
// Detects empty table grids in a PDF page by analysing drawing operators.
// Purpose: find tables that have no text content (empty form rows) which the
// text-based detector (pdf2wordTables.js) cannot see.
//
// Algorithm:
//   1. Parse PDF operator list → collect all line segments (from m/l and re ops).
//   2. Snap coordinates to a grid (SNAP px tolerance).
//   3. Group H-lines by Y, V-lines by X.
//   4. A grid exists where ≥ MIN_COLS+1 unique X values AND ≥ MIN_ROWS+1 unique
//      Y values are connected by crossing lines within a bounding rectangle.
//
// Coordinates: PDF user space (Y increases upward, same as text item.transform[5]).
// ─────────────────────────────────────────────────────────────────────────────

const SNAP     = 4;   // px — coordinates within SNAP px → treated as same line
const MIN_ROWS = 2;   // minimum body rows (not counting header) to call it a grid
const MIN_COLS = 1;   // minimum columns

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} TableGrid
 * @property {number}   x        — left edge (PDF user coords)
 * @property {number}   y        — bottom edge
 * @property {number}   w        — width
 * @property {number}   h        — height
 * @property {number}   colCount — number of columns
 * @property {number}   rowCount — number of rows
 * @property {number[]} colXs    — sorted column boundary X values
 * @property {number[]} rowYs    — sorted row boundary Y values (descending = top first)
 */

/**
 * @param {import('pdfjs-dist').PDFPageProxy} page
 * @returns {Promise<TableGrid[]>}
 */
export async function detectTableGrids(page) {
  const opList = await page.getOperatorList();
  const { hLines, vLines } = _extractSegments(opList);
  return _buildGrids(hLines, vLines);
}

// ── Segment extraction ────────────────────────────────────────────────────────

function _extractSegments(opList) {
  const { fnArray, argsArray } = opList;
  const hLines = []; // { x1, x2, y }
  const vLines = []; // { y1, y2, x }

  // CTM stack — tracks graphics state transforms from q/Q/cm operators
  const ctmStack = [{ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }];
  const ctm = () => ctmStack[ctmStack.length - 1];

  const tx = (x, y) => { const m = ctm(); return m.a * x + m.c * y + m.e; };
  const ty = (x, y) => { const m = ctm(); return m.b * x + m.d * y + m.f; };

  const addSeg = (x1, y1, x2, y2) => {
    const dy = Math.abs(y2 - y1);
    const dx = Math.abs(x2 - x1);
    if (dy <= SNAP && dx > SNAP) {
      hLines.push({ x1: Math.min(x1, x2), x2: Math.max(x1, x2), y: (y1 + y2) / 2 });
    } else if (dx <= SNAP && dy > SNAP) {
      vLines.push({ y1: Math.min(y1, y2), y2: Math.max(y1, y2), x: (x1 + x2) / 2 });
    }
  };

  // pdfjs OPS enum values (pdfjs 3.x — these are NOT raw PDF spec op numbers)
  const OPS_SAVE      = 10;
  const OPS_RESTORE   = 11;
  const OPS_TRANSFORM = 12;
  // All path drawing ops are batched into a single constructPath call
  const OPS_PATH      = 91;

  // Sub-operation codes inside constructPath args[0]
  const P_MOVETO   = 13; // [x, y]
  const P_LINETO   = 14; // [x, y]
  const P_CURVETO  = 15; // [x1,y1, x2,y2, x3,y3]
  const P_CURVETO2 = 16; // [x1,y1, x3,y3]
  const P_CURVETO3 = 17; // [x2,y2, x3,y3]
  const P_CLOSE    = 18; // (no coords)
  const P_RECT     = 19; // [x, y, w, h]

  for (let i = 0; i < fnArray.length; i++) {
    const fn   = fnArray[i];
    const args = argsArray[i];

    switch (fn) {
      case OPS_SAVE: {
        ctmStack.push({ ...ctm() });
        break;
      }
      case OPS_RESTORE: {
        if (ctmStack.length > 1) ctmStack.pop();
        break;
      }
      case OPS_TRANSFORM: {
        const [a, b, c, d, e, f] = args;
        const m = ctm();
        ctmStack[ctmStack.length - 1] = {
          a: m.a * a + m.c * b,  b: m.b * a + m.d * b,
          c: m.a * c + m.c * d,  d: m.b * c + m.d * d,
          e: m.a * e + m.c * f + m.e,
          f: m.b * e + m.d * f + m.f,
        };
        break;
      }
      case OPS_PATH: {
        // args = [[sub-op codes], [flat coord array], [minX,maxX,minY,maxY]]
        const subOps = args[0];
        const co     = args[1]; // flat coordinate values
        let ci = 0;             // index into co[]
        let px = 0, py = 0;    // current path position (PDF user space, pre-CTM)
        let sx = 0, sy = 0;    // subpath start (for P_CLOSE)

        for (const sub of subOps) {
          switch (sub) {
            case P_MOVETO: {
              px = co[ci]; py = co[ci + 1]; ci += 2;
              sx = px; sy = py;
              break;
            }
            case P_LINETO: {
              const nx = co[ci], ny = co[ci + 1]; ci += 2;
              addSeg(tx(px, py), ty(px, py), tx(nx, ny), ty(nx, ny));
              px = nx; py = ny;
              break;
            }
            case P_CURVETO:  { ci += 6; px = co[ci-2]; py = co[ci-1]; break; }
            case P_CURVETO2: { ci += 4; px = co[ci-2]; py = co[ci-1]; break; }
            case P_CURVETO3: { ci += 4; px = co[ci-2]; py = co[ci-1]; break; }
            case P_CLOSE: {
              addSeg(tx(px, py), ty(px, py), tx(sx, sy), ty(sx, sy));
              px = sx; py = sy;
              break;
            }
            case P_RECT: {
              const rx = co[ci], ry = co[ci+1], rw = co[ci+2], rh = co[ci+3]; ci += 4;
              const bx = tx(rx, ry),          by = ty(rx, ry);
              const ex = tx(rx + rw, ry + rh), ey = ty(rx + rw, ry + rh);
              const left = Math.min(bx, ex), right = Math.max(bx, ex);
              const bot  = Math.min(by, ey), top   = Math.max(by, ey);
              hLines.push({ x1: left, x2: right, y: bot  });
              hLines.push({ x1: left, x2: right, y: top  });
              vLines.push({ y1: bot,  y2: top,   x: left });
              vLines.push({ y1: bot,  y2: top,   x: right });
              break;
            }
          }
        }
        break;
      }
    }
  }

  return { hLines, vLines };
}

// ── Grid building ─────────────────────────────────────────────────────────────

function _snap(v) { return Math.round(v / SNAP) * SNAP; }

function _buildGrids(hLines, vLines) {
  if (!hLines.length || !vLines.length) return [];

  // Snap all coordinates
  const sH = hLines.map(l => ({ x1: _snap(l.x1), x2: _snap(l.x2), y: _snap(l.y) }));
  const sV = vLines.map(l => ({ y1: _snap(l.y1), y2: _snap(l.y2), x: _snap(l.x) }));

  // Group H-lines by Y → { y → [x1, x2] spans }
  const hByY = new Map();
  for (const l of sH) {
    if (!hByY.has(l.y)) hByY.set(l.y, []);
    hByY.get(l.y).push([l.x1, l.x2]);
  }

  // Group V-lines by X → { x → [y1, y2] spans }
  const vByX = new Map();
  for (const l of sV) {
    if (!vByX.has(l.x)) vByX.set(l.x, []);
    vByX.get(l.x).push([l.y1, l.y2]);
  }

  const hYs = [...hByY.keys()].sort((a, b) => a - b);
  const vXs = [...vByX.keys()].sort((a, b) => a - b);

  if (hYs.length < MIN_ROWS + 1 || vXs.length < MIN_COLS + 1) return [];

  // Find rectangular subsets of hYs × vXs that form a valid grid.
  // Strategy: group contiguous hYs and vXs where lines span the same range.
  // For simplicity: find the largest bounding box where H-lines span full width
  // and V-lines span full height.

  const grids = [];

  // Cluster Y-values by proximity and shared X range
  // (two H-lines at nearby Y with similar X range belong to the same table)
  const yGroups = _cluster(hYs, SNAP * 3);    // groups of close Y values
  const xGroups = _cluster(vXs, SNAP * 3);    // groups of close X values

  for (const yGroup of yGroups) {
    if (yGroup.length < MIN_ROWS + 1) continue;

    for (const xGroup of xGroups) {
      if (xGroup.length < MIN_COLS + 1) continue;

      const minX = xGroup[0], maxX = xGroup[xGroup.length - 1];
      const minY = yGroup[0], maxY = yGroup[yGroup.length - 1];

      // Verify: each Y in yGroup has an H-line spanning [minX, maxX]
      const hValid = yGroup.every(y => {
        const spans = hByY.get(y) || [];
        return spans.some(([x1, x2]) => x1 <= minX + SNAP && x2 >= maxX - SNAP);
      });

      // Verify: each X in xGroup has a V-line spanning [minY, maxY]
      const vValid = xGroup.every(x => {
        const spans = vByX.get(x) || [];
        return spans.some(([y1, y2]) => y1 <= minY + SNAP && y2 >= maxY - SNAP);
      });

      if (hValid && vValid) {
        grids.push({
          x:        minX,
          y:        minY,
          w:        maxX - minX,
          h:        maxY - minY,
          colCount: xGroup.length - 1,
          rowCount: yGroup.length - 1,
          colXs:    xGroup,
          rowYs:    [...yGroup].reverse(),  // descending (top first in PDF)
        });
      }
    }
  }

  // Remove grids contained within a larger grid
  grids.sort((a, b) => (b.colCount * b.rowCount) - (a.colCount * a.rowCount));
  const result = [];
  for (const g of grids) {
    const inside = result.some(r =>
      r.x <= g.x + SNAP && r.y <= g.y + SNAP &&
      (r.x + r.w) >= (g.x + g.w) - SNAP &&
      (r.y + r.h) >= (g.y + g.h) - SNAP
    );
    if (!inside) result.push(g);
  }

  return result;
}

// Group a sorted array of numbers into clusters where adjacent values
// differ by ≤ gap. Returns array of arrays.
function _cluster(sorted, gap) {
  if (!sorted.length) return [];
  const groups = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] <= gap) {
      groups[groups.length - 1].push(sorted[i]);
    } else {
      groups.push([sorted[i]]);
    }
  }
  return groups;
}
