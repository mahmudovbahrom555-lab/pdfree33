// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors
//
// ── pdf2wordTables.js ─────────────────────────────────────────────────────────
// Pure table-detection module — zero DOM dependencies.
// Input:  lines[] from _p2wExtractText (same format, reused directly)
// Output: TableResult[]
//
// Algorithm: X-coordinate column clustering.
// Why not line-drawing analysis: distinguishing table borders from chart lines,
// decorative frames and signature boxes requires complex geometry — complexity
// grows fast, accuracy gain is marginal for typical business PDFs.
// Why not Structure Tree: ~20% of PDFs are properly tagged; too narrow.
// X-clustering gives ~65–70% recall at low complexity — best ROI for v1.
//
// Conservative by design:
//   • Requires ≥3 rows (2-row "tables" are often coincidental alignment)
//   • Requires ≥2 cols with ≥80% cross-row alignment
//   • Prefers false negatives (missed table) over false positives (broken text)
// ─────────────────────────────────────────────────────────────────────────────

// ── Tuneable constants ────────────────────────────────────────────────────────

const MIN_ROWS         = 3;    // minimum rows to call something a table
const MIN_COLS         = 2;    // minimum columns
const COL_TOLERANCE    = 25;   // px — items within this X-distance → same column
const ALIGN_THRESHOLD  = 0.80; // fraction of rows that must share the column pattern
const CONF_THRESHOLD   = 0.72; // minimum confidence to emit a table result

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect tables in a page's line array.
 *
 * @param {Array<{y:number, items:Array<{x:number, str:string, fontSize:number, bold:boolean, italic:boolean}>}>} lines
 * @param {object}  [opts]
 * @param {boolean} [opts.debug=false]  — log detection details to console
 * @returns {TableResult[]}
 */
export function detectTables(lines, { debug = false } = {}) {
  const tables = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip lines with fewer items than the minimum column count
    if (!line.items || line.items.length < MIN_COLS) { i++; continue; }

    const baseCols = _clusterColumns(line.items, COL_TOLERANCE);
    if (baseCols.length < MIN_COLS) { i++; continue; }

    // Extend forward while subsequent lines align with the base column pattern
    let j = i + 1;
    // Track how many consecutive stub rows we've accepted.
    // A stub row = exactly 1 item that is a positive sequential integer.
    // This handles blank template tables (school forms, contracts) where
    // only the № column contains text and all data cells are empty.
    let stubSeq = 0;   // next expected stub row number (0 = none yet)

    while (j < lines.length) {
      const next = lines[j];
      if (!next.items || next.items.length === 0) break;

      // Fast path: line has enough items — check column alignment
      if (next.items.length >= MIN_COLS) {
        const nextCols   = _clusterColumns(next.items, COL_TOLERANCE);
        const alignScore = _columnAlignScore(baseCols, nextCols, COL_TOLERANCE);
        if (alignScore >= ALIGN_THRESHOLD) {
          // Reset stub sequence when we see a properly-filled row
          stubSeq = 0;
          j++;
          continue;
        }
        break;
      }

      // Single-item line — check for stub row (empty template row with only №)
      // Condition: single integer item ≥1, sequential (1, 2, 3…) or restarting at 1
      const stubN = _stubRowNumber(next);
      if (stubN !== null && (stubSeq === 0 ? stubN === 1 : stubN === stubSeq + 1)) {
        stubSeq = stubN;
        j++;
        continue;
      }

      break;
    }

    const rowCount = j - i;
    if (rowCount >= MIN_ROWS) {
      const tableLines = lines.slice(i, j);
      const colBounds  = _detectColumnBoundaries(tableLines, COL_TOLERANCE);
      const rows       = tableLines.map(ln => _assignToCells(ln.items, colBounds));

      // Stub rows lower fillScore — compensate by boosting alignScore weight
      // when the table is mostly empty (template form pattern).
      const stubFraction = rows.filter(r => r.filter(c => c.trim()).length <= 1).length / rows.length;
      const scores       = _computeScores(rows, colBounds.length, stubFraction);

      if (scores.confidence >= CONF_THRESHOLD) {
        tables.push({
          startIdx:   i,
          endIdx:     j - 1,    // inclusive
          rows,
          colCount:   colBounds.length,
          alignScore: scores.alignScore,
          fillScore:  scores.fillScore,
          confidence: scores.confidence,
        });
      }
      i = j;  // jump past the table (or the rejected candidate)
    } else {
      i++;
    }
  }

  if (debug) _debugPrint(tables, lines);
  return tables;
}

// ── Stub row detection ────────────────────────────────────────────────────────

/**
 * If a line contains exactly one text item that is a positive integer,
 * return that integer. Otherwise return null.
 *
 * Used to detect blank template rows that only have a row number (№):
 *   |  1  |       |            |                   |
 *   |  2  |       |            |                   |
 * These appear in school journals, government forms, blank contracts, etc.
 */
function _stubRowNumber(line) {
  if (line.items.length !== 1) return null;
  const n = parseInt(line.items[0].str.trim(), 10);
  return (!isNaN(n) && n >= 1) ? n : null;
}

// ── Column clustering ─────────────────────────────────────────────────────────

/**
 * Group items into columns by proximity of their X-coordinate.
 * Returns sorted array of column center X values.
 */
