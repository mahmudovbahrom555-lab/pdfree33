// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  ppocrWorker.js — PP-OCRv5 (det + rec) for Chinese and Japanese pages
//
//  On the documents measured (2026-10-29, scripts/ocr-bench on branch
//  wip/ocr-bench-tools: 20 independent Chinese scans, 30 dev scans), PP-OCRv5
//  mobile read 95 % of the characters where Tesseract read 81 % (rough scans
//  95 % vs 78 %; Japanese 98 % vs 49 %), with the script — traditional or
//  simplified — right on 20 of 20. In a browser it needs ~1–1.4 GB on an A4
//  page, so js/ppocrEngine.js only uses it on desktops with ≥ 8 GB.
//
//  The pipeline is a port of RapidOCR 3.10.0's (Apache-2.0, see
//  js/vendor/LICENSE.txt): preprocess (longest side ≤ 4000) → DB text
//  detection (thresh 0.3, box 0.5, unclip 1.6, 2×2 dilation) → each box cut
//  out upright (a box ≥ 1.5 × taller than wide is vertical text: turned a
//  quarter) → CTC recognition (height 48, batches of 6) → lines scoring
//  < 0.5 dropped. No direction (cls) model: PP-OCRv4's turned upright
//  Chinese lines upside down and lost them (pool recall .954 with it,
//  .995 without). Measured faithful to RapidOCR's own output (JS vs Python
//  on the same pages, recall equal within 0.003 per document).
//
//  Each character's place on the line comes from the CTC frames it was read
//  in — as RapidOCR's word boxes do — so a searchable PDF selects the right
//  characters and PDF→Word keeps them in place.
//
//  In:  { type: 'init', base }                   → { type: 'ready' } | { type: 'error' }
//       { type: 'page', image: ImageData }       → { type: 'done', lines } | { type: 'error' }
//       lines: [{ text, score, quad: [[x,y]×4], chars: [{ text, quad }] }]
//  Download progress: { type: 'progress', loaded, total }.
// ============================================================

import * as ort from './vendor/onnxruntime/ort.wasm.min.mjs';

const MAX_SIDE = 4000, MIN_SIDE = 30, DET_LIMIT = 736;
const THRESH = 0.3, BOX_THRESH = 0.5, UNCLIP = 1.6, MAX_CAND = 1000, MIN_SIZE = 3;
const REC_H = 48, REC_W = 320, REC_BATCH = 6, TEXT_SCORE = 0.5;
const MODELS = 'vendor/ppocr/v5/';          // a new model version gets a new folder (HTTP cache key)
const STALL_MS = 30000, ATTEMPTS = 3;

let det, rec, chars;

// A download that keeps going is fine however slow; one silent for 30 s is
// restarted, three times (same rule as js/ocrEngine.js's model fetch).
async function fetchWatched(url, onBytes) {
  let lastErr;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const ctl = new AbortController();
    let timer = setTimeout(() => ctl.abort(), STALL_MS);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const reader = res.body.getReader(), parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(timer); timer = setTimeout(() => ctl.abort(), STALL_MS);
        parts.push(value); got += value.length; onBytes(value.length);
      }
      const out = new Uint8Array(got);
      let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    } catch (e) { lastErr = e; } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

async function init(base) {
  ort.env.wasm.wasmPaths = base + 'vendor/onnxruntime/';
  ort.env.wasm.numThreads = 1;                 // threads need cross-origin isolation, which the site doesn't have
  const total = 4819576 + 16631306;            // det + rec bytes, for the progress bar
  let loaded = 0;
  const onBytes = n => { loaded += n; self.postMessage({ type: 'progress', loaded, total }); };
  const [d, r, c] = await Promise.all([
    fetchWatched(base + MODELS + 'det.onnx', onBytes),
    fetchWatched(base + MODELS + 'rec.onnx', onBytes),
    fetch(base + MODELS + 'chars.json').then(x => x.json()),
  ]);
  const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  [det, rec] = await Promise.all([ort.InferenceSession.create(d, opt), ort.InferenceSession.create(r, opt)]);
  chars = c;
}

