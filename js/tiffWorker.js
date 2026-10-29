// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  tiffWorker.js — TIFF pages → PNG Blobs, off the main thread
//
//  Chrome, Edge and Firefox can't decode TIFF at all (Safari only), and a
//  scanner's or fax's TIFF often holds many pages in one file — "TIF转PDF"
//  was a real on-site search that found nothing (2026-10). Each page
//  (IFD) is decoded with the vendored UTIF.js (MIT; pako for Deflate-
//  compressed TIFFs) and re-encoded as a PNG, which js/worker.js's
//  jpg2pdf path already reads — worker.js itself is off-limits.
//
//  Fax pages are often stored with non-square pixels (204 × 98 dpi
//  "normal" mode): drawn as-is the page comes out squashed to half its
//  height, so the shorter resolution axis is stretched to square pixels.
//
//  In:  { buffer: ArrayBuffer }
//  Out: { pages: Blob[] } or { error: string }
// ============================================================

importScripts('./vendor/pako_inflate.min.js', './vendor/UTIF.js');

function _res(ifd, tag) {
  const v = ifd[tag];
  return v && v[0] ? v[0] : 0;           // UTIF reads RATIONAL tags as numbers
}

self.onmessage = async (e) => {
  try {
    const ifds = UTIF.decode(e.data.buffer);
    // Real pages only: a sub-IFD thumbnail or reduced-resolution copy
    // (NewSubfileType bit 0) isn't a page of the document.
    const pages = ifds.filter(ifd => !(_res(ifd, 't254') & 1));
    const blobs = [];
    for (const ifd of pages) {
      UTIF.decodeImage(e.data.buffer, ifd, ifds);
      const w = ifd.width, h = ifd.height;
      if (!w || !h) continue;
      const rgba = UTIF.toRGBA8(ifd);
      ifd.data = null;                     // free the raw strip bytes before the next page

      const src = new OffscreenCanvas(w, h);
      src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, 0, w * h * 4), w, h), 0, 0);

      const xr = _res(ifd, 't282'), yr = _res(ifd, 't283');
      let out = src;
      if (xr && yr && Math.abs(xr / yr - 1) > 0.05) {
        const ow = xr < yr ? Math.round(w * yr / xr) : w;
        const oh = yr < xr ? Math.round(h * xr / yr) : h;
        out = new OffscreenCanvas(ow, oh);
        const ctx = out.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, 0, 0, ow, oh);
      }
      blobs.push(await out.convertToBlob({ type: 'image/png' }));
    }
    self.postMessage(blobs.length ? { pages: blobs } : { error: 'no pages' });
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
