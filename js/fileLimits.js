// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Largest file each tool accepts, in MB. Every file is processed on the user's
// own device, so a cap protects that device's memory — it is not a paywall, and
// a capable computer can take more than a phone. The one source of these numbers:
// runners (processor.js), the tools' own panels and the site copy all read them
// from here.
//
// BASE: every device. LARGE: a desktop Chromium browser reporting 8 GB or more of
// memory. navigator.deviceMemory is Chromium-only and stops at 8 (a 32 GB machine
// also says 8); userAgentData.mobile is Chromium-only too, and keeps an Android
// phone that reports 8 GB out of the desktop tier. Safari, Firefox and phones give
// no such signal and stay on BASE.
//
// LARGE only lists tools measured on such a device (real 150–800 MB scans, real
// page, 8 GB Mac, 2026-10-03): merge, compress and split all completed 800 MB at
// ~2.1 GB peak memory, so 500 MB leaves room for the user's other tabs. An
// unmeasured tool keeps its BASE cap until it is measured.
const BASE = {
  merge: 300,          // all files of one merge together
  split: 200,
  extract: 200,
  organize: 200,
  resize: 200,
  mangaSplit: 200,
  fill: 200,
  watermark: 200,
  formFields: 200,
  pagenum: 200,
  meta: 200,
  protect: 200,
  flatten: 200,
  rotate: 150,
  redact: 150,
  compress: 150,
  glossary: 150,
  cleanScan: 150,
  ereader: 150,
  pdf2word: 150,
  pdf2excel: 150,
  pdf2ppt: 150,
  pdf2md: 150,
  unlock: 150,
  ocr: 200,
  pdf2jpg: 100,
  docx2pdf: 60,
  jpg2pdf: 50,         // each image
};
const LARGE = {
  merge: 500,
  split: 500,
  extract: 500,
  compress: 500,
};
const DEFAULT_MB = 200;

function isLargeDevice(nav = globalThis.navigator) {
  return (nav?.deviceMemory ?? 0) >= 8 && nav?.userAgentData?.mobile === false;
}

export function maxFileMb(tool, nav = globalThis.navigator) {
  return (isLargeDevice(nav) && LARGE[tool]) || BASE[tool] || DEFAULT_MB;
}

