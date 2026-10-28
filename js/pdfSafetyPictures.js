// SPDX-License-Identifier: AGPL-3.0-only
// The most thorough clean: every page drawn (pdf.js, scripts off, page content
// only — no form widgets or links) and put into a new PDF as a picture. Nothing
// of the original's objects carries over — no scripts, actions, attachments,
// fonts or images as they were — so it also suits a file whose structure
// can't be taken apart (pdfSafetyDisarm.js reports "unreadable"). The cost:
// the text becomes a picture (not selectable or searchable) and the file
// usually grows. One page at a time, its canvas freed before the next, so a
// long document doesn't hold every page in memory at once.

// 150 dpi reads well on screen and in print; long documents get less so a
// phone's memory holds out; no page side over 2,500 px either way.
export function pageScale(pageCount, widthPt, heightPt, { maxSide = 2500 } = {}) {
  const dpi = pageCount > 40 ? 110 : pageCount > 20 ? 130 : 150;
  const scale = dpi / 72;
  return Math.min(scale, maxSide / Math.max(widthPt, heightPt));
}

export async function picturesPdf(pdf, PDFLib, { quality = 0.85, onPage, isCancelled } = {}) {
  const out = await PDFLib.PDFDocument.create();
  for (let i = 1; i <= pdf.numPages; i++) {
    if (isCancelled?.()) return null;
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: pageScale(pdf.numPages, base.width, base.height) });
    const w = Math.ceil(viewport.width), h = Math.ceil(viewport.height);
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';            // JPEG has no transparency: a white page
    ctx.fillRect(0, 0, w, h);
    await page.render({ canvasContext: ctx, viewport, annotationMode: 0 }).promise;
    const blob = canvas.convertToBlob
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality })
      : await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
    const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    // the new page keeps the original's size in points; the picture fills it
    out.addPage([base.width, base.height]).drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
    canvas.width = canvas.height = 0;
    page.cleanup();
    onPage?.(i, pdf.numPages);
  }
  return out.save({ useObjectStreams: true });
}
