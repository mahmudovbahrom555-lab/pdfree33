// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  digitGlyphs.js — which digit a TrueType glyph draws, from its outline.
//
//  Class C4 (tests/corpus/ERROR_CLASSES.md): some PDFs name their digit
//  glyphs wrongly in ToUnicode — B Nazanin's "zero" glyph read as "3", an
//  Arial "2011" read as "3122" — and both text readers, pdf.js included,
//  give the wrong number. The embedded font's own Unicode cmap often knows
//  the right digit, but not always: on 20 of the 46 corpus documents where
//  the two disagreed, the cmap was the wrong one. The glyph's shape decides
//  between the two: its outline, rasterized to a 24×24 square, against
//  reference digits made the same way from system fonts (Latin, Arabic-Indic,
//  Persian — js/digitTemplates.js, scripts/gen_digit_templates.mjs).
//  Measured on 120 hand-labeled glyphs: 54/54, and 57/57 on documents it was
//  not tuned on (scripts/corpus-cloud/c4/).
//
//  Pure byte parsing and arithmetic: the same code runs in the browser, in
//  Node for the tests and to build the templates.
// ============================================================

export const SIZE = 24;
const RASTER = SIZE * 4;          // drawn at 96 px, averaged down 4×4
const DIGIT_BASES = [0x6F0, 0x660, 0x30];   // Persian, Arabic-Indic, Latin

// ── sfnt tables ──────────────────────────────────────────────────────────
// A TrueType font program (FontFile2), or one font of a collection (.ttc).
export function parseFont(bytes, index = 0) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let base = 0;
  if (v.getUint32(0) === 0x74746366) base = v.getUint32(12 + 4 * index);  // 'ttcf'
  const n = v.getUint16(base + 4);
  const tables = {};
  for (let k = 0; k < n; k++) {
    const r = base + 12 + 16 * k;
    tables[String.fromCharCode(v.getUint8(r), v.getUint8(r + 1), v.getUint8(r + 2), v.getUint8(r + 3))] =
      { off: v.getUint32(r + 8), len: v.getUint32(r + 12) };
  }
  if (!tables.glyf || !tables.loca || !tables.head || !tables.maxp) return null;
  const numGlyphs = v.getUint16(tables.maxp.off + 4);
  const longLoca = v.getInt16(tables.head.off + 50) === 1;
  const loca = new Uint32Array(numGlyphs + 1);
  for (let g = 0; g <= numGlyphs; g++) {
    loca[g] = longLoca ? v.getUint32(tables.loca.off + 4 * g) : v.getUint16(tables.loca.off + 2 * g) * 2;
  }
  return { v, tables, numGlyphs, loca };
}

// The font's Unicode cmap (format 4 or 12 subtables of platform 0, or 3/1,
// 3/10) as code point → glyph id. Mac Roman (1,0) and symbol (3,0) tables
// map character codes, not Unicode — a "0x30" there is no digit zero.
export function unicodeCmap(font) {
  const { v, tables } = font;
  const out = new Map();
  if (!tables.cmap) return out;
  const c = tables.cmap.off;
  const n = v.getUint16(c + 2);
  for (let k = 0; k < n; k++) {
    const pid = v.getUint16(c + 4 + 8 * k), eid = v.getUint16(c + 6 + 8 * k);
    if (!(pid === 0 || (pid === 3 && (eid === 1 || eid === 10)))) continue;
    const s = c + v.getUint32(c + 8 + 8 * k);
    const format = v.getUint16(s);
    if (format === 4) {
      const segX2 = v.getUint16(s + 6);
      const ends = s + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      for (let i = 0; i < segX2; i += 2) {
        const end = v.getUint16(ends + i), start = v.getUint16(starts + i);
        const delta = v.getInt16(deltas + i), ro = v.getUint16(ranges + i);
        for (let cp = start; cp <= end && cp !== 0xFFFF; cp++) {
          let g;
          if (ro === 0) g = (cp + delta) & 0xFFFF;
          else {
            g = v.getUint16(ranges + i + ro + 2 * (cp - start));
            if (g) g = (g + delta) & 0xFFFF;
          }
          if (g && !out.has(cp)) out.set(cp, g);
        }
      }
    } else if (format === 12) {
      const groups = v.getUint32(s + 12);
      for (let i = 0; i < groups; i++) {
        const r = s + 16 + 12 * i;
        const start = v.getUint32(r), end = v.getUint32(r + 4), g0 = v.getUint32(r + 8);
        for (let cp = start; cp <= end && cp - start < 0x10000; cp++) if (!out.has(cp)) out.set(cp, g0 + cp - start);
      }
    }
  }
  return out;
}

