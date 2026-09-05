// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  pdf2readCore.js — Read PDF's extraction/reflow core, browser-independent
//
//  Moved out of processor.js so this logic can be reused outside the browser
//  tool (packages/pdf2read-core/, a standalone npm package/CLI/API) without
//  pulling in processor.js's own Worker orchestration / DOM progress+cancel
//  UI — same reasoning, same shape, as js/pdf2mdCore.js's own extraction
//  (see that file's header). Takes a plain pdf.js PDFDocumentProxy-shaped
//  object (NOT a browser File/Blob) — the caller (processor.js's
//  _runPdf2Word/_runPdf2Ppt, js/readUI.js in the browser, or
//  packages/pdf2read-core/src/index.js in Node) owns loading the PDF and
//  producing that object.
//
//  Browser-coupling is limited to 2 injectable seams on _p2wBuildPageData,
//  both optional, same no-op-by-default pattern pdf2mdCore.js's
//  _p2mdExtractText already established:
//    onProgress(pct, label)   — UI progress callback; no-op by default.
//    isCancelled()            — mid-run cancellation check; never-cancel default.
//  No canvasFactory seam is needed here (unlike pdf2mdCore.js) — this module
//  never renders a canvas itself. An `image`-type block from
//  _rpBuildRegionBlocks/_rpBuildPageBlocks carries only a bounding-box
//  (`region: {x0,x1,y0,y1}`), not pixel data — actual cropping is the
//  caller's job (processor.js's _p2pCropCanvasRegion + a real page.render()),
//  same as it already was before this extraction. In Node, callers that
//  don't crop simply get an image block with no picture — the same
//  graceful-degradation shape pdf2mdCore.js already uses for its own
//  no-canvas-in-Node case.
// ============================================================

import { detectTables, looksLikeProseNotData, looksLikeEnumeratedList } from './pdf2wordTables.js';
import { detectColumnRegions, pageIsRtl } from './pdf2wordColumns.js';
import { detectTableGrids } from './pdf2wordBorders.js';
import { BULLET_RE, NUMBERED_RE, LETTERED_RE, BOLD_FONT_NAME_RE, MONEY_TOKEN_RE,
         _visualRTLToLogical, _splitCrossColumnLines } from './textLayoutUtils.js';

// ── Small private helpers ────────────────────────────────────────────────
// Local copies, not imports — the originals in js/processor.js are still
// used by other, unrelated call sites there (pdf2word's own paragraph
// builder, pdf2ppt's slide builder, various other runners' yield-budget
// loops) and extracting THOSE out from under their own callers is a
// separate, larger refactor than this one. These are small, pure, and
// already stable — duplicating them here is a deliberate, bounded tradeoff,
// not an oversight. If one of these ever needs a real bug fix, both copies
// need it (js/processor.js's own copy, and this one).

const _normWatermark = t =>
  t.replace(/^(CamScanner)+$/i, 'CamScanner')
   .replace(/^[Cc][Ss]\]?$/, 'CamScanner')
   .replace(/^-$/, '');

const _normDigits = t => t.replace(/\d+/g, '#');

// rIC vs setTimeout(0): rIC yields at idle (better for the quiet case);
// Node/older browsers fall back to setTimeout(0), which always yields.
function _yieldToUI() {
  if (typeof requestIdleCallback === 'function') {
    return new Promise(r => requestIdleCallback(r, { timeout: 50 }));
  }
  return new Promise(r => setTimeout(r, 0));
}
const _FRAME_BUDGET_MS = 16; // ≈ one 60 FPS frame

// Maps a PDF's real embedded font name + pdf.js's generic CSS-fallback
// family to one of a small set of font names virtually every PowerPoint
// installation already has (see the original processor.js comment history
// for the competitor-verified gap this closed). Deliberately narrow
// (serif/mono only) — no attempt to preserve an exact embedded font name.
// Only caller is _p2wBuildPageData below — moved here in full, not copied
// (processor.js has no other use of it).
function _pptxSafeFontFace(rawName, cssFamily) {
  const s = `${rawName} ${cssFamily}`.toLowerCase();
  if (/mono|courier|consolas/.test(s)) return 'Courier New';
  if (!/sans/.test(s) && /serif|times|georgia|garamond|cambria|minion/.test(s)) return 'Times New Roman';
  return undefined;
}

