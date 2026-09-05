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
import { checkbox, chipGroup } from './uiComponents.js';

// ── UI modules ─────────────────────────────────────────────────
import { initCompressOptions, hideCompressOptions,
         getCompressParams, getCompressScan,
         renderCompressionReport, renderBatchCompressionSummary,
         initCompressEmailOptions, hideCompressEmailOptions,
         renderEmailVerdict }              from './compressUI.js';
import { initJpg2PdfOptions, hideJpg2PdfOptions,
         getJpg2PdfParams }               from './jpg2pdfUI.js';
import { initScanDocumentOptions, hideScanDocumentOptions,
         getScanDocumentParams }          from './scanDocumentUI.js';
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
         getFillParams, clearFillDraft } from './fillUI.js';
import { initRotateOptions, hideRotateOptions,
         getRotateParams }              from './rotateUI.js';
import { initOrganizeOptions, hideOrganizeOptions,
         getOrganizeParams }            from './organizeUI.js';
import { initGlossaryOptions, hideGlossaryOptions,
         getGlossaryParams }            from './glossaryUI.js';
import { initResizeOptions, hideResizeOptions,
         getResizeParams }              from './resizeUI.js';
import { initMangaSplitOptions, hideMangaSplitOptions,
         getMangaSplitParams, renderMangaSurvey } from './mangaSplitUI.js';
import { initCleanScanOptions, hideCleanScanOptions,
         getCleanScanParams }           from './cleanScanUI.js';
import { initEreaderOptions, hideEreaderOptions,
         getEreaderParams }              from './ereaderUI.js';
import { initRedactOptions, hideRedactOptions,
         getRedactParams }                from './redactUI.js';
import { initDraw, loadPdfFile, resetDraw } from './drawUI.js';
import { initPointer, resetPointer }        from './drawPointer.js';
import { initOcrOptions, hideOcrOptions,
         getOcrParams }                     from './ocrUI.js';
import { initPdf2WordOptions, hidePdf2WordOptions,
         getPdf2WordParams,
         renderP2wConfidence, clearP2wConfidence,
         renderAtlasCheck } from './pdf2wordUI.js';
import { initPdf2ExcelOptions, hidePdf2ExcelOptions,
         getPdf2ExcelParams,
         renderP2eConfidence } from './pdf2excelUI.js';
import { initPdf2PptOptions, hidePdf2PptOptions,
         getPdf2PptParams }                 from './pdf2pptUI.js';
import { initPdf2MdOptions, hidePdf2MdOptions,
         getPdf2MdParams }                  from './pdf2mdUI.js';
import { initDocx2PdfOptions, hideDocx2PdfOptions,
         getDocx2PdfParams }                from './docx2pdfUI.js';
import { initUnlockOptions, hideUnlockOptions,
         getUnlockParams }                  from './unlockUI.js';
import { initCompareOptions, hideCompareOptions,
         getCompareParams }               from './compareUI.js';
import { initPdf2PdfaOptions, hidePdf2PdfaOptions } from './pdf2pdfaUI.js';
import { initReadOptions, hideReadOptions,
         cancelRead, getReadParams }         from './readUI.js';

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

// ── Merge: bookmarks + blank pages — inline, same rationale as the
//    filename field above (no separate mergeUI.js needed) ─────────

let _createBookmarks   = false;   // off by default — same opt-in convention as wmRemove
let _insertBlankPages  = 'none';  // 'none' | 'always' | 'odd' — 'none' is a zero-behavior-change default

const BOOKMARKS_TOGGLE_ID  = 'mergeBookmarksToggle';
const BLANK_PAGES_GROUP_ID = 'mergeBlankPages';

function _bookmarksHtml() {
  return checkbox({
    id:       BOOKMARKS_TOGGLE_ID,
    checked:  _createBookmarks,
    title:    t('merge_bookmarks_title'),
    subtitle: t('merge_bookmarks_subtitle'),
  });
}

function _blankPagesHtml() {
  return `
    <div style="margin-top:14px;">
      <label style="display:block;font-size:12px;font-weight:600;color:var(--text2);
        margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em;">
        ${t('merge_blank_pages_title')}
      </label>
      ${chipGroup(BLANK_PAGES_GROUP_ID, [
        { value: 'none',   label: t('merge_blank_pages_none') },
        { value: 'always', label: t('merge_blank_pages_always') },
        { value: 'odd',    label: t('merge_blank_pages_odd') },
      ], _insertBlankPages, t('merge_blank_pages_title'))}
    </div>`;
}

