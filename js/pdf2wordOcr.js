// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

// ── pdf2wordOcr.js ───────────────────────────────────────────────────────────
// PDF→Word's OCR layer. A page with no text layer (a scan) used to go into the
// Word file as one picture of the whole page — the text could not be edited,
// and the hint to run the separate OCR tool first was easy to miss. Now its
// words are read in the browser with the shared engine (js/ocrEngine.js) and
// handed to pdf2readCore's `ocrPage` seam as ordinary text items, so the same
// line, paragraph, RTL, column and table reconstruction builds the document.
// The page image never leaves the device.
// ─────────────────────────────────────────────────────────────────────────────

import { loadTesseract, createOcrWorker, detectOcrLanguage, recognizePage, ocrLangForLocale, joinOcrWords, cjkJoin } from './ocrEngine.js';
import { getLang } from './config.js';

// Text items for pdf2readCore from one recognized page (recognizePage output),
// in Tesseract's reading order. A line's words are joined into runs — the
// words of one stretch of text, split where the gap between two words is
// wider than 0.8 em (the gap between table cells). Gaps are measured over all
// of the line's words, including those under the confidence threshold: their
// text is left out, but a dropped word is no gap — measured without them, a
// line broke at every dropped word and its pieces landed out of order (ar-web:
// reading order 58%). One item per word, the
// gaps between ten words of every line looked like column gutters, and the
// column detector cut paragraphs into single words (2026-10-08, first run on
// an Arabic scan: 73 "paragraphs" on a 9-paragraph page). Every run of a
// Tesseract line gets that line's baseline — on a tilted phone photo the words
// of one line drift several points apart, and grouped by their own y the line
// fell apart. Font size: the line's box height / 1.2 — 11pt body text boxes
// measure 1.2 em in Persian, English and Russian (2026-10-09, deskewed scans).
// The typeface sets it: Arabic in Amiri, a tall naskh, measures 1.6 em and
// comes out ~14pt. Too big is the safe side — an OCR'd page's paragraphs break
// on its own line pitch, not on font size (_p2wBuildParagraphs) — while too
// small turned every line gap past 2 em into a paragraph break (0.6 of the
// box: 8pt for 11pt Persian, paragraph precision 92% → 47%). Tesseract's own
// row_height scattered 19–68px over body lines of one Arabic page, and the
// box height still 56–87px — harakat and descenders — while a 15pt heading
// measured 1.2× the median: on OCR lines size does not tell a heading. Every
// line gets the page's median size unless it is a clear outlier (≥ 1.5×);
// sized one by one, body lines became up to 20 false headings (2026-10-08).
// A line split by a column-sized gap (≥ 1.5 em — a gutter measures ~1.6 em,
// word gaps a fraction) is pieces of different lines: each piece of 3+ words
// keeps its own level, the line's baseline moved by the median bottom of the
// piece's words against the line's (a median of 3+ words is past
// descenders). Within one column a piece's own level only added noise — a
// run split at a wide word gap broke its paragraph. On a two-column page Tesseract
// joins a line of each column into one — columns 4.5pt apart, now the upper,
// now the lower neighbour — and on the joined line's one baseline the
// columns' line gaps alternated 11/19pt for 15.5 (ar-cols2: paragraph
// precision 41–64%).
// Bold: strokes 1.25× the page's median line thickness or more
// (recognizePage's `stroke`) — Tesseract's LSTM reports no font attributes,
// and on OCR lines size does not tell a heading. On pages of 5+ lines. Told
// per piece of a line (see COLUMN_GAP_EM): measured over a line joined
// across two columns, a heading in one made the other column's body text
// bold — 4–5 false headings on fa-cols2.
const BOLD_STROKE = 1.25;
const BOLD_MIN_LINES = 5;
const BOLD_SNAP = 0.25;
const OWN_LEVEL_WORDS = 3;
const COLUMN_GAP_EM = 1.5;
const ROW_SNAP = 1.5;
const RUN_GAP_EM = 0.8;
// Between two Chinese or Japanese characters: Tesseract's boxes hug the ink,
// and beside a narrow glyph (一 小 起) the gap is 0.8–1.2 em — the line broke
// into runs there, a space at each (2026-10-10). Still under a column's.
const CJK_RUN_GAP_EM = 1.25;
const ROW_TO_FONT = 1 / 1.2;
export function ocrItemsFromPage(rec) {
  const [a, , , d, e, f] = rec.vpTransform;      // rotation 0: x' = a·x + e, y' = d·y + f
  const toX = cx => (cx - e) / a;
  const toY = cy => (cy - f) / d;
  const items = [];
  const rows = rec.lines.map(line => line.bbox.y1 - line.bbox.y0).sort((p, q) => p - q);
  const medianRow = rows[Math.floor(rows.length / 2)] || 0;
  const median = vals => [...vals].sort((p, q) => p - q)[Math.floor(vals.length / 2)];
  const boldStroke = rec.lines.length >= BOLD_MIN_LINES ? BOLD_STROKE * median(rec.lines.map(line => line.stroke)) : Infinity;
  const boldRow = median(rec.lines.filter(line => line.stroke >= boldStroke).map(line => line.bbox.y1 - line.bbox.y0)) ?? 0;
  for (const line of rec.lines) {
    const base = line.baseline && line.baseline.has_baseline !== false
      ? (line.baseline.y0 + line.baseline.y1) / 2
      : line.bbox.y1;
    const lineBottom = median(line.words.map(w => w.bbox.y1));
    const height = line.bbox.y1 - line.bbox.y0;
    // A piece's size from its own words' box: a line Tesseract joined across
    // two columns spans both columns' lines, 1.5× and more the median, and
    // its body text came out at heading size (fa-cols2). Bold text is sized
    // apart from body text — a heading's box is 1.2–1.36× the median, and
    // snapped to body size its two wrapped lines sat 2 em apart: two
    // headings — at the median of the page's bold lines within 25% of it
    // (a wrapped heading's short last line measured 12pt against 12.5pt, and
    // the two sizes made two headings again).
    const sizeOf = (h, bold) => {
      const row = bold ? (Math.abs(h / boldRow - 1) < BOLD_SNAP ? boldRow : h)
        : h / medianRow >= ROW_SNAP ? h : medianRow;
      return Math.max(1, (row / a) * ROW_TO_FONT);
    };
    const fontSize = sizeOf(height, false);
    const runs = [];
    const newPiece = () => ({ bottoms: [], top: Infinity, dark: 0, edge: 0 });   // shared by the piece's runs
    const pieces = [newPiece()];
    for (const w of line.words) {
      const box = { x0: toX(w.bbox.x0), x1: toX(w.bbox.x1) };
      const run = runs[runs.length - 1];
      const gap = run && Math.max(box.x0 - run.x1, run.x0 - box.x1);
      if (run && gap <= (cjkJoin(run.last, w.text) ? CJK_RUN_GAP_EM : RUN_GAP_EM) * fontSize) {
        if (w.kept) run.words.push(w.text);
        run.x0 = Math.min(run.x0, box.x0);
        run.x1 = Math.max(run.x1, box.x1);
      } else {
        const piece = run && gap > COLUMN_GAP_EM * fontSize ? newPiece() : pieces[pieces.length - 1];
        if (piece !== pieces[pieces.length - 1]) pieces.push(piece);
        runs.push({ words: w.kept ? [w.text] : [], piece, ...box });
      }
      runs[runs.length - 1].last = w.text;
      const piece = runs[runs.length - 1].piece;
      piece.bottoms.push(w.bbox.y1);
      piece.top = Math.min(piece.top, w.bbox.y0);
      piece.dark += w.ink?.dark ?? 0;
      piece.edge += w.ink?.edge ?? 0;
    }
    runs.filter(run => run.words.length).forEach((run, i, kept) => {
      const { bottoms, top, dark, edge } = run.piece;
      const bold = edge > 0 && dark / edge >= boldStroke;
      const ownLevel = pieces.length > 1 && bottoms.length >= OWN_LEVEL_WORDS;
      items.push({
        str: joinOcrWords(run.words) + (i < kept.length - 1 ? ' ' : ''),
        x: run.x0, y: toY(ownLevel ? base + median(bottoms) - lineBottom : base),
        width: run.x1 - run.x0, fontSize: sizeOf(Math.max(...bottoms) - top, bold), bold,
      });
    });
  }
  return items;
}

