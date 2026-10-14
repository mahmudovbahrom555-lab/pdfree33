// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  blankPage.js — is a rendered page blank? For Extract's "Without blank
//  pages" preset (2026-10-14; BentoPDF/PDFCraft both offer "Remove blank
//  pages" — the leftovers of a duplex scan, separator sheets).
//
//  Judged on the picture, not the text layer: a scanned page has no text
//  at all, blank or not. Ink = clearly darker than the paper (the paper's
//  own brightness taken from the page itself, so a grey scan of a blank
//  sheet is still blank). A scan's edges — shadow of the lid, a dark strip
//  where the sheet ended — are left out.
//
//  Errs towards keeping a page: removing one that held anything loses it,
//  keeping a blank one costs a sheet. A page with only a page number or a
//  signature line is NOT blank — so the limit is a few pixels of ink on
//  the 200 px-wide render Extract makes, not a share of the page.
//  Measured on tests/fixtures/blank/mixed.pdf: a lone 12 pt page number is
//  5 px of ink at 200 px (0 at 60 px — too small to tell from dust), a
//  scanned blank sheet 0; a dust speck is 1–2 px.
// ============================================================

const EDGE = 0.03;          // share of width/height ignored on each side
const INK_BELOW_PAPER = 40; // gray levels darker than the paper to count as ink
const MAX_INK_PIXELS = 3;   // a speck of dust, not a mark

/**
 * @param {Uint8ClampedArray} data RGBA of the rendered page
 * @param {number} w
 * @param {number} h
 * @returns {boolean}
 */
export function isBlankPage(data, w, h) {
  const x0 = Math.floor(w * EDGE), x1 = Math.ceil(w * (1 - EDGE));
  const y0 = Math.floor(h * EDGE), y1 = Math.ceil(h * (1 - EDGE));
  const hist = new Uint32Array(256);
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      hist[Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])]++;
      n++;
    }
  }
  if (!n) return true;
  // the paper: the brightness most of the page has (its 90th percentile)
  let seen = 0, paper = 255;
  for (let g = 0; g < 256; g++) { seen += hist[g]; if (seen >= n * 0.9) { paper = g; break; } }
  let ink = 0;
  for (let g = 0; g < Math.max(0, paper - INK_BELOW_PAPER); g++) ink += hist[g];
  return ink <= MAX_INK_PIXELS;
}
