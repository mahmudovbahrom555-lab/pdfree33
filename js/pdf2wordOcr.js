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

import { loadTesseract, createOcrWorker, detectOcrLanguage, recognizePage, ocrLangForLocale, ocrProbesForBrowser, joinOcrWords, ocrLanes } from './ocrEngine.js';
import { paddleWarm } from './ppocrEngine.js';
import { onOcrDownload } from './ocrDownloads.js';
import { cjkJoin } from './cjkText.js';
import { getLang } from './config.js';
import { _layerWantsOcr } from './pdf2readCore.js';

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
const VERTICAL = 2;   // a line box this many times taller than wide is a column of vertical text
export function ocrItemsFromPage(rec) {
  // rotation 0: the page's own space, x' = a·x + e, y' = d·y + f; a page with
  // /Rotate: the page as shown, y up (pdf2readCore's uprightMatrix) — where
  // its text layer's items are read too
  const [a, b, , d, e, f] = rec.vpTransform;
  const scale = Math.hypot(a, b);
  const toX = rec.rotation ? cx => cx / scale : cx => (cx - e) / a;
  const toY = rec.rotation ? cy => (rec.canvasH - cy) / scale : cy => (cy - f) / d;
  const items = [];
  // A line of vertical text (Japanese newspapers) is a column: its box is
  // tall and narrow, and its type is as large as the column is wide. Sized by
  // its height, 4 pages of a scanned newspaper came out at 29–131 pt, 691
  // pages in Word (multi-page judge, Common Crawl, 2026-11-18).
  const rowOf = b => (b.y1 - b.y0 > VERTICAL * (b.x1 - b.x0) ? b.x1 - b.x0 : b.y1 - b.y0);
  const rows = rec.lines.map(line => rowOf(line.bbox)).sort((p, q) => p - q);
  const medianRow = rows[Math.floor(rows.length / 2)] || 0;
  const median = vals => [...vals].sort((p, q) => p - q)[Math.floor(vals.length / 2)];
  const boldStroke = rec.lines.length >= BOLD_MIN_LINES ? BOLD_STROKE * median(rec.lines.map(line => line.stroke)) : Infinity;
  const boldRow = median(rec.lines.filter(line => line.stroke >= boldStroke).map(line => rowOf(line.bbox))) ?? 0;
  for (const line of rec.lines) {
    const base = line.baseline && line.baseline.has_baseline !== false
      ? (line.baseline.y0 + line.baseline.y1) / 2
      : line.bbox.y1;
    const lineBottom = median(line.words.map(w => w.bbox.y1));
    const height = rowOf(line.bbox);
    const vertical = height !== line.bbox.y1 - line.bbox.y0;
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
      return Math.max(1, (row / scale) * ROW_TO_FONT);
    };
    const fontSize = sizeOf(height, false);
    const partial = line.words.some(w => !w.kept);
    const conf = Math.min(...line.words.filter(w => w.kept).map(w => w.confidence ?? 0));
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
        width: run.x1 - run.x0, fontSize: vertical ? fontSize : sizeOf(Math.max(...bottoms) - top, bold), bold,
        // some of its line's words were too unsure to keep: what is left is a
        // guess (PDF→PowerPoint keeps such a run invisible over the picture)
        ...(partial ? { partial: true } : {}),
        conf,   // the least sure kept word of its line (Tesseract, 0–100)
      });
    });
  }
  return items;
}

// The script of a document's text layer, as a hint for OCR language
// detection: 'ara' when the sampled pages hold 30+ Arabic-script letters and
// they are 60 % of the letters — a layer too broken or thin to read still
// says what it was written in. Only Arabic script was measured (2026-10-18).
export async function layerScript(pdfDoc) {
  let own = 0, all = 0;
  for (const p of [...new Set([1, Math.ceil(pdfDoc.numPages / 2), pdfDoc.numPages])]) {
    const text = (await (await pdfDoc.getPage(p)).getTextContent()).items.map(i => i.str).join(' ').normalize('NFKC');
    own += (text.match(/[\u0600-\u06FF\u0750-\u077F]/g) ?? []).length;
    all += (text.match(/\p{L}/gu) ?? []).length;
  }
  return own >= 30 && own >= 0.6 * all ? 'ara' : null;
}

