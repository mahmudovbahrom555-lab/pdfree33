// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  pdfActualText.js — a page's marked-content /ActualText, for the text
//  readers (PDF→Word, PowerPoint, Read).
//
//  Chrome and LibreOffice write Arabic the way it is drawn — shaped glyphs —
//  and give the real letters in /ActualText around them: Chrome every initial
//  or medial yeh (a glyph whose ToUnicode says Persian yeh, U+FBFE), LibreOffice
//  every letter with a vowel mark. pdf.js 3.11 drops /ActualText (its marked
//  content carries only MCID), so PDF→Word wrote "یقدم ھذا التقریر" for
//  "يقدم هذا التقرير" — a dot wrong in every other word, search and spell-check
//  broken — and lost or split the letters under vowel marks (synthetic pain
//  documents, 2026-10-17: Chrome 78 %, LibreOffice 67 % of words right where
//  macOS PDFKit, which honours ActualText, reads 90–97 %).
//
//  pdf.js does end a text item at every BDC/BMC/EMC and, asked to
//  (includeMarkedContent), marks them in the items in content order. This
//  reads the same operators from the content stream with pdf-lib — the
//  page's, and the Form XObjects it draws, depth first as pdf.js walks them —
//  and returns one entry per BDC/BMC: its /ActualText, or null.
//  textLayoutUtils.applyActualText pairs them with pdf.js's markers; when
//  the counts differ it changes nothing.
// ============================================================

import { loadPdfLib } from './lazyLibs.js';

// pdf-lib parses the whole file: past this size the copy costs more memory
// than a phone can spare for what it fixes
const MAX_BYTES = 60 * 1024 * 1024;

// A reader for one pdf.js document: pageNum → Promise<(string|null)[] | null>.
// null: not to be had (pdf-lib unavailable, file too big or unreadable).
export function createActualTextReader(pdfDoc) {
  let doc = null;
  return async pageNum => {
    doc ??= (async () => {
      const bytes = await pdfDoc.getData();
      if (bytes.length > MAX_BYTES) return null;
      await loadPdfLib();
      return window.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    })().catch(() => null);
    const d = await doc;
    if (!d) return null;
    try {
      return actualTextSpans(window.PDFLib, d, pageNum - 1);
    } catch {
      return null;
    }
  };
}

// The page's BDC/BMC operators in drawing order, each its /ActualText or null.
export function actualTextSpans(PDFLib, doc, pageIndex) {
  const { PDFName, PDFDict, PDFArray, PDFRawStream, PDFStream, decodePDFRawStream } = PDFLib;
  const ctx = doc.context;
  const node = doc.getPage(pageIndex).node;
  const out = [];
  const streamBytes = s => (s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents());
  const textOf = v => (v && typeof v.decodeText === 'function' ? v.decodeText() : null);

  const walk = (bytes, resources, depth, seen) => {
    const props = name => {
      const p = resources?.lookupMaybe(PDFName.of('Properties'), PDFDict);
      return p?.lookupMaybe(PDFName.of(name), PDFDict) ?? null;
    };
    for (const { op, args } of contentOps(bytes)) {
      if (op === 'BMC') out.push(null);
      else if (op === 'BDC') {
        const a = args[1];
        if (a?.dict) out.push(a.dict.ActualText ?? null);
        else if (a?.name) out.push(textOf(props(a.name)?.lookup(PDFName.of('ActualText'))));
        else out.push(null);
      } else if (op === 'Do' && args[0]?.name && depth < 8) {
        const xo = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
        const ref = xo?.get(PDFName.of(args[0].name));
        const form = ref && ctx.lookup(ref);
        if (!(form instanceof PDFStream) || form.dict.get(PDFName.of('Subtype')) !== PDFName.of('Form') || seen.has(ref)) continue;
        const own = form.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
        walk(streamBytes(form), own ?? resources, depth + 1, new Set([...seen, ref]));
      }
    }
  };

  const contents = node.Contents();
  const parts = contents instanceof PDFArray ? contents.asArray().map(r => ctx.lookup(r)) : contents ? [contents] : [];
  // the streams of one page are one content stream, split anywhere
  const all = parts.map(streamBytes);
  const joined = new Uint8Array(all.reduce((n, b) => n + b.length + 1, 0));
  let at = 0;
  for (const b of all) { joined.set(b, at); at += b.length; joined[at++] = 0x0A; }
  walk(joined, node.Resources(), 0, new Set());
  return out;
}

