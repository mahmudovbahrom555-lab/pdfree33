// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors
//
// ── pdf2wordBorders.js ────────────────────────────────────────────────────────
// Detects table grids in a PDF page by analysing drawing operators — both
// empty form rows (no text content, which the text-based detector in
// pdf2wordTables.js cannot see) AND merged-cell tables (rowspan/colspan)
// whose irregular per-row column counts make the text-alignment detector
// reject them outright.
//
// Algorithm ("frame first, then split-and-merge" — see _buildGrids below):
//   1. Parse PDF operator list → collect all line segments (from m/l and re ops).
//   2. Snap coordinates to a grid (SNAP px tolerance).
//   3. Group H-lines by Y, V-lines by X.
//   4. Find the table's OUTER rectangle first: a top/bottom h-line pair whose
//      spans substantially overlap, closed on the sides by v-lines that span
//      (close to) the full candidate height. This is validated strictly.
//   5. Only once that frame is anchored, collect INTERNAL row/column dividers —
//      any real segment touching the frame's interior counts, regardless of
//      how much of the width/height it actually spans. A merged cell (e.g. a
//      tariff table row whose product-name cell spans 3 price rows) legit-
//      imately has no divider drawn for the rows/columns it merges across;
//      requiring every internal divider to span the whole table (the
//      previous design) rejected such tables entirely instead of just losing
//      some colspan/rowspan fidelity.
//
// Coordinates: PDF user space (Y increases upward, same as text item.transform[5]).
// ─────────────────────────────────────────────────────────────────────────────

const SNAP     = 4;   // px — coordinates within SNAP px → treated as same line
const MIN_ROWS = 2;   // minimum body rows (not counting header) to call it a grid
const MIN_COLS = 1;   // minimum columns