// The `ocrPage` seam for one PDF→Word run, plus close() to free the engine.
// The language is detected once, on first use, from the document's page
// images (detectOcrLanguage samples its pages; their text layer, broken or
// absent, says nothing). When it isn't detected with
// confidence — a script with no model, such as Hebrew — every page keeps
// today's behaviour (a picture of the page) instead of risking garbage text.
// `rotated`: whether pages with /Rotate are read too — PDF→PowerPoint leaves
// such a slide a picture, and has no use for its text.
// Pages ahead are read while pdf2readCore works on this one, on `lanes`
// workers (ocrLanes: 1 on a phone and for Chinese/Japanese in Chrome — there
// nothing is read ahead, as before; 2–3 on a desktop). Ahead means up to
// LOOK_AHEAD pages past the one asked for, a page that will likely be asked
// for: no text at all, or a layer pdf2readCore reads again (_layerWantsOcr —
// the one rule, asked here on the page's raw text layer). Whether a page is
// OCRed is still pdf2readCore's call: a page read ahead that it never asks
// for is dropped, and a page it asks for that was not read ahead is read
// then. A page read ahead is read the same way — the same engine, language
// and settings, its own worker (OCR tool, 2.7× on long scans: the same text).
// Out of memory with pages read at once: read again when it is asked for.
const LOOK_AHEAD = 8;
const _outOfMemory = err => /memory|allocat|RangeError/i.test(String(err?.message ?? err));
// onDetect: called as the language detection starts — tens of seconds on a
// book of pictures (44 s, 2026-11-17), with nothing else on the screen moving.
// onDetect(mb) again while it downloads the OCR models: the megabytes so far
// (whole once past 10) — on a slow line that is most of the wait.
export function createOcrLayer(pdfDoc, { onPage = () => {}, onDetect = () => {}, rotated = true } = {}) {
  let engine = null;   // Promise<{ worker, lang } | null>
  let closed = false;
  const idle = [];      // workers free to read a page
  const waiting = [];   // resolvers of reads waiting for a worker
  const extras = [];    // Promises of the extra lanes' workers
  const ahead = new Map();   // page number → Promise<{ items } | { error }>
  let laneCount = 1;
  let asked = 0, looked = 0, looking = null;   // last page asked for; pages up to `looked` checked
  const release = w => { const next = waiting.shift(); next ? next(w) : idle.push(w); };
  const acquire = () => idle.length ? Promise.resolve(idle.pop()) : new Promise(r => waiting.push(r));
  const read = async (page, lang) => {
    const w = await acquire();
    try { return ocrItemsFromPage(await recognizePage(w, page, lang, { level: true })); }
    finally { release(w); }
  };
  const likelyAsked = async page => {
    if (!rotated && (page.rotate || 0) % 360) return false;
    const content = await page.getTextContent({ normalizeWhitespace: false }).catch(() => null);
    if (!content) return false;
    const layerText = content.items.map(i => i.str ?? '').join(' ');
    if (!layerText.trim()) return true;
    return _layerWantsOcr(layerText, await page.getOperatorList().catch(() => null), page.view);
  };
  const readAhead = lang => {
    looking ??= (async () => {
      while (!closed && [...ahead.keys()].filter(q => q > asked).length < laneCount - 1) {
        const q = Math.max(looked, asked) + 1;
        if (q > pdfDoc.numPages || q > asked + LOOK_AHEAD) break;
        looked = q;
        const page = await pdfDoc.getPage(q).catch(() => null);
        if (page && await likelyAsked(page)) ahead.set(q, read(page, lang).then(items => ({ items }), error => ({ error })));
      }
      looking = null;
    })();
  };
  const start = async () => {
    let base = null, shown = '';
    const stopCounting = onOcrDownload(total => {
      base ??= total;
      const mb = (total - base) / 1e6;
      const label = mb < 10 ? mb.toFixed(1) : String(Math.round(mb));
      if (label !== shown && mb >= 0.1) { shown = label; onDetect(label); }
    });
    try {
      onDetect();
      await loadTesseract();
      let worker = await createOcrWorker('eng');
      const detection = await detectOcrLanguage(pdfDoc, worker, { ignoreTextLayer: true, hint: ocrLangForLocale(getLang()), layerLang: await layerScript(pdfDoc), prefer: ocrProbesForBrowser() });
      if (!detection.confident) { await worker.terminate(); return null; }
      paddleWarm(detection.lang);
      // a new worker for another language (see detectOcrLanguage)
      if (detection.lang !== 'eng') {
        await worker.terminate();
        worker = await createOcrWorker(detection.lang);
      }
      idle.push(worker);
      laneCount = Math.min(ocrLanes(detection.lang), Math.max(1, pdfDoc.numPages));
      for (let i = 1; i < laneCount; i++) {
        extras.push(createOcrWorker(detection.lang)
          .then(w => { if (closed) { w.terminate(); return null; } release(w); return w; })
          .catch(() => null));   // fewer lanes: the others carry on
      }
      return { worker, lang: detection.lang };
    } catch {
      return null;   // engine or model unavailable (offline) — pages stay pictures
    } finally {
      stopCounting();   // the pages' own labels take over
    }
  };
  return {
    async ocrPage(page, pageNum) {
      if (!rotated && (page.rotate || 0) % 360) return null;
      engine ??= start();
      const ready = await engine;
      if (!ready) return null;
      onPage(pageNum, ready.lang);
      const early = ahead.get(pageNum);
      for (const q of ahead.keys()) if (q <= pageNum) ahead.delete(q);   // asked, or passed over
      asked = Math.max(asked, pageNum);
      if (laneCount > 1) readAhead(ready.lang);
      const got = early && await early;
      if (got?.items) return got.items;
      if (got?.error && !_outOfMemory(got.error)) return null;   // this page's OCR failed
      try {
        return await read(page, ready.lang);
      } catch {
        return null;   // this page's OCR failed — it stays a picture, the rest goes on
      }
    },
    async close() {
      closed = true;
      const ready = engine && await engine;
      const more = await Promise.all(extras);
      await Promise.all([ready?.worker, ...more].filter(Boolean).map(w => w.terminate()));
    },
  };
}
