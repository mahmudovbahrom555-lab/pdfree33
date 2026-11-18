// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  docxFonts.js — the PDF's own fonts, embedded in the Word file PDF→Word
//  writes, so the text looks as it did and stays text.
//
//  Without them Word set every line in its default font: a certificate in
//  CircularStd, an Olympiad sheet in Calibri came out in another face, wider
//  or narrower, and lines wrapped elsewhere (owner's comparison, 2026-11-18:
//  competitor A embeds the fonts and its pages look like the PDF).
//
//  pdf.js already rebuilds each embedded font into a clean OpenType file for
//  the browser to draw with (font.data) — glyphs only it can reach: its cmap
//  maps the PDF's character codes to private-use code points. With
//  fontExtraProperties it also hands over code → that private-use point
//  (toFontChar) and code → Unicode (toUnicode). The cmap here is rebuilt from
//  those: Unicode → the glyph the PDF draws, the characters Word has in its
//  text.
//
//  Embedded only where the font's own licence allows it (OS/2 fsType, read
//  from the font in the PDF — pdf.js writes 0 in its copy): installable (0)
//  or editable (8). A "preview & print" font (4) makes Word open the whole
//  document read-only; a restricted one (2) may not be embedded at all. Those
//  stay in Word's default font. Only TrueType outlines (glyf): a CFF font's
//  rendering from an embedded file in Word is not established.
// ============================================================

const EDITABLE = 0x8;
const NOT_EMBEDDABLE = 0x2 | 0x4 | 0x200;   // restricted, preview & print, bitmap only
const MAX_FONT_BYTES  = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const tagAt = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

// tag → bytes of each table of a TrueType-outline font; null for any other
// ('OTTO' — CFF — and collections)
function tableDirectory(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const v = u32(bytes, 0);
  if (v !== 0x00010000 && v !== 0x74727565) return null;   // 'true'
  const n = u16(bytes, 4), tables = new Map();
  for (let i = 0; i < n; i++) {
    const r = 12 + 16 * i;
    if (r + 16 > bytes.length) return null;
    const off = u32(bytes, r + 8), len = u32(bytes, r + 12);
    if (off + len > bytes.length) return null;
    tables.set(tagAt(bytes, r), bytes.subarray(off, off + len));
  }
  return tables;
}

// …with what a font to embed needs (pdf.js's copy always has a cmap; a
// composite font's subset in the PDF often none)
export function sfntTables(bytes) {
  const tables = tableDirectory(bytes);
  return tables?.has('glyf') && tables.has('cmap') && tables.has('head') ? tables : null;
}

// A cmap table's best subtable as code → glyph id
export function cmapGlyphs(cmap) {
  const subs = [];
  for (let i = 0; i < u16(cmap, 2); i++) {
    const r = 4 + 8 * i;
    subs.push({ pid: u16(cmap, r), eid: u16(cmap, r + 2), off: u32(cmap, r + 4) });
  }
  const rank = s => (s.pid === 3 && s.eid === 10 ? 0 : s.pid === 3 && s.eid === 1 ? 1 : s.pid === 3 && s.eid === 0 ? 2 : s.pid === 0 ? 3 : s.pid === 1 ? 4 : 9);
  subs.sort((a, b) => rank(a) - rank(b));
  const map = new Map();
  for (const { off } of subs) {
    const f = u16(cmap, off);
    if (f === 4) {
      const segX2 = u16(cmap, off + 6);
      const ends = off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      for (let s = 0; s < segX2; s += 2) {
        const end = u16(cmap, ends + s), start = u16(cmap, starts + s);
        const delta = u16(cmap, deltas + s), ro = u16(cmap, ranges + s);
        for (let c = start; c <= end && c !== 0xFFFF; c++) {
          let g;
          if (ro === 0) g = (c + delta) & 0xFFFF;
          else {
            const at = ranges + s + ro + 2 * (c - start);
            if (at + 1 >= cmap.length) continue;
            g = u16(cmap, at);
            if (g) g = (g + delta) & 0xFFFF;
          }
          if (g) map.set(c, g);
        }
      }
    } else if (f === 12) {
      const n = u32(cmap, off + 12);
      for (let i = 0; i < n; i++) {
        const r = off + 16 + 12 * i, a = u32(cmap, r), z = u32(cmap, r + 4), g = u32(cmap, r + 8);
        for (let c = a; c <= z && c - a < 0x10000; c++) map.set(c, g + c - a);
      }
    } else if (f === 0) {
      for (let c = 0; c < 256; c++) if (cmap[off + 6 + c]) map.set(c, cmap[off + 6 + c]);
    } else if (f === 6) {
      const first = u16(cmap, off + 6), n = u16(cmap, off + 8);
      for (let i = 0; i < n; i++) { const g = u16(cmap, off + 10 + 2 * i); if (g) map.set(first + i, g); }
    } else continue;
    if (map.size) break;
  }
  return map;
}

