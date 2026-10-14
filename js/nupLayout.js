// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  nupLayout.js — the geometry of "pages per sheet" (N-up), no PDF
//  library and no DOM: which source page goes where on which sheet.
//  js/nupWorker.js draws it with pdf-lib; js/nupUI.js previews it.
//
//  Why the tool exists: on-site searches that found nothing — "Put
//  multiple pages on one page", "combine every two pages in one",
//  "QUATRO", "Booklet", "Make into a book" — and the Chinese office chore of printing e-invoices two
//  or four to an A4 sheet (发票合并打印) (Analytics Engine, 2026-10-13).
//
//  A plain script, like pdfEncrypt.js: importScripts() in the worker,
//  `import` in the page and in tests — both find it on self.NupLayout.
// ============================================================

(function () {
  // PDF points; the same A4/Letter/A3 values as resizeWorker.js.
  const PAPER = {
    a4:     [595.28, 841.89],
    a3:     [841.89, 1190.55],
    letter: [612, 792],
  };
  // A grid's two sides; each is tried both ways (2 = 1×2 or 2×1).
  const GRID = { 2: [1, 2], 4: [2, 2], 6: [2, 3], 9: [3, 3], 16: [4, 4] };

  // A page as it shows: /Rotate 90 or 270 swaps its sides.
  function shownSize(page) {
    return page.rotate % 180 ? [page.height, page.width] : [page.width, page.height];
  }

  function pageScale(page, cellW, cellH, maxScale) {
    const [w, h] = shownSize(page);
    return Math.min(maxScale, cellW / w, cellH / h);
  }

  // Sheet orientation and grid: every combination allowed, the one whose
  // smallest page comes out largest — then, on a tie, the largest on
  // average. Choosing orientation by the pages' own shape got the commonest
  // case wrong — two portrait pages stacked on a portrait sheet at ~50 %,
  // where side by side on a landscape one they print at ~70 %; and one
  // landscape page among portrait ones tied both ways on the smallest and
  // stacked them all.
  function chooseSheet(pages, opts) {
    const [a, b] = opts.booklet ? [1, 2] : GRID[opts.perSheet];
    const [shortSide, longSide] = [...PAPER[opts.paper]].sort((x, y) => x - y);
    const orientations = opts.orientation === 'auto' ? ['portrait', 'landscape'] : [opts.orientation];
    let best = null;
    for (const orientation of orientations) {
      const [sheetW, sheetH] = orientation === 'portrait' ? [shortSide, longSide] : [longSide, shortSide];
      // a booklet folds down the middle: always two pages side by side
      for (const [rows, cols] of a === b || opts.booklet ? [[a, b]] : [[a, b], [b, a]]) {
        const cellW = (sheetW - opts.marginLeft - opts.margin - (cols - 1) * opts.gutter) / cols;
        const cellH = (sheetH - 2 * opts.margin - (rows - 1) * opts.gutter) / rows;
        if (cellW <= 0 || cellH <= 0) continue;
        const scales = pages.map(p => pageScale(p, cellW, cellH, opts.maxScale));
        const score = Math.min(...scales), mean = scales.reduce((a, v) => a + v, 0) / scales.length;
        if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && mean > best.mean + 1e-9)) {
          best = { score, mean, sheetW, sheetH, rows, cols, cellW, cellH };
        }
      }
    }
    if (!best) throw new Error('NUP_NO_ROOM');
    return best;
  }

  // Slot → [row, col], rows counted from the top. 'column' fills down
  // first; rtl mirrors the columns (Arabic, Persian, Hebrew read right to
  // left, and so do their page sequences).
  function slotCell(slot, rows, cols, order, rtl) {
    let row, col;
    if (order === 'column') { col = Math.floor(slot / rows); row = slot % rows; }
    else                    { row = Math.floor(slot / cols); col = slot % cols; }
    return [row, rtl ? cols - 1 - col : col];
  }

  // Booklet (saddle stitch): pages padded with blanks to a multiple of 4;
  // each sheet of paper holds 4 pages, two on each side, so that the
  // printed stack — double-sided, flipped on the short edge — folded in
  // the middle reads 1, 2, 3… Side by side, [left, right] for a left-bound
  // book: sheet s front [n−1−2s, 2s], back [2s+1, n−2−2s]. A right-bound
  // book (Arabic, Persian, Hebrew) is the same mirrored — slotCell's rtl.
  // null = a blank page.
  function bookletSides(count) {
    const n = Math.ceil(count / 4) * 4;
    const page = i => (i < count ? i : null);
    const sides = [];
    for (let s = 0; s < n / 4; s++) {
      sides.push([page(n - 1 - 2 * s), page(2 * s)]);
      sides.push([page(2 * s + 1), page(n - 2 - 2 * s)]);
    }
    return sides;
  }

  // pdf-lib's drawPage() draws the page's own (unrotated) content and
  // rotates it counter-clockwise about its bottom-left corner. For a page
  // shown at /Rotate r (clockwise), the content turns by −r, and that
  // corner moves so the turned page fills its box.
  function drawSpec(box, page, scale) {
    const w = page.width * scale, h = page.height * scale;
    const r = ((page.rotate % 360) + 360) % 360;
    if (r === 90)  return { x: box.x,         y: box.y + box.h, width: w, height: h, rotate: -90 };
    if (r === 180) return { x: box.x + box.w, y: box.y + box.h, width: w, height: h, rotate: -180 };
    if (r === 270) return { x: box.x + box.w, y: box.y,         width: w, height: h, rotate: -270 };
    return { x: box.x, y: box.y, width: w, height: h, rotate: 0 };
  }

  /**
   * pages: [{ width, height, rotate }] in reading order (CropBox size, the
   *   page's /Rotate in degrees).
   * opts: perSheet 2|4|6|9|16, paper 'a4'|'a3'|'letter', orientation
   *   'auto'|'portrait'|'landscape', order 'row'|'column', rtl, margin and
   *   gutter in pt, marginLeft (pt; a binding edge — defaults to margin),
   *   maxScale (1 = never enlarge; Infinity = fill the cell), booklet
   *   (true: perSheet and order are ignored, see bookletSides()).
   * → { width, height, rows, cols, sheets: [[{ page, box, draw }]] }
   *   (a booklet's blank pages are simply absent from their side):
   *   box — where the page shows (bottom-left origin, pt); draw — what to
   *   pass to pdf-lib's drawPage() for it.
   */
  function layout(pages, options) {
    const opts = {
      orientation: 'auto', order: 'row', rtl: false, margin: 18, gutter: 8, maxScale: Infinity,
      ...options,
    };
    if (!opts.booklet && !GRID[opts.perSheet]) throw new Error('NUP_BAD_GRID');
    if (!PAPER[opts.paper]) throw new Error('NUP_BAD_PAPER');
    if (!pages.length) throw new Error('NUP_NO_PAGES');
    if (opts.marginLeft == null) opts.marginLeft = opts.margin;

    const sheet = chooseSheet(pages, opts);
    const { rows, cols, cellW, cellH, sheetH } = sheet;
    // the page indexes on each sheet (side), slot by slot
    const order = [];
    if (opts.booklet) order.push(...bookletSides(pages.length));
    else for (let first = 0; first < pages.length; first += opts.perSheet) {
      order.push([...pages.keys()].slice(first, first + opts.perSheet));
    }
    const sheets = order.map(indexes => {
      const placed = [];
      indexes.forEach((index, slot) => {
        if (index == null) return;
        const page = pages[index];
        const [row, col] = slotCell(slot, rows, cols, opts.order, opts.rtl);
        const scale = pageScale(page, cellW, cellH, opts.maxScale);
        const [shownW, shownH] = shownSize(page).map(v => v * scale);
        const cellX = opts.marginLeft + col * (cellW + opts.gutter);
        const cellY = sheetH - opts.margin - (row + 1) * cellH - row * opts.gutter;
        // a booklet's pages meet at the fold; elsewhere centered in the cell
        const x = !opts.booklet ? cellX + (cellW - shownW) / 2 : col === 0 ? cellX + cellW - shownW : cellX;
        const box = { x, y: cellY + (cellH - shownH) / 2, w: shownW, h: shownH };
        placed.push({ page: index, box, draw: drawSpec(box, page, scale) });
      });
      return placed;
    });
    return { width: sheet.sheetW, height: sheet.sheetH, rows, cols, sheets };
  }

  const NupLayout = { PAPER, GRID, layout };
  if (typeof self !== 'undefined') self.NupLayout = NupLayout;
})();