function _bindMergeExtras() {
  document.getElementById(BOOKMARKS_TOGGLE_ID)?.addEventListener('change', e => {
    _createBookmarks = e.target.checked;
  });
  document.querySelectorAll(`input[name="${BLANK_PAGES_GROUP_ID}"]`).forEach(input => {
    input.addEventListener('change', e => {
      if (!e.target.checked) return;
      _insertBlankPages = e.target.value;
      // chip()'s active class is only set at initial-render time (see uiComponents.js) —
      // every other chipGroup consumer (pageNumUI, jpg2pdfUI, resizeUI, …) re-toggles it
      // here on change; this one didn't, so a real click silently updated the selection
      // (and what actually merges) while the UI kept showing "None" highlighted — a real
      // user reported clicking Always/Odd "did nothing" for exactly this reason.
      document.querySelectorAll(`[data-name="${BLANK_PAGES_GROUP_ID}"]`).forEach(el =>
        el.classList.toggle('j2p-chip--active', el.dataset.value === _insertBlankPages));
    });
  });
}

function _resetMergeExtras() {
  _createBookmarks  = false;
  _insertBlankPages = 'none';
}

// ── Merge options — inline (no separate mergeUI.js needed) ─────

function _initMerge(files) {
  const c = id('mergeOptions');
  if (!c) return;
  // Real bug found via Analytics Engine rage-click data (2026-08-20):
  // initToolOptions() re-runs this on EVERY 'pdfree:files-added' /
  // 'pdfree:file-removed' / 'pdfree:file-decrypted' event — i.e. every
  // time a file is added or removed from the merge list, not just once.
  // The old code unconditionally rebuilt c.innerHTML every single call,
  // tearing out and recreating #mergeFilenameInput each time. The typed
  // VALUE survived (restored via _outputStem), but a user mid-typing a
  // custom filename — then adding one more file, a completely natural
  // sequence — got their cursor/focus yanked away mid-edit, over and
  // over, on every file added. Now only does the full (re)build once;
  // subsequent calls just keep the auto-generated default in sync (same
  // "only if not touched by user" rule as before), without ever touching
  // the DOM node the user might currently be focused in.
  const alreadyRendered = !!document.getElementById('mergeFilenameInput');
  if (!alreadyRendered) {
    if (!_outputNameTouched) _outputStem = _computeDefaultStem(files || _lastFiles);
    c.innerHTML     = _filenameHtml() + wmRemoveHtml() + _bookmarksHtml() + _blankPagesHtml();
    c.style.display = 'block';
    bindWmRemove();
    _bindFilenameInput();
    _bindMergeExtras();
    return;
  }
  if (_outputNameTouched) return;
  _outputStem = _computeDefaultStem(files || _lastFiles);
  const input = document.getElementById('mergeFilenameInput');
  if (input && document.activeElement !== input) input.value = _outputStem;
}

function _hideMerge() {
  const c = id('mergeOptions');
  if (c) { c.style.display = 'none'; c.innerHTML = ''; }
  resetWmRemove();
  _resetMergeExtras();
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
  getParams: () => ({
    removeWatermarks: getWmRemove(),
    outputFilename:   getMergeFilename(),
    createBookmarks:  _createBookmarks,
    insertBlankPages: _insertBlankPages,
  }),
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
  // preScan is this file's scan result, not a reusable setting; removeWatermarks
  // is a shared cross-tool toggle (watermarkRemoveUI.js) with no restore path
  // yet — both stripped, leaving only compressUI.js's own settings.
  presetFilter: ({ preset, preserveText, targetDpi, quality, targetSizeMb }) =>
    ({ preset, preserveText, targetDpi, quality, targetSizeMb }),
  onSuccess: ({ compressionReport, batchCompressSummary }) => {
    if (compressionReport) renderCompressionReport(compressionReport);
    else if (batchCompressSummary) renderBatchCompressionSummary(batchCompressSummary);
  },
});

