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
//  user.
//
//  Two drawing paths, chosen per watermark (checked once, up front):
//
//  1. VECTOR (fast path, used whenever possible): embeds LiberationSans-
//     Bold via fontkit (already vendored for pdf2pdfa's font-substitution
//     feature) instead of the WinAnsi standard font — verified it covers
//     Cyrillic + Vietnamese + Turkish + Polish (2327 glyphs). Crisp at any
//     zoom, tiny output, same drawText() approach as before.
//
//  2. RASTER fallback (only when the text has characters Liberation can't
//     cover — in practice, CJK): Liberation is a Latin/Cyrillic/Greek
//     family, not a CJK one, and a real CJK font is a fundamentally
//     different, much larger asset (Noto Sans CJK is 4-16MB per weight)
//     that isn't vendored here — vendoring one, or fetching one from a
//     CDN, are both real options but bigger commitments than this specific
//     gap needs. Verified empirically that fontkit's layout() does NOT
//     cleanly fall back to a "missing glyph" box for uncovered codepoints
//     (produces real-looking-but-wrong glyph IDs) and pdf-lib doesn't
//     throw for a custom embedded font the way it does for WinAnsi — so
//     rather than risk silently-wrong vector output, unsupported text is
//     rendered to a transparent PNG via OffscreenCanvas (the browser's own
//     font stack — every modern OS ships real CJK font support) and
//     embedded as an image instead. Same tile/position math as the vector
//     path, ported to drawImage instead of drawText (pdf-lib's drawImage
//     supports rotate exactly like drawText — verified against the vendor
//     source before relying on it). This covers not just CJK but any
//     script the OS can render, with zero new font assets.
//
//  Image watermarks (options.kind === 'image', an actual logo file) don't
//  need any of this and stay on the original handleWatermark() path in
//  worker.js, unchanged.
//
//  Message contract:
//    in  → { fileBuffer: ArrayBuffer, options: {...}, fontBytes: ArrayBuffer }
//    out → { type: 'progress', value, label }
//        | { type: 'done', result: ArrayBuffer, pageCount }
//        | { type: 'error', message }
// ============================================================

importScripts('./vendor/pdf-lib.min.js');
importScripts('./vendor/fontkit.umd.js');

const WM_COLORS = {
  gray:  [0.5, 0.5, 0.5],
  red:   [0.8, 0.1, 0.1],
  blue:  [0.1, 0.3, 0.7],
  black: [0.1, 0.1, 0.1],
};

const RASTER_SCALE = 2; // render at 2x for crisper output once placed at target size

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

// Renders `text` to a tightly-cropped, transparent-background PNG using the
// browser's own font stack — 'sans-serif' lets the OS substitute whatever
// covers the text's actual script (Noto/Hiragino/Malgun Gothic/etc.), the
// same way a normal web page falls back for a font that doesn't cover some
// character. fontSize is in PDF points; rendered at RASTER_SCALE for
// crispness, with the returned width/height already converted back to
// points so callers never need to know the internal render scale.
function _renderTextToPng(text, fontSize, colorRgb) {
  const px = fontSize * RASTER_SCALE;
  const probe = new OffscreenCanvas(1, 1);
  const pctx  = probe.getContext('2d');
  const fontStyle = `bold ${px}px sans-serif`;
  pctx.font = fontStyle;

  const metrics = pctx.measureText(text);
  const padding = px * 0.15; // guards against clipping tall CJK glyphs / descenders
  const w = Math.max(1, Math.ceil(metrics.width + padding * 2));
  const h = Math.max(1, Math.ceil(
    (metrics.actualBoundingBoxAscent || px * 0.8) +
    (metrics.actualBoundingBoxDescent || px * 0.2) + padding * 2
  ));

  const canvas = new OffscreenCanvas(w, h);
  const ctx    = canvas.getContext('2d');
  // Canvas resets on resize — re-apply style after constructing the real one.
  ctx.font         = fontStyle;
  ctx.fillStyle    = `rgb(${colorRgb.join(',')})`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);

  return canvas.convertToBlob({ type: 'image/png' }).then(blob => blob.arrayBuffer()).then(buf => ({
    bytes: new Uint8Array(buf),
    width: w / RASTER_SCALE,
    height: h / RASTER_SCALE,
  }));
}

