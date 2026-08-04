// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  watermarkImage.js — Image/logo watermark embedding (pdf-lib)
//
//  Loaded into worker.js via importScripts() — worker.js is a
//  classic (non-module) Web Worker, so this file uses plain
//  top-level function declarations, no import/export (same
//  pattern as pdfEncrypt.js). applyImageWatermark() becomes
//  available on the worker's global scope after importScripts().
//
//  Position semantics match the text watermark in worker.js
//  (handleWatermark): 'center' | 'top' | 'bottom' | 'tile'.
//  Unlike text, the logo is drawn upright (no rotation) — a
//  diagonal angle is a stylistic convention for stamp-style text
//  like "CONFIDENTIAL", but reads as broken for a company logo.
//
//  embedPng/embedJpg is called exactly once per document, not per
//  page — repeating it would balloon the output file size.
// ============================================================

const IMG_TILE_GAP_FACTOR = 1.6; // spacing between tiled repeats, relative to logo size

/**
 * Draw an image watermark on every page of a pdf-lib PDFDocument.
 * @param {PDFDocument} pdf
 * @param {PDFPage[]} pages
 * @param {object} opts
 * @param {Uint8Array} opts.bytes  raw image file bytes
 * @param {string} opts.mime       'image/png' | 'image/jpeg'
 * @param {number} [opts.opacity]  0..1
 * @param {number} [opts.size]     logo width as a fraction of page width, e.g. 0.25
 * @param {string} [opts.position] 'center' | 'top' | 'bottom' | 'tile'
 */
async function applyImageWatermark(pdf, pages, opts) {
  const { bytes, mime, opacity = 0.3, size = 0.25, position = 'center' } = opts;

  if (mime !== 'image/png' && mime !== 'image/jpeg') {
    throw new Error('Logo watermark supports PNG or JPG images only');
  }

  // Embed once — pdf-lib dedupes the image resource across all drawImage() calls
  // that reference this same embedded object, so this stays cheap even with tile mode.
  const embeddedImage = mime === 'image/png'
    ? await pdf.embedPng(bytes)
    : await pdf.embedJpg(bytes);

  const aspect = embeddedImage.height / embeddedImage.width;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const { width: pageWidth, height: pageHeight } = page.getSize();
    const w = pageWidth * size;
    const h = w * aspect;

    if (position === 'tile') {
      const gapX = w * IMG_TILE_GAP_FACTOR;
      const gapY = h * IMG_TILE_GAP_FACTOR;
      const cols = Math.ceil(pageWidth / gapX) + 2;
      const rows = Math.ceil(pageHeight / gapY) + 2;
      for (let row = -1; row < rows; row++) {
        for (let col = -1; col < cols; col++) {
          page.drawImage(embeddedImage, {
            x: col * gapX + (row % 2) * (gapX / 2),
            y: row * gapY,
            width: w,
            height: h,
            opacity,
          });
        }
      }
    } else {
      const x = (pageWidth - w) / 2;
      const y = position === 'top'    ? pageHeight - h - 40
              : position === 'bottom' ? 40
              :                         (pageHeight - h) / 2;
      page.drawImage(embeddedImage, { x, y, width: w, height: h, opacity });
    }
  }
}

// Expose globally for importScripts() in worker.js
if (typeof self !== 'undefined') self.applyImageWatermark = applyImageWatermark;