registerTool('jpg2pdf', {
  runner:    'jpg2pdf',
  multiFile: true,
  minFiles:  1,
  init:      initJpg2PdfOptions,
  hide:      hideJpg2PdfOptions,
  getParams: getJpg2PdfParams,
  // exifAngles is per-image rotation for this specific batch, not a reusable
  // setting — stripped, leaving only jpg2pdfUI.js's own layout/quality settings.
  presetFilter: ({ pageSize, orientation, compress, quality }) =>
    ({ pageSize, orientation, compress, quality }),
});

registerTool('scanDocument', {
  // Shares jpg2pdf's exact assembly path (handleJpg2Pdf in js/worker.js) —
  // getScanDocumentParams() returns the same shape getJpg2PdfParams() does.
  // Zero new worker code for this whole tool. See js/scanDocumentUI.js.
  runner:    'jpg2pdf',
  multiFile: true,
  minFiles:  1,
  init:      initScanDocumentOptions,
  hide:      hideScanDocumentOptions,
  getParams: getScanDocumentParams,
  validate:  p => {
    if (p.reviewPending) return t('val_scan_review_pending');
    if (!p.hasFiles) return t('val_scan_no_files');
    return null;
  },
  presetFilter: ({ pageSize, orientation, compress, quality }) =>
    ({ pageSize, orientation, compress, quality }),
});

registerTool('pdf2jpg', {
  runner:    'pdf2jpg',
  init:      initPdf2JpgOptions,
  hide:      hidePdf2JpgOptions,
  getParams: getPdf2JpgParams,
  validate:  p => p.pages.length === 0 ? t('val_select_page') : null,
  // pages is this document's own page selection, not a reusable setting —
  // stripped, leaving only pdf2jpgUI.js's own output settings.
  presetFilter: ({ format, dpi, zip }) => ({ format, dpi, zip }),
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
  // Image-mode watermarks carry the logo's raw bytes — not practical to
  // persist in localStorage, so image mode simply isn't remembered.
  presetFilter: p => p.kind === 'image'
    ? null
    : { kind: p.kind, text: p.text, opacity: p.opacity, position: p.position, fontSize: p.fontSize, color: p.color },
});

