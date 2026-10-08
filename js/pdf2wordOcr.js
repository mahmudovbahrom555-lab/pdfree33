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

import { loadTesseract, createOcrWorker, switchOcrLanguage, detectOcrLanguage, recognizePage } from './ocrEngine.js';

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
// fell apart. Font size: 0.8 of the line's row height, which spans ascenders
// to descenders (11pt body text measured 14pt). Row heights of body lines
// scatter by ±20% — a line within 25% of the page's median gets the median,
// or every taller-than-average body line became a heading (up to 20 false
// headings on an office scan, 2026-10-08).
const ROW_SNAP = 1.25;
const RUN_GAP_EM = 0.8;
const ROW_TO_FONT = 0.8;
export function ocrItemsFromPage(rec) {
  const [a, , , d, e, f] = rec.vpTransform;      // rotation 0: x' = a·x + e, y' = d·y + f
  const toX = cx => (cx - e) / a;
  const toY = cy => (cy - f) / d;
  const items = [];
  const rows = rec.lines.map(line => line.rowHeight).sort((p, q) => p - q);
  const medianRow = rows[Math.floor(rows.length / 2)] || 0;
  for (const line of rec.lines) {
    const base = line.baseline && line.baseline.has_baseline !== false
      ? (line.baseline.y0 + line.baseline.y1) / 2
      : line.bbox.y1;
    const y = toY(base);
    const row = line.rowHeight / medianRow < ROW_SNAP && medianRow / line.rowHeight < ROW_SNAP ? medianRow : line.rowHeight;
    const fontSize = Math.max(1, (row / a) * ROW_TO_FONT);
    const runs = [];
    for (const w of line.words) {
      const box = { x0: toX(w.bbox.x0), x1: toX(w.bbox.x1) };
      const run = runs[runs.length - 1];
      const gap = run && Math.max(box.x0 - run.x1, run.x0 - box.x1);
      if (run && gap <= RUN_GAP_EM * fontSize) {
        if (w.kept) run.words.push(w.text);
        run.x0 = Math.min(run.x0, box.x0);
        run.x1 = Math.max(run.x1, box.x1);
      } else {
        runs.push({ words: w.kept ? [w.text] : [], ...box });
      }
    }
    runs.filter(run => run.words.length).forEach((run, i, kept) => items.push({
      str: run.words.join(' ') + (i < kept.length - 1 ? ' ' : ''),
      x: run.x0, y, width: run.x1 - run.x0, fontSize,
    }));
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
      const worker = await createOcrWorker('eng');
      const detection = await detectOcrLanguage(pdfDoc, worker, { ignoreTextLayer: true });
      if (!detection.confident) { await worker.terminate(); return null; }
      if (detection.lang !== 'eng') await switchOcrLanguage(worker, detection.lang);
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
      const rec = await recognizePage(ready.worker, page, ready.lang);
      return ocrItemsFromPage(rec);
    },
    async close() {
      const ready = engine && await engine;
      await ready?.worker.terminate();
    },
  };
}