// Glyph id → [digit value, base] for every glyph the cmap names a digit.
export function digitGlyphs(cmap) {
  const out = new Map();
  for (const base of DIGIT_BASES) {
    for (let d = 0; d < 10; d++) {
      const g = cmap.get(base + d);
      if (g !== undefined && !out.has(g)) out.set(g, [d, base]);
    }
  }
  return out;
}

// ── outlines ─────────────────────────────────────────────────────────────
// A glyph's contours as closed polygons, in font units; composite glyphs
// are their parts moved by their offsets (scaling ignored — digits don't use
// it). null when the glyph is empty or unreadable.
export function glyphPolygons(font, gid, depth = 0) {
  const { v, tables, loca, numGlyphs } = font;
  if (gid >= numGlyphs || depth > 4) return null;
  const off = tables.glyf.off + loca[gid];
  if (loca[gid + 1] <= loca[gid]) return null;
  const nC = v.getInt16(off);
  if (nC < 0) {                                       // composite
    const polys = [];
    let p = off + 10, more = true;
    while (more) {
      const flags = v.getUint16(p), comp = v.getUint16(p + 2);
      p += 4;
      let dx, dy;
      if (flags & 1) { dx = v.getInt16(p); dy = v.getInt16(p + 2); p += 4; } else { dx = v.getInt8(p); dy = v.getInt8(p + 1); p += 2; }
      if (flags & 8) p += 2; else if (flags & 0x40) p += 4; else if (flags & 0x80) p += 8;
      const part = glyphPolygons(font, comp, depth + 1);
      if (part && (flags & 2)) for (const poly of part) polys.push(poly.map(([x, y]) => [x + dx, y + dy]));
      more = !!(flags & 0x20);
    }
    return polys.length ? polys : null;
  }
  if (nC === 0) return null;
  const ends = [];
  for (let k = 0; k < nC; k++) ends.push(v.getUint16(off + 10 + 2 * k));
  const nPts = ends[nC - 1] + 1;
  let p = off + 10 + 2 * nC;
  p += 2 + v.getUint16(p);                            // instructions
  const flags = [];
  while (flags.length < nPts) {
    const f = v.getUint8(p++);
    flags.push(f);
    if (f & 8) { let r = v.getUint8(p++); while (r-- > 0) flags.push(f); }
  }
  const coord = (shortBit, sameBit) => {
    const out = [];
    let c = 0;
    for (const f of flags) {
      if (f & shortBit) { const d = v.getUint8(p++); c += (f & sameBit) ? d : -d; }
      else if (!(f & sameBit)) { c += v.getInt16(p); p += 2; }
      out.push(c);
    }
    return out;
  };
  const xs = coord(2, 16), ys = coord(4, 32);
  const polys = [];
  let start = 0;
  for (const end of ends) {
    const pts = [];
    for (let k = start; k <= end; k++) pts.push([xs[k], ys[k], !!(flags[k] & 1)]);
    start = end + 1;
    if (pts.length > 1) polys.push(flatten(pts));
  }
  return polys.length ? polys : null;
}

