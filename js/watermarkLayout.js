// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  watermarkLayout.js — Watermark placement geometry (pure)
//
//  Computes draw positions in PDF coordinate space (y=0 at bottom).
//  Consumed by watermarkUI.js for the live preview canvas.
//
//  worker.js carries its own copy of this logic — it uses
//  importScripts() (classic Web Worker) and cannot import ES
//  modules.  When changing any constant here, update worker.js
//  handleWatermark() to match.
//
//  Constants that must stay in sync with worker.js:
//    TILE_GAP_Y = 120
//    tileGapX   = pageWidth / 2.5
//    tile size  = fontSize * 0.7
//    tile angle = -25°
//    top y      = pageHeight - 50
//    bottom y   = 30
//    center angle = -25°
// ============================================================

const TILE_GAP_Y = 120;  // row spacing in PDF pts — must match worker.js

/**
 * Compute watermark draw positions in PDF coordinate space.
 *
 * Returns [{x, y, angle, size}, ...] where:
 *   x, y  — PDF pts, y=0 at page bottom
 *   angle — radians, PDF convention (counter-clockwise positive, like math)
 *   size  — font size in PDF pts (before canvas scaling)
 *
 * Caller responsibilities:
 *   canvas: cx = x * scaleX,  cy = H - y * scaleY,  ctx.rotate(-angle)
 *           (y-axis flip reverses rotation direction — negate the angle)
 *   PDF:    page.drawText(text, { x, y, size, rotate: degrees(angle * 180/π) })
 *
 * For non-tile positions, x = pageWidth/2 (semantic center).
 *   Canvas uses textAlign:'center' — no adjustment needed.
 *   PDF must subtract font.widthOfTextAtSize(text, size)/2 from x.
 */
export function computeWatermarkLayout({ pageWidth, pageHeight, fontSize, position }) {
  if (position === 'tile') {
    const tileGapX = pageWidth / 2.5;
    const cols     = Math.ceil(pageWidth  / tileGapX) + 2;
    const rows     = Math.ceil(pageHeight / TILE_GAP_Y) + 2;
    const size     = fontSize * 0.7;
    const cells    = [];
    for (let row = -1; row < rows; row++) {
      for (let col = -1; col < cols; col++) {
        cells.push({
          x:     col * tileGapX + (row % 2) * (tileGapX / 2),
          y:     row * TILE_GAP_Y,
          angle: -25 * Math.PI / 180,
          size,
        });
      }
    }
    return cells;
  }

  // center / top / bottom — single draw item.
  // x = pageWidth/2 is the semantic horizontal center.
  const y = position === 'top'    ? pageHeight - 50
          : position === 'bottom' ? 30
          :                         pageHeight / 2;
  return [{
    x:     pageWidth / 2,
    y,
    angle: position === 'center' ? -25 * Math.PI / 180 : 0,
    size:  fontSize,
  }];
}
