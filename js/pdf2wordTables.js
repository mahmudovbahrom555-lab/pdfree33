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
// Real, confirmed case (Atlas_DR's md_corpus/003-multipage-ledger, a real
// debit/credit financial ledger): a genuine data row can legitimately have
// FEWER items than the header when columns are mutually exclusive (a
// transaction is either a debit or a credit, never both — so every data row
// is missing one of those two columns by design, not by accident). See
// _columnAlignScore's own comment for how this floor is used.
const MIN_COVERAGE_FRACTION = 0.5;

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

    // Extend forward while subsequent lines align with the base column pattern.
    // effectiveLines (not a plain lines.slice(i,j)) is what actually becomes
    // rows — a wrap-continuation line gets merged into the previous accepted
    // line's own item instead of appearing here, and a repeated header row
    // gets consumed (still advances j, still ends up inside [i, j) so the
    // caller's consumed-index bookkeeping still covers it) without being
    // pushed at all. Both are real bugs found via a real multi-page
    // purchase-order test, not hypothetical:
    //  - A wrapped 2nd line of a table cell (long Description text) used to
    //    always break table extension right there (single stray item, not a
    //    stub row) — if the fragment before or after the break was itself
    //    under MIN_ROWS, that whole chunk (including real data rows) was
    //    silently dropped, not merely mis-formatted.
    //  - A header row re-printed on every page of a multi-page table (a
    //    very common real PDF-generator pattern) satisfied the ordinary
    //    column-alignment check just like a data row, so it got absorbed
    //    as literal data ("Description", "Qty", … sitting mid-table).
    let j = i + 1;
    const effectiveLines = [line];
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
          if (_looksLikeRepeatedHeader(effectiveLines[0], next)) {
            stubSeq = 0;
            j++;
            continue; // consumed, deliberately not added as a data row
          }
          // Reset stub sequence when we see a properly-filled row
          stubSeq = 0;
          effectiveLines.push(next);
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
        effectiveLines.push(next);
        j++;
        continue;
      }

      // Wrap-continuation: a single stray item landing on one of the
      // table's own established column positions (but NOT the leftmost —
      // see below), most likely the tail of a multi-line cell (e.g. a long
      // Description) wrapped onto its own line. Merge its text onto that
      // column's item on the last accepted line rather than treating it as
      // a new row or breaking the table.
      //
      // Excluding baseCols[0] specifically is load-bearing, not incidental:
      // a single leftover item sitting in the LEFTMOST column is exactly
      // the shape of a genuinely sparse row (a category/ID column with
      // nothing else on that row — the same real, already-handled pattern
      // _columnAlignScore's MIN_COVERAGE_FRACTION comment documents for
      // debit/credit ledgers, just at the 1-item extreme). Wrapped text
      // continuations are overwhelmingly a body-text-column phenomenon
      // (descriptions, names, addresses), not the leftmost ID/number
      // column, which by nature holds short tokens that don't wrap. Found
      // via a real regression: without this exclusion, a page whose
      // left-column items happen to line up at the same X as an unrelated
      // table's leftmost column (tests/pdf2wordColumns.test.js's
      // _splitCrossColumnLines fixture) got misread as one long confident
      // table instead of two real parallel columns, since detectColumnRegions()
      // deliberately refuses to split anything detectTables() is confident
      // about (its own "prefer false negatives" table guard).
      const wrapItem = next.items[0];
      const candidateCols = baseCols.slice(1); // exclude the leftmost column
      const nearestCol = candidateCols.length
        ? candidateCols.reduce((best, bc) =>
            Math.abs(bc - wrapItem.x) < Math.abs(best - wrapItem.x) ? bc : best, candidateCols[0])
        : null;
      if (nearestCol !== null && Math.abs(nearestCol - wrapItem.x) <= COL_TOLERANCE) {
        const lastLine   = effectiveLines[effectiveLines.length - 1];
        const targetItem = lastLine.items.reduce((best, it) =>
          Math.abs(it.x - nearestCol) < Math.abs(best.x - nearestCol) ? it : best, lastLine.items[0]);
        targetItem.str = `${targetItem.str} ${wrapItem.str}`;
        j++;
        continue;
      }

      break;
    }

    const rowCount = effectiveLines.length;
    if (rowCount >= MIN_ROWS) {
      const colBounds  = _detectColumnBoundaries(effectiveLines, COL_TOLERANCE);
      const perLine    = effectiveLines.map(ln => _assignToCellsWithFonts(ln.items, colBounds));
      const rows       = perLine.map(r => r.texts);
      const cellFonts  = perLine.map(r => r.fonts);

      // Stub rows lower fillScore — compensate by boosting alignScore weight
      // when the table is mostly empty (template form pattern).
      const stubFraction = rows.filter(r => r.filter(c => c.trim()).length <= 1).length / rows.length;
      const scores       = _computeScores(rows, colBounds.length, stubFraction);

      if (scores.confidence >= CONF_THRESHOLD) {
        tables.push({
          startIdx:   i,
          endIdx:     j - 1,    // inclusive
          rows,
          cellFonts,  // parallel to rows — cellFonts[r][c] is item.fontFamily or undefined.
                      // Purely additive: pdf2word/pdf2excel/pdf2md only ever read `rows`,
                      // so this is inert for them. Consumed by pdf2ppt for per-cell font
                      // preservation in reconstructed PPTX tables.
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

// Groups flat PDF text items into lines[] (the format detectTables() expects),
// clustering by Y-position and sorting each line's items by X.
// Single source of truth: pdf2excel's pre-conversion preview scan
// (pdf2excelUI.js) and its real conversion pass (processor.js's
// _p2eExtractTables) both call this so the two can never drift apart.
const DEFAULT_LINE_YTOL = 6; // px — items within this Y-distance → same line

export function groupItemsIntoLines(items, ytol = DEFAULT_LINE_YTOL) {
  const lines = [];
  for (const item of [...items].sort((a, b) => b.y - a.y)) {
    let merged = false;
    for (const ln of lines) {
      if (Math.abs(ln.y - item.y) <= ytol) { ln.items.push(item); merged = true; break; }
    }
    if (!merged) lines.push({ y: item.y, items: [item] });
  }
  lines.forEach(ln => ln.items.sort((a, b) => a.x - b.x));
  return lines;
}

// ── Repeated header detection ─────────────────────────────────────────────────

/**
 * Does `candidate` look like the table's own header row (`headerLine`)
 * printed again mid-table? Real, common pattern: PDF generators re-print
 * column headers at the top of every page a table spans. Exact text-set
 * match (order-independent, case/whitespace-insensitive) rather than a
 * fuzzy/partial match — deliberately conservative, same "false negatives
 * over false positives" stance as the rest of this file. A genuine data
 * row coincidentally containing the exact same text as every single header
 * cell simultaneously is effectively impossible.
 */
function _looksLikeRepeatedHeader(headerLine, candidate) {
  if (!headerLine?.items || headerLine.items.length !== candidate.items.length) return false;
  const norm = (s) => s.trim().toLowerCase();
  const headerTexts = headerLine.items.map(it => norm(it.str)).sort();
  const candTexts    = candidate.items.map(it => norm(it.str)).sort();
  return headerTexts.every((t, idx) => t === candTexts[idx]);
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
 * How well a line's columns match the established base pattern. Two
 * separate signals, not one ratio, because they protect against two
 * different failure modes:
 *
 *   precision — of THIS line's own items, how many land on a real, known
 *     column. Low precision means the line has extra/unrelated items that
 *     only coincidentally overlap a couple of base positions (protects
 *     against a spurious short line being absorbed into the table).
 *
 *   coverage  — how much of the base pattern this line actually represents
 *     (matched ÷ baseCols.length). A genuine data row can legitimately have
 *     FEWER columns than the header when columns are mutually exclusive —
 *     confirmed on a real debit/credit ledger (Atlas_DR's
 *     md_corpus/003-multipage-ledger) where every transaction row fills
 *     only ONE of the Debit/Credit columns, so the very first data row
 *     (an opening-balance line with no Debit/Credit at all) has just 3 of
 *     the header's 5 columns. The OLD single-ratio design
 *     (matched / Math.max(baseCols.length, lineCols.length)) scored that
 *     row 3/5=0.6 — below ALIGN_THRESHOLD — collapsing the whole table
 *     candidate to 1 row before it ever reached the rows that WOULD have
 *     matched, so the entire 28-row table went undetected. Below
 *     MIN_COVERAGE_FRACTION, though, a short line is more likely unrelated
 *     than a genuine sparse row of THIS table, so coverage still gates it.
 */
function _columnAlignScore(baseCols, lineCols, tolerance) {
  if (lineCols.length === 0) return 0;

  let matched = 0;
  for (const lc of lineCols) {
    if (baseCols.some(bc => Math.abs(bc - lc) <= tolerance)) matched++;
  }

  const coverage = matched / baseCols.length;
  if (coverage < MIN_COVERAGE_FRACTION) return coverage; // forces a reject below ALIGN_THRESHOLD

  return matched / lineCols.length; // precision — fewer-but-all-matching no longer penalised
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
 * Returns { texts, fonts }: texts is a string[] (concatenated text per cell),
 * fonts is a parallel (string|undefined)[] — the first resolved fontFamily
 * seen among the items assigned to that cell, or undefined if none carry one
 * (plain-text extraction paths that never set item.fontFamily at all).
 */
function _assignToCellsWithFonts(items, colBounds) {
  const texts = colBounds.map(() => []);
  const fonts = colBounds.map(() => undefined);

  for (const item of items) {
    let bestCol = 0, bestDist = Infinity;
    for (let c = 0; c < colBounds.length; c++) {
      const d = Math.abs(item.x - colBounds[c].center);
      if (d < bestDist) { bestDist = d; bestCol = c; }
    }
    texts[bestCol].push(item.str);
    if (fonts[bestCol] === undefined && item.fontFamily) fonts[bestCol] = item.fontFamily;
  }

  return { texts: texts.map(parts => parts.join(' ').trim()), fonts };
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

// Two unrelated prose lists placed side by side (e.g. a resume's "Skills" /
// "Interests" columns) can pass detectTables()'s own alignment/fill checks
// perfectly — consistently X-aligned, every column filled, no empty cells —
// while sharing no real relationship. Real tabular data (invoices, budgets,
// schedules, price lists) almost always has at least one short, numeric, or
// code-like column; multi-word prose in EVERY column with no numeric anchor
// anywhere is a structural proxy for "two lists", not a table. Same
// heuristic and threshold as eriScoreXlsx.js's checkProseVsData, adapted to
// operate directly on detectTables()'s raw string rows (used by pdf2md,
// which has no built file afterward to score) rather than a built .xlsx
// file's typed cells (used by pdf2excel's post-build ERI check).
const _PROSE_NUMERIC_LOOKING = /^-?[$€£¥]?\s?\d{1,3}(,\d{3})*(\.\d+)?%?$/;

// "Word count via whitespace split" silently returns 1 for an entire CJK
// sentence, since Chinese/Japanese prose has no spaces between words at
// all (Korean is less affected — it does use spaces between phrases).
// Found via a synthetic Japanese contract fixture: a heading + a 3-item
// numbered clause list ("1. 乙は、甲の指示に従い、本契約に定める業務を誠実
// に遂行するものとする。" — one long sentence, one whitespace-token) got
// detected as a table and neither looksLikeProseNotData() nor
// looksLikeEnumeratedList() caught it, because every clause's prose cell
// counted as "1 word" — nowhere near either function's word-per-cell
// threshold, despite being obviously prose to a human reader. Counting CJK
// ideographs/kana/hangul directly (each roughly half a Latin "word" in
// information density — two CJK characters carry about as much meaning as
// one space-delimited word) fixes both guards without touching their
// thresholds, which stay calibrated against Latin/Cyrillic prose.
const _CJK_RE = /[一-鿿㐀-䶿぀-ヿ가-힣]/g;

function _wordCount(text) {
  const cjkChars  = (text.match(_CJK_RE) || []).length;
  const nonCjk    = text.replace(_CJK_RE, ' ').trim();
  const latinWords = nonCjk ? nonCjk.split(/\s+/).filter(Boolean).length : 0;
  return latinWords + Math.ceil(cjkChars / 2);
}

export function looksLikeProseNotData(rows) {
  if (rows.length < 2) return false;
  const body = rows.slice(1); // header row is short in real AND fake tables alike
  let cellCount = 0, wordCount = 0, hasNumericAnchor = false;
  for (const row of body) {
    for (const cell of row) {
      const text = (cell || '').trim();
      if (!text) continue;
      cellCount++;
      wordCount += _wordCount(text);
      if (_PROSE_NUMERIC_LOOKING.test(text)) hasNumericAnchor = true;
    }
  }
  if (!cellCount) return false;
  return !hasNumericAnchor && (wordCount / cellCount) >= 2.0;
}

// Found on the same real 19-page contract as looksLikeProseNotData above: a
// numbered legal clause list — clause marker in column 1 ("2.5.1.", "5.11.",
// "а)", "б)"), full clause prose in column 2 — passes detectTables()'s own
// alignment/fill checks perfectly (every row has exactly 2 filled cells,
// consistently X-aligned across rows) while being a list, not a table.
// looksLikeProseNotData() catches most of these too (clause prose is
// wordy and no single cell is a bare number), but it can be defeated when a
// clause happens to embed a number that ends a sentence in a way a future
// tweak might read as an anchor, or when column widths shift some prose into
// short fragments — this checks the STRUCTURE of column 1 directly instead,
// so the two guards catch genuinely different failure modes:
//   • dotted/hierarchical numbering: "2.", "2.5.", "2.5.1.", "5.11."
//   • lettered sub-items: "а)"/"б)" (Cyrillic) or "a)"/"b)" (Latin)
// Plain sequential row numbers ("1.", "2.", "3.") on a genuine numbered
// price/item table would ALSO match this marker shape, so this alone isn't
// enough — real numbered-table rows pair the marker with a SHORT other-column
// value (a price, a code, a name), while clause lists pair it with a full
// sentence. Requiring both the marker pattern AND prose-heavy other columns
// keeps genuine numbered tables (e.g. "1. | Widget A | $10.00") intact.
const _CLAUSE_MARKER_RE = /^(?:\d{1,3}(?:\.\d{1,3}){0,3}\.?|[a-zA-Zа-яёА-ЯЁ]\))$/;
const _CLAUSE_MARKER_RATIO   = 0.7;  // fraction of rows whose column 1 must match
const _CLAUSE_OTHER_COLS_WPC = 4.0;  // avg words/cell in the non-marker columns

export function looksLikeEnumeratedList(rows) {
  if (rows.length < 2) return false;

  let markerRows = 0, dataRows = 0;
  let cellCount = 0, wordCount = 0;
  for (const row of rows) {
    const marker = (row[0] || '').trim();
    if (!marker) continue;
    dataRows++;
    if (_CLAUSE_MARKER_RE.test(marker)) markerRows++;
    for (let c = 1; c < row.length; c++) {
      const text = (row[c] || '').trim();
      if (!text) continue;
      cellCount++;
      wordCount += _wordCount(text);
    }
  }
  if (dataRows < 2 || !cellCount) return false;

  const markerRatio = markerRows / dataRows;
  const otherColsWordsPerCell = wordCount / cellCount;
  return markerRatio >= _CLAUSE_MARKER_RATIO && otherColsWordsPerCell >= _CLAUSE_OTHER_COLS_WPC;
}

// ── Exports for test harness ──────────────────────────────────────────────────
export { MIN_ROWS, MIN_COLS, COL_TOLERANCE, ALIGN_THRESHOLD, CONF_THRESHOLD };
