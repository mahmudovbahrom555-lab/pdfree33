// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

// ============================================================
//  redact-worker.js — True PDF Redaction Assembly
//
//  Receives: { pdfBytes, redactedImages, removeMetadata }
//    pdfBytes        — ArrayBuffer of original PDF
//    redactedImages  — { [pageIndex]: { dataUrl, width, height } }
//                      pageIndex is 0-based; only pages WITH redactions
//    removeMetadata  — boolean; strip Author, Creator, keywords, etc.
//
//  Strategy (hybrid — preserves quality):
//    Pages WITHOUT redactions → copied from original via pdf-lib
//    Pages WITH redactions    → embedded as PNG (canvas-flatten)
//
//  Canvas flatten guarantees that underlying content is physically
//  gone from the PDF — not merely obscured by a paint layer.
// ============================================================

importScripts('./vendor/pdf-lib.min.js');

function _progress(value, label) {
  self.postMessage({ type: 'progress', value, label });
}

function _dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  const binary  = atob(base64);
  const bytes   = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

self.onmessage = async (e) => {
  const { pdfBytes, redactedImages, removeMetadata } = e.data;

  try {
    _progress(20, 'Loading PDF structure…');
    const { PDFDocument } = PDFLib;

    const srcPdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const outPdf = await PDFDocument.create();
    const pageCount = srcPdf.getPageCount();

    _progress(30, 'Assembling redacted document…');

    for (let i = 0; i < pageCount; i++) {
      const progressVal = 30 + Math.round((i / pageCount) * 55);
      _progress(progressVal, `Processing page ${i + 1} of ${pageCount}…`);

      if (redactedImages[i]) {
        // Redacted page: embed canvas-rendered PNG
        const { dataUrl } = redactedImages[i];
        const pngBytes = _dataUrlToBytes(dataUrl);
        const pngImage = await outPdf.embedPng(pngBytes);
        // Use original page dimensions from the source PDF
        const srcPage   = srcPdf.getPage(i);
        const { width: pw, height: ph } = srcPage.getSize();
        const newPage = outPdf.addPage([pw, ph]);
        newPage.drawImage(pngImage, { x: 0, y: 0, width: pw, height: ph });
      } else {
        // Non-redacted page: copy original content preserving text, links, etc.
        const [copied] = await outPdf.copyPages(srcPdf, [i]);
        outPdf.addPage(copied);
      }
    }

    if (removeMetadata) {
      _progress(88, 'Removing metadata…');
      outPdf.setAuthor('');
      outPdf.setCreator('PDFree');
      outPdf.setProducer('PDFree');
      outPdf.setTitle('');
      outPdf.setSubject('');
      outPdf.setKeywords([]);
    }

    _progress(92, 'Saving…');
    const outBytes = await outPdf.save();

    self.postMessage({ type: 'done', result: outBytes.buffer }, [outBytes.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || 'Redaction failed' });
  }
};