// ── images: { w, h, d: RGBA } ──────────────────────────────────────────────
function resizeBilinear(src, w, h) {
  const out = new Uint8ClampedArray(w * h * 4), sx = src.w / w, sy = src.h / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5), y0 = Math.min(src.h - 1, fy | 0), y1 = Math.min(src.h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5), x0 = Math.min(src.w - 1, fx | 0), x1 = Math.min(src.w - 1, x0 + 1), tx = fx - x0;
      const a = (y0 * src.w + x0) * 4, b = (y0 * src.w + x1) * 4, c = (y1 * src.w + x0) * 4, e = (y1 * src.w + x1) * 4, o = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) out[o + k] = (src.d[a + k] * (1 - tx) + src.d[b + k] * tx) * (1 - ty) + (src.d[c + k] * (1 - tx) + src.d[e + k] * tx) * ty;
      out[o + 3] = 255;
    }
  }
  return { w, h, d: out };
}
const r32 = v => Math.round(v / 32) * 32;
// BGR planes scaled to [-1, 1] — what the models were trained on (OpenCV images)
function toTensor(img, n = 1, W = img.w, into = null, at = 0) {
  const plane = img.h * W, t = into || new Float32Array(3 * plane * n), base = at * 3 * plane;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const i = (y * img.w + x) * 4, j = y * W + x;
    t[base + j] = img.d[i + 2] / 127.5 - 1;
    t[base + plane + j] = img.d[i + 1] / 127.5 - 1;
    t[base + 2 * plane + j] = img.d[i] / 127.5 - 1;
  }
  return t;
}

// ── geometry ───────────────────────────────────────────────────────────────
function hull(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
// minimum-area rectangle of a convex polygon (rotating calipers)
function minAreaRect(h) {
  if (h.length === 1) return { cx: h[0][0], cy: h[0][1], w: 0, h: 0, ux: 1, uy: 0 };
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const p = h[i], q = h[(i + 1) % h.length];
    let ux = q[0] - p[0], uy = q[1] - p[1]; const L = Math.hypot(ux, uy); if (!L) continue; ux /= L; uy /= L;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const r of h) { const a = r[0] * ux + r[1] * uy, b = -r[0] * uy + r[1] * ux; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area) {
      const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
      best = { area, cx: ca * ux - cb * uy, cy: ca * uy + cb * ux, w: a1 - a0, h: b1 - b0, ux, uy };
    }
  }
  return best;
}
// its corners in RapidOCR's get_mini_boxes order
function miniBox(r) {
  const hw = r.w / 2, hh = r.h / 2, vx = -r.uy, vy = r.ux;
  const p = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => [r.cx + s * hw * r.ux + t * hh * vx, r.cy + s * hw * r.uy + t * hh * vy]).sort((a, b) => a[0] - b[0]);
  const [i1, i4] = p[1][1] > p[0][1] ? [0, 1] : [1, 0];
  const [i2, i3] = p[3][1] > p[2][1] ? [2, 3] : [3, 2];
  return { box: [p[i1], p[i2], p[i3], p[i4]], sside: Math.min(r.w, r.h) };
}
function inPoly(x, y, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function boxScore(pred, W, H, box) {
  const xs = box.map(p => p[0]), ys = box.map(p => p[1]);
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(Math.min(...xs)))), x1 = Math.max(0, Math.min(W - 1, Math.ceil(Math.max(...xs))));
  const y0 = Math.max(0, Math.min(H - 1, Math.floor(Math.min(...ys)))), y1 = Math.max(0, Math.min(H - 1, Math.ceil(Math.max(...ys))));
  let s = 0, n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inPoly(x + 0.5, y + 0.5, box)) { s += pred[y * W + x]; n++; }
  return n ? s / n : 0;
}

