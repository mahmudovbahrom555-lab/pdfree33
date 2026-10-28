// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  pdfDigitFix.js — digits whose ToUnicode names them wrongly (class C4,
//  tests/corpus/ERROR_CLASSES.md), for the text readers.
//
//  A PDF can draw "2011" and name its glyphs "3122" in ToUnicode: pdf.js —
//  every text reader — then gives the wrong number, and it looks right in
//  Word (26 of 269 Arabic-script corpus documents with digits, 2026-10-21).
//  The embedded font's own Unicode cmap usually knows the right digit; where
//  it disagrees with ToUnicode, the glyph's outline decides between the two
//  (js/digitGlyphs.js) — on 20 of the 46 corpus documents where they
//  disagreed it was the font's cmap that was wrong.
//
//  For each font (a Type0 font over an embedded TrueType program, the case
//  all the measured documents had) this finds the digit glyphs to correct;
//  for each page, the digits every font draws, in drawing order — the digit
//  ToUnicode names and the right one when it differs. applyDigitFix pairs
//  them with pdf.js's text items font by font; where the counts or the
//  digits themselves don't line up it changes nothing.
// ============================================================

import { contentOps, pdfLibDocOf } from './pdfActualText.js';
import { parseFont, unicodeCmap, digitGlyphs, glyphPolygons, rasterize, bbox, digitScore } from './digitGlyphs.js';

const DIGIT_BASES = [0x30, 0x660, 0x6F0];
const digitOf = ch => {
  const c = ch.codePointAt(0);
  for (const b of DIGIT_BASES) if (c >= b && c <= b + 9) return [c - b, b];
  return null;
};

// A ToUnicode CMap: code (number) → string, from bfchar and bfrange.
export function parseToUnicode(text) {
  const map = new Map();
  const hex = h => parseInt(h, 16);
  const str = h => {
    let s = '';
    for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return s;
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(hex(m[1]), str(m[2]));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = hex(m[1]), hi = hex(m[2]);
      if (hi - lo > 0xFFFF) continue;
      if (m[3][0] === '[') {
        const list = [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].map(x => str(x[1]));
        for (let c = lo; c <= hi && c - lo < list.length; c++) map.set(c, list[c - lo]);
      } else {
        const first = m[3].slice(1, -1);
        const last = parseInt(first.slice(-4), 16);
        for (let c = lo; c <= hi; c++) map.set(c, str(first.slice(0, -4)) + String.fromCharCode(last + c - lo));
      }
    }
  }
  return map;
}

// The digit glyphs of one font whose ToUnicode digit is wrong, as
// code → the right digit in ToUnicode's own script; null when the font is
// not one this reads, or has nothing to correct, or the shapes don't agree.
export function fontDigitFixes(PDFLib, ctx, fontDict, templates) {
  const { PDFName, PDFArray, PDFDict, PDFRawStream, decodePDFRawStream } = PDFLib;
  const name = k => fontDict.get(PDFName.of(k));
  if (name('Subtype') !== PDFName.of('Type0') || name('Encoding') !== PDFName.of('Identity-H')) return null;
  const desc = ctx.lookup(fontDict.lookup(PDFName.of('DescendantFonts'), PDFArray)?.get(0), PDFDict);
  if (!desc || desc.get(PDFName.of('Subtype')) !== PDFName.of('CIDFontType2')) return null;
  const file = desc.lookup(PDFName.of('FontDescriptor'), PDFDict)?.lookup(PDFName.of('FontFile2'));
  const tu = fontDict.lookup(PDFName.of('ToUnicode'));
  if (!(file instanceof PDFRawStream) || !(tu instanceof PDFRawStream)) return null;
  const c2g = desc.lookup(PDFName.of('CIDToGIDMap'));
  let gidOf = cid => cid;                                   // Identity, the default
  if (c2g instanceof PDFRawStream) {
    const m = decodePDFRawStream(c2g).decode();
    gidOf = cid => (2 * cid + 1 < m.length ? (m[2 * cid] << 8) | m[2 * cid + 1] : 0);
  }
  const font = parseFont(decodePDFRawStream(file).decode());
  if (!font) return null;
  const digits = digitGlyphs(unicodeCmap(font));
  if (!digits.size) return null;
  const names = parseToUnicode(new TextDecoder('latin1').decode(decodePDFRawStream(tu).decode()));

  // every code whose ToUnicode is one digit and whose glyph the font calls another
  const candidates = [];
  for (const [code, s] of names) {
    const said = s.length === 1 ? digitOf(s) : null;
    const g = said && gidOf(code);
    const own = said && digits.get(g);
    if (own && own[0] !== said[0]) candidates.push({ code, g, said, own });
  }
  if (!candidates.length) return null;

  // the shape decides, glyph by glyph; the font is corrected only where it
  // agrees with the font's cmap on most of them
  const height = new Map();
  for (const [g, [, base]] of digits) {
    const p = glyphPolygons(font, g);
    if (p) { const b = bbox(p); height.set(g, [b.y1 - b.y0, base, p]); }
  }
  const tallest = base => Math.max(0, ...[...height.values()].filter(([, b]) => b === base).map(([h]) => h));
  let agree = 0, judged = 0;
  for (const c of candidates) {
    const h = height.get(c.g);
    if (!h) continue;
    const img = rasterize(h[2]), relH = h[0] / (tallest(h[1]) || 1);
    judged++;
    if (digitScore(img, relH, c.own[0], templates) > digitScore(img, relH, c.said[0], templates)) agree++;
  }
  if (!judged || agree * 3 < judged * 2) return null;
  const fixes = new Map();
  for (const c of candidates) fixes.set(c.code, String.fromCharCode(c.said[1] + c.own[0]));
  return fixes;
}

