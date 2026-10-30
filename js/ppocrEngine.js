// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  ppocrEngine.js — PP-OCRv5 for Chinese and Japanese pages on desktops
//
//  js/ocrEngine.js's recognizePage() asks paddleWanted(lang): a Chinese or
//  Japanese page on a desktop with ≥ 8 GB (the same gate as js/fileLimits.js —
//  in a browser PP-OCR takes ~1–1.4 GB on an A4 page) is read by
//  js/ppocrWorker.js; everything else, and any page PP-OCR fails on, stays
//  with Tesseract. 93 % of the people in China who add a file to PDF→Word,
//  PDF→PowerPoint, OCR or PDF→Excel are on a desktop (Analytics, 2026-10-15..29).
//
//  The result is given in Tesseract's shape (words, lines, paragraphs), so
//  everything after recognition — confidence filter, duplicate words, ink,
//  PDF→Word layout, the searchable PDF's text layer — is unchanged.
//  The models are downloaded once (~21 MB, pdfree.io only) and kept by the
//  HTTP cache; the workers are let go after a minute without a page. On 4+
//  cores a recognition-only second worker takes every other batch: the same
//  batches either way, so the same text (checked on 4 documents); site median
//  per document 44 → 38 s (Tesseract's: 26 s).
//  Measurements and their criteria: tests/corpus/ERROR_CLASSES.md, C22.
// ============================================================

import { isLargeDevice } from './fileLimits.js';

const SCRIPTS = new Set(['chi_sim', 'chi_tra', 'jpn']);
const IDLE_MS = 60000;
// CJK punctuation, kana, Han, compatibility ideographs, full-width forms, Hangul
const CJK = new RegExp('[' + [[0x3000, 0x30FF], [0x3400, 0x9FFF], [0xF900, 0xFAFF], [0xFF00, 0xFFEF], [0xAC00, 0xD7AF]]
  .map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']');

export function paddleWanted(lang, nav = globalThis.navigator) {
  return SCRIPTS.has(String(lang).split('+')[0]) && isLargeDevice(nav);
}

const REC_BATCH = 6, TEXT_SCORE = 0.5;
// Recognition is most of the time (~60–75 %, all of it ONNX inference): on 4+
// cores a second, recognition-only worker takes every other batch.
const recWorkers = (nav = globalThis.navigator) => ((nav?.hardwareConcurrency ?? 0) >= 4 ? 2 : 1);

let _workers = null, _ready = null, _idle = null, _queue = Promise.resolve();

function _release() {
  _workers?.forEach(w => w.terminate());
  _workers = _ready = null;
}

function _spawn(detect) {
  const w = new Worker(new URL('./ppocrWorker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    w.onmessage = e => (e.data.type === 'ready' ? resolve(w) : e.data.type === 'error' ? reject(new Error(e.data.message)) : null);
    w.onerror = e => reject(new Error(e.message || 'PP-OCR worker failed'));
    w.postMessage({ type: 'init', base: new URL('./', import.meta.url).href, detect });
  });
}

function _start() {
  if (_ready) return _ready;
  const n = recWorkers();
  _ready = Promise.all(Array.from({ length: n }, (_, i) => _spawn(i === 0))).then(ws => (_workers = ws));
  _ready.catch(_release);
  return _ready;
}

// start downloading the models while the language is being settled / the first page renders
export function paddleWarm(lang) {
  if (paddleWanted(lang)) _start().catch(() => {});
}

function _call(w, msg, transfer = []) {
  return new Promise((resolve, reject) => {
    w.onmessage = e => (e.data.type === 'done' ? resolve(e.data) : e.data.type === 'error' ? reject(new Error(e.data.message)) : null);
    w.onerror = e => reject(new Error(e.message || 'PP-OCR worker failed'));
    w.postMessage(msg, transfer);
  });
}

// a span along a cut-out line → a quad on the page (a vertical line was cut
// out turned a quarter: its x runs down the original box)
function spanQuad(q, crop, x0, x1) {
  const at = (u, v) => [q[0][0] + u * (q[1][0] - q[0][0]) + v * (q[3][0] - q[0][0]), q[0][1] + u * (q[1][1] - q[0][1]) + v * (q[3][1] - q[0][1])];
  const a = Math.min(1, x0 / crop.w), b = Math.min(1, x1 / crop.w);
  return crop.vertical ? [at(0, a), at(1, a), at(1, b), at(0, b)] : [at(a, 0), at(b, 0), at(b, 1), at(a, 1)];
}