// ── detection: text-line quads (tl, tr, br, bl) in reading order ─────────────
async function detect(img) {
  const ratio = Math.min(img.w, img.h) < DET_LIMIT ? DET_LIMIT / Math.min(img.w, img.h) : 1;
  const W = r32(Math.trunc(img.w * ratio)), H = r32(Math.trunc(img.h * ratio));
  const inp = W === img.w && H === img.h ? img : resizeBilinear(img, W, H);
  const out = await det.run({ x: new ort.Tensor('float32', toTensor(inp), [1, 3, H, W]) });
  const pred = out[Object.keys(out)[0]].data;
  const bin = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) bin[i] = pred[i] > THRESH ? 1 : 0;
  const mask = new Uint8Array(W * H);                      // 2×2 dilation, anchor at the kernel centre
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    mask[i] = bin[i] | (x > 0 && bin[i - 1]) | (y > 0 && bin[i - W]) | (x > 0 && y > 0 && bin[i - W - 1]);
  }
  const lab = new Int32Array(W * H), stack = [], boxes = [];
  let n = 0;
  for (let s = 0; s < W * H && n < MAX_CAND; s++) {
    if (!mask[s] || lab[s]) continue;
    n++; lab[s] = n; stack.push(s); const pts = [];
    while (stack.length) {
      const i = stack.pop(), x = i % W, y = (i / W) | 0; let edge = false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) { edge = true; continue; }
        const j = yy * W + xx;
        if (!mask[j]) { edge = true; continue; }
        if (!lab[j]) { lab[j] = n; stack.push(j); }
      }
      if (edge) pts.push([x, y]);
    }
    const r = minAreaRect(hull(pts));
    let { box, sside } = miniBox(r);
    if (sside < MIN_SIZE || boxScore(pred, W, H, box) < BOX_THRESH) continue;
    // unclip by area·ratio/perimeter with round joins: the min-area rect grows by that on every side
    const d = (r.w * r.h) * UNCLIP / (2 * (r.w + r.h));
    ({ box, sside } = miniBox({ ...r, w: r.w + 2 * d, h: r.h + 2 * d }));
    if (sside < MIN_SIZE + 2) continue;
    box = box.map(([x, y]) => [Math.min(img.w, Math.max(0, Math.round(x / W * img.w))), Math.min(img.h, Math.max(0, Math.round(y / H * img.h)))]);
    const xs = [...box].sort((a, b) => a[0] - b[0]);
    const [tl, bl] = xs.slice(0, 2).sort((a, b) => a[1] - b[1]), [tr, br] = xs.slice(2).sort((a, b) => a[1] - b[1]);
    const q = [tl, tr, br, bl].map(([x, y]) => [Math.trunc(Math.min(Math.max(x, 0), img.w - 1)), Math.trunc(Math.min(Math.max(y, 0), img.h - 1))]);
    if (Math.trunc(Math.hypot(q[0][0] - q[1][0], q[0][1] - q[1][1])) <= 3 || Math.trunc(Math.hypot(q[0][0] - q[3][0], q[0][1] - q[3][1])) <= 3) continue;
    boxes.push(q);
  }
  boxes.sort((a, b) => a[0][1] - b[0][1]);                 // top to bottom; within 10 px a line, left to right
  let line = 0;
  const keyed = boxes.map((b, i) => { if (i && b[0][1] - boxes[i - 1][0][1] >= 10) line++; return { b, line }; });
  keyed.sort((a, b) => a.line - b.line || a.b[0][0] - b.b[0][0]);
  return keyed.map(k => k.b);
}

// the quad cut out upright; vertical text turned a quarter (np.rot90)
function crop(img, q) {
  const cw = Math.trunc(Math.max(Math.hypot(q[0][0] - q[1][0], q[0][1] - q[1][1]), Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1])));
  const ch = Math.trunc(Math.max(Math.hypot(q[0][0] - q[3][0], q[0][1] - q[3][1]), Math.hypot(q[1][0] - q[2][0], q[1][1] - q[2][1])));
  const out = new Uint8ClampedArray(cw * ch * 4);
  const ax = (q[1][0] - q[0][0]) / cw, ay = (q[1][1] - q[0][1]) / cw, bx = (q[3][0] - q[0][0]) / ch, by = (q[3][1] - q[0][1]) / ch;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    let sx = q[0][0] + ax * x + bx * y, sy = q[0][1] + ay * x + by * y;
    sx = Math.min(img.w - 1, Math.max(0, sx)); sy = Math.min(img.h - 1, Math.max(0, sy));
    const x0 = sx | 0, y0 = sy | 0, x1 = Math.min(img.w - 1, x0 + 1), y1 = Math.min(img.h - 1, y0 + 1), tx = sx - x0, ty = sy - y0;
    const a = (y0 * img.w + x0) * 4, b = (y0 * img.w + x1) * 4, c = (y1 * img.w + x0) * 4, e = (y1 * img.w + x1) * 4, o = (y * cw + x) * 4;
    for (let k = 0; k < 3; k++) out[o + k] = (img.d[a + k] * (1 - tx) + img.d[b + k] * tx) * (1 - ty) + (img.d[c + k] * (1 - tx) + img.d[e + k] * tx) * ty;
    out[o + 3] = 255;
  }
  if (ch / cw < 1.5) return { w: cw, h: ch, d: out, vertical: false };
  const r = new Uint8ClampedArray(out.length);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) r.set(out.subarray((y * cw + x) * 4, (y * cw + x) * 4 + 4), ((cw - 1 - x) * ch + y) * 4);
  return { w: ch, h: cw, d: r, vertical: true };
}