// GRID_SLACK is intentionally small — see js/processor.js's own comment
// history on this constant for the real regression that shaped its value.
const GRID_SLACK = 2;

export function _assignLineToGridCols(items, colXs) {
  const colCount = colXs.length - 1;
  const cells = Array.from({ length: colCount }, () => []);
  for (const item of items) {
    let col = colCount - 1;
    for (let c = 0; c < colCount; c++) {
      if (item.x >= colXs[c] - GRID_SLACK && item.x < colXs[c + 1] + GRID_SLACK) { col = c; break; }
    }
    cells[col].push(item.str);
  }
  return cells.map(parts => parts.join(' '));
}

export function _assignLineToGridColsFonts(items, colXs) {
  const colCount = colXs.length - 1;
  const fonts = Array.from({ length: colCount }, () => undefined);
  for (const item of items) {
    let col = colCount - 1;
    for (let c = 0; c < colCount; c++) {
      if (item.x >= colXs[c] - GRID_SLACK && item.x < colXs[c + 1] + GRID_SLACK) { col = c; break; }
    }
    if (fonts[col] === undefined && item.fontFamily) fonts[col] = item.fontFamily;
  }
  return fonts;
}

export function _activeDividersForY(grid, y) {
  const { rowYs, colDividers } = grid;
  let top = rowYs[0], bottom = rowYs[rowYs.length - 1];
  for (let r = 0; r < rowYs.length - 1; r++) {
    if (y <= rowYs[r] + GRID_SLACK && y >= rowYs[r + 1] - GRID_SLACK) {
      top = rowYs[r]; bottom = rowYs[r + 1];
      break;
    }
  }
  const bandHeight = Math.max(1, top - bottom);
  return colDividers.map(d => {
    const covered = d.spans.reduce((sum, [a, b]) =>
      sum + Math.max(0, Math.min(b, top) - Math.max(a, bottom)), 0);
    return covered >= bandHeight * 0.5;
  });
}

export function _groupGridCellsWithSpans(rawCells, activeDividers, mergeFn, emptyValue) {
  const join  = mergeFn ?? ((a, b) => [a, b].filter(Boolean).join(' '));
  const empty = arguments.length >= 4 ? emptyValue : '';
  const out = [];
  let buf = rawCells[0] ?? empty;
  let span = 1;
  for (let i = 0; i < activeDividers.length; i++) {
    if (activeDividers[i]) {
      out.push({ text: buf, span });
      buf = rawCells[i + 1] ?? empty;
      span = 1;
    } else {
      buf = join(buf, rawCells[i + 1] ?? empty);
      span++;
    }
  }
  out.push({ text: buf, span });
  return out;
}

