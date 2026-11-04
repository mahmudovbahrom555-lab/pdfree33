// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  pageNumWorker.js — page numbers with text around them, a colour and a font
//
//  Deliberately NOT part of worker.js (off-limits per CLAUDE.md), same
//  pattern as watermarkTextWorker.js. processor.js sends a job here only
//  when the user set a prefix/suffix, a colour, a font or a lowercase
//  format (i ii iii, a b c — worker.js only draws uppercase); the plain
//  defaults stay on worker.js's handlePageNum(), whose positions and sizes
//  this file repeats exactly, so a page numbered here sits where it would
//  have sat there.
//
//  Why: handlePageNum() draws with StandardFonts.Helvetica (Windows-1252
//  only) in a fixed grey, so "第 1 页" could not be written at all and the
//  colour could not be chosen (a user's request, 2026-11-05).
//
//  Fonts: Latin text in Helvetica / Times / Courier (the three standard
//  families, nothing to download). Any letter those can't write is drawn in
//  a small Noto font made for page labels (fonts/pagenum/, built by
//  scripts/make_pagenum_fonts.py: digits, Latin with accents, Greek,
//  Cyrillic, Vietnamese, Thai, Devanagari, Hangul and the CJK/kana words put
//  around page numbers), embedded WHOLE — pdf-lib's subset embedding drops
//  glyphs from Noto fonts ("第 1 页" came out as "第" on pdfree.io,
//  2026-11-05). A label with a character none of them has is drawn as a
//  picture with the browser's own fonts. Right-to-left text is refused with
//  code 'rtl': pdf-lib lays glyphs out left to right, so Arabic or Hebrew
//  would come out reversed.
//
//  Message contract:
//    in  → { fileBuffer: ArrayBuffer, options: {...} }
//    out → { type: 'progress', value, label }
//        | { type: 'done', result: ArrayBuffer, pageCount }
//        | { type: 'error', message, code?, chars? }   code: 'rtl' | 'font-load' | 'unsupported-characters'
// ============================================================

importScripts('./vendor/pdf-lib.min.js');
importScripts('./vendor/fontkit.umd.js');

const MARGIN = 24;   // same as handlePageNum
const DEFAULT_RGB = [0.2, 0.2, 0.2], DEFAULT_OPACITY = 0.8;   // handlePageNum's grey

const STANDARD = { sans: 'Helvetica', serif: 'TimesRoman', mono: 'Courier' };

// The small Noto for a label's script (fonts/pagenum/); the first one whose
// glyphs cover the whole label is used (checked with fontkit before embedding).
const _font = name => new URL(`../fonts/pagenum/pagenum-${name}.ttf`, self.location.href).href;
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;

function _candidates(text) {
  if (/[\uAC00-\uD7AF\u1100-\u11FF\u3131-\u318E]/u.test(text)) return ['kr'];
  if (/[\u3040-\u30FF\u3400-\u9FFF\uF900-\uFAFF]/u.test(text)) return ['cjk'];
  if (/[\u0900-\u097F]/u.test(text)) return ['deva'];
  if (/[\u0E00-\u0E7F]/u.test(text)) return ['thai'];
  return ['latin'];
}

const _fontBytes = new Map();   // per worker: a second job doesn't download the same font again
async function _loadFont(key) {
  if (!_fontBytes.has(key)) {
    _fontBytes.set(key, fetch(_font(key)).then(r => {
      if (!r.ok) throw new Error(`font ${r.status}`);
      return r.arrayBuffer();
    }).catch(err => {   // offline on first use, or the file missing
      _fontBytes.delete(key);
      const e = new Error(`Noto Sans could not be loaded (${err.message})`); e.code = 'font-load'; throw e;
    }));
  }
  return _fontBytes.get(key);
}

function progress(value, label) {
  self.postMessage({ type: 'progress', value, label });
}

function _safeSize(page) {
  try { return page.getSize(); } catch { return { width: 595.28, height: 841.89 }; }
}

function _formatPageNum(n, fmt) {   // as worker.js's, plus the lowercase forms only this worker draws
  if (fmt === 'roman') return _toRoman(n);
  if (fmt === 'roman-lower') return _toRoman(n).toLowerCase();
  if (fmt === 'alpha') return _toAlpha(n);
  if (fmt === 'alpha-lower') return _toAlpha(n).toLowerCase();
  return String(n);
}
function _toRoman(n) {
  if (n <= 0 || n > 3999) return String(n);
  const v = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const s = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
  let r = '';
  for (let i = 0; i < v.length; i++) while (n >= v[i]) { r += s[i]; n -= v[i]; }
  return r;
}
function _toAlpha(n) {
  let r = '';
  while (n > 0) { n--; r = String.fromCharCode(65 + (n % 26)) + r; n = Math.floor(n / 26); }
  return r;
}

function _hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
}