// The font's own family and style, from its name table
export function fontNames(name) {
  const count = u16(name, 2), strOff = u16(name, 4), got = {};
  for (let i = 0; i < count; i++) {
    const r = 6 + 12 * i;
    const pid = u16(name, r), eid = u16(name, r + 2), id = u16(name, r + 6);
    const len = u16(name, r + 8), off = strOff + u16(name, r + 10);
    if (![1, 2, 16, 17].includes(id) || off + len > name.length) continue;
    let s = '';
    if (pid === 3 || pid === 0) for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(u16(name, off + k));
    else if (pid === 1 && eid === 0) for (let k = 0; k < len; k++) s += String.fromCharCode(name[off + k]);
    else continue;
    s = s.replace(/\0/g, '').trim();
    if (s && (got[id] === undefined || pid === 3)) got[id] = s;
  }
  return { family: got[16] || got[1], style: got[17] || got[2] };
}

// ── writing ────────────────────────────────────────────────

function cmapTable(map) {
  const pairs = [...map].sort((a, b) => a[0] - b[0]);
  const bmp = pairs.filter(([c]) => c <= 0xFFFE);
  // format 4: runs of consecutive codes on consecutive glyphs
  const segs = [];
  for (const [c, g] of bmp) {
    const last = segs[segs.length - 1];
    if (last && c === last.end + 1 && g - c === last.d) last.end = c;
    else segs.push({ start: c, end: c, d: g - c });
  }
  segs.push({ start: 0xFFFF, end: 0xFFFF, d: 1 });
  const segX2 = segs.length * 2;
  const f4 = new Uint8Array(16 + 4 * segX2);
  const dv = new DataView(f4.buffer);
  let sr = 1, es = 0;
  while (sr * 2 <= segs.length) { sr *= 2; es++; }
  dv.setUint16(0, 4); dv.setUint16(2, f4.length); dv.setUint16(6, segX2);
  dv.setUint16(8, sr * 2); dv.setUint16(10, es); dv.setUint16(12, segX2 - sr * 2);
  segs.forEach((s, i) => {
    dv.setUint16(14 + 2 * i, s.end);
    dv.setUint16(16 + segX2 + 2 * i, s.start);
    dv.setUint16(16 + 2 * segX2 + 2 * i, s.d & 0xFFFF);
  });
  const astral = pairs.some(([c]) => c > 0xFFFF);
  let f12 = null;
  if (astral) {
    const groups = [];
    for (const [c, g] of pairs) {
      const last = groups[groups.length - 1];
      if (last && c === last[1] + 1 && g === last[2] + c - last[0]) last[1] = c;
      else groups.push([c, c, g]);
    }
    f12 = new Uint8Array(16 + 12 * groups.length);
    const d = new DataView(f12.buffer);
    d.setUint16(0, 12); d.setUint32(4, f12.length); d.setUint32(12, groups.length);
    groups.forEach(([a, z, g], i) => { d.setUint32(16 + 12 * i, a); d.setUint32(20 + 12 * i, z); d.setUint32(24 + 12 * i, g); });
  }
  const subs = [[3, 1, f4], ...(f12 ? [[3, 10, f12]] : [])];
  const head = 4 + 8 * subs.length;
  const out = new Uint8Array(head + f4.length + (f12?.length ?? 0));
  const o = new DataView(out.buffer);
  o.setUint16(2, subs.length);
  let at = head;
  subs.forEach(([p, e, t], i) => { o.setUint16(4 + 8 * i, p); o.setUint16(6 + 8 * i, e); o.setUint32(8 + 8 * i, at); out.set(t, at); at += t.length; });
  return out;
}

