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

import { detectTables, looksLikeProseNotData, looksLikeEnumeratedList } from './pdf2wordTables.js';

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
 * @property {boolean} gutter — boundaries run through a real empty gutter (projection
 *   profile), not the midpoint fallback
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
// Where each run of a line BEGINS in reading order: its left edge, or its right
// edge on an RTL line. Arabic/Hebrew/Persian columns are right-aligned with a
// ragged left edge, so clustering left edges split one column into several
// (ground truth 2026-10-01: three "columns" on every RTL two-column page).
function lineRunStarts(line, rtlAware) {
  if (!line.items || !line.items.length) return [];
  const sorted = [...line.items].sort((a, b) => a.x - b.x);
  const end = it => it.x + (it.width > 0 ? it.width : 0);
  const runs = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].x - end(sorted[i - 1]) > GAP_THRESHOLD) runs.push([]);
    runs[runs.length - 1].push(sorted[i]);
  }
  return runs.map(run => (rtlAware && line.rtl ? Math.max(...run.map(end)) : run[0].x));
}

// Column boundaries through the empty gutters, not halfway between two
// clusters' starts: a vertical projection profile of the page's text runs and
// its widest empty valleys — the X-cut step of recursive XY-cut layout analysis
// (Nagy & Seth 1984) and the whitespace analysis Breuel's work, and
// Bukhari/Shafait/Breuel's for Arabic script, builds column detection on; it
// doesn't care which way the text runs. The old midpoint put an English page's
// boundary at x≈183 inside a left column spanning 72–285 (gutter 285–310).
// Runs (a line split at gaps > GAP_THRESHOLD) rather than lines, so two
// columns' lines merged on one baseline still leave the gutter empty; runs wider
// than FULL_WIDTH_FRACTION of the text are full-width lines (title, abstract) and
// stay out of the profile — they cross every gutter, and on arXiv page 1 they
// outnumber the column lines. The clusters still decide whether there are
// columns and how many; their centres only rank the valleys (a cluster mixing
// abstract and column starts drifted to x≈252, short of the 300–315 gutter).
// Returns null when fewer valleys than needed exist — the caller then keeps the
// midpoint boundaries it always used.
const GUTTER_MIN = 4;              // pt
const FULL_WIDTH_FRACTION = 0.6;
const VALLEY_FRACTION = 0.03;      // runs that may still cross a gutter (a rule, a stray glyph)
function gutterCuts(lines, count) {
  const end = it => it.x + (it.width > 0 ? it.width : 0);
  const runs = [];
  for (const ln of lines) {
    const items = (ln.items || []).filter(Boolean).sort((a, b) => a.x - b.x);
    let run = null;
    for (const it of items) {
      if (run && it.x - run[1] <= GAP_THRESHOLD) run[1] = Math.max(run[1], end(it));
      else { if (run) runs.push(run); run = [it.x, end(it)]; }
    }
    if (run) runs.push(run);
  }
  if (!runs.length) return null;
  const lo = Math.floor(Math.min(...runs.map(r => r[0]))), hi = Math.ceil(Math.max(...runs.map(r => r[1])));
  const narrow = runs.filter(r => r[1] - r[0] <= FULL_WIDTH_FRACTION * (hi - lo));
  const cover = new Uint16Array(hi - lo + 1);
  for (const [x0, x1] of narrow) for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) cover[x - lo]++;
  const allowed = Math.floor(narrow.length * VALLEY_FRACTION);
  const valleys = [];
  for (let i = 0, start = -1; i <= cover.length; i++) {
    const empty = i < cover.length && cover[i] <= allowed;
    if (empty && start < 0) start = i;
    if (!empty && start >= 0) {
      // interior valleys only: text on both sides, not the page margins
      if (start > 0 && i < cover.length && i - start >= GUTTER_MIN) valleys.push({ x: lo + start + (i - start) / 2, w: i - start });
      start = -1;
    }
  }
  if (valleys.length < count) return null;
  return valleys.sort((a, b) => b.w - a.w).slice(0, count).map(v => v.x).sort((a, b) => a - b);
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
  // Direction-aware detection is trusted only when it finds real gutters; any
  // other page gets exactly the detection it always had (left-edge starts,
  // midpoint boundaries). Mixed RTL pages (an infobox beside full-width text)
  // were never split before, and a midpoint cut there tore letter-by-letter
  // Arabic words apart (holdout corpus 2026-10-01: Wikipedia ar/fa recall −3%).
  const aware = _detectColumnRegions(lines, pageWidth, true);
  return aware?.[0].gutter ? aware : _detectColumnRegions(lines, pageWidth, false);
}

