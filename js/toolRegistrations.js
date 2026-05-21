// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  toolRegistrations.js — Wires UI modules into the registry.
//
//  This is the ONLY file that imports from all *UI modules.
//  app.js only imports { toolRegistry } — zero knowledge of
//  individual tool UIs. Adding a new tool: add one entry here.
// ============================================================

import { registerTool } from './toolRegistry.js';

// ── UI modules ─────────────────────────────────────────────────
import { initSplitOptions, hideSplitOptions,
         getSelectedPages, getSplitMode }   from './splitUI.js';
import { initCompressOptions, hideCompressOptions,
         getCompressParams,
         renderCompressionReport }         from './compressUI.js';
import { initJpg2PdfOptions, hideJpg2PdfOptions,
         getJpg2PdfParams }               from './jpg2pdfUI.js';
import { initPdf2JpgOptions, hidePdf2JpgOptions,
         getPdf2JpgParams }               from './pdf2jpgUI.js';
import { initWatermarkOptions, hideWatermarkOptions,
         getWatermarkParams }             from './watermarkUI.js';
import { initPageNumOptions, hidePageNumOptions,
         getPageNumParams }               from './pageNumUI.js';
import { initMetaOptions, hideMetaOptions,
         getMetaParams }                  from './metaUI.js';
import { initExtractOptions, hideExtractOptions,
         getExtractParams }               from './extractUI.js';
import { initProtectOptions, hideProtectOptions,
         getProtectParams }              from './protectUI.js';
import { initFillOptions, hideFillOptions,
         getFillParams }                 from './fillUI.js';
import { initRotateOptions, hideRotateOptions,
         getRotateParams }              from './rotateUI.js';
import { initRedactOptions, hideRedactOptions,
         getRedactParams }                from './redactUI.js';

// ── Registrations ──────────────────────────────────────────────

registerTool('merge', {
  runner: 'merge',
});

registerTool('split', {
  runner:    'split',
  init:      initSplitOptions,
  hide:      hideSplitOptions,
  getParams: () => ({ pages: getSelectedPages(), mode: getSplitMode() }),
  validate:  p => p.pages.length === 0 ? 'Please select at least one page' : null,
});

registerTool('extract', {
  runner:    'split',   // reuses split worker — mode is always 'single'
  init:      initExtractOptions,
  hide:      hideExtractOptions,
  getParams: getExtractParams,
  validate:  p => p.pages.length === 0 ? 'Please select at least one page' : null,
});

registerTool('compress', {
  runner:    'compress',
  init:      initCompressOptions,
  hide:      hideCompressOptions,
  getParams: getCompressParams,
  onSuccess: ({ compressionReport }) => {
    if (compressionReport) renderCompressionReport(compressionReport);
  },
});

registerTool('jpg2pdf', {
  runner:    'jpg2pdf',
  multiFile: true,
  minFiles:  1,
  init:      initJpg2PdfOptions,
  hide:      hideJpg2PdfOptions,
  getParams: getJpg2PdfParams,
});

registerTool('pdf2jpg', {
  runner:    'pdf2jpg',
  init:      initPdf2JpgOptions,
  hide:      hidePdf2JpgOptions,
  getParams: getPdf2JpgParams,
  validate:  p => p.pages.length === 0 ? 'Please select at least one page' : null,
});

registerTool('watermark', {
  runner:     'worker',
  workerTool: 'watermark',
  init:       initWatermarkOptions,
  hide:       hideWatermarkOptions,
  getParams:  getWatermarkParams,
  validate:   p => !p.text?.trim() ? 'Please enter watermark text' : null,
});

registerTool('pagenum', {
  runner:     'worker',
  workerTool: 'pagenum',
  init:       initPageNumOptions,
  hide:       hidePageNumOptions,
  getParams:  getPageNumParams,
});

registerTool('meta', {
  runner:     'worker',
  workerTool: 'meta',
  init:       initMetaOptions,
  hide:       hideMetaOptions,
  getParams:  getMetaParams,
});

registerTool('redact', {
  runner:     'worker',
  workerTool: 'redact',
  init:       initRedactOptions,
  hide:       hideRedactOptions,
  getParams:  getRedactParams,  // now returns { rects, rectsByPage, applyAll, fillColor, opacity }
  validate:   p => {
    // Count total rects across all pages (supports both applyAll and per-page mode)
    const total = p.applyAll
      ? (p.rects?.length || 0)
      : Object.values(p.rectsByPage || {}).reduce((sum, arr) => sum + arr.length, 0);
    return total === 0 ? 'Draw at least one area to cover' : null;
  },
});

registerTool('rotate', {
  runner:     'worker',
  workerTool: 'rotate',
  init:       initRotateOptions,
  hide:       hideRotateOptions,
  getParams:  getRotateParams,
  validate:   (p) => {
    const changed = p.rotations.filter(r => r.angle !== 0).length;
    if (changed === 0) return 'Rotate at least one page';
    return null;
  },
});

registerTool('protect', {
  runner:     'worker',
  workerTool: 'protect',
  init:       initProtectOptions,
  hide:       hideProtectOptions,
  getParams:  getProtectParams,
  validate:   (p) => {
    // Both passwords blank = no open password, still valid (permissions only)
    // Require at least one form of protection to avoid no-op submissions
    const hasOpenPwd = p.userPassword?.length > 0;
    const hasRestrictions = Object.values(p.permissions).some(v => v === false);
    if (!hasOpenPwd && !hasRestrictions) {
      return 'Set an open password or restrict at least one permission';
    }
    return null;
  },
});

registerTool('fill', {
  runner:     'worker',
  workerTool: 'fill',
  init:       initFillOptions,
  hide:       hideFillOptions,
  getParams:  getFillParams,
  validate:   p => p.loading    ? 'Reading PDF fields — please wait a moment…'
                : !p.hasFields  ? 'No fillable fields found in this PDF'
                : null,
});