function nameTable(family, style) {
  const ps = `${family}-${style}`.replace(/[^\x21-\x7E]|[[\](){}<>/%]/g, '').slice(0, 63) || 'PDFreeFont';
  const recs = [[1, family], [2, style], [3, `PDFree: ${family} ${style}`], [4, style === 'Regular' ? family : `${family} ${style}`], [6, ps]];
  const strs = recs.map(([, s]) => { const b = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { b[2 * i] = s.charCodeAt(i) >> 8; b[2 * i + 1] = s.charCodeAt(i) & 0xFF; } return b; });
  const head = 6 + 12 * recs.length;
  const out = new Uint8Array(head + strs.reduce((n, b) => n + b.length, 0));
  const d = new DataView(out.buffer);
  d.setUint16(2, recs.length); d.setUint16(4, head);
  let off = 0;
  recs.forEach(([id], i) => {
    const r = 6 + 12 * i;
    d.setUint16(r, 3); d.setUint16(r + 2, 1); d.setUint16(r + 4, 0x409); d.setUint16(r + 6, id);
    d.setUint16(r + 8, strs[i].length); d.setUint16(r + 10, off);
    out.set(strs[i], head + off); off += strs[i].length;
  });
  return out;
}

// OS/2 unicode ranges [bit, from, to] and Windows code pages [bit, test]:
// Word picks a font for a script by these, and pdf.js's copy describes its
// private-use code points
const RANGES = [[0, 0x20, 0x7E], [1, 0x80, 0xFF], [2, 0x100, 0x17F], [3, 0x180, 0x24F], [7, 0x370, 0x3FF],
  [9, 0x400, 0x52F], [11, 0x590, 0x5FF], [13, 0x600, 0x6FF], [31, 0x2000, 0x206F], [33, 0x20A0, 0x20CF]];
const CODEPAGES = [[0, c => c >= 0x41 && c <= 0x7A], [1, c => c >= 0x100 && c <= 0x17F], [2, c => c >= 0x400 && c <= 0x4FF],
  [3, c => c >= 0x370 && c <= 0x3FF], [5, c => c >= 0x590 && c <= 0x5FF], [6, c => c >= 0x600 && c <= 0x6FF]];

function os2Table(os2, fsType, codes) {
  const out = os2.slice();
  const d = new DataView(out.buffer, out.byteOffset, out.byteLength);
  d.setUint16(8, fsType);
  if (out.length >= 68) {
    const ur = [0, 0, 0, 0];
    for (const [bit, a, z] of RANGES) if (codes.some(c => c >= a && c <= z)) ur[bit >> 5] |= 1 << (bit & 31);
    ur.forEach((v, i) => d.setUint32(42 + 4 * i, v >>> 0));
    const bmp = codes.filter(c => c <= 0xFFFF);
    if (bmp.length) { d.setUint16(64, Math.min(...bmp)); d.setUint16(66, Math.max(...bmp)); }
  }
  if (out.length >= 86) {
    let cp = 0;
    for (const [bit, test] of CODEPAGES) if (codes.some(test)) cp |= 1 << bit;
    d.setUint32(78, cp >>> 0); d.setUint32(82, 0);
  }
  return out;
}

const checksum = b => {
  let s = 0;
  for (let i = 0; i < b.length; i += 4) s = (s + ((b[i] << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0))) >>> 0;
  return s;
};