function _detectColumnRegions(lines, pageWidth, rtlAware) {
  if (lines.length < MIN_LINES_ABS * 2) return null; // too little content to judge at all

  const candidates = lines.flatMap(ln => lineRunStarts(ln, rtlAware).map(x => ({ x, y: ln.y })));
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
  //
  // Filtered through looksLikeProseNotData()/looksLikeEnumeratedList() —
  // the same two guards _processLines() (processor.js) already applies
  // before treating a detectTables() match as a real table — because a
  // genuine 2-column prose page (a newsletter, an academic paper) can align
  // just as consistently row-to-row as a real table when both columns'
  // paragraphs happen to run the same length for a stretch: measured
  // directly on a synthetic-but-realistic 2-column newsletter fixture
  // (varying paragraph lengths per column, a full-width heading — not a
  // pathologically uniform case) at 56% raw coverage, comfortably above
  // TABLE_GUARD_FRACTION, which silently discarded a real, correctly
  // detectable 2-column split and fell back to unsplit output — merged
  // rows of two independent columns read as scrambled, unreadable text
  // (confirmed both live against iLovePDF/Smallpdf, which correctly split
  // the identical fixture, and via a direct detectTables()/
  // looksLikeProseNotData() trace on the same extracted lines). Without
  // this filter, prose cells (multi-word sentences, no numeric anchor)
  // still counted toward "this is a table" evidence even though the exact
  // same rows would already be rejected as a real Table by the main
  // pipeline for the identical reason.
  const tableLineCount = detectTables(lines)
    .filter(t => !looksLikeProseNotData(t.rows) && !looksLikeEnumeratedList(t.rows))
    .reduce((n, t) => n + (t.endIdx - t.startIdx + 1), 0);
  if (tableLineCount >= lines.length * TABLE_GUARD_FRACTION) return null;

  // `gutter` marks a boundary that runs through real empty space — only those
  // may keep full-width lines whole (lineSpansRegions); midpoint boundaries keep
  // the per-item split they always had.
  const gutters = rtlAware ? gutterCuts(lines, real.length - 1) : null;
  const cuts = gutters ?? real.slice(1).map((c, idx) => (real[idx].center + c.center) / 2);
  return real.map((c, idx) => ({
    left:   idx === 0                ? 0          : cuts[idx - 1],
    right:  idx === real.length - 1  ? pageWidth  : cuts[idx],
    gutter: !!gutters,
  }));
}

/** Which region a bare X-coordinate falls into (last region if past the final boundary). */
export function regionIndexForX(x, regions) {
  for (let i = 0; i < regions.length; i++) {
    if (x >= regions[i].left && x < regions[i].right) return i;
  }
  return regions.length - 1;
}

/** Which region a line falls into, by its first item's X (its start in reading order). */
export function lineRegionIndex(line, regions) {
  if (!line.items || !line.items.length) return 0;
  return regionIndexForX(line.items[0].x, regions);
}

// A line whose text runs across a region boundary — text on both sides with no
// gutter-wide gap at it — is a full-width line (a title, an abstract, body text
// under an infobox), not two columns' lines that landed on one baseline. On a
// mixed page such lines were cut at the boundary mid-word (Wikipedia he/ar/fa,
// arXiv page 1 with a full-width title and abstract: 22–54% of the lines cross
// the cut vs 0–4% on real two-column pages). Recursive XY-cut never cuts through
// text either: a vertical cut runs only along empty space.
export function lineSpansRegions(line, regions) {
  const items = (line.items || []).filter(Boolean);
  for (const r of regions.slice(0, -1)) {
    if (!r.gutter) continue; // a midpoint boundary says nothing about empty space
    const b = r.right;
    const leftEnd = Math.max(-Infinity, ...items.filter(it => it.x < b).map(it => it.x + (it.width > 0 ? it.width : 0)));
    const rightStart = Math.min(Infinity, ...items.filter(it => it.x >= b).map(it => it.x));
    if (leftEnd > b || (Number.isFinite(leftEnd) && Number.isFinite(rightStart) && rightStart - leftEnd < GUTTER_MIN)) return true;
  }
  return false;
}

// The lines of region `idx`: a full-width line whole, in the region where it
// starts (left edge, or right edge for RTL — lineRegionIndex reads items[0], the
// line's first item in reading order); any other line cut to its items inside.
export function linesInRegion(lines, regions, idx) {
  const r = regions[idx];
  const out = [];
  for (const ln of lines) {
    if (lineSpansRegions(ln, regions)) {
      if (lineRegionIndex(ln, regions) === idx) out.push({ y: ln.y, rtl: ln.rtl, items: ln.items });
      continue;
    }
    const items = ln.items.filter(it => !!it && it.x >= r.left && it.x < r.right);
    // its own baseline, not the other column's (see _splitCrossColumnLines)
    if (items.length) out.push({ y: Math.max(...items.map(it => it.y)), rtl: ln.rtl, items });
  }
  return out;
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
