// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  watermarkTextWorker.js — Dedicated Web Worker for TEXT watermarks
//
//  Deliberately NOT part of worker.js (off-limits per CLAUDE.md). Same
//  pattern as pdfaWorker.js/cleanScanWorker.js: a standalone classic
//  worker, driven by js/processor.js on the main thread.
//
//  Why this exists instead of worker.js's own handleWatermark(): that
//  function embeds StandardFonts.HelveticaBold, a Windows-1252/WinAnsi
//  font that can only encode Western-European Latin text. Any watermark
//  text containing Cyrillic, Vietnamese diacritics, or Turkish's İ/ğ/ş —
//  including the localized DEFAULT watermark text on ru/vi/tr — made
//  pdf-lib throw a raw 'WinAnsi cannot encode "X"' error straight at the
//  user. This worker embeds LiberationSans-Bold via fontkit instead
//  (already vendored for pdf2pdfa's font-substitution feature) — verified
//  it covers Cyrillic + Vietnamese + Turkish + Polish (2327 glyphs).
//
//  It does NOT cover CJK (Japanese/Korean) — Liberation is a Latin/
//  Cyrillic/Greek font family, not a CJK one, and a real CJK font is a
//  fundamentally different, much larger asset (Noto Sans CJK is 4-16MB
//  per weight) that isn't vendored here. Rather than silently draw
//  garbled/wrong glyphs for unsupported characters — verified empirically
//  that fontkit's layout() does NOT cleanly fall back to a "missing
//  glyph" box, it produces real-looking-but-wrong glyph IDs — this
//  worker checks every character's coverage via fontkit's own
//  hasGlyphForCodePoint() BEFORE drawing anything, and refuses with a
//  clear, catchable error if any character isn't covered, rather than
//  producing corrupted-looking output.
//
//  Image watermarks (options.kind === 'image') don't need any of this —
//  they stay on the original handleWatermark() path in worker.js
//  unchanged.
//
//  Message contract:
//    in  → { fileBuffer: ArrayBuffer, options: {...}, fontBytes: ArrayBuffer }
//    out → { type: 'progress', value, label }
//        | { type: 'done', result: ArrayBuffer, pageCount }
//        | { type: 'error', code?: 'unsupported-characters', message, chars? }
// ============================================================

importScripts('./vendor/pdf-lib.min.js');
importScripts('./vendor/fontkit.umd.js');

const WM_COLORS = {
  gray:  [0.5, 0.5, 0.5],
  red:   [0.8, 0.1, 0.1],
  blue:  [0.1, 0.3, 0.7],
  black: [0.1, 0.1, 0.1],
};

function progress(value, label) {
  self.postMessage({ type: 'progress', value, label });
}

// Unicode-codepoint-aware iteration (not UTF-16 code units) — some
// characters this needs to check are outside the BMP and would otherwise
// split into two bogus "characters" via naive charCodeAt/index iteration.
function _uncoveredChars(fkFont, text) {
  const missing = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (!fkFont.hasGlyphForCodePoint(cp)) missing.push(ch);
  }
  return missing;
}

self.onmessage = async (e) => {
  try {
    const { fileBuffer, options, fontBytes } = e.data;
    const { text = 'CONFIDENTIAL', opacity = 0.3, position = 'center',
            fontSize = 40, color = 'gray' } = options;

    progress(5, 'Loading font…');
    const fkFont = self.fontkit.create(fontBytes);
    const missing = _uncoveredChars(fkFont, text);
    if (missing.length > 0) {
      self.postMessage({
        type: 'error',
        code: 'unsupported-characters',
        message: `Font cannot render: ${Array.from(new Set(missing)).join(' ')}`,
        chars: Array.from(new Set(missing)),
      });
      return;
    }

    const { PDFDocument, rgb, degrees } = self.PDFLib;
    const [r, g, b] = WM_COLORS[color] || WM_COLORS.gray;

    progress(10, 'Loading PDF…');
    const pdf = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
    pdf.registerFontkit(self.fontkit);
    const font = await pdf.embedFont(fontBytes);
    const pages = pdf.getPages();

    // Verbatim port of worker.js's handleWatermark() text-drawing logic —
    // only the font source changed (embedded Liberation TTF instead of
    // StandardFonts.HelveticaBold). Kept in sync manually, same precedent
    // as every other dedicated-worker/shared-worker duplication in this
    // codebase (worker.js is off-limits, so this can't import from it).
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const { width, height } = page.getSize();
      progress(10 + Math.round((i / pages.length) * 80), `Watermarking page ${i + 1} of ${pages.length}…`);

      if (position === 'tile') {
        const tileGapX = width / 2.5, tileGapY = 120;
        const cols = Math.ceil(width / tileGapX) + 2;
        const rows = Math.ceil(height / tileGapY) + 2;
        for (let row = -1; row < rows; row++)
          for (let col = -1; col < cols; col++)
            page.drawText(text, { x: col * tileGapX + (row % 2) * (tileGapX / 2),
              y: row * tileGapY, size: fontSize * 0.7, font,
              color: rgb(r, g, b), opacity, rotate: degrees(-25) });
      } else {
        const tw = font.widthOfTextAtSize(text, fontSize);
        const pos = position === 'top'    ? { x: (width-tw)/2, y: height-50, rotate: degrees(0) }
                  : position === 'bottom' ? { x: (width-tw)/2, y: 30,        rotate: degrees(0) }
                  :                        { x: width/2-tw/2,  y: height/2,  rotate: degrees(-25) };
        page.drawText(text, { size: fontSize, font, color: rgb(r, g, b), opacity, ...pos });
      }
    }

    progress(92, 'Saving…');
    const bytes = await pdf.save({ useObjectStreams: true, addDefaultPage: false });
    self.postMessage(
      { type: 'done', result: bytes.buffer, pageCount: pages.length },
      [bytes.buffer]
    );
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