// Quadratic contour → polygon: implied on-curve points between two
// off-curve ones, each curve in 6 straight steps.
function flatten(pts) {
  const n = pts.length;
  const on = k => pts[k % n];
  let s = pts.findIndex(q => q[2]);
  if (s < 0) {                                        // all off-curve: start at a midpoint
    const a = pts[0], b = pts[1];
    pts = [[(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, true], ...pts.slice(1), pts[0]];
    s = 0;
  }
  const out = [];
  let prev = on(s);
  out.push([prev[0], prev[1]]);
  for (let k = 1; k <= n; k++) {
    const q = on(s + k);
    if (q[2]) { out.push([q[0], q[1]]); prev = q; continue; }
    const nx = on(s + k + 1);
    const end = nx[2] ? nx : [(q[0] + nx[0]) / 2, (q[1] + nx[1]) / 2, true];
    for (let t = 1; t <= 6; t++) {
      const u = t / 6, a = (1 - u) * (1 - u), b = 2 * u * (1 - u), c = u * u;
      out.push([a * prev[0] + b * q[0] + c * end[0], a * prev[1] + b * q[1] + c * end[1]]);
    }
    prev = end;
    if (nx[2]) k++;
  }
  return out;
}

export function bbox(polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of polys) for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}

// The glyph filled (non-zero winding) into a square, ink bbox fitted and
// centred, 96 px averaged down to SIZE×SIZE: values 0..1.
export function rasterize(polys) {
  const { x0, y0, x1, y1 } = bbox(polys);
  const w = x1 - x0 || 1, h = y1 - y0 || 1;
  const k = (RASTER - 1) / Math.max(w, h);
  const ox = (RASTER - w * k) / 2, oy = (RASTER - h * k) / 2;
  const edges = [];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
      const p = [ox + (ax - x0) * k, oy + (y1 - ay) * k], q = [ox + (bx - x0) * k, oy + (y1 - by) * k];
      if (p[1] !== q[1]) edges.push(p[1] < q[1] ? [p, q, 1] : [q, p, -1]);
    }
  }
  const big = new Uint8Array(RASTER * RASTER);
  for (let row = 0; row < RASTER; row++) {
    const y = row + 0.5, hits = [];
    for (const [p, q, dir] of edges) if (y >= p[1] && y < q[1]) hits.push([p[0] + (y - p[1]) * (q[0] - p[0]) / (q[1] - p[1]), dir]);
    hits.sort((a, b) => a[0] - b[0]);
    let wind = 0;
    for (let i = 0; i < hits.length - 1; i++) {
      wind += hits[i][1];
      if (wind === 0) continue;
      for (let col = Math.max(0, Math.ceil(hits[i][0] - 0.5)); col < Math.min(RASTER, hits[i + 1][0] - 0.5); col++) big[row * RASTER + col] = 1;
    }
  }
  const img = new Float32Array(SIZE * SIZE);
  for (let r = 0; r < RASTER; r++) for (let c = 0; c < RASTER; c++) if (big[r * RASTER + c]) img[(r >> 2) * SIZE + (c >> 2)] += 1 / 16;
  return img;
}

// How well a glyph matches a digit: the best cosine similarity against that
// digit's references, less half the gap in relative height — an
// Arabic-Indic zero is a dot, and squares of the same dot look alike.
export function digitScore(img, relH, value, templates) {
  let best = -1;
  let ii = 0;
  for (const v of img) ii += v * v;
  for (const t of templates) {
    if (t.value !== value) continue;
    let it = 0;
    for (let i = 0; i < img.length; i++) it += img[i] * t.img[i];
    best = Math.max(best, it / (Math.sqrt(ii * t.norm2) + 1e-6) - 0.5 * Math.abs(relH - t.relH));
  }
  return best;
}

// Reference digits from fonts: { value, relH, img, norm2 }[] — relH is the
// glyph's height over the tallest digit of the same script in its font.
export function fontTemplates(font) {
  const cmap = unicodeCmap(font);
  const out = [];
  for (const base of DIGIT_BASES) {
    const glyphs = [];
    for (let d = 0; d < 10; d++) {
      const g = cmap.get(base + d);
      const polys = g !== undefined ? glyphPolygons(font, g) : null;
      if (polys) glyphs.push([d, polys, bbox(polys)]);
    }
    if (glyphs.length < 10) continue;
    const tallest = Math.max(...glyphs.map(([, , b]) => b.y1 - b.y0));
    for (const [d, polys, b] of glyphs) {
      const img = rasterize(polys);
      out.push({ value: d, relH: (b.y1 - b.y0) / tallest, img, norm2: img.reduce((s, x) => s + x * x, 0) });
    }
  }
  return out;
}