export function writeSfnt(tables) {
  const tags = [...tables.keys()].sort();
  const n = tags.length;
  let sr = 1, es = 0;
  while (sr * 2 <= n) { sr *= 2; es++; }
  let size = 12 + 16 * n;
  for (const t of tags) size += (tables.get(t).length + 3) & ~3;
  const out = new Uint8Array(size);
  const d = new DataView(out.buffer);
  d.setUint32(0, 0x00010000); d.setUint16(4, n); d.setUint16(6, sr * 16); d.setUint16(8, es); d.setUint16(10, n * 16 - sr * 16);
  let at = 12 + 16 * n, headAt = -1;
  tags.forEach((t, i) => {
    let b = tables.get(t);
    if (t === 'head') { b = b.slice(); new DataView(b.buffer, b.byteOffset).setUint32(8, 0); headAt = at; }
    const r = 12 + 16 * i;
    for (let k = 0; k < 4; k++) out[r + k] = t.charCodeAt(k);
    d.setUint32(r + 4, checksum(b)); d.setUint32(r + 8, at); d.setUint32(r + 12, b.length);
    out.set(b, at);
    at += (b.length + 3) & ~3;
  });
  if (headAt >= 0) d.setUint32(headAt + 8, (0xB1B0AFBA - checksum(out)) >>> 0);
  return out;
}

// A glyph with no outline whose advance is width/1000 em, the nearest one
// within 2 %: the font's own space
export function blankGlyph(tables, width) {
  const head = tables.get('head'), hhea = tables.get('hhea'), hmtx = tables.get('hmtx');
  const loca = tables.get('loca'), maxp = tables.get('maxp');
  if (!hhea || !hmtx || !loca || !maxp) return 0;
  const upm = u16(head, 18), long = u16(head, 50) === 1, n = u16(maxp, 4), metrics = u16(hhea, 34);
  const at = g => (long ? u32(loca, 4 * g) : 2 * u16(loca, 2 * g));
  const want = width * upm / 1000;
  let best = 0, bestD = Infinity;
  for (let g = 1; g < n; g++) {
    if ((long ? 4 : 2) * (g + 1) + (long ? 3 : 1) >= loca.length) break;
    if (at(g + 1) !== at(g)) continue;   // has an outline
    const adv = u16(hmtx, 4 * Math.min(g, metrics - 1));
    const d = Math.abs(adv - want);
    if (d < bestD) { best = g; bestD = d; }
  }
  return bestD <= 0.02 * upm ? best : 0;
}

// ── the PDF's licences ─────────────────────────────────────

const _baseName = s => String(s || '').replace(/^\/?[A-Z]{6}\+/, '').replace(/-(Identity-[HV]|UniGB.*|UniJIS.*)$/, '');

// The font's own fsType from its FontFile2 stream: the first OS/2 found, by
// base name (no subset prefix). Fonts without one, or unreadable, are absent.
export function fontLicenses(PDFLib, doc) {
  const { PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } = PDFLib;
  const out = new Map();
  const visit = (font, outer) => {
    const desc = font.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
    const file = desc?.lookup(PDFName.of('FontFile2'));
    if (!(file instanceof PDFRawStream)) return;
    const names = [font.lookup(PDFName.of('BaseFont')), outer?.lookup(PDFName.of('BaseFont'))].filter(Boolean).map(n => _baseName(n.decodeText?.() ?? n.asString?.() ?? n.toString()));
    if (names.every(n => out.has(n))) return;
    let fsType = null;
    try {
      const bytes = decodePDFRawStream(file).decode();
      const os2 = tableDirectory(bytes)?.get('OS/2');
      if (os2 && os2.length >= 10) fsType = u16(os2, 8);
    } catch { /* unreadable stream: no licence known */ }
    if (fsType !== null) for (const n of names) if (!out.has(n)) out.set(n, fsType);
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.lookup(PDFName.of('Type'))?.toString() !== '/Font') continue;
    const sub = obj.lookup(PDFName.of('Subtype'))?.toString();
    if (sub === '/TrueType') visit(obj);
    else if (sub === '/Type0') {
      const kids = obj.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray);
      const kid = kids?.lookupMaybe(0, PDFDict);
      if (kid) visit(kid, obj);
    }
  }
  return out;
}

