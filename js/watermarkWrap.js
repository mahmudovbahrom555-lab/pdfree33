// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  watermarkWrap.js — a watermark too long for the page goes onto more
//  lines (owner, 2026-11-24: "Shukurov Murod Akbaraliyevich" as a
//  personalized watermark ran off the page).
//
//  One file for both sides: the preview (watermarkUI.js imports it) and the
//  PDF (watermarkTextWorker.js, a classic worker, loads it with
//  importScripts). So it has no import/export — it sets globals.
//
//  Not for the tile position: a tile repeats the text on purpose.
// ============================================================

(function () {
  const MARGIN = 36;        // pt kept clear of the page edge
  const MAX_LINES = 3;
  const LINE_HEIGHT = 1.2;
  const MIN_SIZE = 8;

  // How wide a line may be on a page, for text turned by `deg` degrees and
  // centred: its run along the turned direction must stay inside the page.
  function maxLineWidth(pageWidth, pageHeight, deg) {
    const a = Math.abs(deg % 180) * Math.PI / 180;
    const cos = Math.abs(Math.cos(a)), sin = Math.abs(Math.sin(a));
    const w = pageWidth - 2 * MARGIN, h = pageHeight - 2 * MARGIN;
    const byW = cos > 1e-3 ? w / cos : Infinity;
    const byH = sin > 1e-3 ? h / sin : Infinity;
    return Math.max(40, Math.min(byW, byH));
  }

  function greedy(words, size, width, maxWidth) {
    const lines = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (!line || width(next) * size <= maxWidth) line = next;
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
    return lines;
  }

  // text, width(s) = the string's width at size 1, the wanted size →
  // { lines, size }: the text on as few lines as fit (at most 3), at the
  // wanted size; smaller only when a single word, or 3 lines, can't fit.
  function wrapWatermark(text, width, size, maxWidth) {
    if (width(text) * size <= maxWidth) return { lines: [text], size };
    const words = text.split(/\s+/).filter(Boolean);
    for (let s = size; s >= MIN_SIZE; s *= 0.9) {
      const lines = greedy(words, s, width, maxWidth);
      if (lines.length <= MAX_LINES && lines.every(l => width(l) * s <= maxWidth)) return { lines, size: s };
    }
    const s = Math.max(MIN_SIZE, Math.min(size, maxWidth / Math.max(...words.map(width))));
    return { lines: greedy(words, s, width, maxWidth), size: s };
  }

  // Each line's baseline across the turned text (pt, up positive), for
  // `count` lines: centred on the anchor; from the anchor down for 'top'
  // (its first line keeps the old top baseline); up for 'bottom'.
  function lineBaselines(count, size, position) {
    const step = size * LINE_HEIGHT;
    return Array.from({ length: count }, (_, i) =>
      position === 'top' ? -i * step
        : position === 'bottom' ? (count - 1 - i) * step
        : ((count - 1) / 2 - i) * step - size * 0.35);
  }

  globalThis.pdfreeWatermarkWrap = { maxLineWidth, wrapWatermark, lineBaselines };
})();
