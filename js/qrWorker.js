// SPDX-License-Identifier: AGPL-3.0-only
// QR codes on one rendered page, for the PDF safety check (js/pdfSafetyQr.js),
// where the browser has no BarcodeDetector of its own. jsQR (js/vendor/jsQR.js,
// v1.4.0, no release since 2021) reads one code per image, so the page is read
// whole and then in overlapping parts; what was read is kept once. It runs
// here, in its own worker: the caller gives up after a few seconds and ends
// the worker, so a picture made to stall the reader can't stall the tab.
importScripts('./vendor/jsQR.js');

const MAX_SIDE = 2400;   // the caller renders at most this; larger is refused

// The page's codes: the whole image, then 2×2 and 3×3 overlapping parts.
function decodeAll(rgba, width, height) {
  if (width > MAX_SIDE || height > MAX_SIDE || rgba.length !== width * height * 4) return [];
  const found = new Map();
  const read = (x0, y0, w, h) => {
    let data = rgba;
    if (w !== width || h !== height) {
      data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) data.set(rgba.subarray(((y0 + y) * width + x0) * 4, ((y0 + y) * width + x0 + w) * 4), y * w * 4);
    }
    // eslint-disable-next-line no-undef
    const code = jsQR(data, w, h, { inversionAttempts: 'attemptBoth' });
    if (code && code.data && !found.has(code.data)) {
      const xs = [code.location.topLeftCorner.x, code.location.bottomRightCorner.x].map(v => (v + x0) / width);
      const ys = [code.location.topLeftCorner.y, code.location.bottomRightCorner.y].map(v => (v + y0) / height);
      found.set(code.data, { data: code.data, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    }
  };
  read(0, 0, width, height);
  for (const n of [2, 3]) {
    const w = Math.ceil(width / n * 1.25), h = Math.ceil(height / n * 1.25);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const x0 = Math.min(width - w, Math.round(i * (width - w) / (n - 1)));
      const y0 = Math.min(height - h, Math.round(j * (height - h) / (n - 1)));
      read(Math.max(0, x0), Math.max(0, y0), Math.min(w, width), Math.min(h, height));
    }
  }
  return [...found.values()];
}

self.onmessage = (e) => {
  const { id, width, height, buffer } = e.data;
  let codes = [], error = null;
  try { codes = decodeAll(new Uint8ClampedArray(buffer), width, height); } catch (err) { error = String(err?.message ?? err); }
  self.postMessage({ id, codes, error });
};
