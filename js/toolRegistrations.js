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
import { id, esc }      from './utils.js';
import { t }             from './i18n.js';
import { getWmRemove, wmRemoveHtml, bindWmRemove, resetWmRemove } from './watermarkRemoveUI.js';

// ── UI modules ─────────────────────────────────────────────────
import { initCompressOptions, hideCompressOptions,
         getCompressParams, getCompressScan,
         renderCompressionReport,
         initCompressEmailOptions, hideCompressEmailOptions,
         renderEmailVerdict }              from './compressUI.js';
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
import { initDraw, loadPdfFile, resetDraw } from './drawUI.js';
import { initPointer, resetPointer }        from './drawPointer.js';
import { initOcrOptions, hideOcrOptions,
         getOcrParams }                     from './ocrUI.js';
import { initPdf2WordOptions, hidePdf2WordOptions,
         getPdf2WordParams,
         renderP2wConfidence, clearP2wConfidence } from './pdf2wordUI.js';
import { initPdf2ExcelOptions, hidePdf2ExcelOptions,
         getPdf2ExcelParams,
         renderP2eConfidence } from './pdf2excelUI.js';
import { initPdf2PptOptions, hidePdf2PptOptions,
         getPdf2PptParams }                 from './pdf2pptUI.js';
import { initPdf2MdOptions, hidePdf2MdOptions,
         getPdf2MdParams }                  from './pdf2mdUI.js';
import { initUnlockOptions, hideUnlockOptions,
         getUnlockParams }                  from './unlockUI.js';
import { initCompareOptions, hideCompareOptions,
         getCompareParams }               from './compareUI.js';
import { initPdf2PdfaOptions, hidePdf2PdfaOptions } from './pdf2pdfaUI.js';

// ── Merge filename ─────────────────────────────────────────────

let _outputStem        = '';
let _outputNameTouched = false;
let _lastFiles         = [];

// Camera rolls: IMG_0001, DSC_1234, DSCN0001, P1010001, R0010234, scan001, Scan_001
const _CAMERA  = /^[a-z]{1,5}[-_]?\d{3,}/i;
// OS / app defaults: document, file, new, untitled, page, temp, draft, copy, screenshot…
const _GENERIC = /^(document|doc|file|new|untitled|page|pages|output|temp|tmp|draft|copy|unnamed|noname|image|picture|photo|screenshot|capture)[\s\-_\d]*$/i;

function _isGenericStem(stem) {
  const s = stem.trim();
  return _CAMERA.test(s) || _GENERIC.test(s);
}