// A line whose non-space characters are mostly Unicode Private-Use-Area
// glyphs (the range LaTeX/PDF math fonts inject for symbols that never
// round-trip to real Unicode text) can't be rendered as text at all — it
// would show up as garbled tofu. Routed to an image block instead of real
// equation OCR (out of scope for v1); cheap insurance, not full math support.
const _PUA_RE = /[-\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;
function _isMostlyPUA(str) {
  const nonSpace = str.replace(/\s/g, '');
  if (!nonSpace) return false;
  return (nonSpace.match(_PUA_RE) || []).length / nonSpace.length > 0.4;
}

// Read-mode's per-region block builder — same dispatch shape as
// _p2pBuildRegionShapes (mirrors its table/list/heading/footer-suppression
// heuristics exactly, reusing the same detectors), but emits a flat, ordered
// array of plain reading blocks instead of PPTX shapes with absolute x/y.
// Paragraph text is joined across all of a buffered block's ORIGINAL lines
// into one continuous string (not one block per original line) — a PDF's own
// line breaks are just where the fixed-width source column happened to wrap,
// not real paragraph breaks, and preserving them would defeat the point of a
// reflowing view.
function _rpBuildRegionBlocks(lines, borderGrids, xBounds, median, repeatTextSet, repeatPatternSet) {
  const tables = detectTables(lines)
    .filter(t => !looksLikeProseNotData(t.rows) && !looksLikeEnumeratedList(t.rows))
    .filter(t => {
      const tMinY = Math.min(lines[t.startIdx].y, lines[t.endIdx].y);
      const tMaxY = Math.max(lines[t.startIdx].y, lines[t.endIdx].y);
      return !borderGrids.some(g => tMinY <= g.y + g.h && g.y <= tMaxY);
    });
  const lineToTable = new Map();
  for (const t of tables) {
    for (let li = t.startIdx; li <= t.endIdx; li++) lineToTable.set(li, t);
  }

  const blocks = [];
  const gridConsumedLines = new Set();

  for (const grid of borderGrids) {
    const gridLines = [];
    for (let li = 0; li < lines.length; li++) {
      if (lineToTable.has(li)) continue;
      const ln = lines[li];
      if (ln.y >= grid.y - 4 && ln.y <= grid.y + grid.h + 4) gridLines.push({ li, ln });
    }
    if (!gridLines.length) continue;
    gridLines.sort((a, b) => b.ln.y - a.ln.y);

    const rows = gridLines.map(({ ln }, idx) => {
      const rawCells      = _assignLineToGridCols(ln.items, grid.colXs);
      const rawFonts      = _assignLineToGridColsFonts(ln.items, grid.colXs);
      const activeDivider = _activeDividersForY(grid, ln.y);
      const cellGroups    = _groupGridCellsWithSpans(rawCells, activeDivider);
      const fontGroups    = _groupGridCellsWithSpans(rawFonts, activeDivider, (a, b) => a ?? b, undefined);
      return cellGroups.map(({ text, span }, ci) => ({ text, span, bold: idx === 0, fontFace: fontGroups[ci]?.text }));
    });
    for (const { li } of gridLines) gridConsumedLines.add(li);
    blocks.push({ type: 'table', rows, y: grid.y });
  }

  let pageBaselineX = 0;
  {
    const xFreq = new Map();
    for (const ln of lines) {
      const x = ln.items[0]?.x;
      if (x === undefined) continue;
      const rounded = Math.round(x);
      xFreq.set(rounded, (xFreq.get(rounded) || 0) + 1);
    }
    let bestCount = 0;
    for (const [x, count] of xFreq) if (count > bestCount) { bestCount = count; pageBaselineX = x; }
  }

  const _isBoldHeadingLine = (items) => {
    if (!items.every(i => i.bold)) return false;
    const text = items.map(i => i.str).join('');
    if (MONEY_TOKEN_RE.test(text)) return false;
    const len = text.replace(/\s+/g, '').length;
    return len > 3 && len <= 100;
  };

  // Deliberately NOT porting _p2pBuildRegionShapes's gap-based visual-region
  // detection here. That heuristic fits an absolute-positioned slide/page —
  // an image crop and any nearby caption text can coexist as two separate
  // overlaid shapes without looking wrong. In a flowing reading view the
  // same gap would produce an image block AND the caption text rendering
  // again as its own paragraph right next to it — confirmed via a real
  // Playwright screenshot during this feature's own build: a small,
  // low-value image crop sat directly above the identical caption text,
  // and an ordinary bold-but-same-size sub-heading with generous spacing
  // (common in real documents, not just this test fixture) produced a
  // false-positive near-blank image block, since the heading-sized guard
  // only protects LARGER-font headings, not bold same-size ones. A real
  // diagram/photo simply has no picture in this v1 — its caption/surrounding
  // text still reads fine, which is an honest, disclosed limitation rather
  // than a broken-looking duplicate. The PUA-character guard above (for
  // formula-heavy lines specifically) stays — narrower, precise, and
  // verified not to have this failure mode.

  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    if (buffer.length === 1) {
      const raw = buffer[0].items.map(i => i.str).join('').trim();
      const t   = _normWatermark(raw);
      if (t === '' || repeatTextSet.has(t) || repeatPatternSet.has(_normDigits(t))) { buffer = []; return; }
    }
    const allItems = buffer.flatMap(ln => ln.items);
    const allText  = allItems.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
    if (!allText) { buffer = []; return; }
    const maxSize = Math.max(...allItems.map(i => i.fontSize));

    let heading = false;
    if (allText.length > 3) {
      if (maxSize >= median * 1.3) heading = true;
      else if (allText.length <= 100 && buffer.every(ln => _isBoldHeadingLine(ln.items))) heading = true;
    }

    blocks.push({
      type: heading ? 'heading' : 'paragraph',
      text: allText,
      bold: allItems.every(i => i.bold),
      italic: allItems.every(i => i.italic),
      fontFace: allItems.find(i => i.fontFamily)?.fontFamily,
      y: Math.max(...buffer.map(ln => ln.y)),
    });
    buffer = [];
  };

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const ln = lines[lineIdx];
    if (gridConsumedLines.has(lineIdx)) continue;
    const tbl = lineToTable.get(lineIdx);
    if (tbl) {
      flush();
      if (lineIdx === tbl.startIdx) {
        blocks.push({
          type: 'table',
          rows: tbl.rows.map((row, ri) => row.map((text, ci) => ({
            text: text || '', span: 1, bold: false, fontFace: tbl.cellFonts?.[ri]?.[ci],
          }))),
          y: Math.max(...lines.slice(tbl.startIdx, tbl.endIdx + 1).map(l => l.y)),
        });
      }
      continue;
    }

    const nearEdge = lineIdx < 3 || lineIdx >= lines.length - 3;
    if (nearEdge) {
      const raw = ln.items.map(i => i.str).join('').trim();
      if (/^\d+$/.test(raw) || repeatPatternSet.has(_normDigits(_normWatermark(raw)))) continue;
    }

    const lnRawText = ln.items.map(i => i.str).join('').trim();

    // PUA guard — a formula-heavy line can't be rendered as text at all.
    // Flush whatever body text was buffered first, emit this line as its
    // own image block (bbox = the line's own extent), then move on.
    if (_isMostlyPUA(lnRawText)) {
      flush();
      const xs = ln.items.map(i => i.x);
      const maxFont = Math.max(...ln.items.map(i => i.fontSize));
      blocks.push({
        type: 'image',
        region: { x0: Math.min(...xs), x1: Math.max(...xs) + maxFont * 4, y0: ln.y + maxFont, y1: ln.y - maxFont * 0.3 },
        y: ln.y,
      });
      continue;
    }

    const bulletMatch   = BULLET_RE.test(lnRawText);
    const numberedMatch = !bulletMatch && NUMBERED_RE.test(lnRawText);
    const letteredMatch = !bulletMatch && !numberedMatch && LETTERED_RE.test(lnRawText) &&
      (ln.items[0]?.x ?? 0) > pageBaselineX + 10;

    if (bulletMatch || letteredMatch || numberedMatch) {
      flush();
      // Numbered items keep their own marker text ("1.", "2.5.1.") — real
      // sequence information a reading view shouldn't discard (unlike PPTX,
      // there's no per-block auto-numbering container here to rebuild it
      // from). Bullet/lettered markers carry no sequence meaning, so they're
      // stripped and rendered via the list-item's own CSS bullet instead —
      // same "lettered sub-items render as bullet-style" convention pdf2ppt
      // already established.
      const text = numberedMatch ? lnRawText.trim() : lnRawText.replace(bulletMatch ? BULLET_RE : LETTERED_RE, '').trim();
      if (text) {
        blocks.push({
          type: 'list-item',
          ordinal: numberedMatch ? 'number' : 'bullet',
          text,
          bold: ln.items.every(i => i.bold),
          italic: ln.items.every(i => i.italic),
          fontFace: ln.items.find(i => i.fontFamily)?.fontFamily,
          y: ln.y,
        });
      }
      continue;
    }

    if (buffer.length > 0) {
      const lastLn      = buffer[buffer.length - 1];
      const lastMaxFont = Math.max(...lastLn.items.map(i => i.fontSize));
      const curMaxFont  = Math.max(...ln.items.map(i => i.fontSize));
      const gap         = lastLn.y - ln.y;
      const lastIsHead  = lastMaxFont >= median * 1.3 || _isBoldHeadingLine(lastLn.items);
      const isHead      = curMaxFont  >= median * 1.3 || _isBoldHeadingLine(ln.items);
      if (isHead || lastIsHead || gap > lastMaxFont * 2.0) flush();
    }
    buffer.push(ln);
  }
  flush();

  // Reading order within a region is top-to-bottom by each block's own Y
  // (grid-tables and the main line walk build blocks in different, already
  // top-first passes — sorting once here by descending Y, PDF's own
  // bottom-to-top axis, gives one final consistent order regardless of
  // which pass produced each block).
  blocks.sort((a, b) => b.y - a.y);
  return blocks;
}