// A reader for one pdf.js document: pageNum → Promise<Map<baseFont, {said,
// right}[]> | null> — per font, its digits in drawing order. null when no
// font of the page has anything to correct (the common case: one pass over
// the fonts, no content stream read).
// The reference digits, fetched only when a font needs judging.
export const loadDigitTemplates = async () => (await import('./digitTemplates.js')).digitTemplates();

export function createDigitFixReader(pdfDoc, loadTemplates) {
  const fixesByFont = new Map();                            // font dict ref tag → fixes | null
  let templates = null;
  return async pageNum => {
    const doc = await pdfLibDocOf(pdfDoc);
    if (!doc) return null;
    try {
      return await pageDigits(window.PDFLib, doc, pageNum - 1, fixesByFont, async () => (templates ??= await loadTemplates()));
    } catch {
      return null;
    }
  };
}

export async function pageDigits(PDFLib, doc, pageIndex, cache, getTemplates) {
  const { PDFName, PDFDict, PDFArray, PDFRawStream, PDFStream, PDFRef, decodePDFRawStream } = PDFLib;
  const ctx = doc.context;
  const node = doc.getPage(pageIndex).node;
  const fontsOf = res => res?.lookupMaybe(PDFName.of('Font'), PDFDict);

  // the page's fonts and its forms', and whether any needs correcting
  const seen = new Set();
  // each resource dictionary once: LibreOffice gives a page's transparency
  // groups the page's own resources, which list every group — each form opened
  // every form again, eight levels deep (234 forms on a page of 423708: k^8
  // visits, the tab froze for good)
  const visited = new Set();
  let any = false;
  const visit = async (res, depth) => {
    if (!res || visited.has(res)) return;
    visited.add(res);
    const fonts = fontsOf(res);
    if (fonts) {
      for (const [, ref] of fonts.entries()) {
        const key = ref instanceof PDFRef ? ref.tag : null;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (!cache.has(key)) {
          const dict = ctx.lookup(ref, PDFDict);
          // only a font that could need it pays for the templates
          const quick = dict && dict.get(PDFName.of('Subtype')) === PDFName.of('Type0');
          cache.set(key, quick ? fontDigitFixes(PDFLib, ctx, dict, await getTemplates()) : null);
        }
        if (cache.get(key)) any = true;
      }
    }
    const xo = res?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (xo && depth < 8) {
      for (const [, ref] of xo.entries()) {
        const form = ctx.lookup(ref);
        if (form instanceof PDFStream && form.dict.get(PDFName.of('Subtype')) === PDFName.of('Form')) {
          await visit(form.dict.lookupMaybe(PDFName.of('Resources'), PDFDict), depth + 1);
        }
      }
    }
  };
  await visit(node.Resources(), 0);
  if (!any) return null;

  // the digits each font draws, in order (all fonts: pdf.js pairs by base
  // font name, and two fonts can share one)
  const streamBytes = s => (s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents());
  const out = new Map();
  const toUni = new Map();
  const walk = (bytes, res, depth) => {
    let font = null;
    const show = strs => {
      if (!font) return;
      const { base, twoByte, names, fixes } = font;
      let list = out.get(base);
      if (!list) out.set(base, (list = []));
      for (const s of strs) {
        for (let k = 0; k + (twoByte ? 1 : 0) < s.length; k += twoByte ? 2 : 1) {
          const code = twoByte ? (s[k] << 8) | s[k + 1] : s[k];
          const said = names ? names.get(code) ?? '' : String.fromCharCode(code);
          for (const ch of said) if (digitOf(ch)) list.push({ said: ch, right: (said.length === 1 && fixes?.get(code)) || ch });
        }
      }
    };
    for (const { op, args } of contentOps(bytes)) {
      if (op === 'Tf' && args[0]?.name) {
        const ref = fontsOf(res)?.get(PDFName.of(args[0].name));
        const dict = ref && ctx.lookup(ref, PDFDict);
        if (!dict) { font = null; continue; }
        const key = ref instanceof PDFRef ? ref.tag : null;
        if (!toUni.has(dict)) {
          const tu = dict.lookup(PDFName.of('ToUnicode'));
          toUni.set(dict, tu instanceof PDFRawStream ? parseToUnicode(new TextDecoder('latin1').decode(decodePDFRawStream(tu).decode())) : null);
        }
        const baseName = dict.get(PDFName.of('BaseFont'))?.decodeText?.() ?? String(dict.get(PDFName.of('BaseFont')) ?? '').replace(/^\//, '');
        font = { base: baseName, twoByte: dict.get(PDFName.of('Subtype')) === PDFName.of('Type0'), names: toUni.get(dict), fixes: key ? cache.get(key) : null };
      } else if (op === 'Tj' || op === "'") show([args[0]?.str].filter(Boolean));
      else if (op === '"') show([args[2]?.str].filter(Boolean));
      else if (op === 'TJ') show((args[0]?.arr ?? []).map(a => a.str).filter(Boolean));
      else if (op === 'Do' && args[0]?.name && depth < 8) {
        const ref = res?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.get(PDFName.of(args[0].name));
        const form = ref && ctx.lookup(ref);
        if (form instanceof PDFStream && form.dict.get(PDFName.of('Subtype')) === PDFName.of('Form')) {
          walk(streamBytes(form), form.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? res, depth + 1);
        }
      }
    }
  };
  const contents = node.Contents();
  const parts = contents instanceof PDFArray ? contents.asArray().map(r => ctx.lookup(r)) : contents ? [contents] : [];
  const all = parts.map(streamBytes);
  const joined = new Uint8Array(all.reduce((n, b) => n + b.length + 1, 0));
  let at = 0;
  for (const b of all) { joined.set(b, at); at += b.length; joined[at++] = 0x0A; }
  walk(joined, node.Resources(), 0);
  // only fonts with something to correct are worth pairing
  for (const [base, list] of out) if (!list.some(d => d.right !== d.said)) out.delete(base);
  return out.size ? out : null;
}

// pdf.js text items with their digits corrected: per base font, the items'
// digits are walked in item order against the font's digits in drawing
// order, and an item is corrected only where every one of its digits is the
// one ToUnicode names, in that order. Not backwards: pdf.js doesn't always
// take a digit from ToUnicode — on a corpus document it gave the right
// "2018" where ToUnicode, read in drawing order, says "8102" — and a
// reversed match there would have turned the right number into the wrong
// one. A font whose digit count differs keeps its text.
export function applyDigitFix(items, baseFontOf, fixes) {
  if (!fixes) return items;
  const byFont = new Map();
  for (const it of items) {
    if (typeof it.str !== 'string' || !it.fontName) continue;
    const base = baseFontOf(it.fontName);
    if (!base || !fixes.has(base)) continue;
    if (!byFont.has(base)) byFont.set(base, []);
    byFont.get(base).push(it);
  }
  for (const [base, its] of byFont) {
    const list = fixes.get(base);
    const counts = its.map(it => [...it.str].filter(digitOf).length);
    if (counts.reduce((a, b) => a + b, 0) !== list.length) continue;
    let at = 0;
    for (let i = 0; i < its.length; i++) {
      const it = its[i], n = counts[i];
      if (!n) continue;
      const slice = list.slice(at, at + n);
      at += n;
      const mine = [...it.str].filter(digitOf);
      if (!slice.every((d, k) => d.said === mine[k])) continue;
      let k = 0;
      it.str = [...it.str].map(ch => (digitOf(ch) ? slice[k++].right : ch)).join('');
    }
  }
  return items;
}
