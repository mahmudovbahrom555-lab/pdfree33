// SPDX-License-Identifier: AGPL-3.0-only
// What the PDF safety check reads from the pages as drawn (pdf.js), not from
// the file's objects: the text under each link (a link showing one site and
// leading to another) and QR codes (a code's address is read before anyone
// scans it with a phone). Rendering only — pdf.js runs no document script
// (isEvalSupported off, scripting off).
import { describeUri } from './pdfSafetyScan.js';
import { textUnder, linkMismatch } from './pdfSafetyReport.js';

// pdf.js text items in page space: x, y of the baseline start, width, height.
export function textItemsOf(textContent) {
  return textContent.items
    .filter(it => it.str && it.transform)
    .map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5], width: it.width, height: it.height || Math.abs(it.transform[3]) }));
}

// Links whose shown text names another site: [{ uri, shown, page }].
export async function linkMismatchesOnPages(pdfDoc, uris) {
  const byPage = new Map();
  for (const u of uris) if (u.rect && Number.isInteger(u.page)) (byPage.get(u.page) ?? byPage.set(u.page, []).get(u.page)).push(u);
  const out = [];
  for (const [pageIndex, links] of byPage) {
    const page = await pdfDoc.getPage(pageIndex + 1);
    const items = textItemsOf(await page.getTextContent());
    for (const u of links) {
      const m = linkMismatch(textUnder(items, u.rect), u.uri);
      if (m) out.push({ uri: u.uri, shown: m.shown, page: pageIndex });
    }
    page.cleanup();
  }
  return out;
}

// QR codes on the first `maxPages` pages: [{ page, data, box, ...describeUri }].
// The browser's own BarcodeDetector where it has one; otherwise jsQR in a
// worker (js/qrWorker.js) that is ended after `timeoutMs` on a page.
export async function qrCodesOnPages(pdfDoc, { maxPages = 30, maxSide = 1600, timeoutMs = 5000 } = {}) {
  const native = await nativeQrDetector();
  let worker = null, seq = 0;
  const viaWorker = (img) => new Promise(resolve => {
    worker ??= new Worker(new URL('./qrWorker.js', import.meta.url));
    const id = ++seq;
    const timer = setTimeout(() => { worker.terminate(); worker = null; resolve([]); }, timeoutMs);
    worker.onmessage = e => { if (e.data.id !== id) return; clearTimeout(timer); resolve(e.data.codes ?? []); };
    worker.postMessage({ id, width: img.width, height: img.height, buffer: img.data.buffer }, [img.data.buffer]);
  });
  const out = [];
  try {
    for (let i = 1; i <= Math.min(pdfDoc.numPages, maxPages); i++) {
      const page = await pdfDoc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3, maxSide / Math.max(base.width, base.height)) });
      const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
        : Object.assign(document.createElement('canvas'), { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) });
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport, annotationMode: 0 }).promise;
      let codes;
      if (native) {
        const found = await native.detect(canvas).catch(() => []);
        codes = found.map(c => ({ data: c.rawValue, box: [c.boundingBox.left / canvas.width, c.boundingBox.top / canvas.height, c.boundingBox.right / canvas.width, c.boundingBox.bottom / canvas.height] }));
      } else {
        codes = await viaWorker(ctx.getImageData(0, 0, canvas.width, canvas.height));
      }
      for (const c of codes) out.push({ page: i - 1, data: c.data, box: c.box, ...(/^[a-z][a-z0-9+.-]*:/i.test(c.data) ? describeUri(c.data) : {}) });
      canvas.width = canvas.height = 0;   // let the memory go before the next page
      page.cleanup();
    }
  } finally {
    worker?.terminate();
  }
  return out;
}

async function nativeQrDetector() {
  try {
    if (typeof BarcodeDetector === 'undefined') return null;
    // eslint-disable-next-line no-undef
    if (!(await BarcodeDetector.getSupportedFormats()).includes('qr_code')) return null;
    // eslint-disable-next-line no-undef
    return new BarcodeDetector({ formats: ['qr_code'] });
  } catch { return null; }
}