// Read-mode's outer dispatcher — same column/straddle-guard shape as
// _p2pBuildSlideShapes, but concatenates each region's blocks in region
// order (not absolute-position shapes) since a reading view has no
// "canvas" to place shapes on, only a reading sequence.
export function _rpBuildPageBlocks(page, median, repeatTextSet, repeatPatternSet) {
  const { lines, pageW, pageH, borderGrids = [] } = page;
  if (!lines.length) return { blocks: [], scanned: true };

  const regions = pageW ? detectColumnRegions(lines, pageW) : null;
  const splittable = regions && !borderGrids.some(g =>
    regions.filter(r => g.x < r.right && (g.x + g.w) > r.left).length > 1
  );

  if (!splittable) {
    if (regions) {
      // A grid/table straddles a column boundary — can't split cleanly.
      // Whole page becomes one image block rather than mangling it.
      return { blocks: [{ type: 'image', region: { x0: 0, x1: pageW, y0: pageH, y1: 0 }, y: pageH }], scanned: false };
    }
    return { blocks: _rpBuildRegionBlocks(lines, borderGrids, { x0: 0, x1: pageW }, median, repeatTextSet, repeatPatternSet), scanned: false };
  }

  const ordered = pageIsRtl(lines) ? [...regions].reverse() : regions;
  const blocks = [];
  for (const region of ordered) {
    const inRegion = (it) => !!it && it.x >= region.left && it.x < region.right;
    const regionLines = lines
      .map(ln => ({ y: ln.y, items: ln.items.filter(inRegion) }))
      .filter(ln => ln.items.length);
    const regionGrids = borderGrids.filter(g => g.x >= region.left && (g.x + g.w) <= region.right);
    blocks.push(..._rpBuildRegionBlocks(regionLines, regionGrids, { x0: region.left, x1: region.right }, median, repeatTextSet, repeatPatternSet));
  }
  return { blocks, scanned: false };
}