// ── Content stream lexer ─────────────────────────────────────────────────
// Just enough of ISO 32000-1 §7.2/§8.8 to find operators and their operands:
// strings (literal and hex), names, numbers, arrays, dicts, inline images.
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

function* contentOps(b) {
  let i = 0, args = [];
  const n = b.length;
  const skipWs = () => {
    for (;;) {
      while (i < n && WS.has(b[i])) i++;
      if (b[i] !== 37) return;              // %comment
      while (i < n && b[i] !== 10 && b[i] !== 13) i++;
    }
  };
  const literal = () => {                   // after "("
    const bytes = [];
    let depth = 1;
    while (i < n) {
      const c = b[i++];
      if (c === 92) {                       // backslash
        const e = b[i++];
        const map = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 };
        if (map[e] !== undefined) bytes.push(map[e]);
        else if (e >= 48 && e <= 55) {
          let v = e - 48;
          for (let k = 0; k < 2 && b[i] >= 48 && b[i] <= 55; k++) v = v * 8 + b[i++] - 48;
          bytes.push(v & 255);
        } else if (e === 13) { if (b[i] === 10) i++; } else if (e !== 10) bytes.push(e);
      } else if (c === 40) { depth++; bytes.push(c); } else if (c === 41) { if (--depth === 0) break; bytes.push(c); } else bytes.push(c);
    }
    return { str: bytes };
  };
  const hex = () => {                       // after "<"
    let h = '';
    while (i < n && b[i] !== 62) { if (!WS.has(b[i])) h += String.fromCharCode(b[i]); i++; }
    i++;
    if (h.length % 2) h += '0';
    const bytes = [];
    for (let k = 0; k < h.length; k += 2) bytes.push(parseInt(h.slice(k, k + 2), 16));
    return { str: bytes };
  };
  const regular = () => {
    const s = i;
    while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
    return String.fromCharCode(...b.subarray(s, i));
  };
  const value = () => {
    skipWs();
    const c = b[i];
    if (c === 40) { i++; return literal(); }
    if (c === 60 && b[i + 1] === 60) { i += 2; return dict(); }
    if (c === 60) { i++; return hex(); }
    if (c === 91) {
      i++;
      const arr = [];
      for (;;) { skipWs(); if (i >= n || b[i] === 93) { i++; break; } arr.push(value()); }
      return { arr };
    }
    if (c === 47) { i++; return { name: regular() }; }
    if (c === 41 || c === 62 || c === 93 || c === 123 || c === 125) { i++; return { junk: true }; }
    const t = regular();
    if (!t) { i++; return { junk: true }; }
    return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t) ? { num: +t } : { op: t };
  };
  const dict = () => {                      // after "<<"
    const d = {};
    for (;;) {
      skipWs();
      if (i >= n) break;
      if (b[i] === 62 && b[i + 1] === 62) { i += 2; break; }
      const k = value();
      if (!k.name) continue;
      const v = value();
      d[k.name] = v.str ? pdfText(v.str) : v;
    }
    return { dict: d };
  };
  while (i < n) {
    skipWs();
    if (i >= n) break;
    const v = value();
    if (v.op) {
      if (v.op === 'ID') {                  // inline image data up to EI
        i++;
        while (i < n && !(b[i] === 69 && b[i + 1] === 73 && WS.has(b[i - 1]) && (i + 2 >= n || WS.has(b[i + 2])))) i++;
        i += 2;
      } else yield { op: v.op, args };
      args = [];
    } else args.push(v);
  }
}

// A PDF text string: UTF-16BE with its BOM, or PDFDocEncoding (Latin-1 here)
function pdfText(bytes) {
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
    let s = '';
    for (let k = 2; k + 1 < bytes.length; k += 2) s += String.fromCharCode((bytes[k] << 8) | bytes[k + 1]);
    return s;
  }
  return String.fromCharCode(...bytes);
}