// Vector path — verbatim port of worker.js's handleWatermark() text-drawing
// logic, only the font source changed (embedded Liberation TTF instead of
// StandardFonts.HelveticaBold). Kept in sync manually, same precedent as
// every other dedicated-worker/shared-worker duplication in this codebase
// (worker.js is off-limits, so this can't import from it).
function _drawVectorText(pages, { text, opacity, position, fontSize, font, rgb, degrees, color }) {
  const [r, g, b] = WM_COLORS[color] || WM_COLORS.gray;
  for (const page of pages) {
    const { width, height } = page.getSize();
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
}

// Raster fallback — same position/tile geometry and diagonal-rotation
// convention as _drawVectorText above (so switching path for an
// unsupported script doesn't change the watermark's established look),
// adapted for an image instead of text: an image's (x,y) is its bottom-left
// corner, not a text baseline, so center/top/bottom offsets are adjusted
// to keep the image visually centered on the same target point.
async function _drawImageText(pdf, pages, pngBytes, imgW, imgH, { opacity, position, degrees }) {
  const embeddedImage = await pdf.embedPng(pngBytes);

  for (const page of pages) {
    const { width, height } = page.getSize();
    if (position === 'tile') {
      const gapX = width / 2.5, gapY = 120;
      const cols = Math.ceil(width / gapX) + 2;
      const rows = Math.ceil(height / gapY) + 2;
      // Tiled copies render smaller (0.7x, matching the vector tile's own
      // font-size scale-down) so the pattern reads as a repeat, not a wall.
      const w = imgW * 0.7, h = imgH * 0.7;
      for (let row = -1; row < rows; row++)
        for (let col = -1; col < cols; col++)
          page.drawImage(embeddedImage, {
            x: col * gapX + (row % 2) * (gapX / 2) - w / 2,
            y: row * gapY - h / 2,
            width: w, height: h, opacity, rotate: degrees(-25),
          });
    } else {
      const pos = position === 'top'
        ? { x: (width - imgW) / 2, y: height - 50 - imgH / 2, rotate: degrees(0) }
        : position === 'bottom'
        ? { x: (width - imgW) / 2, y: 30 - imgH / 2, rotate: degrees(0) }
        : { x: (width - imgW) / 2, y: (height - imgH) / 2, rotate: degrees(-25) };
      page.drawImage(embeddedImage, { width: imgW, height: imgH, opacity, ...pos });
    }
  }
}

self.onmessage = async (e) => {
  try {
    const { fileBuffer, options, fontBytes } = e.data;
    const { text = 'CONFIDENTIAL', opacity = 0.3, position = 'center',
            fontSize = 40, color = 'gray' } = options;

    progress(5, 'Preparing…');
    const fkFont = self.fontkit.create(fontBytes);
    const missing = _uncoveredChars(fkFont, text);

    const { PDFDocument, rgb, degrees } = self.PDFLib;

    progress(10, 'Loading PDF…');
    const pdf = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
    const pages = pdf.getPages();

    if (missing.length === 0) {
      pdf.registerFontkit(self.fontkit);
      const font = await pdf.embedFont(fontBytes);
      progress(20, 'Watermarking…');
      _drawVectorText(pages, { text, opacity, position, fontSize, font, rgb, degrees, color });
    } else {
      progress(15, 'Rendering text…');
      const [r, g, b] = (WM_COLORS[color] || WM_COLORS.gray).map(v => Math.round(v * 255));
      const { bytes: pngBytes, width: imgW, height: imgH } = await _renderTextToPng(text, fontSize, [r, g, b]);
      progress(30, 'Watermarking…');
      await _drawImageText(pdf, pages, pngBytes, imgW, imgH, { opacity, position, degrees });
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