// ── Page-data extraction (pdf.js → lines/items) ─────────────────────────
export async function _p2wBuildPageData(pdfDoc, { onProgress = () => {}, isCancelled = () => false } = {}) {
  const YTOL = 6;   // px — items within 6px on Y → same line (was 4; increased to group
                   //  characters with slight baseline variation, e.g. Cyrillic in some PDFs)

  // ── Pass 1: collect all items + compute global median font size ────────────
  const pageData = [];
  const allSizes = [];

  // Confidence stats — accumulated across both passes
  const _cs = {
    totalPages:         pdfDoc.numPages,
    fullPageFallbacks:  0,   // pages with no text layer (scanned)
    totalLines:         0,
    rtlLines:           0,
    mathChars:          0,
    totalChars:         0,
    totalTables:        0,   // filled in Pass 2
    totalGapVisuals:    0,   // filled in Pass 2
    totalInlineVisuals: 0,   // filled in Pass 2
  };

  let frameStart = performance.now();   // tracks time since last yield — same idiom as _runPdf2Jpg
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    if (isCancelled()) break;
    onProgress(10 + Math.round((p / pdfDoc.numPages) * 40),
               `Reading page ${p}/${pdfDoc.numPages}…`);

    const page    = await pdfDoc.getPage(p);
    const vp1     = page.getViewport({ scale: 1 });
    const pageH   = vp1.height;
    const pageW   = vp1.width;
    // getOperatorList() runs alongside the other two purely to force pdf.js to
    // resolve font objects into page.commonObjs — getTextContent() alone never
    // does, and without it every font's style below reports a generic CSS
    // fallback family ("sans-serif") instead of the real embedded name, so
    // bold detection silently fails on any PDF whose fonts pdf.js can't map
    // to a known family (confirmed on a real contract where headings were
    // same-size-but-bold: content.styles[...].fontFamily was "sans-serif" for
    // BOTH the bold title and regular body text — indistinguishable — while
    // page.commonObjs.get(fontName).name correctly gave
    // "CAAAAA+NotoSans-Bold" vs "DAAAAA+NotoSans-Regular").
    const [content, borderGrids] = await Promise.all([
      page.getTextContent({ normalizeWhitespace: false }),
      detectTableGrids(page).catch(() => []),
      page.getOperatorList().catch(() => {}),
    ]);
    const _boldFontCache = new Map(); // fontName -> boolean, one commonObjs lookup per unique font per page
    const _isFontBold = fontName => {
      if (_boldFontCache.has(fontName)) return _boldFontCache.get(fontName);
      let bold = false;
      try {
        bold = BOLD_FONT_NAME_RE.test(page.commonObjs.get(fontName)?.name || '');
      } catch { /* font object failed to resolve — fall through to false */ }
      _boldFontCache.set(fontName, bold);
      return bold;
    };
    // Real embedded font name (e.g. "Times-Roman", "CAAAAA+NotoSans-Bold") —
    // a much stronger signal than pdf.js's own style.fontFamily, which is
    // usually just a generic CSS fallback ("serif"/"sans-serif"/"monospace"),
    // not the actual typeface. Cached per unique font per page, same idiom
    // as _isFontBold above (one commonObjs lookup, not one per item).
    const _rawNameCache = new Map();
    const _rawFontName = fontName => {
      if (_rawNameCache.has(fontName)) return _rawNameCache.get(fontName);
      let name = '';
      try { name = page.commonObjs.get(fontName)?.name || ''; } catch { /* unresolved font object */ }
      _rawNameCache.set(fontName, name);
      return name;
    };
    const allMapped = content.items
      .filter(item => 'str' in item && item.str.split(' ').join('').trim())
      .map(item => {
        const fontSize  = (item.height > 0 ? item.height : Math.abs(item.transform[3])) || 10;
        const style     = content.styles[item.fontName] || {};
        const fam       = (style.fontFamily || '').toLowerCase();
        // Rotation detected when b-component dominates a-component in the transform matrix.
        // Normal text: [a≈size, b≈0, …]. Rotated 90°: [a≈0, b≈size, …].
        const isRotated = Math.abs(item.transform[1]) > Math.abs(item.transform[0]) * 0.5;
        // pdf.js returns dir:'rtl' items in visual (left-to-right screen) order.
        // _visualRTLToLogical restores Unicode logical order while preserving embedded
        // LTR words (plain reverse() would corrupt e.g. "(Arabic)" → "(cibarA)").
        // Strip NUL bytes produced by fonts without ToUnicode CMap — they corrupt DOCX XML.
        const str = ((item.dir === 'rtl') ? _visualRTLToLogical(item.str) : item.str)
          .split(' ').join('');
        return {
          str,
          x:        item.transform[4],
          y:        item.transform[5],
          width:    item.width || 0,
          fontSize,
          rotated:  isRotated,
          bold:     _isFontBold(item.fontName) || BOLD_FONT_NAME_RE.test(fam),
          italic:   /italic|oblique/.test(fam),
          fontFamily: _pptxSafeFontFace(_rawFontName(item.fontName), fam),
        };
      });

    // Rotated items (vertical column headers in tables) are processed separately
    // so they don't pollute normal line-grouping.
    const items        = allMapped.filter(i => !i.rotated);
    const rotatedItems = allMapped.filter(i =>  i.rotated);

    // Group normal items into lines
    const lines = [];
    for (const item of [...items].sort((a, b) => b.y - a.y)) {
      let merged = false;
      for (const ln of lines) {
        if (Math.abs(ln.y - item.y) <= YTOL) { ln.items.push(item); merged = true; break; }
      }
      if (!merged) lines.push({ y: item.y, items: [item] });
    }
    lines.forEach(ln => {
      const txt    = ln.items.map(i => i.str).join('');
      const rtlCnt = (txt.match(/[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\uFB1D-\uFB4F\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
      ln.rtl = rtlCnt > 0;  // any RTL chars -> paragraph gets <w:bidi/>
      // RTL lines: keep pdf.js content-stream order (logical Unicode order for well-formed PDFs).
      // Sorting by X would reverse word order on pure-Arabic lines and break mixed
      // lines like "Arabic (العربية)" where LTR words have lower X than RTL words.
      // Word's built-in BiDi algorithm handles display when bidirectional:true is set.
      if (rtlCnt === 0) ln.items.sort((a, b) => a.x - b.x);
    });

    // Column-aware line re-splitting — see _splitCrossColumnLines() below
    // for why this has to happen here, before anything else touches `lines`.
    _splitCrossColumnLines(lines, pageW);

    allSizes.push(...items.map(i => i.fontSize).filter(s => s > 0));
    pageData.push({ lines, rotatedItems, borderGrids, pageH, pageW, items });

    // Accumulate confidence stats from this page
    _cs.totalLines += lines.length;
    _cs.rtlLines   += lines.filter(ln => ln.rtl).length;
    if (!lines.length) _cs.fullPageFallbacks++;
    for (const item of items) {
      const s = item.str;
      _cs.totalChars += s.length;
      // Math Unicode blocks: operators (2200-22FF), arrows (2190-21FF),
      // letterlike (2100-214F), Greek (0370-03FF as formula proxy)
      for (const ch of s) {
        const cp = ch.codePointAt(0);
        if ((cp >= 0x2190 && cp <= 0x22FF) || (cp >= 0x2100 && cp <= 0x214F) ||
            (cp >= 0x0370 && cp <= 0x03FF)) _cs.mathChars++;
      }
    }

    page.cleanup?.();

    // No yield point existed anywhere in this loop before — a real user
    // report (413.5ms max single-frame gap on a 25-page table-heavy PDF,
    // measured with 4x CPU throttle) traced back to this being the one
    // remaining unchunked per-page loop in the whole pdf2word/pdf2excel
    // family. Same budget-checked yield idiom _runPdf2Jpg already uses —
    // caps the worst single frame gap at roughly "one page's cost" instead
    // of "the whole document's cost", without moving any code off-thread.
    const now = performance.now();
    if (now - frameStart >= _FRAME_BUDGET_MS) {
      await _yieldToUI();
      frameStart = performance.now();
    }
  }

  const sorted = [...allSizes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 10;

  // ── Post-Pass-1: Uzbek CamScanner OCR normalization ───────────────────────
  // CamScanner's OCR maps the Uzbek modifier letters oʻ (U+02BB) and gʻ to
  // the byte sequence that pdf.js decodes as "oâ" / "gâ".
  // We fix this ONLY when the document is detected as Uzbek OCR:
  //   ratio = count(oâ | gâ | Oâ | Gâ) / count(all â) > 0.75
  // This keeps French/Portuguese/Romanian/Vietnamese â intact — in those
  // languages â appears after many letters (b, c, ch, t, m, p…), so the
  // oâ+gâ ratio stays well below 0.75.
  {
    let totalAcirc = 0, uzbekAcirc = 0;
    for (const { lines } of pageData) {
      for (const ln of lines) {
        for (const item of ln.items) {
          const all  = (item.str.match(/â/g)       || []).length;
          const uz   = (item.str.match(/[oOgG]â/g) || []).length;
          totalAcirc += all;
          uzbekAcirc += uz;
        }
      }
    }
    if (totalAcirc >= 3 && uzbekAcirc / totalAcirc > 0.75) {
      for (const { lines } of pageData) {
        for (const ln of lines) {
          for (const item of ln.items) {
            item.str = item.str
              .replace(/oâ/g, 'oʻ').replace(/Oâ/g, 'Oʻ')
              .replace(/gâ/g, 'gʻ').replace(/Gâ/g, 'Gʻ');
          }
        }
      }
    }
  }

  // ── Post-Pass-1: build watermark filter ───────────────────────────────────
  // Short text appearing on ≥ ⅔ of pages (min 3) is treated as a repeated
  // watermark / header / footer and suppressed in output.
  const _repeatTextSet = new Set();
  {
    const freq = new Map();   // lineText → number of pages it appears on
    for (const { lines } of pageData) {
      const seenOnPage = new Set();
      for (const ln of lines) {
        const raw = ln.items.map(i => i.str).join('').trim();
        const t   = _normWatermark(raw);
        if (t.length > 0 && t.length <= 60 && !seenOnPage.has(t)) {
          seenOnPage.add(t);
          freq.set(t, (freq.get(t) || 0) + 1);
        }
      }
    }
    // Text must appear on ≥ ⅔ of pages (min 3) to be treated as a watermark.
    // Using ⅓ was too aggressive: on a 9-page doc a heading on 3 pages (33%)
    // would be suppressed. ⅔ preserves legitimate section titles that happen to
    // repeat while still catching CamScanner stamps (100% frequency).
    const minPages = Math.max(3, Math.ceil(pageData.length * 2 / 3));
    for (const [t, cnt] of freq) {
      // Never suppress pure integers — those are handled separately as page numbers
      if (cnt >= minPages && !/^\d+$/.test(t)) _repeatTextSet.add(t);
    }
  }

  // ── Post-Pass-1: build page-number PATTERN filter ─────────────────────────
  // A variable page-number footer/header ("Page 1 of 4", "Page 2 of 4", ...,
  // "1/4", "- 4 -") differs per page by design, so it never matches the
  // exact-string _repeatTextSet above and used to leak into the body as its
  // own paragraph on every page (real, competitor-verified gap — iLovePDF
  // and Smallpdf both strip this). Digit-normalizing ("Page # of #") lets
  // the same cross-page-repetition idea catch it, restricted to lines near
  // the top or bottom of the page (first/last 3 lines by index — same
  // position proxy the bare-integer page-number skip below already uses)
  // so a real recurring heading with a changing number ("Q1 Results" / "Q2
  // Results" as a body section title) is never at risk: it would digit-
  // normalize to the same pattern too, but sits in the body, not the edge.
  const _repeatPatternSet = new Set();
  {
    const freq = new Map(); // digit-normalized pattern -> number of pages it appeared on (edge lines only)
    for (const { lines } of pageData) {
      const seenOnPage = new Set();
      const edgeIdxs = new Set([
        ...lines.slice(0, 3).map((_, i) => i),
        ...lines.slice(-3).map((_, i) => lines.length - 3 + i),
      ]);
      for (const idx of edgeIdxs) {
        const ln  = lines[idx];
        if (!ln) continue;
        const raw = ln.items.map(i => i.str).join('').trim();
        const t   = _normWatermark(raw);
        if (!t || t.length > 60) continue;
        const pattern = _normDigits(t);
        if (pattern === t) continue; // no digits at all — _repeatTextSet above already covers this
        if (!seenOnPage.has(pattern)) {
          seenOnPage.add(pattern);
          freq.set(pattern, (freq.get(pattern) || 0) + 1);
        }
      }
    }
    const minPages = Math.max(3, Math.ceil(pageData.length * 2 / 3));
    for (const [pattern, cnt] of freq) {
      if (cnt >= minPages) _repeatPatternSet.add(pattern);
    }
  }

  return { pageData, median, repeatTextSet: _repeatTextSet, repeatPatternSet: _repeatPatternSet, cs: _cs };
}
