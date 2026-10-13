// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// pdf.js's worker, after the .at() polyfill (see atPolyfill.js) — the
// vendored worker is never edited. Set as pdf.js's workerSrc in pdf2jpgUI.js.
importScripts('./atPolyfill.js', './vendor/pdf.worker.min.js');
