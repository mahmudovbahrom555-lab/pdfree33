// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors
//
// ── pdf2wordColumns.js ──────────────────────────────────────────────────────
// Pure page-level column-region detection — zero DOM dependencies, mirrors
// pdf2wordTables.js's mean-based X-coordinate clustering (`_clusterColumns`),
// not a literal call to it: that function returns bare column centers, tuned
// for a table's cell-gap scale; this needs per-cluster line count and Y-range
// too (to reject noise and confirm columns actually run in parallel down the
// page), so it's its own small function rather than forcing an incompatible
// return shape onto the table-detection one.
//
// Calibrated against 5 real, license-verified 2-column academic PDFs (see
// tests/fixtures/columns/), not guessed: column 1's line-start X clustered
// at 54-92pt across all 5 (page margin), column 2's at 305-321pt (~50% of a
// 595-612pt page) — a 200pt+ gap versus each column's own ~40pt worst-case
// internal spread. That gap-to-spread ratio is what TOLERANCE below assumes.
//
// "Prefer false negatives" — same philosophy detectTables()/
// detectTableGrids() already document: the overwhelming majority of real
// PDFs are single-column, and returning null (no split) must be the safe,
// common outcome whenever detection is remotely ambiguous.
// ─────────────────────────────────────────────────────────────────────────────

import { detectTables } from './pdf2wordTables.js';

// A confident detectTables() match covering at least this fraction of the
// candidate lines means this is tabular data (e.g. a financial statement's
// label|amount rows), not two independent reading-flow columns — see the
// guard at the bottom of detectColumnRegions() for the real-document
// evidence behind this number: on financial-nested-subtotals.pdf (a real
// label|amount table, 13 lines) detectTables() confidently covers 92% of
// them, while the worst false-positive across 5 real, license-verified
// 2-column academic PDFs (tests/fixtures/columns/ — mostly stray
// references/bibliography lines that already have a separate, known,
// unrelated mis-detection issue) tops out at 25%. 50% sits with a wide
// margin on both sides of that real, measured gap.
const TABLE_GUARD_FRACTION = 0.5;

const TOLERANCE          = 40;   // pt — candidate column-start X's within this → same column
const MIN_LINES_ABS      = 5;    // a column needs at least this many lines...
const MIN_LINES_FRACTION = 0.15; // ...or this fraction of the page's lines, whichever is stricter
const MIN_Y_OVERLAP_FRACTION = 0.5; // surviving clusters must Y-overlap at least this much of the shorter one
const MAX_COLUMNS = 3;           // more than this and the detection is treated as noise, not columns
// pt — a within-line gap bigger than this is treated as a column boundary,
// not word-spacing. Calibrated against real data, not guessed: measured the
// actual gap at every genuine column boundary across all 5 real 2-column
// papers in tests/fixtures/columns/ (202 merged-line instances) — the
// smallest real gap found was 15pt. 12pt sits safely below that while
// staying well above normal inter-word spacing (a few pt at these font
// sizes), so it won't mistake ordinary wide word-spacing for a new column.
const GAP_THRESHOLD = 12;

/**
 * @typedef {Object} ColumnRegion
 * @property {number} left  — left X boundary (page-edge extended for the first region)
 * @property {number} right — right X boundary (page-edge extended for the last region)
 */

// Every X position within `line` where a new "column run" starts: the
// line's own first item, plus any item preceded by a gap bigger than
// GAP_THRESHOLD. Necessary because _p2wBuildPageData's plain Y-proximity
// line-grouping frequently merges BOTH columns' items into one line object
// on a genuine 2-column page (same font/line-height page-wide → same Y per
// row) — measured directly: 70-85% of lines on the 5 real papers above.
// Using only `line.items[0].x` (the line's single leftmost item) would make
// column 2 invisible on every one of THOSE merged lines, since its items
// are never first. Looking for gaps instead recovers both columns' real
// start positions regardless of merging.
function lineRunStarts(line) {
  if (!line.items || !line.items.length) return [];
  const sorted = [...line.items].sort((a, b) => a.x - b.x);
  const starts = [sorted[0].x];
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].x + (sorted[i - 1].width > 0 ? sorted[i - 1].width : 0);
    if (sorted[i].x - prevEnd > GAP_THRESHOLD) starts.push(sorted[i].x);
  }
  return starts;
}

/**
 * Detects page-level column regions from a page's line array (the same
 * `lines` shape _p2wBuildPageData produces: {y, items:[{x,...}]}, sorted by
 * Y descending, each line's items sorted by X for LTR).
 *
 * @param {Array<{y:number, items:Array<{x:number}>}>} lines
 * @param {number} pageWidth
 * @returns {ColumnRegion[]|null} left-to-right regions, or null if no
 *   confident multi-column layout was found (single-column — the common case)
 */