// detection on the first worker; the batches RapidOCR would make (sorted by
// width, 6 a batch) dealt out in turn — every batch is the same whichever
// worker runs it, so the text doesn't change with the number of workers
async function _readPage(workers, image) {
  const { quads, crops, scale: [sx, sy] } = await _call(workers[0], { type: 'detect', image }, [image.data.buffer]);
  const order = crops.map((c, i) => [c.w / c.h, i]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  const batches = [];
  for (let s = 0; s < order.length; s += REC_BATCH) batches.push(order.slice(s, s + REC_BATCH));
  const shares = workers.map((_, k) => batches.filter((_, b) => b % workers.length === k));
  const meta = crops.map(c => ({ w: c.w, vertical: c.vertical }));
  const recs = new Array(crops.length);
  await Promise.all(workers.map(async (w, k) => {
    if (!shares[k].length) return;
    const send = shares[k].map(ids => ids.map(i => crops[i]));
    const { results } = await _call(w, { type: 'recognize', batches: send }, send.flat().map(c => c.d.buffer));
    shares[k].forEach((ids, b) => ids.forEach((i, j) => { recs[i] = results[b][j]; }));
  }));
  const lines = [];
  quads.forEach((q, i) => {
    const r = recs[i];
    if (!r || r.score < TEXT_SCORE || !r.text) return;
    const scaled = quad => quad.map(([x, y]) => [x * sx, y * sy]);
    lines.push({ text: r.text, score: r.score, quad: scaled(q), chars: r.spans.map(sp => ({ text: sp.ch, quad: scaled(spanQuad(q, meta[i], sp.x0, sp.x1)) })) });
  });
  return lines;
}

const box = quad => {
  const xs = quad.map(p => p[0]), ys = quad.map(p => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};
const union = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

// PP-OCR lines → Tesseract's result.data: a Chinese/Japanese character is a
// word of its own (as Tesseract gives them), a Latin or digit run a word.
export function tesseractShape(ppLines) {
  const lines = ppLines.map(l => {
    const confidence = Math.round(l.score * 1000) / 10, words = [];
    let run = null;
    for (const c of l.chars) {
      const b = box(c.quad);
      if (!c.text.trim()) { run = null; continue; }
      if (CJK.test(c.text)) { words.push({ text: c.text, confidence, bbox: b }); run = null; continue; }
      if (run) { run.text += c.text; run.bbox = union(run.bbox, b); }
      else { run = { text: c.text, confidence, bbox: b }; words.push(run); }
    }
    const bbox = box(l.quad);
    return { words, bbox, baseline: { x0: bbox.x0, y0: bbox.y1, x1: bbox.x1, y1: bbox.y1, has_baseline: true }, text: l.text };
  }).filter(l => l.words.length);
  // paragraphs: a line starts a new one after a gap taller than a line, or in another column
  const paragraphs = [];
  for (const l of lines) {
    const prev = paragraphs.at(-1)?.lines.at(-1), h = l.bbox.y1 - l.bbox.y0;
    const near = prev && l.bbox.y0 - prev.bbox.y1 < h && l.bbox.x0 < prev.bbox.x1 && prev.bbox.x0 < l.bbox.x1;
    if (near) paragraphs.at(-1).lines.push(l); else paragraphs.push({ lines: [l] });
  }
  return { data: { lines, words: lines.flatMap(l => l.words), paragraphs, text: lines.map(l => l.text).join('\n') } };
}

// One page canvas → Tesseract-shaped result. Throws when PP-OCR can't run
// (models not downloadable, out of memory): the caller falls back to Tesseract.
export function paddleRecognize(canvas) {
  const job = _queue.then(async () => {
    clearTimeout(_idle);
    const workers = await _start();
    const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    try { return tesseractShape(await _readPage(workers, image)); }
    catch (e) { _release(); throw e; }
    finally { _idle = setTimeout(_release, IDLE_MS); }
  });
  _queue = job.catch(() => {});
  return job;
}
