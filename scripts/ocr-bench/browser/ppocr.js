// PP-OCRv5 mobile (det + rec) in the browser with onnxruntime-web — a port of
// RapidOCR 3.10.0's pipeline (Apache-2.0): preprocess → DB detection → crop →
// CTC recognition. Experiment for step 3, not site code. No cls (upside-down) model.
import * as ort from './node_modules/onnxruntime-web/dist/ort.wasm.min.mjs';

const MAX_SIDE = 4000, MIN_SIDE = 30;           // Global (M4)
const DET_LIMIT = 736;                           // limit_type "min"
const THRESH = 0.3, BOX_THRESH = 0.5, UNCLIP = 1.6, MAX_CAND = 1000, MIN_SIZE = 3;
const REC_H = 48, REC_W = 320, REC_BATCH = 6, TEXT_SCORE = 0.5;

let det, rec, chars;
export async function init(base, { threads = 1 } = {}) {
  ort.env.wasm.wasmPaths = base + 'node_modules/onnxruntime-web/dist/';
  ort.env.wasm.numThreads = threads;
  const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  [det, rec, chars] = await Promise.all([
    ort.InferenceSession.create(base + 'models/ch_PP-OCRv5_det_mobile.onnx', opt),
    ort.InferenceSession.create(base + 'models/ch_PP-OCRv5_rec_mobile.onnx', opt),
    fetch(base + 'models/chars.json').then(r => r.json()),
  ]);
}

// ── image helpers: {w, h, d: Uint8ClampedArray RGBA} ──────────────────────
function resizeBilinear(src, w, h) {
  const out = new Uint8ClampedArray(w * h * 4), sx = src.w / w, sy = src.h / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5), y0 = Math.min(src.h - 1, fy | 0), y1 = Math.min(src.h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5), x0 = Math.min(src.w - 1, fx | 0), x1 = Math.min(src.w - 1, x0 + 1), tx = fx - x0;
      const a = (y0 * src.w + x0) * 4, b = (y0 * src.w + x1) * 4, c = (y1 * src.w + x0) * 4, e = (y1 * src.w + x1) * 4, o = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) {
        out[o + k] = (src.d[a + k] * (1 - tx) + src.d[b + k] * tx) * (1 - ty) + (src.d[c + k] * (1 - tx) + src.d[e + k] * tx) * ty;
      }
      out[o + 3] = 255;
    }
  }
  return { w, h, d: out };
}
const r32 = v => Math.round(v / 32) * 32;
// BGR planes, (x/255 - 0.5) / 0.5 — what the Python side fed (cv2 BGR)
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

// ── geometry ─────────────────────────────────────────────────────────────
function hull(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
// minimum-area rectangle of a convex polygon: {cx, cy, w, h, ux, uy} (u = unit along w)
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
function rectPoints(r) {
  const hw = r.w / 2, hh = r.h / 2, vx = -r.uy, vy = r.ux;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => [r.cx + s * hw * r.ux + t * hh * vx, r.cy + s * hw * r.uy + t * hh * vy]);
}
// RapidOCR get_mini_boxes ordering: sort by x, then pick (tl, tr, br, bl)
function miniBox(r) {
  const p = rectPoints(r).sort((a, b) => a[0] - b[0]);
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

// ── detection ────────────────────────────────────────────────────────────
async function detect(img) {
  let ratio = 1;
  if (Math.min(img.w, img.h) < DET_LIMIT) ratio = DET_LIMIT / Math.min(img.w, img.h);
  const W = r32(Math.trunc(img.w * ratio)), H = r32(Math.trunc(img.h * ratio));
  const inp = W === img.w && H === img.h ? img : resizeBilinear(img, W, H);
  const out = await det.run({ x: new ort.Tensor('float32', toTensor(inp), [1, 3, H, W]) });
  const pred = out[Object.keys(out)[0]].data;
  // binarize + 2×2 dilation (anchor at the kernel centre → pixels y-1..y, x-1..x)
  const bin = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) bin[i] = pred[i] > THRESH ? 1 : 0;
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    mask[i] = bin[i] | (x > 0 && bin[i - 1]) | (y > 0 && bin[i - W]) | (x > 0 && y > 0 && bin[i - W - 1]);
  }
  // connected components (8-neighbour), boundary pixels → hull
  const lab = new Int32Array(W * H), stack = []; let n = 0; const boxes = [];
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
    if (sside < MIN_SIZE) continue;
    const score = boxScore(pred, W, H, box);
    if (score < BOX_THRESH) continue;
    // unclip: offset by d = area·ratio/perimeter (round joins) → its min-area rect grows by d per side
    const d = (r.w * r.h) * UNCLIP / (2 * (r.w + r.h));
    ({ box, sside } = miniBox({ ...r, w: r.w + 2 * d, h: r.h + 2 * d }));
    if (sside < MIN_SIZE + 2) continue;
    box = box.map(([x, y]) => [Math.min(img.w, Math.max(0, Math.round(x / W * img.w))), Math.min(img.h, Math.max(0, Math.round(y / H * img.h)))]);
    // order clockwise (tl, tr, br, bl), clip, drop thin
    const xs = [...box].sort((a, b) => a[0] - b[0]);
    const [tl, bl] = xs.slice(0, 2).sort((a, b) => a[1] - b[1]), [tr, br] = xs.slice(2).sort((a, b) => a[1] - b[1]);
    const q = [tl, tr, br, bl].map(([x, y]) => [Math.trunc(Math.min(Math.max(x, 0), img.w - 1)), Math.trunc(Math.min(Math.max(y, 0), img.h - 1))]);
    if (Math.trunc(Math.hypot(q[0][0] - q[1][0], q[0][1] - q[1][1])) <= 3 || Math.trunc(Math.hypot(q[0][0] - q[3][0], q[0][1] - q[3][1])) <= 3) continue;
    boxes.push(q);
  }
  // reading order: by top-left y, lines where consecutive y differ < 10, then x
  boxes.sort((a, b) => a[0][1] - b[0][1]);
  let line = 0; const keyed = boxes.map((b, i) => { if (i && b[0][1] - boxes[i - 1][0][1] >= 10) line++; return { b, line }; });
  keyed.sort((a, b) => a.line - b.line || a.b[0][0] - b.b[0][0]);
  return keyed.map(k => k.b);
}