export function detectColumnRegions(lines, pageWidth) {
  if (lines.length < MIN_LINES_ABS * 2) return null; // too little content to judge at all

  const candidates = lines.flatMap(ln => lineRunStarts(ln).map(x => ({ x, y: ln.y })));
  if (candidates.length < MIN_LINES_ABS * 2) return null;

  // Mean-based clustering, same algorithm _clusterColumns (pdf2wordTables.js)
  // uses, tracking distinct-line count + Y-range per cluster (needed below,
  // unlike that function's bare-centers return).
  const clusters = []; // [{ sum, center, ys:Set<y>, minY, maxY }]
  for (const { x, y } of [...candidates].sort((a, b) => a.x - b.x)) {
    let best = null, bestDist = Infinity;
    for (const c of clusters) {
      const d = Math.abs(c.center - x);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    if (best && bestDist <= TOLERANCE) {
      best.sum += x; best.ys.add(y); best.center = best.sum / best.ys.size;
      best.minY = Math.min(best.minY, y); best.maxY = Math.max(best.maxY, y);
    } else {
      clusters.push({ sum: x, center: x, ys: new Set([y]), minY: y, maxY: y });
    }
  }

  // Reject noise clusters — a stray indented line or footnote shouldn't
  // register as its own "column". Counts DISTINCT LINES touching the
  // cluster (ys.size), not raw candidate count — a single dense line
  // shouldn't out-vote a genuine but sparser column.
  const minLines = Math.max(MIN_LINES_ABS, Math.ceil(lines.length * MIN_LINES_FRACTION));
  const real = clusters.filter(c => c.ys.size >= minLines).sort((a, b) => a.center - b.center);

  // Adjacent clusters that DON'T substantially overlap in Y are merged into
  // one before being rejected outright — genuine parallel columns coexist
  // across most of the page height, but a real 2-column page can still
  // legitimately produce 3+ x-clusters when the SAME logical column shifts
  // indent partway down the page (a References section's hanging indent, a
  // block-quote, a sub-list) rather than actually gaining a third
  // simultaneous column. Confirmed directly on a real arXiv paper (page 1
  // of Atlas_DR's md_corpus/002-two-column-paper): body text clustered at
  // x≈54 (Y122-469) and a lower-page indent shift at x≈119 (Y492-763) are
  // Y-DISJOINT from each other, yet both sit far left of the genuine right
  // column at x≈318 (Y122-492, which overlaps x≈54 almost perfectly) —
  // rejecting outright the moment the FIRST adjacent pair (x≈54 vs x≈119)
  // fails Y-overlap silently threw away correct 2-column detection on the
  // whole page. Two clusters that never coexist in Y cannot be two
  // SIMULTANEOUS side-by-side columns by definition, so folding them into
  // one logical column (rather than abandoning the whole page) preserves
  // this check's original protective intent — a real title block above
  // single-column body text still correctly resolves to null below, since
  // merging title+body collapses them to ONE cluster, which then fails the
  // `real.length < 2` check same as before this fix.
  let mergedAny = true;
  while (mergedAny && real.length > 1) {
    mergedAny = false;
    for (let i = 1; i < real.length; i++) {
      const a = real[i - 1], b = real[i];
      const overlap = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
      const shorterSpan = Math.min(a.maxY - a.minY, b.maxY - b.minY) || 1;
      if (overlap / shorterSpan < MIN_Y_OVERLAP_FRACTION) {
        const combined = {
          sum: a.sum + b.sum,
          ys: new Set([...a.ys, ...b.ys]),
          minY: Math.min(a.minY, b.minY),
          maxY: Math.max(a.maxY, b.maxY),
        };
        combined.center = combined.sum / combined.ys.size;
        real.splice(i - 1, 2, combined);
        mergedAny = true;
        break; // indices shifted after splice — restart the scan
      }
    }
  }
  if (real.length < 2 || real.length > MAX_COLUMNS) return null;

  // Table guard — see TABLE_GUARD_FRACTION's own comment above. Reuses
  // detectTables() (pdf2wordTables.js, already tuned + regression-guarded,
  // e.g. the debit/credit ledger case) rather than inventing a new
  // heuristic here: a real 2-column table has every row's items align
  // consistently at both cluster X-positions, exactly what that function
  // is built to recognize. Checked against the ORIGINAL, unsplit `lines`
  // (not the per-cluster candidates) since that's what a real table's rows
  // still look like at this point in the pipeline — the caller hasn't
  // split anything yet.
  const tableLineCount = detectTables(lines)
    .reduce((n, t) => n + (t.endIdx - t.startIdx + 1), 0);
  if (tableLineCount >= lines.length * TABLE_GUARD_FRACTION) return null;

  return real.map((c, idx) => ({
    left:  idx === 0                ? 0          : (c.center + real[idx - 1].center) / 2,
    right: idx === real.length - 1  ? pageWidth  : (c.center + real[idx + 1].center) / 2,
  }));
}

/** Which region a bare X-coordinate falls into (last region if past the final boundary). */
export function regionIndexForX(x, regions) {
  for (let i = 0; i < regions.length; i++) {
    if (x >= regions[i].left && x < regions[i].right) return i;
  }
  return regions.length - 1;
}

/** Which region a line falls into, by its first item's X. */
export function lineRegionIndex(line, regions) {
  if (!line.items || !line.items.length) return 0;
  return regionIndexForX(line.items[0].x, regions);
}

/**
 * Page-level reading direction, for column TRAVERSAL order only (rightmost
 * column first for RTL) — entirely separate from per-line BiDi text shaping
 * (_visualRTLToLogical, `ln.rtl`'s existing use for <w:bidi/>), which this
 * does not touch. Majority vote over the page's own per-line `rtl` flag
 * (_p2wBuildPageData already computes it; not recomputed here).
 */
export function pageIsRtl(lines) {
  if (!lines.length) return false;
  const rtlCount = lines.filter(ln => ln.rtl).length;
  return rtlCount / lines.length > 0.5;
}