function _clusterColumns(items, tolerance) {
  const clusters = [];   // [{center, sum, count}]

  for (const item of [...items].sort((a, b) => a.x - b.x)) {
    let best = null, bestDist = Infinity;
    for (const c of clusters) {
      const d = Math.abs(c.center - item.x);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    if (best && bestDist <= tolerance) {
      best.sum   += item.x;
      best.count += 1;
      best.center = best.sum / best.count;  // running mean
    } else {
      clusters.push({ center: item.x, sum: item.x, count: 1 });
    }
  }

  return clusters.map(c => c.center).sort((a, b) => a - b);
}

/**
 * Fraction of line's columns that match at least one base column.
 * Symmetric: also penalises if the line has far more columns than the base.
 */
function _columnAlignScore(baseCols, lineCols, tolerance) {
  if (lineCols.length === 0) return 0;

  let matched = 0;
  for (const lc of lineCols) {
    if (baseCols.some(bc => Math.abs(bc - lc) <= tolerance)) matched++;
  }

  // Use the larger set as denominator — penalises wildly different column counts
  return matched / Math.max(baseCols.length, lineCols.length);
}

// ── Column boundary computation ───────────────────────────────────────────────

/**
 * Determine column boundaries (left, center, right) from all lines in a table.
 * Mid-points between adjacent column centres define cell left/right edges.
 */
function _detectColumnBoundaries(lines, tolerance) {
  const allX = lines.flatMap(ln => ln.items.map(i => i.x));
  const centers = _clusterColumns(
    allX.map(x => ({ x })),
    tolerance
  ).sort((a, b) => a - b);

  return centers.map((center, idx) => ({
    center,
    left:  idx === 0               ? -Infinity : (center + centers[idx - 1]) / 2,
    right: idx === centers.length - 1 ? Infinity  : (center + centers[idx + 1]) / 2,
  }));
}

// ── Cell assignment ───────────────────────────────────────────────────────────

/**
 * Assign each text item to the nearest column by X-distance to column center.
 * Returns a string[] with one entry per column (concatenated text in cell).
 */
function _assignToCells(items, colBounds) {
  const cells = colBounds.map(() => []);

  for (const item of items) {
    let bestCol = 0, bestDist = Infinity;
    for (let c = 0; c < colBounds.length; c++) {
      const d = Math.abs(item.x - colBounds[c].center);
      if (d < bestDist) { bestDist = d; bestCol = c; }
    }
    cells[bestCol].push(item.str);
  }

  return cells.map(parts => parts.join(' ').trim());
}

// ── Confidence scoring ────────────────────────────────────────────────────────

/**
 * Compute two independent quality signals and derive a combined confidence.
 *
 * alignScore:    fraction of rows that have ≥ceil(cols*0.6) non-empty cells.
 *                Measures structural regularity.
 * fillScore:     average cell occupancy across all rows.
 *                Measures data density — sparse grids are likely false positives.
 * stubFraction:  fraction of rows that are numbered-only (template rows).
 *                When high, fillScore is penalised less — blank forms ARE tables.
 *
 * confidence: weighted combination, capped at 1.0.
 *             Row count bonus: more evidence → higher confidence.
 */
function _computeScores(rows, expectedCols, stubFraction = 0) {
  if (!rows.length || !expectedCols) return { alignScore: 0, fillScore: 0, confidence: 0 };

  // For template tables, require only 1 non-empty cell (the row number).
  // For data tables, require 60% of cells non-empty.
  const minFilled = stubFraction > 0.5
    ? 1
    : Math.ceil(expectedCols * 0.6);

  let alignedRows  = 0;
  let totalFill    = 0;

  for (const row of rows) {
    const nonEmpty = row.filter(cell => cell.trim()).length;
    if (nonEmpty >= minFilled) alignedRows++;
    totalFill += nonEmpty / expectedCols;
  }

  const alignScore = alignedRows / rows.length;
  const fillScore  = totalFill  / rows.length;

  // Row count bonus: saturates at 0.15 for 10+ rows
  const rowBonus = Math.min(rows.length / 10, 1) * 0.15;

  // For template tables: weight align heavily, fill less (empty cells are expected)
  const wAlign = stubFraction > 0.5 ? 0.70 : 0.55;
  const wFill  = stubFraction > 0.5 ? 0.15 : 0.30;

  const confidence = Math.min(alignScore * wAlign + fillScore * wFill + rowBonus, 1.0);

  return { alignScore, fillScore, confidence };
}

// ── Debug output ──────────────────────────────────────────────────────────────

function _debugPrint(tables, _lines) {
  if (!tables.length) {
    console.log('[pdf2wordTables] No tables detected on this page');
    return;
  }
  console.group(`[pdf2wordTables] ${tables.length} table(s) detected`);
  tables.forEach((t, idx) => {
    const pct = v => (v * 100).toFixed(0) + '%';
    console.group(
      `Table ${idx + 1}: lines ${t.startIdx}–${t.endIdx} | ` +
      `${t.rows.length} rows × ${t.colCount} cols | ` +
      `align=${pct(t.alignScore)} fill=${pct(t.fillScore)} conf=${pct(t.confidence)}`
    );
    // Print as a simple ASCII grid
    const widths = Array.from({ length: t.colCount }, (_, c) =>
      Math.min(Math.max(...t.rows.map(r => (r[c] || '').length), 4), 24)
    );
    const divider = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
    console.log(divider);
    for (const row of t.rows) {
      const cells = row.map((cell, c) => {
        const s = (cell || '').slice(0, widths[c]);
        return ' ' + s.padEnd(widths[c]) + ' ';
      });
      console.log('|' + cells.join('|') + '|');
    }
    console.log(divider);
    console.groupEnd();
  });
  console.groupEnd();
}

// ── Exports for test harness ──────────────────────────────────────────────────
export { MIN_ROWS, MIN_COLS, COL_TOLERANCE, ALIGN_THRESHOLD, CONF_THRESHOLD };