// crop the quad to an upright rectangle (affine through 3 corners, bilinear, edge replicate)
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
  let res = { w: cw, h: ch, d: out };
  if (ch / cw >= 1.5) {                       // vertical text: np.rot90 (counter-clockwise)
    const r = new Uint8ClampedArray(out.length);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const ny = cw - 1 - x, nx = y; r.set(out.subarray((y * cw + x) * 4, (y * cw + x) * 4 + 4), (ny * ch + nx) * 4);
    }
    res = { w: ch, h: cw, d: r };
  }
  return res;
}

async function recognize(crops) {
  const order = crops.map((c, i) => [c.w / c.h, i]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  const res = new Array(crops.length);
  for (let s = 0; s < order.length; s += REC_BATCH) {
    const ids = order.slice(s, s + REC_BATCH);
    const maxR = Math.max(REC_W / REC_H, ...ids.map(i => crops[i].w / crops[i].h));
    const W = Math.trunc(REC_H * maxR), t = new Float32Array(ids.length * 3 * REC_H * W);
    ids.forEach((i, k) => {
      const c = crops[i], rw = Math.min(W, Math.ceil(REC_H * c.w / c.h));
      toTensor(resizeBilinear(c, Math.max(1, rw), REC_H), ids.length, W, t, k);
    });
    const out = await rec.run({ x: new ort.Tensor('float32', t, [ids.length, 3, REC_H, W]) });
    const o = out[Object.keys(out)[0]], [, T, C] = o.dims, p = o.data;
    ids.forEach((i, k) => {
      let txt = '', conf = 0, cnt = 0, prev = -1;
      for (let tt = 0; tt < T; tt++) {
        let best = 0, bv = -Infinity; const off = (k * T + tt) * C;
        for (let c = 0; c < C; c++) if (p[off + c] > bv) { bv = p[off + c]; best = c; }
        if (best !== 0 && best !== prev) { txt += chars[best]; conf += bv; cnt++; }
        prev = best;
      }
      res[i] = { txt, score: cnt ? conf / cnt : 0 };
    });
  }
  return res;
}

// one page image (RGBA) → lines in reading order + timings
export async function ocrPage(img) {
  const t0 = performance.now();
  let page = img;
  if (Math.max(img.w, img.h) > MAX_SIDE) {
    const r = MAX_SIDE / Math.max(img.w, img.h);
    page = resizeBilinear(img, r32(Math.trunc(img.w * r)), r32(Math.trunc(img.h * r)));
  }
  if (Math.min(page.w, page.h) < MIN_SIDE) throw new Error('page too small');
  const boxes = await detect(page);
  const t1 = performance.now();
  const recs = await recognize(boxes.map(b => crop(page, b)));
  const t2 = performance.now();
  return { lines: recs.filter(r => r.score >= TEXT_SCORE).map(r => r.txt), boxes: boxes.length, detMs: t1 - t0, recMs: t2 - t1 };
}