// A standard font when it can write every label, else the small Noto that
// covers them all — or null: then the labels are drawn as pictures.
// Throws code 'rtl'.
async function _pickFont(pdf, labels, family) {
  const { StandardFonts } = self.PDFLib;
  const all = labels.join('');
  if (RTL.test(all)) { const e = new Error('Right-to-left text is not supported in page numbers yet'); e.code = 'rtl'; throw e; }
  const standard = await pdf.embedFont(StandardFonts[STANDARD[family] || STANDARD.sans]);
  try { labels.forEach(l => standard.encodeText(l)); return standard; } catch { /* a letter outside Windows-1252 */ }
  for (const key of _candidates(all)) {
    const bytes = await _loadFont(key);
    const fk = self.fontkit.create(bytes);
    if ([...all].some(ch => !fk.hasGlyphForCodePoint(ch.codePointAt(0)))) continue;
    pdf.registerFontkit(self.fontkit);
    // whole, never subset: see the header
    const font = await pdf.embedFont(bytes, { subset: false });
    try { labels.forEach(l => font.encodeText(l)); return font; } catch { /* shaping failed */ }
  }
  return null;
}

// A label the fonts above can't write, drawn by the browser (its own fonts
// cover every script); returns the PNG and its size in points.
async function _labelPicture(label, fontSize, [r, g, b], family) {
  if (typeof OffscreenCanvas === 'undefined') {   // older iOS Safari: nothing to draw it with
    const e = new Error('These characters cannot be written in page numbers: ' + label);
    e.code = 'unsupported-characters'; e.chars = [...new Set(label)].filter(ch => ch.codePointAt(0) > 0x7E); throw e;
  }
  const SCALE = 4, px = fontSize * SCALE;
  const css = `${px}px ${family === 'serif' ? 'serif' : family === 'mono' ? 'monospace' : 'sans-serif'}`;
  const probe = new OffscreenCanvas(1, 1).getContext('2d');
  probe.font = css;
  const m = probe.measureText(label);
  const ascent = m.actualBoundingBoxAscent || px * 0.8, descent = m.actualBoundingBoxDescent || px * 0.2;
  const w = Math.max(1, Math.ceil(m.width)), h = Math.max(1, Math.ceil(ascent + descent));
  const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d');
  ctx.font = css;
  ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(label, 0, ascent);
  const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  return { png, width: w / SCALE, height: h / SCALE, descent: descent / SCALE };
}

self.onmessage = async (e) => {
  try {
    const { fileBuffer, options } = e.data;
    const {
      position = 'bottom-center', format = 'arabic',
      fromPage = 1, toPage = null, startAt = 1,
      fontSize = 10, showTotal = false, skipFirst = false,
      prefix = '', suffix = '', color = null, font: family = 'sans',
    } = options;
    const { PDFDocument, rgb } = self.PDFLib;

    progress(5, 'Loading PDF…');
    const pdf = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
    const pages = pdf.getPages();

    // page range exactly as handlePageNum
    const fromIdx = Math.max(0, (fromPage || 1) - 1 + (skipFirst && fromPage <= 1 ? 1 : 0));
    const toIdx   = toPage !== null ? Math.min(toPage - 1, pages.length - 1) : pages.length - 1;
    const visibleTotal = Math.max(0, toIdx - fromIdx + 1);

    const labelFor = i => {
      const base = _formatPageNum((i - fromIdx) + startAt, format);
      const num  = showTotal ? `${base} / ${_formatPageNum(startAt + visibleTotal - 1, format)}` : base;
      return `${prefix}${num}${suffix}`;
    };
    const labels = [];
    for (let i = fromIdx; i <= toIdx; i++) labels.push(labelFor(i));

    progress(8, 'Preparing font…');
    const font = await _pickFont(pdf, labels.length ? labels : [prefix + suffix], family);
    const chosen = _hexToRgb(color);
    const [r, g, b] = chosen || DEFAULT_RGB;
    const opacity = chosen ? 1 : DEFAULT_OPACITY;

    for (let i = fromIdx; i <= toIdx; i++) {
      progress(10 + Math.round((i / pages.length) * 82), `Numbering page ${i + 1} of ${pages.length}…`);
      const page = pages[i];
      const { width, height } = _safeSize(page);
      const label = labels[i - fromIdx];
      const pic   = font ? null : await _labelPicture(label, fontSize, [r, g, b], family);
      const tw    = font ? font.widthOfTextAtSize(label, fontSize) : pic.width;
      const isOdd = (i % 2) === 0;
      const x = position === 'book'         ? (isOdd ? width - MARGIN - tw : MARGIN)
              : position === 'bottom-right' ? width - MARGIN - tw
              : position === 'bottom-left'  ? MARGIN
              :                              (width - tw) / 2;
      const y = position === 'top-center' ? height - MARGIN - fontSize : MARGIN;
      if (font) page.drawText(label, { x, y, size: fontSize, font, color: rgb(r, g, b), opacity });
      else page.drawImage(await pdf.embedPng(pic.png), { x, y: y - pic.descent, width: pic.width, height: pic.height, opacity });
    }

    progress(93, 'Saving…');
    const bytes = await pdf.save({ useObjectStreams: true, addDefaultPage: false });
    self.postMessage({ type: 'done', result: bytes.buffer, pageCount: pages.length }, [bytes.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message, code: err.code, chars: err.chars });
  }
};
