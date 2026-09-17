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
 * @param {number} [opts.fromPage] 1-based first page to watermark
 * @param {number} [opts.toPage]   1-based last page to watermark; null/omitted = last page
 * @param {string} [opts.layer]    'front' | 'behind' — behind renders under the page's existing content
 */
async function applyImageWatermark(pdf, pages, opts) {
  const { bytes, mime, opacity = 0.3, size = 0.25, position = 'center',
          fromPage = 1, toPage = null, layer = 'front' } = opts;

  if (mime !== 'image/png' && mime !== 'image/jpeg') {
    throw new Error('Logo watermark supports PNG or JPG images only');
  }

  // page.getSize() calls pdf-lib's PDFArray.asRectangle() under the hood,
  // which throws PDFArrayIsNotRectangleError for a /MediaBox that isn't
  // exactly 4 elements — a realistic risk for a PDF that's been through
  // several rounds of merge/edit (same class of bug fixed in
  // resizeWorker.js/mangaSplitWorker.js's own _safeCropBox()). Falls back
  // to a fixed A4 size rather than failing the whole watermark job for one
  // malformed page.
  //
  // Deliberately scoped INSIDE this function, not a top-level declaration:
  // this file is loaded via importScripts() into worker.js's shared classic-
  // worker global scope alongside pdfEncrypt.js, and each file is minified
  // independently — a top-level `function _safeSize(page)` here was
  // minified to the SAME single-letter global name as pdfEncrypt.js's own
  // top-level `_rc4` function, silently clobbering RC4 encryption for
  // EVERY Protect operation (not just malformed-MediaBox files). Caught by
  // tests/e2e/protect.e2e.mjs's CI gate before this ever reached
  // production. A function scoped inside its only caller can't collide
  // with another file's top-level names after minification.
  const safeSize = (page) => {
    try { return page.getSize(); } catch { return { width: 595.28, height: 841.89 }; }
  };

  // Same "move the one new /Contents entry from end to front" technique as
  // watermarkTextWorker.js's _moveWatermarkBehind() — kept as a separate
  // local copy (not a shared import) for the same importScripts()-shared-
  // global-scope reason _safeSize/safeSize above is scoped locally: this
  // file shares one classic-worker namespace with pdfEncrypt.js via
  // worker.js, and a top-level declaration here risks a minified-name
  // collision with that file's own top-level names.
  const moveBehind = (page) => {
    const Contents = page.node.Contents();
    if (Contents && Contents.size() > 1) {
      const last = Contents.get(Contents.size() - 1);
      Contents.remove(Contents.size() - 1);
      Contents.insert(0, last);
    }
  };

  // Embed once — pdf-lib dedupes the image resource across all drawImage() calls
  // that reference this same embedded object, so this stays cheap even with tile mode.
  const embeddedImage = mime === 'image/png'
    ? await pdf.embedPng(bytes)
    : await pdf.embedJpg(bytes);

  const aspect = embeddedImage.height / embeddedImage.width;

  const fromIdx = Math.max(0, (fromPage || 1) - 1);
  const toIdx = (toPage !== null && toPage !== undefined)
    ? Math.min(toPage - 1, pages.length - 1) : pages.length - 1;

  for (let i = 0; i < pages.length; i++) {
    if (i < fromIdx || i > toIdx) continue;
    const page = pages[i];
    const { width: pageWidth, height: pageHeight } = safeSize(page);
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
    if (layer === 'behind') moveBehind(page);
  }
}

// Expose globally for importScripts() in worker.js
if (typeof self !== 'undefined') self.applyImageWatermark = applyImageWatermark;