// ── the fonts of one document ─────────────────────────────

// Scripts whose letters join or reorder (Arabic, Hebrew, Syriac, the Indic
// scripts, Thai, Tibetan, Myanmar, Khmer): drawn from contextual forms the
// font's shaping tables pick, and pdf.js's copy has none. Persian set in an
// embedded font came out as a page of boxes in LibreOffice (multi-page
// corpus, 2 of 188 documents, 2026-11-18); Word's own fonts shape them.
const SHAPED_SCRIPT_RE = /[\u0590-\u08FF\u0900-\u0DFF\u0E00-\u0FFF\u1000-\u109F\u1780-\u17FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

const _isBold = s => /bold|black|heavy|semibold|demibold/i.test(s);
const _isItalic = s => /italic|oblique/i.test(s);

// Collects the fonts a PDF→Word run draws with. faceOf(pdf.js font object,
// text) → { face, bold, italic } for a run in an embedded font, undefined for
// one left to Word (not TrueType, licence forbids, unknown, too big, a
// character missing). files() → the fonts for embedDocxFonts.
export function createFontSet(licenses) {
  const byLoaded = new Map();            // pdf.js loadedName → result
  const families = new Map();            // face → { regular, bold, italic, boldItalic }
  let total = 0;

  const build = f => {
    const fsType = licenses.get(_baseName(f.name));
    if (fsType === undefined || fsType & NOT_EMBEDDABLE) return undefined;
    const tables = sfntTables(f.data);
    if (!tables || !tables.has('name') || !tables.has('OS/2')) return undefined;
    const fontChar = f.toFontChar, toUni = f.toUnicode;
    if (!fontChar || !toUni) return undefined;
    const glyphs = cmapGlyphs(tables.get('cmap'));
    const uni = new Map();
    const map = toUni._map;
    for (const code of Object.keys(fontChar)) {
      const fc = fontChar[code];
      const u = map ? map[code] : (toUni.firstChar !== undefined && code >= toUni.firstChar && code <= toUni.lastChar ? String.fromCodePoint(+code) : undefined);
      if (typeof u !== 'string' || !u) continue;
      const cp = u.codePointAt(0);
      if (u.length !== String.fromCodePoint(cp).length || cp < 0x20) continue;   // ligatures and controls
      const g = glyphs.get(fc);
      if (g && !uni.has(cp)) uni.set(cp, g);
    }
    // pdf.js leaves blank glyphs out of its cmap, the space among them: the
    // blank glyph as wide as the PDF's space, so Word doesn't set the spaces
    // in another font
    const spaceCode = map ? Object.keys(map).find(k => map[k] === ' ') : undefined;
    if (!uni.has(0x20) && spaceCode !== undefined && f.widths?.[spaceCode]) {
      const g = blankGlyph(tables, f.widths[spaceCode]);
      if (g) uni.set(0x20, g);
    }
    if (!uni.size) return undefined;
    const own = fontNames(tables.get('name'));
    const family = (own.family || _baseName(f.name).replace(/[-,].*$/, '')).replace(/[^\p{L}\p{N} ]/gu, '').trim() || 'Embedded';
    const style = own.style || _baseName(f.name);
    const bold = _isBold(style) || !!f.bold, italic = _isItalic(style) || !!f.italic;
    const slot = bold ? (italic ? 'boldItalic' : 'bold') : italic ? 'italic' : 'regular';
    // one family, one file per style. The same file the PDF holds twice (a
    // simple and a composite font on one subset: an Olympiad sheet's Calibri
    // Bold) is one font, its characters joined; another subset of the same
    // face keeps other glyphs, so it takes a family of its own
    const glyf = tables.get('glyf'), key = `${glyf.length}:${checksum(glyf)}:${checksum(tables.get('loca') ?? glyf)}`;
    let face = family;
    for (let k = 2; families.get(face)?.[slot] && families.get(face)[slot].key !== key; k++) face = `${family} ${k}`;
    if (!families.has(face)) families.set(face, {});
    const fam = families.get(face);
    if (fam[slot] && fam[slot].key === key) {
      for (const [c, g] of uni) if (!fam[slot].uni.has(c)) fam[slot].uni.set(c, g);
    } else {
      const size = [...tables.values()].reduce((n, t) => n + t.length, 0);
      if (size > MAX_FONT_BYTES || total + size > MAX_TOTAL_BYTES) return undefined;
      total += size;
      fam[slot] = { key, tables, uni, fsType };
    }
    return { face, bold, italic, rec: fam[slot] };
  };

  return {
    // { face, bold, italic } for text drawn in pdf.js font f, when the
    // embedded font has every character of it — else Word would set the
    // missing ones in another font, mid-word
    faceOf(f, text) {
      if (!f?.loadedName) return undefined;
      if (!byLoaded.has(f.loadedName)) {
        let r;
        try { r = f.data ? build(f) : undefined; } catch { r = undefined; }
        byLoaded.set(f.loadedName, r);
      }
      const r = byLoaded.get(f.loadedName);
      if (!r || SHAPED_SCRIPT_RE.test(text)) return undefined;
      for (const ch of text) if (!/\s/.test(ch) && !r.rec.uni.has(ch.codePointAt(0))) return undefined;
      r.rec.used = true;
      return { face: r.face, bold: r.bold, italic: r.italic };
    },
    // the fonts some run is set in
    files() {
      return [...families].filter(([, fam]) => SLOTS.some(([slot]) => fam[slot]?.used)).map(([face, fam]) => {
        const out = { face, codes: new Set() };
        for (const [slot] of SLOTS) {
          const r = fam[slot];
          if (!r?.used) continue;
          const codes = [...r.uni.keys()];
          const t = new Map(r.tables);
          t.set('cmap', cmapTable(r.uni));
          t.set('name', nameTable(face, { regular: 'Regular', bold: 'Bold', italic: 'Italic', boldItalic: 'Bold Italic' }[slot]));
          t.set('OS/2', os2Table(r.tables.get('OS/2'), r.fsType & EDITABLE, codes));
          out[slot] = writeSfnt(t);
          for (const c of codes) out.codes.add(c);
        }
        return out;
      });
    },
  };
}

// ── into the .docx ────────────────────────────────────────

const _guid = () => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

// ECMA-376 Part 2 §… font obfuscation: the first 32 bytes XOR the key's
// bytes, the GUID read backwards
export function obfuscateFont(bytes, guid) {
  const key = guid.replace(/-/g, '').match(/../g).map(h => parseInt(h, 16)).reverse();
  const out = bytes.slice();
  for (let i = 0; i < 32 && i < out.length; i++) out[i] ^= key[i % 16];
  return out;
}

// <x …/> → <x …></x>, so children can go in
const _open = (xml, tag) => xml.replace(new RegExp(`<${tag}(\\b[^>]*?)\\s*/>`), `<${tag}$1></${tag}>`);
const _esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SLOTS = [['regular', 'embedRegular'], ['bold', 'embedBold'], ['italic', 'embedItalic'], ['boldItalic', 'embedBoldItalic']];

// The written .docx with the fonts in it: word/fonts/*.odttf, their entries
// in fontTable.xml, and embedTrueTypeFonts in settings.xml so Word keeps them
// when the file is saved again. The same Blob when there are none.
export async function embedDocxFonts(blob, JSZip, files) {
  if (!files.length) return blob;
  const zip = await JSZip.loadAsync(blob);
  const tablePath = 'word/fontTable.xml', relsPath = 'word/_rels/fontTable.xml.rels';
  let table = (await zip.file(tablePath)?.async('string')) ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"></w:fonts>';
  if (!/xmlns:r=/.test(table)) table = table.replace('<w:fonts ', '<w:fonts xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
  table = _open(table, 'w:fonts');
  const rels = [];
  let entries = '', n = 0;
  for (const fam of files) {
    // a font of that name the writer listed is replaced by this one
    table = table.replace(new RegExp(`<w:font w:name="${_esc(fam.face).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^]*?</w:font>`), '');
    let embeds = '';
    for (const [slot, el] of SLOTS) {
      if (!fam[slot]) continue;
      const guid = _guid(), id = `rIdFont${++n}`;
      zip.file(`word/fonts/font${n}.odttf`, obfuscateFont(fam[slot], guid));
      rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font${n}.odttf"/>`);
      embeds += `<w:${el} r:id="${id}" w:fontKey="{${guid}}"/>`;
    }
    const codes = [...fam.codes];
    let cp = 0, ur = 0;
    for (const [bit, test] of CODEPAGES) if (codes.some(test)) cp |= 1 << bit;
    for (const [bit, a, z] of RANGES) if (bit < 32 && codes.some(c => c >= a && c <= z)) ur |= 1 << bit;
    const hex = v => (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
    entries += `<w:font w:name="${_esc(fam.face)}"><w:charset w:val="00"/><w:family w:val="auto"/><w:pitch w:val="variable"/>`
      + `<w:sig w:usb0="${hex(ur)}" w:usb1="00000000" w:usb2="00000000" w:usb3="00000000" w:csb0="${hex(cp)}" w:csb1="00000000"/>${embeds}</w:font>`;
  }
  zip.file(tablePath, table.replace('</w:fonts>', `${entries}</w:fonts>`));
  const oldRels = await zip.file(relsPath)?.async('string');
  zip.file(relsPath, oldRels
    ? _open(oldRels, 'Relationships').replace('</Relationships>', `${rels.join('')}</Relationships>`)
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
  // docx writes fontTable.xml but links it only when it has fonts of its own:
  // unlinked, neither Word nor LibreOffice reads it, and no font loads
  const docRelsPath = 'word/_rels/document.xml.rels';
  const docRels = await zip.file(docRelsPath)?.async('string');
  if (docRels && !/relationships\/fontTable"/.test(docRels)) {
    zip.file(docRelsPath, _open(docRels, 'Relationships').replace('</Relationships>',
      '<Relationship Id="rIdFontTable" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/></Relationships>'));
  }
  let types = await zip.file('[Content_Types].xml').async('string');
  if (!/PartName="\/word\/fontTable\.xml"/.test(types)) {
    types = types.replace('</Types>', '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/></Types>');
  }
  if (!/Extension="odttf"/.test(types)) {
    types = types.replace('</Types>', '<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/></Types>');
  }
  zip.file('[Content_Types].xml', types);
  const settings = await zip.file('word/settings.xml')?.async('string');
  if (settings && !/embedTrueTypeFonts/.test(settings)) {
    // in the schema's order: after the elements that precede it (Word
    // refuses a settings part out of order)
    const before = /<w:(?:writeProtection|view|zoom|removePersonalInformation|removeDateAndTime|doNotDisplayPageBoundaries|displayBackgroundShape|printPostScriptOverText|printFractionalCharacterWidth|printFormsData)\b(?:[^>]*\/>|[^]*?<\/w:(?:writeProtection|view|zoom|removePersonalInformation|removeDateAndTime|doNotDisplayPageBoundaries|displayBackgroundShape|printPostScriptOverText|printFractionalCharacterWidth|printFormsData)>)/g;
    let at = -1;
    for (const m of settings.matchAll(before)) at = m.index + m[0].length;
    if (at < 0) at = settings.search(/<w:settings\b[^>]*>/) + settings.match(/<w:settings\b[^>]*>/)[0].length;
    zip.file('word/settings.xml', `${settings.slice(0, at)}<w:embedTrueTypeFonts/>${settings.slice(at)}`);
  }
  return zip.generateAsync({ type: 'blob', mimeType: blob.type, compression: 'DEFLATE' });
}
