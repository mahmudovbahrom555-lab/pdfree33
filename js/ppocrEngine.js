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
//  HTTP cache; the worker is let go after a minute without a page.
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

let _worker = null, _ready = null, _idle = null, _queue = Promise.resolve();

function _release() {
  _worker?.terminate();
  _worker = _ready = null;
}

function _start() {
  if (_ready) return _ready;
  _worker = new Worker(new URL('./ppocrWorker.js', import.meta.url), { type: 'module' });
  const w = _worker;
  _ready = new Promise((resolve, reject) => {
    w.onmessage = e => (e.data.type === 'ready' ? resolve(w) : e.data.type === 'error' ? reject(new Error(e.data.message)) : null);
    w.onerror = e => reject(new Error(e.message || 'PP-OCR worker failed'));
    w.postMessage({ type: 'init', base: new URL('./', import.meta.url).href });
  });
  _ready.catch(_release);
  return _ready;
}

// start downloading the models while the language is being settled / the first page renders
export function paddleWarm(lang) {
  if (paddleWanted(lang)) _start().catch(() => {});
}

function _page(w, image) {
  return new Promise((resolve, reject) => {
    w.onmessage = e => (e.data.type === 'done' ? resolve(e.data.lines) : e.data.type === 'error' ? reject(new Error(e.data.message)) : null);
    w.onerror = e => reject(new Error(e.message || 'PP-OCR worker failed'));
    w.postMessage({ type: 'page', image }, [image.data.buffer]);
  });
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
    const w = await _start();
    const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    try { return tesseractShape(await _page(w, image)); }
    catch (e) { _release(); throw e; }
    finally { _idle = setTimeout(_release, IDLE_MS); }
  });
  _queue = job.catch(() => {});
  return job;
}