// Frame-search tuneables (see _buildGrids)
const FRAME_MIN_HEIGHT      = SNAP * 5;   // 20px floor for a candidate table's total height
const FRAME_MIN_OVERLAP_ABS = SNAP * 10;  // 40px floor for top/bottom span overlap
const FRAME_OVERLAP_FRAC    = 0.6;        // …or ≥60% of the shorter span, whichever is stricter
const FRAME_EDGE_SLACK      = SNAP * 2;   // 8px slack when matching a side v-line's span to the frame height
const INTERNAL_MIN_OVERLAP  = SNAP * 5;   // 20px — ignore stray/incidental internal segment overlaps
const MAX_H_CANDIDATES      = 300;        // safety cap: bail out of the O(n²) frame search on pathological pages

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
  const viewport = page.getViewport({ scale: 1 });
  return _buildGrids(hLines, vLines, viewport.width, viewport.height);
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
  const OPS_SAVE        = 10;
  const OPS_RESTORE     = 11;
  const OPS_TRANSFORM   = 12;
  // Form XObject content is flattened into the page's operator list by pdf.js,
  // bracketed by these two ops. paintFormXObjectBegin carries its own [matrix, bbox]
  // placement matrix (applied on top of the current CTM, like an implicit q + cm),
  // and paintFormXObjectEnd restores the CTM (like Q). Table borders drawn inside a
  // Form XObject (letterheads, stamps, content wrapped by some PDF generators) need
  // this matrix applied, or their coordinates land in the wrong space entirely.
  const OPS_FORM_BEGIN  = 74;
  const OPS_FORM_END    = 75;
  // All path drawing ops are batched into a single constructPath call
  const OPS_PATH        = 91;

  // Composes CTM `m` with a PDF matrix [a,b,c,d,e,f] the same way `cm` does.
  const _composeMatrix = (m, [a, b, c, d, e, f]) => ({
    a: m.a * a + m.c * b,  b: m.b * a + m.d * b,
    c: m.a * c + m.c * d,  d: m.b * c + m.d * d,
    e: m.a * e + m.c * f + m.e,
    f: m.b * e + m.d * f + m.f,
  });

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
        ctmStack[ctmStack.length - 1] = _composeMatrix(ctm(), args);
        break;
      }
      case OPS_FORM_BEGIN: {
        ctmStack.push({ ...ctm() });
        const matrix = args[0];
        if (Array.isArray(matrix) && matrix.length === 6) {
          ctmStack[ctmStack.length - 1] = _composeMatrix(ctm(), matrix);
        }
        break;
      }
      case OPS_FORM_END: {
        if (ctmStack.length > 1) ctmStack.pop();
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

function _buildGrids(hLines, vLines, pageW = Infinity, pageH = Infinity) {
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
  if (hYs.length > MAX_H_CANDIDATES || vXs.length > MAX_H_CANDIDATES) return [];

  // ── Frame-first search ("split-and-merge") ──────────────────────────────
  // For every pair of horizontal lines (yHi above yLo), check whether they
  // form a table's top/bottom edge: their spans must substantially overlap
  // (that overlap becomes the candidate left/right), and there must be a
  // vertical line near each side spanning (close to) the full height. This
  // is exactly as strict as the old per-row/per-column validation — it just
  // applies ONLY to the outer frame, not to every internal divider.
  const candidates = [];

  for (let hi = hYs.length - 1; hi >= 0; hi--) {
    const yHi = hYs[hi];
    for (let lo = 0; lo < hi; lo++) {
      const yLo = hYs[lo];
      if (yHi - yLo < FRAME_MIN_HEIGHT) continue;

      // Best-overlapping span pair between yHi's and yLo's h-line segments
      // defines the candidate frame's left/right edges.
      let left = null, right = null, bestOverlap = 0;
      for (const [ax1, ax2] of hByY.get(yHi) || []) {
        for (const [bx1, bx2] of hByY.get(yLo) || []) {
          const overlap = Math.min(ax2, bx2) - Math.max(ax1, bx1);
          if (overlap <= 0) continue;
          const minSpan = Math.min(ax2 - ax1, bx2 - bx1);
          if (overlap < FRAME_MIN_OVERLAP_ABS || overlap < minSpan * FRAME_OVERLAP_FRAC) continue;
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            left  = Math.max(ax1, bx1);
            right = Math.min(ax2, bx2);
          }
        }
      }
      if (left === null) continue;

      // Outer sides: a v-line near `left` and one near `right` must each
      // span (close to) the full candidate height [yLo, yHi].
      const findEdgeX = (target) => {
        for (const x of vXs) {
          if (Math.abs(x - target) > SNAP * 2) continue;
          const spans = vByX.get(x) || [];
          if (spans.some(([y1, y2]) => y1 <= yLo + FRAME_EDGE_SLACK && y2 >= yHi - FRAME_EDGE_SLACK)) {
            return x;
          }
        }
        return null;
      };
      const leftX  = findEdgeX(left);
      const rightX = findEdgeX(right);
      if (leftX === null || rightX === null || leftX === rightX) continue;

      // Reject the page's own crop/media box outline — many PDF generators
      // draw a full-page border rectangle that technically satisfies every
      // frame check above (its top/bottom edges span the "full width" and
      // its sides span the "full height" — of the page itself). That is
      // never a real table; it would otherwise swallow every genuine table
      // on the page as "internal dividers" of one giant page-sized grid.
      if ((rightX - leftX) >= pageW - SNAP * 4 && (yHi - yLo) >= pageH - SNAP * 4) continue;

      // Reject candidates whose sides sit exactly at the page's own left/
      // right edge UNLESS the candidate also spans (close to) the page's
      // full height. A real table almost always has some horizontal
      // margin; reusing the raw page boundary as a wall — combined with
      // unrelated full-width rules elsewhere (section dividers, a 2-column
      // layout's vertical rule) — can otherwise assemble a false "table"
      // out of ordinary decorative lines that were never meant to be a
      // table at all.
      const sidesArePageEdge = leftX <= SNAP * 2 || rightX >= pageW - SNAP * 2;
      if (sidesArePageEdge && (yHi - yLo) < pageH - SNAP * 4) continue;

      // ── Internal dividers: once the frame is anchored, collect every row/
      // column separator inside it regardless of how much of the width or
      // height it actually spans — a merged cell (rowspan/colspan)
      // legitimately breaks a divider into a partial-length segment. This is
      // the one behaviour change from the old algorithm: previously an
      // internal divider had to span the WHOLE opposite dimension, which is
      // exactly why a real tariff table with merged product-name cells was
      // silently rejected before (its internal column dividers only existed
      // for some rows, never the table's full height).
      const internalYs = hYs.filter(y => y > yLo + SNAP && y < yHi - SNAP &&
        (hByY.get(y) || []).some(([x1, x2]) =>
          Math.min(x2, rightX) - Math.max(x1, leftX) >= INTERNAL_MIN_OVERLAP));
      const internalXs = vXs.filter(x => x > leftX + SNAP && x < rightX - SNAP &&
        (vByX.get(x) || []).some(([y1, y2]) =>
          Math.min(y2, yHi) - Math.max(y1, yLo) >= INTERNAL_MIN_OVERLAP));

      const rowYs = [yHi, ...internalYs.sort((a, b) => b - a), yLo];
      const colXs = [leftX, ...internalXs.sort((a, b) => a - b), rightX];
      const rowCount = rowYs.length - 1;
      const colCount = colXs.length - 1;
      if (rowCount < MIN_ROWS || colCount < MIN_COLS) continue;

      candidates.push({
        x: leftX, y: yLo, w: rightX - leftX, h: yHi - yLo,
        colCount, rowCount, colXs, rowYs,
      });
    }
  }

  // Resolve nested/overlapping frame candidates by preferring the LARGEST:
  // whenever the same pair of full-height outer verticals encloses a real
  // multi-row table, every adjacent 2-row slice of it also technically
  // satisfies the frame checks on its own (it reuses the same left/right
  // verticals, which trivially "span" any sub-range of a height they already
  // span in full) — preferring the smallest nested candidate would shred one
  // real table into dozens of tiny 2-row fragments instead of recognising
  // it as one table. The genuinely-bogus "coarser wrapper" case (a full
  // page's own crop-box outline swallowing everything on it) is excluded
  // explicitly above via the pageW/pageH check, so it never reaches here to
  // compete for "largest" in the first place.
  candidates.sort((a, b) => (b.colCount * b.rowCount) - (a.colCount * a.rowCount));
  const result = [];
  for (const g of candidates) {
    const inside = result.some(r =>
      r.x <= g.x + SNAP && r.y <= g.y + SNAP &&
      (r.x + r.w) >= (g.x + g.w) - SNAP &&
      (r.y + r.h) >= (g.y + g.h) - SNAP
    );
    if (!inside) result.push(g);
  }

  return result;
}