function _dateStem() {
  const d = new Date();
  return `merged-${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _computeDefaultStem(files) {
  if (!files || files.length === 0) return _dateStem();
  const first = files[0].name.replace(/\.pdf$/i, '');
  return _isGenericStem(first) ? _dateStem() : `${first}_merged`;
}

export function updateMergeDefaultFilename(files) {
  _lastFiles = files || [];
  if (_outputNameTouched) return;
  _outputStem = _computeDefaultStem(_lastFiles);
  const input = document.getElementById('mergeFilenameInput');
  if (input) input.value = _outputStem;
}

export function getMergeFilename() {
  return (_outputStem.trim() || _dateStem()) + '.pdf';
}

function _filenameHtml() {
  return `
    <div style="margin-bottom:14px;">
      <label for="mergeFilenameInput" style="display:block;font-size:12px;font-weight:600;
        color:var(--text2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em;">
        ${t('val_output_filename')}
      </label>
      <div style="display:flex;align-items:center;gap:6px;">
        <input id="mergeFilenameInput" type="text" spellcheck="false" autocomplete="off"
          value="${esc(_outputStem)}"
          style="flex:1;min-width:0;padding:7px 10px;border:1px solid var(--border);
            border-radius:8px;font-size:13px;font-family:inherit;
            background:var(--bg);color:var(--text);outline:none;box-sizing:border-box;">
        <span style="font-size:13px;color:var(--text2);white-space:nowrap;flex-shrink:0;">.pdf</span>
      </div>
    </div>`;
}

function _bindFilenameInput() {
  const input = document.getElementById('mergeFilenameInput');
  if (!input) return;
  input.addEventListener('input', () => {
    _outputStem        = input.value;
    _outputNameTouched = input.value.trim().length > 0;
  });
  input.addEventListener('blur', () => {
    // Strip .pdf if user pastes "report.pdf" into the field
    const clean = input.value.replace(/\.pdf$/i, '').trim();
    if (clean.length === 0) {
      // Field cleared → restore auto-generated default
      _outputNameTouched = false;
      _outputStem        = _computeDefaultStem(_lastFiles);
      input.value        = _outputStem;
    } else {
      input.value = clean;
      _outputStem = clean;
    }
  });
}

// ── Merge options — inline (no separate mergeUI.js needed) ─────

function _initMerge(files) {
  const c = id('mergeOptions');
  if (!c) return;
  // Compute default only if not yet touched by user
  if (!_outputNameTouched) _outputStem = _computeDefaultStem(files || _lastFiles);
  c.innerHTML     = _filenameHtml() + wmRemoveHtml();
  c.style.display = 'block';
  bindWmRemove();
  _bindFilenameInput();
}

function _hideMerge() {
  const c = id('mergeOptions');
  if (c) { c.style.display = 'none'; c.innerHTML = ''; }
  resetWmRemove();
  _outputStem        = '';
  _outputNameTouched = false;
  _lastFiles         = [];
}

// ── Registrations ──────────────────────────────────────────────

registerTool('merge', {
  runner:    'merge',
  multiFile: true,
  minFiles:  1,
  init:      _initMerge,
  hide:      _hideMerge,
  getParams: () => ({ removeWatermarks: getWmRemove(), outputFilename: getMergeFilename() }),
});

registerTool('split', {
  runner:    'split',
  init:      file => initExtractOptions(file, 'separate'),
  hide:      hideExtractOptions,
  getParams: getExtractParams,
  validate:  p => p.pages.length === 0 ? t('val_select_page') : null,
});

registerTool('extract', {
  runner:    'split',   // reuses split worker — mode is always 'single'
  init:      initExtractOptions,
  hide:      hideExtractOptions,
  getParams: getExtractParams,
  validate:  p => p.pages.length === 0 ? t('val_select_page') : null,
});

registerTool('compress', {
  runner:    'compress',
  init:      initCompressOptions,
  hide:      hideCompressOptions,
  getParams: () => ({ ...getCompressParams(), removeWatermarks: getWmRemove(), preScan: getCompressScan() }),
  validate:  (p) => {
    const scan = getCompressScan();
    // Hard block only when scan ran AND confirms Light preset is a near-no-op:
    // Light does not recompress images or use object streams, so if pre-scan
    // found zero removable items the operation will produce negligible results.
    if (scan && p.preset === 'low' && scan.opportunities === 0) {
      return t('val_light_no_savings');
    }
    return null;
  },
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
  validate:  p => p.pages.length === 0 ? t('val_select_page') : null,
});

registerTool('watermark', {
  runner:     'worker',
  workerTool: 'watermark',
  init:       initWatermarkOptions,
  hide:       hideWatermarkOptions,
  getParams:  getWatermarkParams,
  validate:   p => p.kind === 'image'
    ? (!p.bytes ? t('val_wm_upload_logo') : null)
    : (!p.text?.trim() ? t('val_wm_enter_text') : null),
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
  // True redact (canonical /redact-pdf/ tool page, any locale) uses canvas-flatten
  // via dedicated worker. Visual cover (/annotate-pdf/, /cover-pdf/, /highlight-pdf/)
  // keeps worker runner. Gated on data-true-redact (set by tool-page.html only for
  // tool.id === 'redact') rather than an English-only pathname substring — the
  // canonical redact page is served at a translated slug in every non-English
  // locale (e.g. /de/pdf-schwaerzen/), so a literal '/redact-pdf/' check silently
  // fell through to cover-only (recoverable) behavior on all 13 non-English pages
  // while their SEO copy explicitly promised permanent, unrecoverable redaction.
  runner:     document.body.hasAttribute('data-true-redact') ? 'redact-true' : 'worker',
  workerTool: 'redact',
  init:       initRedactOptions,
  hide:       hideRedactOptions,
  getParams:  () => ({ ...getRedactParams(), removeMetadata: !!document.getElementById('rdctRemoveMeta')?.checked }),
  validate:   p => {
    const total = p.applyAll
      ? (p.rects?.length || 0)
      : Object.values(p.rectsByPage || {}).reduce((sum, arr) => sum + arr.length, 0);
    return total === 0 ? t('val_redact_draw_area') : null;
  },
});

registerTool('rotate', {
  runner:     'worker',
  workerTool: 'rotate',
  init:       initRotateOptions,
  hide:       hideRotateOptions,
  getParams:  () => ({ ...getRotateParams(), removeWatermarks: getWmRemove() }),
  validate:   (p) => {
    const changed = p.rotations.filter(r => r.angle !== 0).length;
    if (changed === 0) return t('val_rotate_select');
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
      return t('val_protect_required');
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
  validate:   p => p.loading
                ? t('val_fill_loading')
                : !p.hasFields
                ? t('val_fill_no_fields')
                : p.missingRequired?.length
                ? `${t('val_fill_required_prefix')} ${p.missingRequired.slice(0, 3).join(', ')}${p.missingRequired.length > 3 ? '…' : ''}`
                : null,
});

registerTool('flatten', {
  runner:     'worker',
  workerTool: 'flatten',
  getParams:  () => ({}),
});

let _drawInitialized = false;

registerTool('draw-pdf', {
  async init(file) {
    if (!_drawInitialized) {
      initDraw();
      initPointer();
      _drawInitialized = true;
    }
    await loadPdfFile(file);
  },
  hide() {
    resetPointer();
    resetDraw();
  },
});

registerTool('ocr', {
  init:      initOcrOptions,
  hide:      hideOcrOptions,
  getParams: getOcrParams,
  validate:  p => {
    if (p.loading)                      return t('val_analysing_pdf');
    if (!p.hasFile)                     return null;
    if (!p.isTextPdf && !p.isOcrReady) return t('install_ocr_first');
    return null;
  },
});

registerTool('pdf2word', {
  runner:    'pdf2word',
  init:      initPdf2WordOptions,
  hide:      hidePdf2WordOptions,
  getParams: getPdf2WordParams,
  validate:  p => {
    if (p.loading) return t('val_analysing_pdf');
    if (!p.pageCount) return null;
    return null;
  },
  onSuccess: ({ confidence }) => {
    if (confidence) renderP2wConfidence(confidence);
  },
});

registerTool('pdf2excel', {
  runner:    'pdf2excel',
  init:      initPdf2ExcelOptions,
  hide:      hidePdf2ExcelOptions,
  getParams: getPdf2ExcelParams,
  validate:  p => {
    if (p.loading) return t('val_analysing_pdf');
    if (!p.pageCount) return null;
    return null;
  },
  onSuccess: ({ confidence }) => {
    if (confidence) renderP2eConfidence(confidence);
  },
});

registerTool('pdf2ppt', {
  runner:    'pdf2ppt',
  init:      initPdf2PptOptions,
  hide:      hidePdf2PptOptions,
  getParams: getPdf2PptParams,
  validate:  p => {
    if (p.loading) return t('val_analysing_pdf');
    if (!p.pageCount) return null;
    return null;
  },
});

registerTool('pdf2md', {
  runner:    'pdf2md',
  init:      initPdf2MdOptions,
  hide:      hidePdf2MdOptions,
  getParams: getPdf2MdParams,
  validate:  p => p.loading ? t('val_analysing_pdf') : null,
});

registerTool('unlock', {
  runner:    'unlock',
  init:      initUnlockOptions,
  hide:      hideUnlockOptions,
  getParams: getUnlockParams,
  validate:  p => (p.needsPassword && !p.password) ? t('val_enter_password') : null,
});

registerTool('compare', {
  multiFile: true,
  minFiles:  1,
  init:      initCompareOptions,
  hide:      hideCompareOptions,
  getParams: getCompareParams,
  validate:  p => {
    if (!p.hasFiles) return 'Please select two PDF files to compare';
    return null;
  },
});

// Analysis-only — no runner, no getParams. See pdf2pdfaUI.js header.
registerTool('pdf2pdfa', {
  init: initPdf2PdfaOptions,
  hide: hidePdf2PdfaOptions,
});

// Email compression mode — same worker runner as 'compress' but with
// fixed aggressive params and email-specific post-processing UI.
registerTool('compress-email', {
  runner:    'compress',
  init:      initCompressEmailOptions,
  hide:      hideCompressEmailOptions,
  getParams: () => ({ preset: 'high', targetDpi: 96, quality: 0.60, preserveText: false, removeWatermarks: false, preScan: getCompressScan() }),
  onSuccess: ({ compressionReport }) => {
    if (compressionReport) {
      renderCompressionReport(compressionReport);
      renderEmailVerdict(compressionReport.compressedSize);
    }
  },
});