// CTC: per line, the characters with the frame span each was read in
async function recognize(crops) {
  const order = crops.map((c, i) => [c.w / c.h, i]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  const res = new Array(crops.length);
  for (let s = 0; s < order.length; s += REC_BATCH) {
    const ids = order.slice(s, s + REC_BATCH);
    const maxR = Math.max(REC_W / REC_H, ...ids.map(i => crops[i].w / crops[i].h));
    const W = Math.trunc(REC_H * maxR), t = new Float32Array(ids.length * 3 * REC_H * W);
    const widths = ids.map((i, k) => {
      const c = crops[i], rw = Math.max(1, Math.min(W, Math.ceil(REC_H * c.w / c.h)));
      toTensor(resizeBilinear(c, rw, REC_H), ids.length, W, t, k);
      return rw;
    });
    const out = await rec.run({ x: new ort.Tensor('float32', t, [ids.length, 3, REC_H, W]) });
    const o = out[Object.keys(out)[0]], [, T, C] = o.dims, p = o.data;
    ids.forEach((i, k) => {
      const found = []; let prev = -1, sum = 0;
      for (let tt = 0; tt < T; tt++) {
        let best = 0, bv = -Infinity; const off = (k * T + tt) * C;
        for (let c = 0; c < C; c++) if (p[off + c] > bv) { bv = p[off + c]; best = c; }
        if (best !== 0 && best === prev && found.length) found[found.length - 1].t1 = tt;
        else if (best !== 0) { found.push({ ch: chars[best], t0: tt, t1: tt }); sum += bv; }
        prev = best;
      }
      // frames → x on the crop (frames span the padded width W; the crop filled widths[k] of it)
      const f = (W / T) * (crops[i].w / widths[k]);
      res[i] = { text: found.map(c => c.ch).join(''), score: found.length ? sum / found.length : 0, spans: found.map(c => ({ ch: c.ch, x0: c.t0 * f, x1: (c.t1 + 1) * f })) };
    });
  }
  return res;
}

// a span along the cut-out line → a quad on the page
function spanQuad(q, crop, x0, x1) {
  const at = (u, v) => [q[0][0] + u * (q[1][0] - q[0][0]) + v * (q[3][0] - q[0][0]), q[0][1] + u * (q[1][1] - q[0][1]) + v * (q[3][1] - q[0][1])];
  if (!crop.vertical) {
    const a = Math.min(1, x0 / crop.w), b = Math.min(1, x1 / crop.w);
    return [at(a, 0), at(b, 0), at(b, 1), at(a, 1)];
  }
  // turned a quarter: the cut-out's x runs down the original box
  const a = Math.min(1, x0 / crop.w), b = Math.min(1, x1 / crop.w);
  return [at(0, a), at(1, a), at(1, b), at(0, b)];
}

async function ocrPage(img) {
  let page = img;
  if (Math.max(img.w, img.h) > MAX_SIDE) {
    const r = MAX_SIDE / Math.max(img.w, img.h);
    page = resizeBilinear(img, r32(Math.trunc(img.w * r)), r32(Math.trunc(img.h * r)));
  }
  if (Math.min(page.w, page.h) < MIN_SIDE) return [];
  const sx = img.w / page.w, sy = img.h / page.h;            // back to the caller's pixels
  const boxes = await detect(page);
  const crops = boxes.map(b => crop(page, b));
  const recs = await recognize(crops);
  const lines = [];
  boxes.forEach((q, i) => {
    const r = recs[i];
    if (r.score < TEXT_SCORE || !r.text) return;
    const scale = quad => quad.map(([x, y]) => [x * sx, y * sy]);
    lines.push({ text: r.text, score: r.score, quad: scale(q), chars: r.spans.map(s => ({ text: s.ch, quad: scale(spanQuad(q, crops[i], s.x0, s.x1)) })) });
  });
  return lines;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') { await init(m.base); self.postMessage({ type: 'ready' }); return; }
    const { width: w, height: h, data: d } = m.image;
    self.postMessage({ type: 'done', lines: await ocrPage({ w, h, d }) });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
