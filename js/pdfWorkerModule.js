// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// pdf.js 4's worker (an ES module), after the .at() polyfill (atPolyfill.js);
// js/pdfjsLoader.js sets this file as workerSrc and pdf.js starts it with
// { type: 'module' }. The vendored worker is never edited. Its folder carries
// the version, so a browser can't pair a cached worker of one pdf.js with the
// library of another ("API version does not match Worker version").
import './atPolyfill.js';
import './vendor/pdfjs-4.10.38/pdf.worker.min.js';