// The `ocrPage` seam for one PDF→Word run, plus close() to free the engine.
// The language is detected once, on first use, from the document's page
// images (detectOcrLanguage samples its pages; their text layer, broken or
// absent, says nothing). When it isn't detected with
// confidence — a script with no model, such as Hebrew — every page keeps
// today's behaviour (a picture of the page) instead of risking garbage text.
// Rotated pages (/Rotate 90/180/270) are left as they are for now.
export function createOcrLayer(pdfDoc, { onPage = () => {} } = {}) {
  let engine = null;   // Promise<{ worker, lang } | null>
  const start = async () => {
    try {
      await loadTesseract();
      let worker = await createOcrWorker('eng');
      const detection = await detectOcrLanguage(pdfDoc, worker, { ignoreTextLayer: true, hint: ocrLangForLocale(getLang()) });
      if (!detection.confident) { await worker.terminate(); return null; }
      // a new worker for another language (see detectOcrLanguage)
      if (detection.lang !== 'eng') {
        await worker.terminate();
        worker = await createOcrWorker(detection.lang);
      }
      return { worker, lang: detection.lang };
    } catch {
      return null;   // engine or model unavailable (offline) — pages stay pictures
    }
  };
  return {
    async ocrPage(page, pageNum) {
      if ((page.rotate || 0) !== 0) return null;
      engine ??= start();
      const ready = await engine;
      if (!ready) return null;
      onPage(pageNum, ready.lang);
      try {
        const rec = await recognizePage(ready.worker, page, ready.lang, { level: true });
        return ocrItemsFromPage(rec);
      } catch {
        return null;   // this page's OCR failed — it stays a picture, the rest goes on
      }
    },
    async close() {
      const ready = engine && await engine;
      await ready?.worker.terminate();
    },
  };
}