registerTool('pagenum', {
  runner:     'worker',
  workerTool: 'pagenum',
  init:       initPageNumOptions,
  hide:       hidePageNumOptions,
  getParams:  getPageNumParams,
  // Catches a From/To range outside the real document (e.g. "from page 50"
  // on a 2-page PDF) — previously nothing did, so the worker just clamped to
  // an empty range and numbered zero pages while still reporting success.
  // pageCount===0 means pageNumUI hasn't finished reading it yet (or
  // couldn't) — skip the check rather than risk a false-positive block; the
  // worker's own clamp stays the last-resort safety net regardless.
  validate: p => {
    if (p.pageCount > 0) {
      const to = p.toPage ?? p.pageCount;
      if (p.fromPage > p.pageCount || to < p.fromPage) {
        return t('val_pagenum_out_of_range', { n: p.pageCount });
      }
    }
    return null;
  },
  // fromPage/toPage are this document's page range, not a reusable setting —
  // the next file re-applies the saved format/position from page 1.
  presetFilter: ({ position, format, fontSize, showTotal }) => ({ position, format, fontSize, showTotal }),
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

registerTool('organize', {
  runner:     'organize', // dedicated js/organizeWorker.js, not the shared js/worker.js — see processor.js's _runOrganize
  init:       initOrganizeOptions,
  hide:       hideOrganizeOptions,
  getParams:  getOrganizeParams,
  validate:   (p) => p.pageOrder.length === 0 ? t('val_organize_no_pages') : null,
  // No presetFilter — page order/deletions/rotations are 100% specific to
  // this document, same reasoning that excludes rotate entirely and strips
  // exifAngles/pages from jpg2pdf's and pdf2jpg's presets.
});

registerTool('glossary', {
  runner:     'glossary', // dedicated js/glossaryWorker.js, not the shared js/worker.js — see processor.js's _runGlossary
  init:       initGlossaryOptions,
  hide:       hideGlossaryOptions,
  getParams:  getGlossaryParams,
  validate:   (p) => {
    if (!p.hasFile) return t('val_glossary_no_dictionary');
    if (p.dictionary.length === 0) return t('val_glossary_no_dictionary');
    return null;
  },
  // No presetFilter — the dictionary is pasted fresh per document, same
  // reasoning as organize's page order: nothing here generalizes.
});

registerTool('resize', {
  runner:     'resize', // dedicated js/resizeWorker.js, not the shared js/worker.js — see processor.js's _runResize
  init:       initResizeOptions,
  hide:       hideResizeOptions,
  getParams:  getResizeParams,
  // Unlike rotate/organize, every field here (paper size, mode, margin,
  // orientation) is a genuine cross-document preference, not per-document
  // state — safe to persist as-is, same class as jpg2pdf/pdf2jpg's presets.
  presetFilter: (p) => ({ ...p }),
});

registerTool('mangaSplit', {
  runner:     'mangaSplit', // dedicated js/mangaSplitWorker.js, not the shared js/worker.js — see processor.js's _runMangaSplit
  init:       initMangaSplitOptions,
  hide:       hideMangaSplitOptions,
  getParams:  getMangaSplitParams,
  onSuccess:  () => renderMangaSurvey(),
  // No presetFilter — rtl/skipPages are cheap to redo per document and
  // skipPages (page indices) has no meaning carried over to a different PDF,
  // same reasoning that excludes rotate/organize's per-document state.
});

registerTool('cleanScan', {
  runner:    'cleanScan', // dedicated js/cleanScanWorker.js, not the shared js/worker.js — see processor.js's _runCleanScan
  init:      initCleanScanOptions,
  hide:      hideCleanScanOptions,
  getParams: getCleanScanParams,
  validate:  p => !p.hasFile ? t('val_cs_loading') : null,
});

registerTool('ereader', {
  runner:    'ereader', // dedicated js/ereaderWorker.js, not the shared js/worker.js — see processor.js's _runEreader
  init:      initEreaderOptions,
  hide:      hideEreaderOptions,
  getParams: getEreaderParams,
  validate:  p => !p.hasFile ? t('val_er_loading') : null,
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
  // Passwords are never persisted — protectUI.js deliberately never caches
  // them across async gaps either. Only the permission toggles are reusable.
  presetFilter: ({ permissions }) => ({ permissions }),
});

registerTool('fill', {
  runner:     'fillOrder', // dedicated js/fillOrderWorker.js runs first (tab order), then falls through to the shared js/worker.js fill pipeline — see processor.js's _runFillOrder
  workerTool: 'fill',
  init:       initFillOptions,
  hide:       hideFillOptions,
  getParams:  getFillParams,
  onSuccess:  () => clearFillDraft(),
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
  onSuccess: ({ confidence, atlasEri }) => {
    if (confidence) renderP2wConfidence(confidence);
    // Always called (not gated on atlasEri being truthy): renderAtlasCheck
    // clears the shared #atlasCheck div itself when passed a falsy/errored
    // value — matters now that TWO tools (this one and pdf2md) can populate
    // the same div, so switching between them must always leave it in sync
    // with whichever tool just actually ran, not stale from the other.
    renderAtlasCheck(atlasEri);
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
  // Same shared #atlasCheck div pdf2word uses (js/eriScoreMd.js computes the
  // score for Markdown output instead of DOCX) — always called, not gated,
  // so it self-clears correctly when switching to/from pdf2word.
  onSuccess: ({ atlasEri }) => renderAtlasCheck(atlasEri, 'atlas_check_scope_note_md'),
});

registerTool('docx2pdf', {
  runner:    'docx2pdf',
  init:      initDocx2PdfOptions,
  hide:      hideDocx2PdfOptions,
  getParams: getDocx2PdfParams,
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

// No runner — self-managed like compare/ocr/pdf2pdfa (see SELF_MANAGED_TOOLS
// in js/app.js). Auto-runs on file load (mirrors pdf2pdfa's own precedent,
// not compare's click-to-confirm — there's nothing to configure beforehand),
// so validate() never actually blocks a click here in practice.
registerTool('read', {
  init:      initReadOptions,
  hide:      hideReadOptions,
  cancel:    cancelRead,
  getParams: getReadParams,
  // init() only ever runs once a file is already selected, and doProcess()
  // is never called for a self-managed tool — there's no reachable invalid
  // state for this to report.
  validate:  () => null,
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
