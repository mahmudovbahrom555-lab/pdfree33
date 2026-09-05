// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  processor.js — PDF processing via Web Worker
// ============================================================

import { fmtSize } from './utils.js';
import { t, tp } from './i18n.js';
import { setProgress, hideProgress, setButtonProcessing, setButtonReady,
         showCancelBtn, hideCancelBtn, showToast, startLongOpHint, clearLongOpHint } from './ui.js';
import { selectedFiles, setFilesLocked, renderList } from './files.js';
import { trackToolError, trackBatchStart, trackBatchSuccess } from './analytics.js';
import { TOOLS, MAX_COMPRESS_MB } from './config.js';
import { getRunner, getWorkerTool } from './toolRegistry.js';
import { loadJSZip, loadDocx, loadExcelJs, loadPptxGenJs } from './lazyLibs.js';
import { loadPdfJs } from './pdf2jpgUI.js';
import { preprocessPdfBuffer, decryptWithPassword } from './decryptPdf.js';
import { detectTables, groupItemsIntoLines, looksLikeProseNotData, looksLikeEnumeratedList } from './pdf2wordTables.js';
import { detectColumnRegions, pageIsRtl } from './pdf2wordColumns.js';
import { openFeedback } from './feedback.js';
import { isHeicFile, decodeHeicToJpegBlob } from './heicDecode.js';
import { evaluateStructural } from './eriScore.js';
import { evaluateXlsxStructural } from './eriScoreXlsx.js';
import { evaluateMarkdownStructural } from './eriScoreMd.js';
import { contentBBox, reconcileGlobalCrop, padBBox, composeWithAspect, DEVICE_PRESETS,
         detectColumnGutter, reconcileColumnSplit, ereaderSampleIndices } from './ereaderCrop.js';
import { BULLET_RE, NUMBERED_RE, LETTERED_RE, BOLD_FONT_NAME_RE, MONEY_TOKEN_RE,
         _visualRTLToLogical, _splitCrossColumnLines, _isCjk } from './textLayoutUtils.js';
import { _p2mdExtractText, _p2mdRender, _detectPageImages, browserCanvasFactory } from './pdf2mdCore.js';
import { _p2wBuildPageData } from './pdf2readCore.js';
import { recognizeFormula } from './formulaOcr.js';
import { docxToPdf } from './docxToPdfCore.js';
export { BULLET_RE, NUMBERED_RE, LETTERED_RE, BOLD_FONT_NAME_RE, MONEY_TOKEN_RE, _splitCrossColumnLines };

// Below this ERI "tables" score, the text-detected/border-grid tables in the
// first-pass docx are more likely mis-detected layout (garbled/ghost tables)
// than real ones — see checkTablesStruct() in eriChecks.js. _runPdf2Word()
// rebuilds paragraphs-only (no tables) in that case and keeps whichever
// variant scores higher overall, rather than shipping a probably-broken table.
const _ERI_TABLE_RETRY_THRESHOLD = 0.75;

// pdf2excel's two independent quality gates, applied in sequence:
//  1. detectTables()'s OWN confidence (pdf2wordTables.js) already floors at
//     0.72 before a table is returned at all — _P2E_CONF_THRESHOLD raises
//     that bar specifically for "does this deserve its own worksheet", vs.
//     being flattened into the Text sheet as plain rows.
//  2. _P2E_ERI_THRESHOLD is a second, independent opinion computed from the
//     ACTUAL produced .xlsx bytes (eriScoreXlsx.js) — a table can pass gate 1
//     (detector was confident) and still be structurally wrong (e.g. a
//     confidently-aligned two-column resume layout that isn't tabular data).
const _P2E_CONF_THRESHOLD = 0.85;
const _P2E_ERI_THRESHOLD  = 70;

// CamScanner adds a stamp at the bottom of every scanned page. pdf.js
// sometimes extracts it as two separate items on the same line, so joining
// produces "CamScannerCamScanner" instead of "CamScanner". Normalise to
// a single canonical form so the frequency counter sees one string, not two.
// Also collapse the "cs]" logo abbreviation and bare "-" separator line.
// Shared by _p2wBuildPageData() (builds the repeat-text set) and
// _p2wBuildParagraphs() (checks a paragraph against that set).
const _normWatermark = t =>
  t.replace(/^(CamScanner)+$/i, 'CamScanner')
   .replace(/^[Cc][Ss]\]?$/, 'CamScanner')
   .replace(/^-$/, '');

// Digit-normalized form of an already-_normWatermark'd string, e.g.
// "Page 1 of 4" -> "Page # of #" — lets the page-number footer/header
// detector below (js/processor.js's _repeatPatternSet) catch VARIABLE
// page-number text that differs per page by design and so never matches
// _repeatTextSet's exact-string check.
const _normDigits = t => t.replace(/\d+/g, '#');

// _pptxSafeFontFace moved to js/pdf2readCore.js (imported above) — its only
// caller, _p2wBuildPageData, moved there too.

// Hard cap for image mode — defined here to avoid coupling with pdf2wordUI.js.
// Must match MAX_IMAGE_PAGES in pdf2wordUI.js.
const _P2W_IMAGE_CAP = 500;

// BULLET_RE/NUMBERED_RE/BOLD_FONT_NAME_RE/MONEY_TOKEN_RE moved to
// textLayoutUtils.js (shared with pdf2md's core) — imported below,
// re-exported here for backward compatibility with existing test imports.

// docx.js reference id linking a numbered-list Paragraph (in
// _p2wBuildParagraphs) to the Document-level numbering definition that
// actually supplies the "1. 2. 3." auto-numbering (built in _runPdf2Word's
// _buildDoc). Bullets don't need this — docx.js's `bullet: { level: 0 }`
// shorthand needs no matching Document-level config.
const _P2W_NUMBERED_LIST_REF = 'p2w-numbered-list';

let _worker = _createWorker();
export let isProcessing = false;
// _p2wBuildPageData/_p2wBuildParagraphs check isProcessing per-page to
// support mid-run cancellation. It's normally only ever set true inside
// doProcess()'s real orchestration — anything calling these functions
// directly and bypassing doProcess() (tests, and self-managed tools like
// Read that never go through the worker/registry runner pipeline at all)
// needs a way to flip it without invoking the full side-effecting pipeline
// (DOM events, worker messaging, etc.).
export function _setProcessingFlag(v) { isProcessing = v; }
let _currentTool = '';
let _processStartMs = null;
export function getProcessStartMs() { return _processStartMs; }

function _createWorker() {
  // ?v= query forces cache bypass when worker.js changes — prevents stale SW cache
  // Use new URL(..., import.meta.url) so the path resolves relative to THIS module
  // (js/processor.js), not relative to the HTML page that loaded it.
  // CRITICAL for localized subfolders (/de/, /es/, /fr/, /pt/) where a plain
  // './js/worker.js' would resolve to /de/js/worker.js → 404 → silent hang.
  return new Worker(new URL('./worker.js?v=__WORKER_HASH__', import.meta.url));
}

// ── Background compress pre-scan ─────────────────────────────
// Runs when the user drops a file — scans PDF structure in the worker
// before they click Compress, so recommendations appear immediately.
// Returns the scan report, or null if scan was cancelled/skipped.

let _scanResolve = null; // pending promise resolver

export function startCompressScan(file) {
  if (isProcessing) return Promise.resolve(null); // compression running — skip
  cancelCompressScan(); // abort any previous in-flight scan

  return new Promise(resolve => {
    _scanResolve = resolve;
    _worker.onmessage = (e) => {
      if (e.data.type === 'scan-done') {
        _scanResolve = null;
        _worker.onmessage = null;
        resolve(e.data.report);
      }
    };
    // File is sent by structured clone (not Transferable) — stays accessible in main thread
    _worker.postMessage({ tool: 'compress-scan', file });
  });
}

export function cancelCompressScan() {
  if (!_scanResolve) return;
  _scanResolve(null);
  _scanResolve      = null;
  // The scan's postMessage is still executing inside the worker — a single
  // in-flight message can't be aborted, only ignored client-side. Left alone,
  // it keeps parsing the PDF in the background, competing for CPU/RAM with
  // whatever runs next (e.g. the real compress/merge job the user just
  // triggered). On memory-constrained mobile devices that contention can
  // silently crash or stall the worker mid-job. Recreating it guarantees
  // a clean slate for the job about to start.
  _worker.terminate();
  _worker = _createWorker();
}

// ── Background merge page-count scan ─────────────────────────
// Runs when the user adds files to the merge list — counts pages
// in each file so the file list shows "contract.pdf · 2.4 MB · 12 pages".

let _mergeScanResolve = null;

export function startMergeBatchScan(files) {
  if (isProcessing) return Promise.resolve([]);
  cancelCompressScan();
  cancelMergeScan();

  return new Promise(resolve => {
    _mergeScanResolve = resolve;
    _worker.onmessage = (e) => {
      if (e.data.type === 'merge-scan-done') {
        _mergeScanResolve = null;
        _worker.onmessage  = null;
        resolve(e.data.results);
      }
    };
    // Files are sent as structured clone (not Transferable) — originals stay accessible
    _worker.postMessage({
      tool:  'merge-scan-batch',
      items: files.map((f, i) => ({ file: f, index: i })),
    });
  });
}

export function cancelMergeScan() {
  if (!_mergeScanResolve) return;
  _mergeScanResolve([]);
  _mergeScanResolve  = null;
  // Same reasoning as cancelCompressScan(): the in-flight 'merge-scan-batch'
  // message can't be aborted, only ignored — without recreating the worker it
  // keeps reading/parsing every queued file in the background right as the
  // real 'merge' job is about to be posted to the SAME worker, doubling
  // memory/CPU load at the worst possible moment. This is the likely cause
  // of "sometimes it just doesn't merge" reports on lower-memory phones —
  // clicking Merge before the background page-count scan has finished.
  _worker.terminate();
  _worker = _createWorker();
}

// ── Cancel ────────────────────────────────────────────────────

// Set only while a batch job (see "Batch processing" section below) is
// awaiting a postMessage round-trip. Lets cancelProcess() unstick the
// sequential await loop instead of leaving it hung on a terminated worker.
let _batchCancelReject = null;

export function cancelProcess(currentTool) {
  if (!isProcessing) return;
  if (_batchCancelReject) {
    const reject = _batchCancelReject;
    _batchCancelReject = null;
    reject(new _BatchCancelled());
  }
  _worker.terminate();
  _worker      = _createWorker();
  isProcessing = false;
  setFilesLocked(false);
  hideProgress();
  hideCancelBtn();
  setButtonReady(TOOLS[currentTool].btn);
  showToast(t('cancelled'));

  // A batch queue (see "Batch processing" section) may have left per-row
  // pending/processing/done/error badges on selectedFiles — clear them so a
  // cancelled run doesn't look like a stale partial result on next render.
  if (selectedFiles.some(f => f._batchStatus)) {
    selectedFiles.forEach(f => { delete f._batchStatus; });
    renderList();
  }
}

// Sentinel error — signals _runBatch's loop to unwind quietly because
// cancelProcess() already performed all UI cleanup (button, progress,
// toast). Distinguished from a real per-file failure, which should mark
// that row as errored and continue with the rest of the queue.
class _BatchCancelled extends Error {}

// ── Main entry point ──────────────────────────────────────────

function _abortUI() {
  isProcessing = false;
  setFilesLocked(false);
  hideCancelBtn();
  hideProgress();
  setButtonReady(TOOLS[_currentTool]?.btn || 'Try again');
}

export async function doProcess(currentTool, extraParams = {}) {
  if (isProcessing) return;
  cancelCompressScan(); // abort any in-flight background scan before starting compression
  cancelMergeScan();    // abort any in-flight merge page-count scan
  isProcessing = true;
  _currentTool = currentTool;
  _processStartMs = Date.now();

  const filesSnapshot = [...selectedFiles];

  setFilesLocked(true);
  setButtonProcessing();
  setProgress(5, t('prog_reading'));
  startLongOpHint(12000);
  showCancelBtn();

  // ── Batch dispatch ──────────────────────────────────────────────
  // 2+ files for any tool in BATCH_TOOLS (compress/watermark/protect/
  // pagenum/flatten) route into the sequential queue + ZIP flow
  // (see "Batch processing" section below) instead of the single-file
  // runnerMap. Exactly one file for ANY tool always falls through to the
  // unchanged code below — single-file behavior is byte-for-byte
  // identical to before batch processing existed.
  if (BATCH_TOOLS.has(currentTool) && filesSnapshot.length > 1) {
    try {
      await _runBatch(currentTool, filesSnapshot, extraParams);
    } catch (err) {
      isProcessing = false;
      setFilesLocked(false);
      hideCancelBtn();
      _handleError(currentTool, err.message);
    }
    return;
  }

  // ── Runner dispatch ────────────────────────────────────────────
  // Registry maps each tool to a runner key (e.g. 'merge', 'worker').
  // This map resolves runner key → _run* function — O(1), no if-else.
  // Adding a new runner type: add one entry here + one _run* function.
  // Adding a new tool that uses an existing runner: only toolRegistrations.js.
  const runnerMap = {
    merge:    () => _runMerge(filesSnapshot, extraParams),
    split:    () => _runSplit(filesSnapshot, extraParams),
    compress: () => _runCompress(filesSnapshot, extraParams, currentTool),
    jpg2pdf:  () => _runJpg2Pdf(filesSnapshot, extraParams),
    pdf2jpg:  () => _runPdf2Jpg(filesSnapshot, extraParams),
    pdf2word: () => _runPdf2Word(filesSnapshot, extraParams),
    pdf2excel: () => _runPdf2Excel(filesSnapshot, extraParams),
    pdf2ppt:  () => _runPdf2Ppt(filesSnapshot, extraParams),
    pdf2md:   () => _runPdf2Md(filesSnapshot, extraParams),
    docx2pdf: () => _runDocx2Pdf(filesSnapshot, extraParams),
    unlock:       () => _runUnlock(filesSnapshot, extraParams),
    worker:       () => _runWorkerTool(getWorkerTool(currentTool) ?? currentTool, filesSnapshot, extraParams),
    organize:     () => _runOrganize(filesSnapshot, extraParams),
    resize:       () => _runResize(filesSnapshot, extraParams),
    mangaSplit:   () => _runMangaSplit(filesSnapshot, extraParams),
    fillOrder:    () => _runFillOrder(filesSnapshot, extraParams),
    cleanScan:    () => _runCleanScan(filesSnapshot, extraParams),
    ereader:      () => _runEreader(filesSnapshot, extraParams),
    glossary:     () => _runGlossary(filesSnapshot, extraParams),
    'redact-true': () => _runRedactTrue(filesSnapshot, extraParams),
  };

  try {
    const runner = getRunner(currentTool);
    const run    = runnerMap[runner] ?? (() => _runStub(currentTool));
    await run();
  } catch (err) {
    isProcessing = false;
    setFilesLocked(false);
    hideCancelBtn();
    _handleError(currentTool, err.message);
  }
}

// ── Size guards ────────────────────────────────────────────────

const MB = 1024 * 1024;

function _checkSize(file, maxMb) {
  if (file.size > maxMb * MB) {
    showToast(t('warn_file_too_large', { size: fmtSize(file.size), max: maxMb }), 8000);
    return false;
  }
  return true;
}

function _checkTotalSize(files, maxMb) {
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > maxMb * MB) {
    showToast(t('warn_total_too_large', { size: fmtSize(total), max: maxMb }), 8000);
    return false;
  }
  return true;
}

// ── Merge ──────────────────────────────────────────────────────

// Deliberately its own Worker instance, NOT the shared `_worker` above —
// js/worker.js is off-limits per CLAUDE.md. js/mergeWorker.js is a
// standalone classic worker, same pattern as js/organizeWorker.js/
// js/resizeWorker.js. Created once and kept alive for the session, same
// rationale as `_organizeWorker` below.
let _mergeWorker = null;
function _ensureMergeWorker() {
  if (!_mergeWorker) {
    _mergeWorker = new Worker(new URL('./mergeWorker.js', import.meta.url));
  }
  return _mergeWorker;
}

async function _runMerge(filesSnapshot, { removeWatermarks = false, outputFilename = '', createBookmarks = false, insertBlankPages = 'none' } = {}) {
  if (!_checkTotalSize(filesSnapshot, 300)) { _abortUI(); return; }
  // Use pre-decrypted buffer when files.js already ran QPDF at file-add time.
  // .slice(0) copies so the cached buffer survives the postMessage transfer.
  const buffers = await Promise.all(filesSnapshot.map(async f =>
    f._decryptedBuffer ? f._decryptedBuffer.slice(0) : await preprocessPdfBuffer(await f.arrayBuffer())
  ));
  setProgress(10, t('prog_merging'));

  // Watchdog: mirrors _runCompress's — browsers don't reliably fire onerror
  // when a worker is OOM-killed, which is exactly the failure mode
  // cancelMergeScan() above guards against (a stale background page-count
  // scan competing for memory with this job on a low-RAM phone). Without
  // this, a silently-dead worker leaves the UI stuck in "processing"
  // forever with no error and no merged file — indistinguishable from
  // "nothing happened" from the user's side.
  const WATCHDOG_MS = 45_000;
  let watchdog = setTimeout(() => {
    if (!isProcessing) return;   // already cancelled — don't fire phantom error
    isProcessing = false;
    setFilesLocked(false);
    hideCancelBtn();
    _handleError('merge', t('err_merge_timeout'), 'timeout');
  }, WATCHDOG_MS);
  const _resetWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (!isProcessing) return;
      isProcessing = false;
      setFilesLocked(false);
      hideCancelBtn();
      _handleError('merge', t('err_merge_timeout'), 'timeout');
    }, WATCHDOG_MS);
  };

  // ⚠️  TRANSFERABLE: all buffers in `buffers` are transferred to the worker.
  //     They are DETACHED here immediately after postMessage — do not read them.
  //     Filenames are passed separately (plain strings, not Transferable) so the
  //     worker can include them in error reports for the "skipped files" toast.
  const names  = filesSnapshot.map(f => f.name);
  const worker = _ensureMergeWorker();
  worker.postMessage({ files: buffers, names, removeWatermarks, createBookmarks, insertBlankPages }, buffers);

  worker.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'progress') {
      _resetWatchdog();
      setProgress(data.value, data.label);
    } else if (data.type === 'done') {
      clearTimeout(watchdog);
      if (!(data.result instanceof ArrayBuffer)) {
        _handleError('merge', 'Unexpected result type from worker'); return;
      }
      isProcessing = false;
      setFilesLocked(false);
      hideCancelBtn();
      setProgress(100, t('prog_done'));
      const blob = new Blob([data.result], { type: 'application/pdf' });

      // Reflect partial success in the description when some files were skipped
      const mergedCount  = data.mergedCount ?? filesSnapshot.length;
      const skippedCount = filesSnapshot.length - mergedCount;
      const desc = skippedCount > 0
        ? t('desc_merged_partial', { n: mergedCount, total: filesSnapshot.length, pages: data.totalPages, size: fmtSize(blob.size) })
        : t('desc_merged', { total: filesSnapshot.length, pages: data.totalPages, size: fmtSize(blob.size) });

      const filename = outputFilename ||
        `${filesSnapshot[0]?.name.replace(/\.pdf$/i, '') ?? 'merged_document'}_merged.pdf`;
      document.dispatchEvent(new CustomEvent('pdfree:success', {
        detail: { tool: 'merge', blob, desc, filename, pageCounts: data.pageCounts ?? null }
      }));

      // Consolidated toast for skipped files — one message beats five individual ones.
      // Cap at 5 entries: 90 error labels in one toast is unreadable.
      if (data.fileErrors?.length > 0) {
        const MAX_SHOWN  = 5;
        const shown      = data.fileErrors.slice(0, MAX_SHOWN);
        const overflow   = data.fileErrors.length - shown.length;
        const labels     = shown.map(e => {
          const hint = e.code === 'ENCRYPTED' ? t('hint_protected')
                     : e.code === 'CORRUPT'   ? t('hint_corrupted')
                     :                          '';
          // Use filename when available (added in v14+), fall back to position
          return (e.name ?? `#${e.index}`) + hint;
        });
        if (overflow > 0) labels.push(t('more_files', { n: overflow }));
        showToast(
          tp(data.fileErrors.length, 'skipped_files_one', 'skipped_files_many', { labels: labels.join(', ') }),
          7000
        );
      }
    } else if (data.type === 'error') {
      clearTimeout(watchdog);
      isProcessing = false;
      setFilesLocked(false);
      hideCancelBtn();
      _handleError('merge', data.message);
    }
  };
  worker.onerror = (e) => {
    clearTimeout(watchdog);
    isProcessing = false;
    setFilesLocked(false);
    hideCancelBtn();
    _handleError('merge', e.message || 'Worker error');
  };
}

// ── Split ──────────────────────────────────────────────────────

async function _runSplit(filesSnapshot, { pages, mode, removeWatermarks = false } = {}) {
  if (!_checkSize(filesSnapshot[0], 200)) { _abortUI(); return; }
  const _sf = filesSnapshot[0];
  const buffer = _sf._decryptedBuffer ? _sf._decryptedBuffer.slice(0) : await preprocessPdfBuffer(await _sf.arrayBuffer());
  setProgress(5, t('prog_loading_pdf'));

  // ⚠️  TRANSFERABLE CONTRACT: `buffer` was passed to worker as a Transferable.
  //     It is now DETACHED here in the main thread — do not read it after this line.
  //     The worker owns it until it sends `done`, at which point data.result
  //     (single mode) or data.result[*].buffer (separate mode) are transferred
  //     back and become the new owners. Each buffer must be consumed exactly once
  //     (Blob constructor, JSZip.file()) and never stored for later reuse.
  _worker.postMessage({ tool: 'split', file: buffer, options: { pages, mode, removeWatermarks } }, [buffer]);

  _worker.onmessage = async (e) => {
    const data = e.data;
    if (data.type === 'progress') {
      setProgress(data.value, data.label);
    } else if (data.type === 'done') {
      setProgress(95, t('prog_packaging'));
      try {
        let blob, desc, filename;

        if (data.mode === 'single') {
          if (!(data.result instanceof ArrayBuffer)) {
            _handleError('split', 'Unexpected result type from worker'); return;
          }
          // Один PDF
          blob     = new Blob([data.result], { type: 'application/pdf' });
          desc     = tp(data.totalPages, 'desc_split_single', 'desc_split_single_many', { n: data.totalPages, size: fmtSize(blob.size) });
          filename = 'extracted.pdf';
        } else {
          if (!Array.isArray(data.result)) {
            _handleError('split', 'Unexpected result type from worker'); return;
          }
          // Несколько PDF → ZIP через JSZip
          await loadJSZip();
          const JSZip = window.JSZip;
          const zip = new JSZip();
          setProgress(96, t('prog_zip'));
          // ⚠️  item.buffer is a transferred (detached) ArrayBuffer received from
          //     the worker. JSZip.file() consumes it here — do not use item.buffer
          //     again after this loop. Accessing a detached ArrayBuffer returns
          //     byteLength=0 and reads return 0s, silently corrupting output.
          for (const item of data.result) {
            zip.file(item.name, item.buffer);
          }
          setProgress(97, t('prog_compressing'));
          blob     = await zip.generateAsync(
            { type: 'blob', compression: 'DEFLATE' },
            meta  => setProgress(97 + Math.round(meta.percent / 100 * 2), t('prog_compressing'))
          );
          desc     = tp(data.totalPages, 'desc_split_separate', 'desc_split_separate_many', { n: data.totalPages, size: fmtSize(blob.size) });
          filename = 'split_pages.zip';
        }

        isProcessing = false;
        setFilesLocked(false);
        hideCancelBtn();
        setProgress(100, t('prog_done'));
        document.dispatchEvent(new CustomEvent('pdfree:success', {
          detail: { tool: 'split', blob, desc, filename }
        }));
      } catch (err) {
        isProcessing = false;
        setFilesLocked(false);
        hideCancelBtn();
        _handleError('split', err.message);
      }
    } else if (data.type === 'error') {
      isProcessing = false;
      setFilesLocked(false);
      hideCancelBtn();
      _handleError('split', data.message);
    }
  };
  _worker.onerror = (e) => {
    isProcessing = false;
    setFilesLocked(false);
    hideCancelBtn();
    _handleError('split', e.message || 'Worker error');
  };
}

// ── Organize (reorder / delete / rotate pages) ──────────────────
//
// Deliberately its own Worker instance, NOT the shared `_worker` above —
// js/worker.js is off-limits per CLAUDE.md and has no primitive for
// rebuilding a document in caller-chosen page order anyway (its rotate
// handler only mutates pages in place). js/organizeWorker.js is a
// standalone classic worker, same pattern as js/pdfaAnalyze.js's
// dedicated js/pdfaWorker.js. Created once and kept alive for the
// session (not re-created/terminated per call) — mirrors `_worker`
// itself, and avoids re-running importScripts('pdf-lib.min.js') on
// every single Organize submission.
let _organizeWorker = null;
function _ensureOrganizeWorker() {
  if (!_organizeWorker) {
    _organizeWorker = new Worker(new URL('./organizeWorker.js', import.meta.url));
  }
  return _organizeWorker;
}

async function _runOrganize(filesSnapshot, { pageOrder = [] } = {}) {
  if (!_checkSize(filesSnapshot[0], 200)) { _abortUI(); return; }
  const file   = filesSnapshot[0];
  const buffer = file._decryptedBuffer ? file._decryptedBuffer.slice(0) : await preprocessPdfBuffer(await file.arrayBuffer());
  setProgress(5, t('prog_organize'));

  const worker = _ensureOrganizeWorker();
  // ⚠️  TRANSFERABLE CONTRACT — same as every other worker call in this file:
  //     `buffer` is detached here; the worker owns it until `done` transfers
  //     data.result back.
  worker.postMessage({ file: buffer, options: { pageOrder } }, [buffer]);

  worker.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'progress') {
      setProgress(data.value, data.label);
    } else if (data.type === 'done') {
      if (!(data.result instanceof ArrayBuffer)) {
        _handleError('organize', 'Unexpected result from worker'); return;
      }
      isProcessing = false;
      setFilesLocked(false);
      hideCancelBtn();
      setProgress(100, t('prog_done'));

      const blob     = new Blob([data.result], { type: 'application/pdf' });
      const base     = file.name.replace(/\.pdf$/i, '');
      const filename = `${base}-organized.pdf`;
      const desc     = t('desc_organize', { pages: data.pageCount, size: fmtSize(blob.size) });

      document.dispatchEvent(new CustomEvent('pdfree:success', {
        detail: { tool: 'organize', blob, desc, filename }
      }));
    } else if (data.type === 'error') {
      isProcessing = false;
      setFilesLocked(false);
      hideCancelBtn();
      _handleError('organize', data.message);
    }
  };
  worker.onerror = (e) => {
    isProcessing = false;
    setFilesLocked(false);
    hideCancelBtn();
    _handleError('organize', e.message || 'Worker error');
  };
}

// ── Glossary (find dictionary terms, attach Highlight+Popup annotations) ─
//
// Own persistent Worker instance, same rationale as _organizeWorker above.
// pdf.js text EXTRACTION (getPage/getTextContent) deliberately still
// happens HERE, on the main thread, not inside glossaryWorker.js —
// confirmed empirically that pdf.js can't run inside an already-running
// Worker with this project's pdf.js build (see glossaryWorker.js's own
// header comment for the exact error). Same shape _runCleanScan uses
// (pdf.js/rendering on the main thread, only the pdf-lib write happens in
// the dedicated worker).
//
// The actual term-MATCHING (regex scan over every line × every dictionary
// term) is a different story: it has zero pdf.js dependency — it only
// touches the plain {str, transform, width} objects pdf.js already handed
// back — so there's no reason it needs the main thread at all. It used to
// run here too (moved into glossaryWorker.js instead, see that file's
// `_findGlossaryMatches`) after a real Playwright measurement (4x CPU
// throttle, 200 pages / worst-case repeated-vocabulary text, "Use this
// crop"-style rAF heartbeat) found a 211ms single-frame main-thread gap —
// smaller than the scan-document warpToRect case (368ms) but the same
// class of bug, found in the same audit pass. pageItemsByPage is now
// handed to the worker instead of the already-computed matches array.
let _glossaryWorker = null;
function _ensureGlossaryWorker() {
  if (!_glossaryWorker) {
    _glossaryWorker = new Worker(new URL('./glossaryWorker.js', import.meta.url));
  }
  return _glossaryWorker;
}

async function _runGlossary(filesSnapshot, { dictionary = [] } = {}) {
  if (!_checkSize(filesSnapshot[0], 150)) { _abortUI(); return; }
  const file = filesSnapshot[0];

  if (dictionary.length === 0) {
    _handleError('glossary', t('val_glossary_no_dictionary'));
    return;
  }

  try {
    setProgress(5, t('prog_glossary_load'));
    await loadPdfJs();
    const buffer = file._decryptedBuffer ? file._decryptedBuffer.slice(0) : await preprocessPdfBuffer(await file.arrayBuffer());
    // pdf.js's getDocument() spawns its own internal worker and transfers
    // the underlying ArrayBuffer to it — detaching `buffer` in the
    // process (confirmed empirically: without this .slice(0) copy, the
    // later worker.postMessage({file: buffer}, [buffer]) throws
    // "ArrayBuffer at index 0 is already detached"). Give pdf.js its own
    // independent copy so `buffer` itself stays valid for the transfer
    // to glossaryWorker.js afterwards.
    const pdfJsDoc = await window.pdfjsLib.getDocument({ isEvalSupported: false, data: new Uint8Array(buffer.slice(0)) }).promise;
    const pageCount = pdfJsDoc.numPages;
    if (pageCount === 0) throw new Error('PDF has no pages');

    setProgress(15, t('prog_glossary_search'));
    const pageItemsByPage = [];
    for (let i = 1; i <= pageCount; i++) {
      const page    = await pdfJsDoc.getPage(i);
      const content = await page.getTextContent();
      pageItemsByPage.push(content.items);
      setProgress(15 + Math.round((i / pageCount) * 25), t('prog_glossary_search'));
    }

    const hasAnyText = pageItemsByPage.some(items => items.some(it => it.str && it.str.trim()));
    if (!hasAnyText) {
      _handleError('glossary', t('val_glossary_no_text_layer'));
      return;
    }

    // Matching (regex scan over every line × every dictionary term) and
    // annotation-writing both happen inside glossaryWorker.js now — see
    // the comment above _ensureGlossaryWorker for why matching moved off
    // the main thread. pageItemsByPage (plain, structured-cloneable
    // {str, transform, width} objects — no pdf.js dependency) is handed
    // over instead of an already-computed matches array.
    setProgress(45, t('prog_glossary_write'));
    const worker = _ensureGlossaryWorker();
    worker.postMessage({ file: buffer, options: { pageItemsByPage, dictionary } }, [buffer]);

    worker.onmessage = (e) => {
      const data = e.data;
      if (data.type === 'progress') {
        setProgress(Math.max(15, data.value), data.label);
      } else if (data.type === 'done') {
        if (!(data.result instanceof ArrayBuffer)) {
          _handleError('glossary', 'Unexpected result from worker'); return;
        }
        isProcessing = false;
        setFilesLocked(false);
        hideCancelBtn();
        setProgress(100, t('prog_done'));

        const blob     = new Blob([data.result], { type: 'application/pdf' });
        const base     = file.name.replace(/\.pdf$/i, '');
        const filename = `${base}-glossary.pdf`;
        const desc     = t('desc_glossary', { count: data.annotationCount });

        document.dispatchEvent(new CustomEvent('pdfree:success', {
          detail: { tool: 'glossary', blob, desc, filename }
        }));
        // Same defensive cap the worker enforces (see glossaryWorker.js's
        // _GLOSSARY_MAX_MATCHES) — only fires on genuinely pathological
        // input, not realistic large documents.
        if (data.truncated) {
          showToast(t('warn_glossary_truncated', { n: data.matchCount }), 6000);
        }
      } else if (data.type === 'error') {
        isProcessing = false;
        setFilesLocked(false);
        hideCancelBtn();
        _handleError('glossary', data.code === 'no_matches' ? t('val_glossary_no_matches') : data.message);
      }
    };
    worker.onerror = (e) => {
      isProcessing = false;
      setFilesLocked(false);
      hideCancelBtn();
      _handleError('glossary', e.message || 'Worker error');
    };
  } catch (err) {
    isProcessing = false;
    setFilesLocked(false);
    hideCancelBtn();
    _handleError('glossary', err.message || 'Processing error');
  }
}

// ── Resize (fit/fill/actual-size onto a target paper size) ──────
//
// Own persistent Worker instance, same rationale as _organizeWorker above:
// js/worker.js is off-limits and importScripts('pdf-lib.min.js') is worth
// paying once per session, not once per submission.
let _resizeWorker = null;
function _ensureResizeWorker() {
  if (!_resizeWorker) {
    _resizeWorker = new Worker(new URL('./resizeWorker.js', import.meta.url));
  }
  return _resizeWorker;
}

async function _runResize(filesSnapshot, { targetSize = 'a4', mode = 'fit', marginPt = 28, orientation = 'auto' } = {}) {
  if (!_checkSize(filesSnapshot[0], 200)) { _abortUI(); return; }
  const file   = filesSnapshot[0];
  const buffer = file._decryptedBuffer ? file._decryptedBuffer.slice(0) : await preprocessPdfBuffer(await file.arrayBuffer());
  setProgress(5, t('prog_resize'));

  const worker = _ensureResizeWorker();
  worker.postMessage({ file: buffer, options: { targetSize, mode, marginPt, orientation } }, [buffer]);

  worker.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'progress') {
      setProgress(data.value, data.label);
    } else if (data.type === 'done') {
      if (!(data.result instanceof ArrayBuffer)) {
        _handleError('resize', 'Unexpected result from worker'); return;
      }
      isProcessing = false;
      setFilesLocked(false);
      hideCancelBtn();
      setProgress(100, t('prog_done'));

      const blob     = new Blob([data.result], { type: 'application/pdf' });
      const base     = file.name.replace(/\.pdf$/i, '');
      const filename = `${base}-resized.pdf`;
      const desc     = t('desc_resize', { pages: data.pageCount, size: fmtSize(blob.size) });

      document.dispatchEvent(new CustomEvent('pdfree:success', {
        detail: { tool: 'resize', blob, desc, filename }
      }));
    } else if (data.type === 'error') {
      isProcessing = false;
      setFilesLocked(false);
      hideCancelBtn();
      _handleError('resize', data.message);
    }
  };
  worker.onerror = (e) => {
    isProcessing = false;
    setFilesLocked(false);
    hideCancelBtn();
    _handleError('resize', e.message || 'Worker error');
  };
}

// ── Split Manga Pages ──────────────────────────────────────────
//
// Own persistent Worker instance, same rationale as _organizeWorker/
// _resizeWorker above: js/worker.js is off-limits and importScripts
// ('pdf-lib.min.js') is worth paying once per session, not once per
// submission.
let _mangaSplitWorker = null;
function _ensureMangaSplitWorker() {
  if (!_mangaSplitWorker) {
    _mangaSplitWorker = new Worker(new URL('./mangaSplitWorker.js', import.meta.url));
  }
  return _mangaSplitWorker;
}

async function _runMangaSplit(filesSnapshot, { rtl = true, skipPages = [] } = {}) {
  if (!_checkSize(filesSnapshot[0], 200)) { _abortUI(); return; }
  const file   = filesSnapshot[0];
  const buffer = file._decryptedBuffer ? file._decryptedBuffer.slice(0) : await preprocessPdfBuffer(await file.arrayBuffer());
  setProgress(5, t('prog_manga_split'));

  const worker = _ensureMangaSplitWorker();
  worker.postMessage({ file: buffer, options: { rtl, skipPages } }, [buffer]);

  worker.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'progress') {
      setProgress(data.value, data.label);
    } else if (data.type === 'done') {
      if (!(data.result instanceof ArrayBuffer)) {
        _handleError('mangaSplit', 'Unexpected result from worker'); return;
      }
      isProcessing = false;
      setFilesLocked(false);
      hideCancelBtn();
      setProgress(100, t('prog_done'));

      const blob     = new Blob([data.result], { type: 'application/pdf' });
      const base     = file.name.replace(/\.pdf$/i, '');
      const filename = `${base}-split.pdf`;
      const desc     = t('desc_manga_split', { pages: data.pageCount, size: fmtSize(blob.size) });

      document.dispatchEvent(new CustomEvent('pdfree:success', {
        detail: { tool: 'mangaSplit', blob, desc, filename }
      }));
    } else if (data.type === 'error') {
      isProcessing = false;
      setFilesLocked(false);
      hideCancelBtn();
      _handleError('mangaSplit', data.message);
    }
  };
  worker.onerror = (e) => {
    isProcessing = false;
    setFilesLocked(false);
    hideCancelBtn();
    _handleError('mangaSplit', e.message || 'Worker error');
  };
}

// ── Fill: custom tab order ────────────────────────────────────
//
// Own persistent Worker instance, same rationale as _organizeWorker/
// _resizeWorker above. Must run BEFORE the shared-worker fill pipeline,
// on the original unfilled bytes — js/worker.js's handleFill() defaults
// to flatten()ing the form, which deletes the AcroForm/widget dicts
// entirely, leaving nothing left to reorder afterward. This worker only
// mutates structural field order (/Annots + /Tabs); values, fonts,
// flatten and signatures all still go through the existing, unmodified
// _runWorkerTool('fill', ...) pipeline exactly as before.
let _fillOrderWorker = null;
function _ensureFillOrderWorker() {
  if (!_fillOrderWorker) {
    _fillOrderWorker = new Worker(new URL('./fillOrderWorker.js', import.meta.url));
  }
  return _fillOrderWorker;
}

async function _runFillOrder(filesSnapshot, params) {
  const { tabOrderMode, tabOrder, ...fillParams } = params;
  if (!tabOrderMode) {
    await _runWorkerTool('fill', filesSnapshot, fillParams);
    return;
  }

  if (!_checkSize(filesSnapshot[0], 200)) { _abortUI(); return; }
  const file     = filesSnapshot[0];
  const original = file._decryptedBuffer ? file._decryptedBuffer.slice(0) : await preprocessPdfBuffer(await file.arrayBuffer());
  setProgress(3, t('prog_fill_order'));

  const worker = _ensureFillOrderWorker();
  worker.postMessage({ file: original, options: { mode: tabOrderMode, fieldOrder: tabOrder } }, [original]);

  // Intermediate progress from fillOrderWorker is intentionally not
  // forwarded — reordering is near-instant and _runWorkerTool's own
  // setProgress(5, ...) takes over right after, so relaying fine-grained
  // percentages here would just make the bar jump backward at the handoff.
  worker.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'done') {
      if (!(data.result instanceof ArrayBuffer)) {
        _handleError('fill', 'Unexpected result from worker'); return;
      }
      _runWorkerTool('fill', filesSnapshot, fillParams, data.result);
    } else if (data.type === 'error') {
      isProcessing = false;
      setFilesLocked(false);
      hideCancelBtn();
      _handleError('fill', data.message);
    }
  };
  worker.onerror = (e) => {
    isProcessing = false;
    setFilesLocked(false);
    hideCancelBtn();
    _handleError('fill', e.message || 'Worker error');
  };
}

// ── Clean Scan (whiten scanned-document backgrounds) ────────────
//
// Own persistent Worker instance, same rationale as the other dedicated
// workers above. Different shape from those, though: pdf.js has no
// working precedent in this codebase for running inside a Worker (every
// existing worker only ever does pdf-lib/pixel work — pdf.js rendering
// always stays main-thread, see ocrUI.js/pdf2jpgUI.js), so THIS function
// drives the render loop itself — one page at a time, sequential, never
// parallel (matches pdf2jpgUI.js's own bounded-concurrency discipline;
// full-DPI raster pages are far heavier than that file's 160px thumbs) —
// and cleanScanWorker.js only ever receives already-rendered bitmaps.
// ── Watermark (text mode): dedicated Unicode-capable worker ────────────
// See watermarkTextWorker.js's own header for the full rationale — this
// exists because worker.js's handleWatermark() embeds a WinAnsi-only
// standard font, which can't render Cyrillic/Vietnamese/Turkish text
// (including the localized default watermark text on ru/vi/tr). Image
// watermarks don't need any of this and stay on worker.js unchanged —
// only routed here when options.kind !== 'image'.
let _watermarkTextWorker = null;
function _ensureWatermarkTextWorker() {
  if (!_watermarkTextWorker) {
    _watermarkTextWorker = new Worker(new URL('./watermarkTextWorker.js', import.meta.url));
  }
  return _watermarkTextWorker;
}

// Fetched once per page load and cached — same file every time, same
// pattern as pdfaAnalyze.js's _loadLiberationFont (LiberationSans-Bold is
// the metric-compatible replacement for the HelveticaBold this feature
// used before, so existing Latin-text watermarks render identically).
// Only fileBuffer goes in postMessage's transfer list below, never this
// cached buffer — an ArrayBuffer put in a transfer list is detached after
// the call, which would silently corrupt every watermark after the first
// if this cache were transferred instead of structure-cloned.
let _liberationSansBoldPromise = null;
function _loadLiberationSansBold() {
  if (!_liberationSansBoldPromise) {
    const url = new URL('./vendor/liberation-fonts/LiberationSans-Bold.ttf', import.meta.url).href;
    _liberationSansBoldPromise = fetch(url).then(r => {
      if (!r.ok) throw new Error(`Failed to load LiberationSans-Bold.ttf (${r.status})`);
      return r.arrayBuffer();
    });
  }
  return _liberationSansBoldPromise;
}

// Low-level request/response round trip for one file — shared by both the
// single-file path (_runWatermarkText) and the batch path
// (_batchWorkerToolOne). No watchdog/cancel wiring (unlike
// _postToWorkerForBatch's shared-worker version) — font-embedding +
// drawText is fast enough that a hang here would indicate a real bug, not
// something worth a timeout UX for.
async function _watermarkTextRequest(fileBuffer, options, onProgress) {
  const fontBytes = await _loadLiberationSansBold();
  return new Promise((resolve, reject) => {
    const worker = _ensureWatermarkTextWorker();
    worker.onmessage = (e) => {
      const data = e.data;
      if (data.type === 'progress') { onProgress?.(data.value, data.label); return; }
      if (data.type === 'done')     { resolve(data); return; }
      if (data.type === 'error')    { const err = new Error(data.message); err.code = data.code; err.chars = data.chars; reject(err); return; }
    };
    worker.onerror = (e) => reject(new Error(e.message || 'Worker error'));
    worker.postMessage({ fileBuffer, options, fontBytes }, [fileBuffer]);
  });
}

async function _runWatermarkText(filesSnapshot, params) {
  const file = filesSnapshot[0];
  if (!_checkSize(file, 200)) { _abortUI(); return; }
  const buffer = file._decryptedBuffer ? file._decryptedBuffer.slice(0) : await preprocessPdfBuffer(await file.arrayBuffer());

  setProgress(5, t('prog_watermark'));

  let data;
  try {
    data = await _watermarkTextRequest(buffer, params, (value, label) => setProgress(value, label));
  } catch (err) {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    if (err.code === 'unsupported-characters') {
      _handleError('watermark', t('err_watermark_unsupported_chars'), 'watermark_unsupported_chars');
    } else {
      _handleError('watermark', err.message);
    }
    return;
  }
  if (!isProcessing) return;

  isProcessing = false;
  setFilesLocked(false);
  hideCancelBtn();
  setProgress(100, t('prog_done'));

  const blob = new Blob([data.result], { type: 'application/pdf' });
  const base = file.name.replace(/\.pdf$/i, '');
  const filename = `${base}-watermarked.pdf`;
  const desc = t('desc_watermark', { pages: data.pageCount, size: fmtSize(blob.size) });

  document.dispatchEvent(new CustomEvent('pdfree:success', {
    detail: { tool: 'watermark', blob, desc, filename }
  }));
}

let _cleanScanWorker = null;
function _ensureCleanScanWorker() {
  if (!_cleanScanWorker) {
    _cleanScanWorker = new Worker(new URL('./cleanScanWorker.js', import.meta.url));
  }
  return _cleanScanWorker;
}

// cleanScanWorker.js emits 'progress' zero or more times before its real
// response (only the 'assemble' message type does) — resolve on the
// first non-progress message, relay progress via callback in the meantime.
function _cleanScanWorkerRequest(worker, message, transfer, onProgress) {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'progress') { onProgress?.(d.value, d.label); return; }
      if (d.type === 'error') { reject(new Error(d.message)); return; }
      resolve(d);
    };
    worker.onerror = (e) => reject(new Error(e.message || 'Worker error'));
    worker.postMessage(message, transfer);
  });
}

async function _runCleanScan(filesSnapshot, { mode = 'clean', strength = 0.5, scale = 2 } = {}) {
  if (!_checkSize(filesSnapshot[0], 150)) { _abortUI(); return; }
  const file = filesSnapshot[0];

  try {
    setProgress(2, t('prog_clean_scan_load'));
    await loadPdfJs();
    const buffer = file._decryptedBuffer ? file._decryptedBuffer.slice(0) : await preprocessPdfBuffer(await file.arrayBuffer());
    const pdfDoc = await window.pdfjsLib.getDocument({ isEvalSupported: false, data: new Uint8Array(buffer) }).promise;
    const pageCount = pdfDoc.numPages;
    if (pageCount === 0) throw new Error('PDF has no pages');

    const worker     = _ensureCleanScanWorker();
    const pages      = [];
    const pageSizes  = [];

    // Sequential, one page fully round-tripped (render → worker → response)
    // before starting the next — deliberately not parallel, see comment above.
    for (let i = 1; i <= pageCount; i++) {
      const page = await pdfDoc.getPage(i);
      const vp1  = page.getViewport({ scale: 1 }); // unscaled viewport = page size in points
      pageSizes.push({ width: vp1.width, height: vp1.height });

      const vp     = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      page.cleanup?.();

      const bitmap = await createImageBitmap(canvas);
      const result = await _cleanScanWorkerRequest(
        worker,
        { type: 'processPage', index: i - 1, bitmap, mode, strength },
        [bitmap]
      );
      pages.push(result);

      setProgress(5 + Math.round((i / pageCount) * 80), t('prog_clean_scan_page', { n: i, total: pageCount }));
    }

    const done = await _cleanScanWorkerRequest(
      worker,
      { type: 'assemble', pages, pageSizes },
      pages.map(p => p.bytes),
      (value, label) => setProgress(Math.max(85, value), label)
    );

    if (!(done.result instanceof ArrayBuffer)) {
      _handleError('cleanScan', 'Unexpected result from worker'); return;
    }

    isProcessing = false;
    setFilesLocked(false);
    hideCancelBtn();
    setProgress(100, t('prog_done'));

    const blob     = new Blob([done.result], { type: 'application/pdf' });
    const base     = file.name.replace(/\.pdf$/i, '');
    const filename = `${base}-cleaned.pdf`;
    const desc     = t('desc_clean_scan', { pages: done.pageCount, size: fmtSize(blob.size) });

    document.dispatchEvent(new CustomEvent('pdfree:success', {
      detail: { tool: 'cleanScan', blob, desc, filename }
    }));
  } catch (err) {
    isProcessing = false;
    setFilesLocked(false);
    hideCancelBtn();
    _handleError('cleanScan', err.message || 'Processing error');
  }
}

// ── E-Reader Optimizer ────────────────────────────────────────
// Dedicated js/ereaderWorker.js, not the shared js/worker.js — same
// reasoning as Clean Scan above (pdf.js rendering stays main-thread here).

let _ereaderWorker = null;
function _ensureEreaderWorker() {
  if (!_ereaderWorker) {
    _ereaderWorker = new Worker(new URL('./ereaderWorker.js', import.meta.url));
  }
  return _ereaderWorker;
}

function _ereaderWorkerRequest(worker, message, transfer, onProgress) {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'progress') { onProgress?.(d.value, d.label); return; }
      if (d.type === 'error') { reject(new Error(d.message)); return; }
      resolve(d);
    };
    worker.onerror = (e) => reject(new Error(e.message || 'Worker error'));
    worker.postMessage(message, transfer);
  });
}

const _EREADER_SAMPLE_MAX     = 12;   // pages sampled to compute the one global crop rect
const _EREADER_BBOX_EDGE      = 560;  // downsample long edge for bbox detection — cheap, doesn't need full DPI
const _EREADER_RENDER_SCALE   = 2.5;  // main-thread render scale for the real per-page pass
const _EREADER_OUTPUT_HEIGHT  = 1800; // fixed output pixel height, every page — sharp enough for e-ink
const _EREADER_PAGE_HEIGHT_PT = 792;  // fixed output PDF page height (points), every page

async function _runEreader(filesSnapshot, { device = 'kindle', grayscale = true, contrast = 0.5, quality = 0.85, columnMode = 'auto' } = {}) {
  if (!_checkSize(filesSnapshot[0], 150)) { _abortUI(); return; }
  const file = filesSnapshot[0];

  try {
    setProgress(2, t('prog_ereader_load'));
    await loadPdfJs();
    const buffer = file._decryptedBuffer ? file._decryptedBuffer.slice(0) : await preprocessPdfBuffer(await file.arrayBuffer());
    const pdfDoc = await window.pdfjsLib.getDocument({ isEvalSupported: false, data: new Uint8Array(buffer) }).promise;
    const pageCount = pdfDoc.numPages;
    if (pageCount === 0) throw new Error('PDF has no pages');

    const targetAspect = (DEVICE_PRESETS[device] || DEVICE_PRESETS.kindle).aspect;

    // ── Sample pages, detect per-page content bbox + 2-column gutter,
    // reconcile to one global crop + one global column-split decision ──
    // (main thread only — pdf.js never runs inside a Worker in this codebase,
    // see ereaderWorker.js's header comment)
    setProgress(4, t('prog_ereader_analyze'));
    const sampleIndices = ereaderSampleIndices(pageCount, _EREADER_SAMPLE_MAX);
    const bboxes  = [];
    const gutters = [];
    let firstPageVp1 = null;

    for (const i of sampleIndices) {
      const page = await pdfDoc.getPage(i);
      const vp1  = page.getViewport({ scale: 1 });
      if (!firstPageVp1) firstPageVp1 = vp1;
      const scale  = _EREADER_BBOX_EDGE / Math.max(vp1.width, vp1.height);
      const vp     = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width  = Math.max(1, Math.round(vp.width));
      canvas.height = Math.max(1, Math.round(vp.height));
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      page.cleanup?.();
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const bbox = contentBBox(data, canvas.width, canvas.height);
      bboxes.push(bbox);
      gutters.push(detectColumnGutter(data, canvas.width, canvas.height, bbox));
    }

    const reconciled  = padBBox(reconcileGlobalCrop(bboxes));
    const columnSplit = columnMode === 'off' ? { enabled: false, centerFrac: null } : reconcileColumnSplit(gutters);
    // When splitting, skip the whole-page aspect composition below — expanding
    // the FULL width toward a single-page device ratio before the cut would
    // waste padding on content about to be split in half anyway. Each half
    // gets its own device-aspect fit for free via the worker's existing
    // "contain" letterbox step (see ereaderWorker.js), no separate
    // composeWithAspect call needed per half.
    const cropRect = columnSplit.enabled
      ? reconciled
      : composeWithAspect(reconciled, firstPageVp1.width, firstPageVp1.height, targetAspect);

    const outputHeight = _EREADER_OUTPUT_HEIGHT;
    const outputWidth  = Math.round(outputHeight * targetAspect);
    const pageSize = {
      width:  Math.round(_EREADER_PAGE_HEIGHT_PT * targetAspect),
      height: _EREADER_PAGE_HEIGHT_PT,
    };

    const worker = _ensureEreaderWorker();
    const pages  = [];
    let outIdx   = 0;

    // Sequential, one page fully round-tripped (render → worker → response)
    // before starting the next — same reasoning as _runCleanScan. Each
    // source page yields 1 output page normally, or 2 (left/right column)
    // when columnSplit is active — outIdx assigns the final, flattened
    // page order the assembled PDF actually uses.
    for (let i = 1; i <= pageCount; i++) {
      const page = await pdfDoc.getPage(i);
      const vp     = page.getViewport({ scale: _EREADER_RENDER_SCALE });
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      page.cleanup?.();

      const bitmap = await createImageBitmap(canvas);
      const result = await _ereaderWorkerRequest(
        worker,
        {
          type: 'processPage', index: i - 1, bitmap, cropRect,
          columnSplit: columnSplit.enabled ? { centerFrac: columnSplit.centerFrac } : null,
          grayscale, contrast, quality, outputWidth, outputHeight,
        },
        [bitmap]
      );
      for (const p of result.pages) {
        pages.push({ index: outIdx++, bytes: p.bytes, format: p.format, width: p.width, height: p.height });
      }

      setProgress(8 + Math.round((i / pageCount) * 77), t('prog_ereader_page', { n: i, total: pageCount }));
    }

    const done = await _ereaderWorkerRequest(
      worker,
      { type: 'assemble', pages, pageSize },
      pages.map(p => p.bytes),
      (value, label) => setProgress(Math.max(85, value), label)
    );

    if (!(done.result instanceof ArrayBuffer)) {
      _handleError('ereader', 'Unexpected result from worker'); return;
    }

    isProcessing = false;
    setFilesLocked(false);
    hideCancelBtn();
    setProgress(100, t('prog_done'));

    const blob     = new Blob([done.result], { type: 'application/pdf' });
    const base     = file.name.replace(/\.pdf$/i, '');
    const filename = `${base}-ereader.pdf`;
    const desc     = t('desc_ereader', { pages: done.pageCount, size: fmtSize(blob.size) });

    document.dispatchEvent(new CustomEvent('pdfree:success', {
      detail: { tool: 'ereader', blob, desc, filename }
    }));
  } catch (err) {
    isProcessing = false;
    setFilesLocked(false);
    hideCancelBtn();
    _handleError('ereader', err.message || 'Processing error');
  }
}

// ── Compress ───────────────────────────────────────────────────

async function _runCompress(filesSnapshot, { preset = 'medium', preserveText = true, removeWatermarks = false, targetDpi = null, quality = null, targetSizeMb = null } = {}, toolKey = 'compress') {
  if (!_checkSize(filesSnapshot[0], MAX_COMPRESS_MB)) { _abortUI(); return; }

  const file   = filesSnapshot[0];
  const buffer = file._decryptedBuffer ? file._decryptedBuffer.slice(0) : await preprocessPdfBuffer(await file.arrayBuffer());
  setProgress(5, t('prog_loading_pdf'));

  // Watchdog: if the worker goes silent for 45s (OOM crash or freeze),
  // browsers don't reliably fire onerror — detect it ourselves.
  const WATCHDOG_MS = 45_000;
  let watchdog = setTimeout(() => {
    if (!isProcessing) return;   // already cancelled — don't fire phantom error
    isProcessing = false;
    setFilesLocked(false);
    hideCancelBtn();
    _handleError('compress', t('err_compress_timeout'), 'timeout');
  }, WATCHDOG_MS);
  const _resetWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (!isProcessing) return;   // already cancelled — don't fire phantom error
      isProcessing = false;
      setFilesLocked(false);
      hideCancelBtn();
      _handleError('compress', t('err_compress_timeout'), 'timeout');
    }, WATCHDOG_MS);
  };

  // ⚠️  TRANSFERABLE: buffer detached after this call — worker owns it until done.
  _worker.postMessage(
    { tool: 'compress', file: buffer, options: { preset, preserveText, removeWatermarks, targetDpi, quality, targetSizeMb } },
    [buffer]
  );

  _worker.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'progress') {
      _resetWatchdog();
      setProgress(data.value, data.label);
    } else if (data.type === 'scan-report') {
      _resetWatchdog();
      document.dispatchEvent(new CustomEvent('pdfree:scan-report', {
        detail: { toolKey, report: data.report },
      }));
    } else if (data.type === 'done') {
      clearTimeout(watchdog);
      isProcessing = false;
      setFilesLocked(false);
      hideCancelBtn();
      setProgress(100, t('prog_done'));

      // Guard: worker must return an ArrayBuffer. Any other type means
      // something went wrong in serialisation (detached buffer, wrong transfer, etc.)
      if (!(data.result instanceof ArrayBuffer)) {
        _handleError('compress', 'Unexpected result type from worker');
        return;
      }

      const blob = new Blob([data.result], { type: 'application/pdf' });

      // Build filename: "report.pdf" → "report-compressed.pdf"
      const baseName = file.name.replace(/\.pdf$/i, '');
      const filename  = `${baseName}-compressed.pdf`;

      const savedPct  = data.originalSize > 0
        ? Math.round((data.savedBytes / data.originalSize) * 100)
        : 0;
      const desc = savedPct > 0
        ? t('desc_compress_saved', { pct: savedPct })
        : t('desc_compress_optimized');

      document.dispatchEvent(new CustomEvent('pdfree:success', {
        detail: {
          tool: toolKey,  // actual tool key (compress or compress-email) for registry dispatch
          blob,
          desc,
          filename,
          // Extra data for compression report UI (beyond standard ТЗ)
          compressionReport: {
            originalSize:   data.originalSize,
            compressedSize: data.compressedSize,
            savedBytes:     data.savedBytes,
            report:         data.report,
            targetSizeMb,
          },
        }
      }));

      if (data.report?.wasEncrypted) {
        showToast(t('warn_encrypted_pdf'), 5000);
      }
    } else if (data.type === 'error') {
      clearTimeout(watchdog);
      isProcessing = false;
      setFilesLocked(false);
      hideCancelBtn();
      _handleError('compress', data.message);
    }
  };

  _worker.onerror = (e) => {
    clearTimeout(watchdog);
    isProcessing = false;
    setFilesLocked(false);
    hideCancelBtn();
    _handleError('compress', e.message || 'Worker error');
  };
}

// ── JPG → PDF ──────────────────────────────────────────────────

async function _runJpg2Pdf(filesSnapshot, params) {
  const oversized = filesSnapshot.find(f => f.size > 50 * MB);
  if (oversized) {
    showToast(t('warn_file_too_large', { size: fmtSize(oversized.size), max: 50 }), 8000);
    isProcessing = false; setFilesLocked(false); hideCancelBtn(); return;
  }
  // Read all images as ArrayBuffers and transfer to worker. HEIC/HEIF files
  // are decoded to JPEG first (js/heicDecode.js, cached — shares the decode
  // already done for the thumbnail preview in jpg2pdfUI.js): worker.js is
  // off-limits and its createImageBitmap()-based decode can't read HEIC in
  // any browser except Safari. A failed decode becomes a zero-length
  // buffer, which worker.js's own existing empty-buffer guard already
  // skips and reports — no worker.js changes needed either way.
  const buffers = await Promise.all(filesSnapshot.map(async f => {
    if (!isHeicFile(f)) return f.arrayBuffer();
    const jpegBlob = await decodeHeicToJpegBlob(f);
    return jpegBlob ? jpegBlob.arrayBuffer() : new ArrayBuffer(0);
  }));
  setProgress(5, t('prog_loading_imgs'));

  if (params.separate && filesSnapshot.length > 1) {
    return _runJpg2PdfSeparate(filesSnapshot, buffers, params);
  }

  _worker.postMessage(
    { tool: 'jpg2pdf', files: buffers, options: params },
    buffers   // All buffers as Transferables (zero-copy)
  );

  _worker.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'progress') {
      setProgress(data.value, data.label);
    } else if (data.type === 'warn') {
      // Diagnostic: Windows createImageBitmap fallback chain messages
      console.warn('[jpg2pdf worker]', data.message);
    } else if (data.type === 'done') {
      if (!(data.result instanceof ArrayBuffer)) {
        _handleError('jpg2pdf', 'Unexpected result from worker'); return;
      }
      isProcessing = false;
      setFilesLocked(false);
      hideCancelBtn();
      setProgress(100, t('prog_done'));

      const blob     = new Blob([data.result], { type: 'application/pdf' });
      const baseName = filesSnapshot.length === 1
        ? filesSnapshot[0].name.replace(/\.[^.]+$/, '')
        : 'converted';
      const filename = `${baseName}.pdf`;
      const pagesWord  = tp(data.pageCount, 'word_page', 'word_pages');
      const imagesWord = tp(filesSnapshot.length, 'word_image', 'word_images');
      const desc       = `${data.pageCount} ${pagesWord} · ${filesSnapshot.length} ${imagesWord} · ${fmtSize(blob.size)}`;

      // Warn user about any images that couldn't be processed
      if (data.skipped?.length > 0) {
        const nums = data.skipped.join(', ');
        showToast(tp(data.skipped.length, 'skipped_imgs_one', 'skipped_imgs_many', { nums }), 6000);
      }

      document.dispatchEvent(new CustomEvent('pdfree:success', {
        detail: { tool: 'jpg2pdf', blob, desc, filename }
      }));
    } else if (data.type === 'error') {
      isProcessing = false; setFilesLocked(false); hideCancelBtn();
      _handleError('jpg2pdf', data.message);
    }
  };
  _worker.onerror = (e) => {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('jpg2pdf', e.message || 'Worker error');
  };
}

// "Separate PDFs" mode (one PDF per image instead of one merged PDF) —
// worker.js's handleJpg2Pdf (off-limits, never edited) only ever produces a
// single combined PDF from N images, so this calls that SAME unmodified
// contract once per image (a 1-element files array — exactly the code path
// already exercised whenever someone converts a single image today) and
// zips the N individual results together client-side. Same "several
// outputs -> ZIP via JSZip" idiom _runSplit already uses for its own
// separate mode (see the comment there re: transferred-buffer lifetime).
// Sequential, not parallel: _worker is one shared instance with a single
// reassignable onmessage handler, not per-call message IDs.
async function _runJpg2PdfSeparate(filesSnapshot, buffers, params) {
  const zipEntries = [];
  const skipped    = [];

  for (let i = 0; i < filesSnapshot.length; i++) {
    if (!isProcessing) return; // cancelled between images
    setProgress(5 + Math.round((i / filesSnapshot.length) * 85), t('prog_loading_imgs'));

    const singleOptions = { ...params, exifAngles: [params.exifAngles?.[i] ?? 0] };
    const result = await new Promise((resolve) => {
      _worker.postMessage({ tool: 'jpg2pdf', files: [buffers[i]], options: singleOptions }, [buffers[i]]);
      _worker.onmessage = (e) => {
        const data = e.data;
        if (data.type === 'done' || data.type === 'error') resolve(data);
        // 'progress'/'warn' from a single-image call aren't worth surfacing
        // individually — the outer per-image loop progress above covers it.
      };
      _worker.onerror = (e) => resolve({ type: 'error', message: e.message || 'Worker error' });
    });

    if (result.type !== 'done' || !(result.result instanceof ArrayBuffer)) {
      skipped.push(i + 1);
      continue;
    }
    const baseName = filesSnapshot[i].name.replace(/\.[^.]+$/, '');
    zipEntries.push({ name: `${baseName}.pdf`, buffer: result.result });
  }

  if (!isProcessing) return;

  if (zipEntries.length === 0) {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('jpg2pdf', 'All images failed to convert');
    return;
  }

  setProgress(92, t('prog_zip'));
  await loadJSZip();
  const JSZip = window.JSZip;
  const zip = new JSZip();
  // De-dupe identical base names (e.g. two "photo.jpg" from different
  // source folders) — JSZip silently overwrites a same-name entry
  // otherwise, silently dropping a successfully-converted file.
  const usedNames = new Set();
  for (const entry of zipEntries) {
    let name = entry.name, n = 2;
    while (usedNames.has(name)) { name = entry.name.replace(/\.pdf$/, ` (${n}).pdf`); n++; }
    usedNames.add(name);
    zip.file(name, entry.buffer);
  }

  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE' },
    meta => setProgress(92 + Math.round(meta.percent / 100 * 6), t('prog_compressing'))
  );

  isProcessing = false;
  setFilesLocked(false);
  hideCancelBtn();
  setProgress(100, t('prog_done'));

  if (skipped.length > 0) {
    const nums = skipped.join(', ');
    showToast(tp(skipped.length, 'skipped_imgs_one', 'skipped_imgs_many', { nums }), 6000);
  }

  const imagesWord = tp(zipEntries.length, 'word_image', 'word_images');
  const desc = `${zipEntries.length} ${imagesWord} · ${fmtSize(blob.size)}`;
  document.dispatchEvent(new CustomEvent('pdfree:success', {
    detail: { tool: 'jpg2pdf', blob, desc, filename: 'converted_images.zip' }
  }));
}

// ── PDF → JPG ──────────────────────────────────────────────────
// Рендеринг требует DOM (canvas), поэтому работаем в главном потоке.

// Time-budget yield helper.
// Why time-based instead of page-count threshold:
//   A threshold like "yield every 10 pages" assumes pages take equal time.
//   A 300-DPI A0 poster takes 40× longer than a 72-DPI thumbnail.
//   Time-based control answers the actual question: "have I blocked the
//   UI thread for too long?" regardless of what caused the delay.
//
// Why 16ms budget (≈ one 60 FPS frame):
//   If we've been running for >16ms, the browser has already missed a
//   frame. Yielding now lets it paint, handle input, and schedule the
//   next frame before we continue. Yielding more often is wasteful;
//   less often causes visible jank on slow pages.
//
// rIC vs setTimeout(0):
//   setTimeout(0) always yields — correct for the busy case.
//   rIC with { timeout: 50 } yields at idle — better for the quiet case
//   (tab in background, no user interaction), prevents unnecessary 50ms
//   stalls on fast single-page exports.
//   We use rIC when available; Safari/Firefox fallback to setTimeout(0).
function _yieldToUI() {
  if (typeof requestIdleCallback === 'function') {
    return new Promise(r => requestIdleCallback(r, { timeout: 50 }));
  }
  return new Promise(r => setTimeout(r, 0));
}

const _FRAME_BUDGET_MS = 16;   // ≈ one 60 FPS frame

async function _runPdf2Jpg(filesSnapshot, { pages, format, dpi }) {
  const file   = filesSnapshot[0];
  if (!_checkSize(file, 100)) { _abortUI(); return; }
  const scale  = dpi / 72;
  const mime   = format === 'png' ? 'image/png' : 'image/jpeg';
  const ext    = format === 'png' ? 'png' : 'jpg';
  const quality = format === 'jpg' ? 0.92 : undefined;

  // pdf.js должен быть загружен к этому моменту через pdf2jpgUI.initPdf2JpgOptions
  if (!window.pdfjsLib) {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('pdf2jpg', t('err_no_renderer'), 'renderer_not_loaded');
    return;
  }

  setProgress(5, t('prog_loading_pdf'));

  // Pass raw bytes via data: — not a blob URL (avoids cross-origin Worker fetch issues).
  // pdf.worker.min.js is now bundled locally (js/vendor/) so Worker mode is safe
  // on all origins including localhost. No disableWorker needed.
  let pdfDoc;
  try {
    const rawBuf = file._decryptedBuffer ? file._decryptedBuffer.slice(0) : await preprocessPdfBuffer(await file.arrayBuffer());
    pdfDoc = await window.pdfjsLib.getDocument({ isEvalSupported: false,
      data:              new Uint8Array(rawBuf),
      useSystemFonts:    false,
      verbosity:         0,
      disableJavaScript: true,  // prevent PDF JS execution during rendering
    }).promise;
  } catch (err) {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('pdf2jpg', err.message); return;
  }

  const validPages = pages.filter(p => p >= 1 && p <= pdfDoc.numPages);
  if (validPages.length === 0) {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('pdf2jpg', t('no_pages_selected'), 'no_pages'); return;
  }

  // Diagnostic log — after validPages is declared (avoids TDZ ReferenceError)
  console.info('[pdf2jpg] pages=%d dpi=%d file=%dKB offline=%s',
    validPages.length, dpi, Math.round(file.size / 1024), !navigator.onLine);

  // UX warning for heavy exports: large page count + high DPI = long render.
  // disableWorker:true means rendering blocks the main thread — honest heads-up matters.
  if (validPages.length > 30 || (validPages.length > 10 && dpi >= 200)) {
    showToast(t('warn_large_export', { n: validPages.length, dpi }), 6000);
  }

  // ── Memory-efficient streaming pipeline ─────────────────────────
  // Problem: accumulating all page ArrayBuffers before zipping them
  // costs O(pages × pageSize) RAM. At 300 DPI a 200-page PDF = ~1 GB.
  // Solution: feed pages into JSZip immediately after render, then
  // drop the reference. Peak RAM stays at ~2 pages at a time.
  //
  // Two modes:
  //   >1 page  → streaming into JSZip as pages render (regardless of the
  //              `zip` checkbox — see the page-loop comment below for why
  //              packaging can't be skipped just because zip=false)
  //   1 page   → buffer only that page (already bounded), no ZIP needed
  if (validPages.length > 1) await loadJSZip();
  let streamZip   = null;
  let streamCount = 0;
  let singleResult = null;
  let canvas = document.createElement('canvas');
  const ctx  = canvas.getContext('2d');

  try {
    let frameStart = performance.now();   // tracks time since last yield

    for (let i = 0; i < validPages.length; i++) {
      if (!isProcessing) return;

      const pageNum  = validPages[i];
      setProgress(10 + Math.round((i / validPages.length) * 80),
                  t('prog_rendering', { i: i + 1, n: validPages.length }));

      try {
        const page     = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale });
        canvas.width   = Math.round(viewport.width);
        canvas.height  = Math.round(viewport.height);
        await page.render({ canvasContext: ctx, viewport }).promise;

        const blob = await new Promise(res => {
          // Pass quality only for jpg — avoids undefined/NaN for png
          if (format === 'jpg' && quality !== undefined) {
            canvas.toBlob(res, mime, quality);
          } else {
            canvas.toBlob(res, mime);
          }
        });
        if (!blob) throw new Error('Image export failed (canvas too large for device)');
        if (typeof page.cleanup === 'function') page.cleanup();
        const buf  = await blob.arrayBuffer();
        const baseName = file.name.replace(/\.pdf$/i, '');
        const name     = `${baseName}-page${pageNum}.${ext}`;

        // Real bug fixed here: this used to key off `!zip` alone, so
        // unchecking "pack into ZIP" (js/pdf2jpgUI.js's p2jZipCheck — its
        // own label promises "pack all images", implying OFF means
        // "give them to me separately") on a multi-page selection silently
        // kept only the FIRST rendered page and discarded the rest with no
        // warning. There's no reliable individual-file-download path in
        // this codebase yet (looped programmatic <a download> clicks are
        // known-unreliable on iOS Safari — only the first tends to fire),
        // so for >1 page the only currently-safe delivery mechanism is a
        // ZIP regardless of the checkbox; `zip` alone (without the page-
        // count check) must never gate which pages get kept.
        if (validPages.length === 1) {
          if (!singleResult) singleResult = { name, buffer: buf };
        } else {
          if (!streamZip) streamZip = new (window.JSZip)();
          streamZip.file(name, buf);
          streamCount++;
        }

        // Time-budget yield: only pause the UI thread when we've consumed
        // a full frame's worth of time. For fast pages (small/low-DPI) we
        // may render several pages per frame with no unnecessary pauses.
        // For slow pages (large/high-DPI) we yield after every single page.
        const now = performance.now();
        if (now - frameStart >= _FRAME_BUDGET_MS) {
          await _yieldToUI();
          frameStart = performance.now();   // reset budget after yield
        }
      } catch (err) {
        showToast(t('warn_page_fail', { page: pageNum, msg: err.message }), 4000);
      }
    }
  } finally {
    // Zero canvas dimensions → releases GPU texture memory immediately.
    // canvas = null signals to GC and future readers: intentionally released.
    canvas.width  = 0;
    canvas.height = 0;
    canvas.remove();
    canvas = null;
  }

  const successCount = streamZip ? streamCount : (singleResult ? 1 : 0);
  if (successCount === 0) {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('pdf2jpg', t('err_no_render'), 'render_all_failed'); return;
  }

  setProgress(93, t('prog_packaging'));

  let blob, filename, desc;
  if (validPages.length === 1) {
    blob     = new Blob([singleResult.buffer], { type: mime });
    filename = singleResult.name;
    desc     = t('desc_pdf2jpg_one', { ext: ext.toUpperCase(), size: fmtSize(blob.size) });
  } else {
    blob = await streamZip.generateAsync(
      { type: 'blob', compression: 'STORE' },   // images already compressed — no re-deflate
      meta => setProgress(93 + Math.round(meta.percent / 100 * 5), t('prog_packaging'))
    );
    const baseName = file.name.replace(/\.pdf$/i, '');
    filename = `${baseName}-images.zip`;
    desc     = t('desc_pdf2jpg_many', { n: streamCount, ext: ext.toUpperCase(), size: fmtSize(blob.size) });
  }

  isProcessing = false;
  setFilesLocked(false);
  hideCancelBtn();
  setProgress(100, t('prog_done'));

  document.dispatchEvent(new CustomEvent('pdfree:success', {
    detail: { tool: 'pdf2jpg', blob, desc, filename }
  }));
}

// ── Generic single-file worker tool ───────────────────────────
// Используется для watermark, pagenum, meta — все следуют одному
// паттерну: один файл → worker → ArrayBuffer → Blob → success.

// bufferOverride: used by _runFillOrder to hand off already-reordered
// bytes instead of re-reading/preprocessing the original file — every
// other caller omits it and behaves exactly as before.
async function _runWorkerTool(tool, filesSnapshot, params, bufferOverride) {
  // Text watermarks need a Unicode-capable font — see watermarkTextWorker.js.
  // Image watermarks (options.kind === 'image') don't and stay below unchanged.
  if (tool === 'watermark' && params.kind !== 'image') {
    return _runWatermarkText(filesSnapshot, params);
  }

  const file   = filesSnapshot[0];
  const limits = { watermark: 200, pagenum: 200, meta: 200, protect: 200, rotate: 150, redact: 150, fill: 200, flatten: 200 };
  if (!_checkSize(file, limits[tool] ?? 200)) { _abortUI(); return; }
  const buffer = bufferOverride ?? (file._decryptedBuffer ? file._decryptedBuffer.slice(0) : await preprocessPdfBuffer(await file.arrayBuffer()));

  const labelMap = {
    watermark: t('prog_watermark'),
    pagenum:   t('prog_pagenum'),
    meta:      t('prog_meta'),
    protect:   t('prog_protect'),
    rotate:    t('prog_rotate'),
    redact:    t('prog_redact'),
    fill:      'Filling PDF…',
    flatten:   t('prog_flatten'),
  };
  setProgress(5, labelMap[tool] || t('prog_processing'));

  // ⚠️  TRANSFERABLE: buffer detached after this call — worker owns it until done.
  _worker.postMessage(
    { tool, file: buffer, options: params },
    [buffer]
  );

  _worker.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'progress') {
      setProgress(data.value, data.label);
    } else if (data.type === 'done') {
      if (!(data.result instanceof ArrayBuffer)) {
        _handleError(tool, 'Unexpected result from worker'); return;
      }
      isProcessing = false;
      setFilesLocked(false);
      hideCancelBtn();
      setProgress(100, t('prog_done'));

      const blob = new Blob([data.result], { type: 'application/pdf' });
      const base = file.name.replace(/\.pdf$/i, '');
      const suffixes = { watermark: '-watermarked', pagenum: '-numbered', meta: '-edited', protect: '-protected', rotate: '-rotated', redact: '-redacted', fill: '-filled', flatten: '-locked' };
      const filename = `${base}${suffixes[tool] || '-processed'}.pdf`;

      const pages = data.pageCount;
      const size  = fmtSize(blob.size);
      const extra = data.wasAlreadyProtected ? ' · re-encrypted' : '';
      const descMap = {
        watermark: t('desc_watermark', { pages, size }),
        pagenum:   t('desc_pagenum',   { pages, size }),
        meta:      t('desc_meta',      { pages, size }),
        protect:   t('desc_protect',   { pages, size, extra }),
        rotate:    t('desc_rotate',    { pages, size }),
        redact:    t('desc_redact',    { pages, size }),
        fill:      t('desc_fill',      { pages, size }),
        flatten:   t('desc_flatten',   { pages, size }),
      };

      document.dispatchEvent(new CustomEvent('pdfree:success', {
        detail: { tool, blob, desc: descMap[tool] || fmtSize(blob.size), filename }
      }));

      if (tool === 'protect' && data.wasAlreadyProtected) {
        showToast(t('already_protected'), 4000);
      }
      if (tool === 'flatten' && data.info === 'no_fields') {
        showToast(t('warn_xfa_form'), 6000);
      }
      if (tool === 'fill' && data.skippedFields > 0) {
        showToast(tp(data.skippedFields, 'warn_fill_skip_one', 'warn_fill_skip_many'), 6000);
      }
    } else if (data.type === 'error') {
      isProcessing = false; setFilesLocked(false); hideCancelBtn();
      _handleError(tool, data.message);
    }
  };

  _worker.onerror = (e) => {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError(tool, e.message || 'Worker error');
  };
}

// ── Batch processing (compress / watermark / protect / pagenum /
//    flatten, 2+ files) ──────────────────────────────────────────
//
// Scope is intentionally narrow, not "everything with runner:'worker'".
// merge/jpg2pdf are already N-inputs→1-output; split already has its own
// separate-files zip flow — those stay outside _runBatch entirely.
// fill is deliberately excluded even though it's runner:'worker': its
// options panel is built from file[0]'s AcroForm field *schema*, and
// applying file[0]'s filled-in values to other files is only correct when
// every file is the same template — silently "batching" it would produce
// wrong output on the common case (different files, different forms).
// meta is excluded for now too — technically as safe as pagenum (no
// per-file dependency), just not asked for yet; add it the same one-line
// way as the rest below if it ever is.
//
// Design: reuse the SAME shared `_worker` instance, one postMessage per
// file, awaited sequentially — never concurrent (the shared worker's
// onmessage/onerror are reassigned per call, so parallel calls would
// clobber each other's callbacks; see processor.js module docs). Each
// file's ArrayBuffer result is collected, then all successful outputs
// are bundled into one ZIP via the exact loadJSZip()/JSZip() pattern
// already used by _runSplit's separate-files mode and _runPdf2Jpg.
// Derived from config.js's `batch: true` flag, not hardcoded here — single
// source of truth, so adding/removing a batch-eligible tool only ever means
// touching one file (config.js), never risks the two lists drifting apart.
const BATCH_TOOLS = new Set(Object.keys(TOOLS).filter(k => TOOLS[k].batch));

// The options panel is inherently single-file (built from files[0]), so
// batch mode applies whatever the panel currently holds to every file.
// protect is the clearest case where this is exactly the point, not a
// caveat: one password entered once, applied to every file in the batch.
// pagenum's options (position/format/start number) and flatten (no options
// at all — it just locks whatever fields exist) have no per-file dependency
// either. rotate was tried here too but reverted (see config.js's rotate
// entry) — per-page rotation genuinely can't generalize across files with
// different page counts, unlike the tools that remain.
const _BATCH_SIZE_LIMITS = {
  compress: MAX_COMPRESS_MB, watermark: 200,
  protect: 200, pagenum: 200, flatten: 150,
};
const _BATCH_SUFFIX = {
  watermark: '-watermarked',
  protect: '-protected', pagenum: '-numbered', flatten: '-flattened',
};
const _BATCH_WATCHDOG_MS = 45_000; // same silent-hang guard as _runCompress's single-file watchdog

/**
 * postMessage → onmessage/onerror, wrapped as a promise for the batch
 * loop's sequential await. Mirrors the exact worker contract every other
 * runner in this file uses (progress/done/error message types, Transferable
 * buffer handoff) — just resolves/rejects instead of driving UI directly.
 */
function _postToWorkerForBatch(msg, transfer, onProgress) {
  return new Promise((resolve, reject) => {
    let watchdog;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => settle(reject, new Error(t('err_batch_timeout'))), _BATCH_WATCHDOG_MS);
    };
    const settle = (fn, val) => {
      clearTimeout(watchdog);
      _batchCancelReject = null;
      fn(val);
    };

    _worker.onmessage = (e) => {
      const data = e.data;
      if (data.type === 'progress') { arm(); onProgress?.(data.value, data.label); return; }
      if (data.type === 'done')     { settle(resolve, data); return; }
      if (data.type === 'error')    { settle(reject, new Error(data.message)); return; }
    };
    _worker.onerror = (e) => settle(reject, new Error(e.message || 'Worker error'));

    _batchCancelReject = reject;
    arm();
    _worker.postMessage(msg, transfer);
  });
}

/** One file through the compress runner — returns { name, buffer } for the zip. */
async function _batchCompressOne(file, params, onProgress) {
  const buffer = file._decryptedBuffer ? file._decryptedBuffer.slice(0) : await preprocessPdfBuffer(await file.arrayBuffer());
  const { preset = 'medium', preserveText = true, removeWatermarks = false, targetDpi = null, quality = null, targetSizeMb = null } = params;
  const data = await _postToWorkerForBatch(
    { tool: 'compress', file: buffer, options: { preset, preserveText, removeWatermarks, targetDpi, quality, targetSizeMb } },
    [buffer],
    onProgress
  );
  if (!(data.result instanceof ArrayBuffer)) throw new Error('Unexpected result type from worker');
  const baseName = file.name.replace(/\.pdf$/i, '');
  // originalSize/compressedSize come straight from worker.js's compress handler
  // (same 'done' message shape as the single-file path) — _runBatch sums these
  // across the whole batch for the aggregate "before → after" summary.
  return { name: `${baseName}-compressed.pdf`, buffer: data.result, originalSize: data.originalSize, compressedSize: data.compressedSize };
}

/** One file through a generic worker tool (watermark/protect/pagenum/flatten) — returns { name, buffer }. */
async function _batchWorkerToolOne(tool, file, params, onProgress) {
  const buffer = file._decryptedBuffer ? file._decryptedBuffer.slice(0) : await preprocessPdfBuffer(await file.arrayBuffer());
  // Same Unicode-font routing as the single-file path in _runWorkerTool —
  // see watermarkTextWorker.js for why. _watermarkTextRequest throwing
  // (e.g. code:'unsupported-characters') is caught by _runBatch's own
  // per-file try/catch, same as any other batch-item failure.
  const data = (tool === 'watermark' && params.kind !== 'image')
    ? await _watermarkTextRequest(buffer, params, onProgress)
    : await _postToWorkerForBatch({ tool, file: buffer, options: params }, [buffer], onProgress);
  if (!(data.result instanceof ArrayBuffer)) throw new Error('Unexpected result from worker');
  const base = file.name.replace(/\.pdf$/i, '');
  return { name: `${base}${_BATCH_SUFFIX[tool] || '-processed'}.pdf`, buffer: data.result };
}

async function _runBatch(tool, filesSnapshot, extraParams) {
  const total = filesSnapshot.length;
  trackBatchStart(tool, total);

  // Fresh queue — reset any stale status left over from a previous failed
  // "process again" attempt on the same file objects.
  filesSnapshot.forEach(f => { f._batchStatus = 'pending'; });
  renderList(true);

  const zipEntries   = [];
  const failedNames  = [];
  let succeeded = 0;
  // compress-only aggregate for the "before → after" summary — see the
  // desc-building block below. Meaningless for the other 4 batch tools
  // (they don't shrink files on purpose), so left at 0 and unused there.
  let totalOriginalSize   = 0;
  let totalCompressedSize = 0;

  for (let i = 0; i < total; i++) {
    // cancelProcess() rejects the CURRENT file's in-flight worker promise via
    // _BatchCancelled (caught below), but a cancel click landing in the gap
    // between two files — after file i's promise settles and clears
    // _batchCancelReject, before file i+1 re-arms it — would otherwise go
    // undetected and let the loop run to completion. This check closes that gap.
    if (!isProcessing) return;

    const file = filesSnapshot[i];
    file._batchStatus = 'processing';
    renderList(true);

    const fileLabel = t('prog_batch_file', { i: i + 1, n: total });
    const base  = Math.round((i / total) * 100);
    const band  = 100 / total;
    setProgress(base, fileLabel);

    try {
      if (!_checkSize(file, _BATCH_SIZE_LIMITS[tool] ?? 200)) {
        throw new Error('File too large'); // _checkSize already toasted specifics
      }

      const onProgress = (value) => {
        setProgress(Math.min(99, Math.round(base + (value / 100) * band)), fileLabel);
      };

      const result = tool === 'compress'
        ? await _batchCompressOne(file, extraParams, onProgress)
        : await _batchWorkerToolOne(getWorkerTool(tool) ?? tool, file, extraParams, onProgress);

      zipEntries.push(result);
      file._batchStatus = 'done';
      succeeded++;
      if (tool === 'compress') {
        totalOriginalSize   += result.originalSize;
        totalCompressedSize += result.compressedSize;
      }
    } catch (err) {
      if (err instanceof _BatchCancelled) return; // cancelProcess() already cleaned up the UI
      file._batchStatus = 'error';
      failedNames.push(file.name);
      trackToolError(tool, 'batch_item_failed');
    }
    renderList(true);
  }

  // Cancel has no in-flight worker promise to reject once the loop above has
  // finished (every file already got its 'done'/'error' response) — check the
  // flag directly so a cancel landing in the zip-building tail doesn't let a
  // "cancelled" run finish anyway and hand the user an unexpected download.
  if (!isProcessing) return;

  if (zipEntries.length === 0) {
    isProcessing = false;
    setFilesLocked(false);
    hideCancelBtn();
    trackToolError(tool, 'batch_all_failed');
    _handleError(tool, t('err_batch_all_failed'));
    return;
  }

  setProgress(96, t('prog_zip'));
  await loadJSZip();
  const JSZip = window.JSZip;
  const zip = new JSZip();
  for (const entry of zipEntries) zip.file(entry.name, entry.buffer);
  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE' },
    meta => setProgress(96 + Math.round(meta.percent / 100 * 4), t('prog_compressing'))
  );

  if (!isProcessing) return; // cancelled while zipping — don't finish/download a cancelled run

  isProcessing = false;
  setFilesLocked(false);
  hideCancelBtn();
  setProgress(100, t('prog_done'));
  clearLongOpHint(); // batch never called hideProgress() on success — the "Still
                      // working…" hint (armed by startLongOpHint in doProcess) was
                      // never dismissed and could linger past a 12s+ batch finishing.

  const failed = total - succeeded;
  // Exact before/after size + % lives in the prominent hero line rendered by
  // renderBatchCompressionSummary() (see batchCompressSummary below) — the
  // text description here stays generic, mirroring the single-file compress
  // flow's own desc_compress_saved/desc_compress_optimized pattern.
  let desc;
  if (tool === 'compress' && totalOriginalSize > 0) {
    desc = failed > 0
      ? t('desc_batch_compress_partial', { ok: succeeded, total })
      : t('desc_batch_compress_done',    { n: succeeded });
  } else {
    desc = failed > 0
      ? t('desc_batch_partial', { ok: succeeded, total, size: fmtSize(blob.size) })
      : t('desc_batch_done', { n: succeeded, size: fmtSize(blob.size) });
  }
  const filename = `${tool}-batch-${succeeded}-files.zip`;
  // Separate shape from single-file's compressionReport (which carries a
  // per-file breakdown: XMP/thumbnails/image recompression counts, etc.) —
  // none of that sums meaningfully across a batch, so this is just the two
  // totals compressUI.js needs for the prominent "before → after" line.
  const batchCompressSummary = tool === 'compress' && totalOriginalSize > 0
    ? { originalSize: totalOriginalSize, compressedSize: totalCompressedSize }
    : null;

  document.dispatchEvent(new CustomEvent('pdfree:success', {
    detail: { tool, blob, desc, filename, batchCompressSummary }
  }));
  trackBatchSuccess(tool, total, succeeded);

  if (failed > 0) {
    const names = failedNames.slice(0, 5).join(', ');
    showToast(tp(failed, 'warn_batch_failed_one', 'warn_batch_failed_many', { n: failed, names }), 7000);
  }
}

// ── PDF → Word ────────────────────────────────────────────────
// Runs entirely in main thread (like pdf2jpg): docx lib needs DOM
// for Blob creation, and pdf.js rendering needs canvas.

async function _runPdf2Word(filesSnapshot, { mode = 'text', dpi = 150 } = {}) {
  const file = filesSnapshot[0];
  if (!_checkSize(file, 150)) { _abortUI(); return; }

  setProgress(5, 'Loading libraries…');

  try {
    await loadDocx();
  } catch {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('pdf2word', 'Word library unavailable — check your internet connection.');
    return;
  }

  if (!window.pdfjsLib) {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('pdf2word', 'PDF engine not ready — reopen the tool.', 'renderer_not_loaded');
    return;
  }

  setProgress(8, 'Loading PDF…');

  let pdfDoc;
  try {
    const rawBuf = file._decryptedBuffer
      ? file._decryptedBuffer.slice(0)
      : await preprocessPdfBuffer(await file.arrayBuffer());
    pdfDoc = await window.pdfjsLib.getDocument({ isEvalSupported: false,
      data:              new Uint8Array(rawBuf),
      useSystemFonts:    false,
      verbosity:         0,
      disableJavaScript: true,
    }).promise;
  } catch (err) {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('pdf2word', err.message); return;
  }

  // Hard cap for image mode: rendering 500+ pages accumulates GB of ArrayBuffers
  // in RAM before Packer.toBlob() can flush them into a ZIP stream.
  const effectivePages = mode === 'image'
    ? Math.min(pdfDoc.numPages, _P2W_IMAGE_CAP)
    : pdfDoc.numPages;

  if (mode === 'image' && pdfDoc.numPages > _P2W_IMAGE_CAP) {
    showToast(
      `Image mode is limited to ${_P2W_IMAGE_CAP} pages. Pages 1–${_P2W_IMAGE_CAP} will be exported.`,
      7000
    );
  }

  let paragraphs;
  let confidence = null;
  let pageData, median, repeatTextSet, repeatPatternSet, cs;   // text mode only — kept for the ERI retry below
  try {
    if (mode === 'text') {
      setProgress(10, 'Extracting text…');
      ({ pageData, median, repeatTextSet, repeatPatternSet, cs } = await _p2wBuildPageData(pdfDoc, {
        onProgress:  (pct, label) => setProgress(pct, label),
        isCancelled: () => !isProcessing,
      }));
      ({ paragraphs, cs } = await _p2wBuildParagraphs(pdfDoc, pageData, median, repeatTextSet, cs, { repeatPatternSet }));
      confidence = _p2wConfidence(cs, median);
    } else {
      setProgress(10, 'Rendering pages…');
      paragraphs = await _p2wRenderImages(pdfDoc, dpi, effectivePages);
    }
  } catch (err) {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('pdf2word', err.message); return;
  }

  if (!isProcessing) return;

  setProgress(92, 'Building Word document…');

  const { Document, Packer, AlignmentType, LevelFormat } = window.docx;
  const _buildDoc = children => new Document({
    creator:     'PDFree',
    description: 'Converted from PDF by PDFree.io',
    // Only referenced by paragraphs _p2wBuildParagraphs tags with
    // numbering:{reference:_P2W_NUMBERED_LIST_REF,level:0} (flat "1./2./3."
    // markers detected in the source) — harmless, unused boilerplate on any
    // document that has none (image mode, or text with no numbered lists).
    numbering: {
      config: [{
        reference: _P2W_NUMBERED_LIST_REF,
        levels: [{
          level:     0,
          format:    LevelFormat.DECIMAL,
          text:      '%1.',
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    sections: [{ children }],
  });

  // toBlob() uses JSZip type:"blob" — browser-native, no polyfill needed.
  // toBuffer() uses type:"nodebuffer" which JSZip does not support in browsers.
  let blob = await Packer.toBlob(_buildDoc(paragraphs));

  // Atlas structural check — scores the ACTUAL shipped DOCX (tables real vs.
  // layout-mis-detected, paragraphs trapped in text boxes, flow chopped by
  // hard breaks) via eriScore.js's evaluateStructural(), the same JS port
  // of Atlas_DR's evaluate_structural() already used below for the
  // table-retry decision — now also surfaced to the user (see
  // renderAtlasCheck in pdf2wordUI.js), not just consumed internally.
  // Computed unconditionally for mode==='text' (image mode has no editable
  // structure to score at all). Best-effort throughout: any scoring failure
  // here never blocks a conversion that already succeeded — `atlasEri`
  // simply stays null and the UI shows nothing for it.
  let atlasEri = null;
  if (mode === 'text' && isProcessing) {
    try {
      atlasEri = await evaluateStructural(await blob.arrayBuffer());

      // Self-check: if this document has tables and they score badly, verify
      // whether rebuilding paragraphs-only (no PDF re-parse needed —
      // pageData is already extracted) scores higher, and keep whichever
      // variant actually does — same retry this block already ran, now just
      // also keeping the winning variant's OWN atlasEri for display instead
      // of silently keeping the pre-retry score.
      if (cs.totalTables > 0 && atlasEri.components.tables < _ERI_TABLE_RETRY_THRESHOLD) {
        setProgress(95, 'Verifying table structure…');
        const retry = await _p2wBuildParagraphs(
          pdfDoc, pageData, median, repeatTextSet, cs, { useTables: false, repeatPatternSet }
        );
        const retryBlob = await Packer.toBlob(_buildDoc(retry.paragraphs));
        const retryEri = await evaluateStructural(await retryBlob.arrayBuffer());
        if (retryEri.eri > atlasEri.eri) {
          blob       = retryBlob;
          confidence = _p2wConfidence(retry.cs, median);
          atlasEri   = retryEri;
        }
      }
    } catch {
      // ERI check is best-effort — never let a scoring failure block a
      // conversion that already succeeded.
    }
  }

  const baseName = file.name.replace(/\.pdf$/i, '');
  const filename = `${baseName}.docx`;
  const modeTag  = mode === 'text' ? 'editable text' : 'page images';
  const pageNote = effectivePages < pdfDoc.numPages
    ? `${effectivePages} of ${pdfDoc.numPages} pages`
    : `${effectivePages} page${effectivePages !== 1 ? 's' : ''}`;
  const desc = `${pageNote} · ${modeTag} · ${fmtSize(blob.size)}`;

  isProcessing = false;
  setFilesLocked(false);
  hideCancelBtn();
  setProgress(100, t('prog_done'));

  document.dispatchEvent(new CustomEvent('pdfree:success', {
    detail: { tool: 'pdf2word', blob, desc, filename, confidence, atlasEri }
  }));
}

// ── PDF → Excel ──────────────────────────────────────────────────
// Reuses detectTables() (js/pdf2wordTables.js) — the same X-coordinate
// column-clustering engine pdf2word uses — since its rows: string[][]
// output is already Excel's native cell model. Deliberately does NOT
// reuse detectTableGrids() (border-only grids with no text): those are
// visually meaningful in a Word document but carry zero cell data, so
// they'd only produce empty worksheets — not useful in a spreadsheet.
// Each detected table becomes its own worksheet; any line not captured
// by a table is appended to a catch-all "Text" sheet so nothing is
// silently dropped, even on documents that turn out not to be
// spreadsheet-like.

async function _runPdf2Excel(filesSnapshot) {
  const file = filesSnapshot[0];
  if (!_checkSize(file, 150)) { _abortUI(); return; }

  setProgress(5, 'Loading libraries…');

  try {
    await loadExcelJs();
  } catch {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('pdf2excel', 'Excel library unavailable — check your internet connection.');
    return;
  }

  if (!window.pdfjsLib) {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('pdf2excel', 'PDF engine not ready — reopen the tool.', 'renderer_not_loaded');
    return;
  }

  setProgress(8, 'Loading PDF…');

  let pdfDoc;
  try {
    const rawBuf = file._decryptedBuffer
      ? file._decryptedBuffer.slice(0)
      : await preprocessPdfBuffer(await file.arrayBuffer());
    pdfDoc = await window.pdfjsLib.getDocument({ isEvalSupported: false,
      data:              new Uint8Array(rawBuf),
      useSystemFonts:    false,
      verbosity:         0,
      disableJavaScript: true,
    }).promise;
  } catch (err) {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('pdf2excel', err.message); return;
  }

  let extracted;
  try {
    extracted = await _p2eExtractTables(pdfDoc);
  } catch (err) {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('pdf2excel', err.message); return;
  }

  if (!isProcessing) return;

  setProgress(90, 'Building spreadsheet…');

  // Gate 1: detector's own confidence (pdf2wordTables.js already floors
  // emission at 0.72 — this raises the bar specifically for "does this
  // deserve its own worksheet" vs. being flattened into the Text sheet).
  // Demoted rows are joined with a double space, same shape as a plain
  // text line — they're no longer claimed to be tabular data.
  const keptTables  = [];
  let   textRows    = [...extracted.textRows];
  for (const tbl of extracted.tables) {
    if (tbl.confidence >= _P2E_CONF_THRESHOLD) {
      keptTables.push(tbl);
    } else {
      for (const row of tbl.rows) textRows.push({ page: tbl.page, text: row.join('  ') });
    }
  }
  let tables = keptTables;

  let workbook = _p2eBuildWorkbook(tables, textRows);
  let buffer   = await workbook.xlsx.writeBuffer();

  // Gate 2: independent structural check computed from the ACTUAL produced
  // .xlsx bytes (eriScoreXlsx.js), not the detector's self-reported
  // confidence — a table can pass gate 1 (detector was confident) and still
  // be structurally wrong (e.g. a confidently-aligned two-column layout
  // that isn't tabular data at all). Best-effort: any failure here just
  // ships the gate-1 result, never blocks a successful conversion.
  if (tables.length && isProcessing) {
    try {
      const eri = await evaluateXlsxStructural(buffer);
      const badSheetNames = new Set(
        eri.sheets.filter(s => s.eri < _P2E_ERI_THRESHOLD).map(s => s.name)
      );
      if (badSheetNames.size) {
        setProgress(95, 'Verifying table structure…');
        const survivors = [];
        tables.forEach((tbl, i) => {
          if (badSheetNames.has(`Table ${i + 1}`)) {
            for (const row of tbl.rows) textRows.push({ page: tbl.page, text: row.join('  ') });
          } else {
            survivors.push(tbl);
          }
        });
        tables   = survivors;
        workbook = _p2eBuildWorkbook(tables, textRows);
        buffer   = await workbook.xlsx.writeBuffer();
      }
    } catch {
      // ERI check is best-effort — never let a scoring failure block a
      // conversion that already succeeded.
    }
  }

  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  const baseName = file.name.replace(/\.pdf$/i, '');
  const filename = `${baseName}.xlsx`;
  const confidence = _p2eConfidence({ ...extracted, tables });
  const tableNote = tables.length
    ? `${tables.length} table${tables.length !== 1 ? 's' : ''} found`
    : 'no tables found';
  const desc = `${extracted.totalPages} page${extracted.totalPages !== 1 ? 's' : ''} · ${tableNote} · ${fmtSize(blob.size)}`;

  isProcessing = false;
  setFilesLocked(false);
  hideCancelBtn();
  setProgress(100, t('prog_done'));

  document.dispatchEvent(new CustomEvent('pdfree:success', {
    detail: { tool: 'pdf2excel', blob, desc, filename, confidence }
  }));
}

// Builds the ExcelJS workbook: one worksheet per surviving table, plus a
// single "Text" sheet for everything not confidently tabular. Split out so
// _runPdf2Excel() can rebuild it a second time (cheap — no PDF re-parse,
// no re-detection) after demoting whichever tables fail the post-build ERI
// structural check.
function _p2eBuildWorkbook(tables, textRows) {
  const workbook = new window.ExcelJS.Workbook();
  workbook.creator = 'PDFree';

  tables.forEach((tbl, i) => {
    const sheet = workbook.addWorksheet(`Table ${i + 1}`.slice(0, 31));

    tbl.rows.forEach((row, ri) => {
      if (ri === 0) { sheet.addRow(row); return; } // header stays plain text
      const parsed    = row.map(_p2eCellValue);
      const excelRow  = sheet.addRow(parsed.map(p => p.value));
      parsed.forEach((p, ci) => {
        if (p.numFmt) excelRow.getCell(ci + 1).numFmt = p.numFmt;
      });
    });

    // Only assert "this looks like a header" visually when the detector
    // itself was confident — CONF_THRESHOLD in pdf2wordTables.js already
    // gates emission at 0.72, so 0.8 marks the genuinely high-confidence tier
    // (same cutoff pdf2word's own document-level score uses for "high").
    if (tbl.confidence >= 0.8) {
      sheet.getRow(1).font = { bold: true };
    }

    const colCount = tbl.rows[0]?.length || 0;
    if (tbl.rows.length > 1 && colCount > 0) {
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to:   { row: tbl.rows.length, column: colCount },
      };
    }

    sheet.columns.forEach(col => {
      let maxLen = 10;
      col.eachCell({ includeEmpty: true }, cell => {
        maxLen = Math.max(maxLen, String(cell.value ?? '').length);
      });
      col.width = Math.min(maxLen + 2, 60);
    });
  });

  if (textRows.length) {
    const sheet = workbook.addWorksheet('Text');
    textRows.forEach(r => sheet.addRow([r.text]));
    sheet.getColumn(1).width = 100;
  }

  if (!tables.length && !textRows.length) {
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['No extractable text or tables were found in this PDF.']);
  }

  return workbook;
}

// Simplified line-grouping (no heading/RTL-paragraph/rotated-header handling —
// none of that matters for cell data) + detectTables() per page. Lines not
// consumed by a detected table are returned separately as fallback rows.
async function _p2eExtractTables(pdfDoc) {
  const tables = [];
  const textRows = [];
  let pagesWithNoText = 0;

  // Checked at the TOP of each iteration (not the bottom, unlike
  // _p2wBuildPageData's identical idiom) because this loop has an early
  // `continue` for no-text pages — a bottom-of-loop check would be skipped
  // on that path. No yield point existed anywhere here before — a real
  // user report (161.0ms max single-frame gap on a 25-page table-heavy
  // PDF, 4x CPU throttle) traced back to this being the one remaining
  // unchunked per-page loop in pdf2excel. Same budget-checked idiom
  // _runPdf2Jpg already uses.
  let frameStart = performance.now();
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    if (!isProcessing) break;
    if (performance.now() - frameStart >= _FRAME_BUDGET_MS) {
      await _yieldToUI();
      frameStart = performance.now();
    }
    setProgress(10 + Math.round((p / pdfDoc.numPages) * 75),
                `Reading page ${p}/${pdfDoc.numPages}…`);

    const page    = await pdfDoc.getPage(p);
    const content = await page.getTextContent({ normalizeWhitespace: false });
    const items = content.items
      .filter(item => 'str' in item && item.str.split(' ').join('').trim())
      .map(item => ({
        str: ((item.dir === 'rtl') ? _visualRTLToLogical(item.str) : item.str)
          .split(' ').join(''),
        x: item.transform[4],
        y: item.transform[5],
        fontSize: (item.height > 0 ? item.height : Math.abs(item.transform[3])) || 10,
      }));

    const lines = groupItemsIntoLines(items);

    if (!lines.length) { pagesWithNoText++; page.cleanup?.(); continue; }

    const pageTables = detectTables(lines);
    const consumed    = new Set();
    for (const tbl of pageTables) {
      for (let li = tbl.startIdx; li <= tbl.endIdx; li++) consumed.add(li);
      tables.push({ page: p, rows: tbl.rows, confidence: tbl.confidence });
    }
    lines.forEach((ln, li) => {
      if (consumed.has(li)) return;
      const text = ln.items.map(i => i.str).join(' ').trim();
      if (text) textRows.push({ page: p, text });
    });

    page.cleanup?.();
  }

  return { tables, textRows, totalPages: pdfDoc.numPages, pagesWithNoText };
}

export function _p2eConfidence({ tables, totalPages, pagesWithNoText }) {
  if (!tables.length) {
    return { score: 0, level: 'none', tableCount: 0, pagesWithNoText, totalPages };
  }
  const avgConf      = tables.reduce((sum, t) => sum + t.confidence, 0) / tables.length;
  const pageCoverage = Math.max(0.5, 1 - (pagesWithNoText / totalPages));
  const score        = Math.round(avgConf * 100 * pageCoverage);
  const level        = score >= 80 ? 'high' : score >= 55 ? 'medium' : 'low';
  return { score, level, tableCount: tables.length, pagesWithNoText, totalPages };
}

// Parses a table cell's text into a typed Excel value where it's unambiguous
// to do so, so sums/charts/sorting work without the user retyping numbers.
// Conservative by design (same philosophy as detectTables() itself — prefer
// leaving a cell as text over silently mis-parsing it):
//   • numbers: optional currency symbol / thousands separators, then a plain
//     integer or decimal — "$1,234.56" and "1234.56" both become a Number
//   • percentages: "12.5%" → 0.125 with a percent display format
//   • dates: ISO (YYYY-MM-DD) only. Slash/dot formats (01/02/2026) are
//     deliberately left as text — JS's Date parser assumes MM/DD/YYYY
//     regardless of the source locale, so guessing would risk silently
//     swapping day and month rather than just failing to format.
export function _p2eCellValue(str) {
  const s = (str ?? '').trim();
  if (!s) return { value: str };

  if (/^-?\d{1,3}(,\d{3})*(\.\d+)?%$/.test(s) || /^-?\d+(\.\d+)?%$/.test(s)) {
    return { value: parseFloat(s.replace(/,/g, '').replace('%', '')) / 100, numFmt: '0.00%' };
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return { value: d, numFmt: 'yyyy-mm-dd' };
  }

  const numCandidate = s.replace(/^[$€£¥]\s?/, '').replace(/,/g, '');
  if (/^-?\d+(\.\d+)?$/.test(numCandidate)) {
    return { value: parseFloat(numCandidate) };
  }

  return { value: str };
}

// ── PDF → PowerPoint ─────────────────────────────────────────────
// Simplest of the three PDF→Office tools: no text extraction or table
// detection, since reconstructing arbitrary PDF layouts as *editable*
// PowerPoint text boxes is unreliable — the industry-standard approach
// (Adobe included) is one full-bleed image per slide. Reuses
// _p2wDetectFormat() (the same adaptive PNG/JPEG heuristic PDF to Word's
// image fallback uses) and the same large-deck quality tiering
// _p2wRenderImages() already applies for memory safety.

// Scale-to-fit + center a page's own image within the deck's fixed slide
// box, instead of stretching it to fill x=0,y=0,w=layoutW,h=layoutH
// unconditionally. PPTX only supports one slide size per deck, so a mixed-
// page-size source PDF (e.g. one landscape page in an otherwise-portrait
// document) can't get its own slide dimensions — but the previous version
// force-stretched every page into the layout box regardless, visibly
// distorting anything that didn't match page 1's aspect ratio. This never
// enlarges past 100% and is a no-op (scale=1, x=y=0, same output as
// before) for the common case where a page's aspect ratio already matches
// the deck layout — same 'fit' semantics as resizeWorker.js's _fitRect
// (checked several open-source PDF→PPTX converters, e.g. kevinmcguinness/
// pdf2pptx, while fixing this: deriving layout from page 1 and force-
// stretching everything else turns out to be the common failure mode
// here, not something to imitate).
function _p2pFitRect(srcW, srcH, availW, availH) {
  const scale  = Math.min(1, availW / srcW, availH / srcH);
  const scaledW = srcW * scale;
  const scaledH = srcH * scale;
  return { scale, w: scaledW, h: scaledH, x: (availW - scaledW) / 2, y: (availH - scaledH) / 2 };
}

// ── Invisible text layer: Ctrl+F search + copy-paste over the image ────
//
// The slide image is a flat raster — nothing on it is searchable or
// selectable in PowerPoint. This adds a second, transparent layer of real
// text boxes positioned to match pdf.js's own text coordinates, so Ctrl+F
// and drag-select work even though every slide is still fundamentally an
// image. The text is never visible (color alpha 0, no fill, no border) —
// this is a utility layer, not an attempt at visually-editable slides
// (that remains a deliberately rejected approach, see the block comment
// above _p2pFitRect).
//
// Naively wrapping every pdf.js text *item* in its own PPTX text box was
// considered and rejected: kerning/ligatures/font switches routinely
// split a single word across 3-4 items, so a page can report hundreds of
// them — one shape per item would both tank PowerPoint's render
// performance and make drag-select pick up meaningless fragments instead
// of words. Merged in three passes instead: group items into lines by Y
// (small tolerance for sub/superscript jitter), merge items within a line
// by X-gap (small gap = same word run, large gap = a column break — keep
// those as separate boxes rather than smearing two columns into one
// unreadable line), then merge vertically-adjacent single-column lines
// with matching indent/font-size into one multi-line paragraph box (own
// addition beyond the line-level merge — cuts shape count further for
// ordinary body text, which is most of what real documents are).
const _P2P_MAX_TEXT_BLOCKS = 400; // safety cap — skip the layer entirely past this, not truncate it

export function _p2pMergeLineItems(line) {
  line.sort((a, b) => a.x - b.x);
  const blocks = [];
  let cur = null;
  for (const item of line) {
    if (!cur) { cur = { ...item }; continue; }
    const gap    = item.x - (cur.x + cur.width);
    const maxGap = cur.fontSize * 0.6; // beyond this, treat as a separate column/block, not a word gap
    if (gap < maxGap) {
      const needsSpace = gap > cur.fontSize * 0.1;
      cur.text  += (needsSpace ? ' ' : '') + item.text;
      cur.width  = (item.x + item.width) - cur.x;
      cur.height = Math.max(cur.height, item.height);
    } else {
      blocks.push(cur);
      cur = { ...item };
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

// Merge line N+1 into line N's block only when it's unambiguous: exactly
// one block on each line (no column split already detected on either),
// same left edge within 2pt, similar font size (within 15%), and a
// vertical gap consistent with ordinary single-spaced body text (<0.7×
// font size) — anything a real paragraph wouldn't do (a heading followed
// by body text, a table row, two side-by-side columns) fails at least one
// of these and is deliberately left as separate boxes.
export function _p2pMergeParagraphs(lineBlockGroups) {
  const out = [];
  for (const group of lineBlockGroups) {
    if (group.length !== 1) { out.push(...group); continue; }
    const block = group[0];
    const prev  = out[out.length - 1];
    if (prev &&
        prev._singleLine &&
        Math.abs(prev.x - block.x) < 2 &&
        Math.abs(prev.fontSize - block.fontSize) / prev.fontSize < 0.15 &&
        // Baseline-to-baseline gap consistent with ordinary single-line
        // spacing. Typical single-spaced leading runs ~1.15-1.5x font
        // size depending on font/renderer (verified empirically — an
        // initial 0.7x threshold rejected every real paragraph line,
        // since normal line spacing is *always* well above 0.7x); 1.8x
        // stays comfortably above that range while still well under a
        // genuine paragraph-break/heading gap (commonly 2x+).
        (prev._bottomY - block.y) < prev.fontSize * 1.8 &&
        (prev._bottomY - block.y) > 0) {
      prev.text   += '\n' + block.text;
      prev.width   = Math.max(prev.width, block.width);
      // prev._topY is fixed at the paragraph's first line, set once below
      // and never touched again — recomputing height from it directly
      // avoids compounding error on the 3rd+ merged line (an earlier
      // version derived each new height from the previous ALREADY-
      // accumulated height plus prev.y again, double-counting on every
      // merge past the first and producing a shape positioned above the
      // actual top of the text — caught by inspecting the raw generated
      // XML, not visually, since the layer is invisible by design).
      prev.height   = prev._topY - block.y;
      prev._bottomY = block.y;
      continue;
    }
    block._singleLine = true;
    block._topY        = block.y + block.height;
    block._bottomY      = block.y;
    out.push(block);
  }

  // block.y is only ever the FIRST merged line's own baseline — never
  // updated while later lines merge in (only .height and ._bottomY are).
  // The consumer (_runPdf2Ppt) derives each shape's top edge as
  // `y + height`, which is correct for a single untouched line (top =
  // baseline + own height) but wrong for a merged multi-line paragraph:
  // .height has grown to span the WHOLE paragraph while .y is still just
  // the topmost line's baseline, so `y + height` overshoots downward by
  // roughly the paragraph's own height — verified directly on a real
  // title+paragraph fixture where this pushed the paragraph's invisible
  // search/copy box ABOVE the title's, inverted from the source PDF's
  // actual top-to-bottom order (real, functional bug: Ctrl+F highlight and
  // drag-select land on the wrong on-slide position, even though the
  // rendered image itself always looks correct — the box is invisible).
  // Re-deriving y from the already-correct ._topY (fixed once, at the
  // paragraph's first line, and never touched again — see the comment
  // above) keeps the existing `y + height` formula downstream valid for
  // every block, merged or not, without changing that formula at all.
  for (const block of out) {
    if (block._topY !== undefined) block.y = block._topY - block.height;
  }
  return out;
}

async function _p2pExtractTextBlocks(page) {
  let items;
  try {
    items = (await page.getTextContent()).items;
  } catch { return []; }

  const norm = items
    .filter(it => it.str && it.str.trim() !== '')
    .map(it => {
      const tx = it.transform;
      return {
        text: it.str, x: tx[4], y: tx[5],
        width: it.width, height: it.height || Math.abs(tx[3]),
        fontSize: Math.abs(tx[3]) || 10,
      };
    });
  if (!norm.length) return [];

  norm.sort((a, b) => b.y - a.y); // PDF: larger y = higher on the page

  const lines = [];
  let curLine = null, curY = null;
  for (const item of norm) {
    const yTolerance = item.fontSize * 0.3;
    if (curY === null || Math.abs(curY - item.y) > yTolerance) {
      if (curLine) lines.push(curLine);
      curLine = [item];
      curY = item.y;
    } else {
      curLine.push(item);
    }
  }
  if (curLine) lines.push(curLine);

  const lineBlockGroups = lines.map(_p2pMergeLineItems);
  const blocks = _p2pMergeParagraphs(lineBlockGroups);

  return blocks.length > _P2P_MAX_TEXT_BLOCKS ? [] : blocks;
}

// ── Stage 1 "Editable text" mode: real, positioned, formatted PPTX text
// shapes instead of an invisible search layer over a raster image ─────────
//
// Reuses pdf2word's already-proven detectors (detectTables, detectColumnRegions,
// BULLET_RE/NUMBERED_RE/LETTERED_RE, the same heading font-ratio threshold and
// same-size-bold heading detection, the same repeatTextSet/repeatPatternSet
// footer suppression shipped earlier today) rather than re-deriving any of
// them. Deliberately simpler than _p2wBuildParagraphs in a few disclosed
// ways (Stage 1 scope, not an oversight — see this feature's own plan file):
//   - A multi-column page (detectColumnRegions() returns non-null) becomes
//     ONE whole-page image region — real per-column text reconstruction is
//     a Stage 2 candidate, not attempted here.
//   - A detected table becomes ONE image region spanning its own lines — no
//     native PPTX table (addTable) this round.
//   - RTL/CJK-specific paragraph-merge threshold tuning is not replicated
//     (plain LTR/Cyrillic 2.0x threshold used for every language) — a
//     disclosed simplification, not a correctness requirement for Stage 1.
//
// Unlike a flowing Word document, a PPTX slide has no reading-order
// constraint — every shape carries its own absolute x/y — so text shapes
// and image regions are returned as two independent, unordered lists; the
// caller (_runPdf2Ppt) places each at its own position without needing them
// pre-interleaved.
//
// Returns { textShapes, imageRegions, scanned } for ONE page:
//   textShapes:   [{ y0, y1, runs:[{text,bold,italic,fontSize}], heading, bullet }]
//                 y0/y1 in PDF points, origin bottom-left (y0 = top edge,
//                 y1 = bottom edge — y0 > y1, same convention as the rest of
//                 this codebase).
//   imageRegions: [{ y0, y1 }] — a Y-band to crop from the page's already-
//                 rendered canvas and place as one picture shape. Covers
//                 detected tables, multi-column pages (whole page), and
//                 ordinary whitespace gaps between text (diagrams/charts) —
//                 without this last case, any diagram/chart with no table
//                 border and no accompanying text would be silently
//                 dropped instead of merely left unreconstructed, which
//                 would be a real regression against today's always-safe
//                 raster fallback, not just a missed enhancement.
//   scanned:      true when the page has no extractable text at all — the
//                 caller renders the whole page as one image slide, same as
//                 today's existing scanned-page handling.
// Stage 3: builds shapes for ONE region's worth of lines — either the whole
// page (xBounds = {x0:0, x1:pageW}, the common single-column case) or one
// detected column region (xBounds = {x0:region.left, x1:region.right}).
// Extracted from _p2pBuildSlideShapes so the outer dispatcher below can call
// it once per page OR once per column, mirroring exactly how pdf2word's own
// _p2wBuildParagraphs dispatches its per-page body (_processLines) once per
// detected column region — see that function's outer loop for the pattern
// this mirrors.
function _p2pBuildRegionShapes(lines, borderGrids, xBounds, median, repeatTextSet, repeatPatternSet) {
  // Text-detected tables that Y-overlap a border grid are dropped in favor
  // of the grid — same precedence pdf2word's own _processLines uses, and
  // for the identical reason: border grids carry real merge/span line data
  // (colDividers) that pure X-position clustering can never recover (a
  // merged cell just looks like "an item missing from this column" to
  // detectTables(), indistinguishable from ordinary sparse/optional data).
  // Verified directly — without this filter, this file's own gridSpan test
  // (mirrors tests/pdf2wordParagraphs.test.js's real regression case)
  // failed: the text-detected path won the overlap and produced an empty
  // cell instead of a real colspan.
  const tables = detectTables(lines)
    .filter(t => !looksLikeProseNotData(t.rows) && !looksLikeEnumeratedList(t.rows))
    .filter(t => {
      const tMinY = Math.min(lines[t.startIdx].y, lines[t.endIdx].y);
      const tMaxY = Math.max(lines[t.startIdx].y, lines[t.endIdx].y);
      return !borderGrids.some(g => tMinY <= g.y + g.h && g.y <= tMaxY);
    });
  const lineToTable = new Map();
  for (const t of tables) {
    for (let li = t.startIdx; li <= t.endIdx; li++) lineToTable.set(li, t);
  }

  const tableShapes = [];

  // ── Border-grid tables (visually-bordered, may have merged cells) ───────
  // Stage 2: same dual-path table handling pdf2word's _processLines already
  // uses — text-detected tables above catch tables with no visible border
  // lines; border grids (detectTableGrids, js/pdf2wordBorders.js) catch the
  // reverse: a bordered table whose cells may be sparse or empty (no text
  // content at all). Reuses _assignLineToGridCols/_activeDividersForY/
  // _groupGridCellsWithSpans exactly as pdf2word does for its own real
  // docx gridSpan tables — pure, output-format-agnostic helpers. No
  // "covered by a text table" skip needed here (unlike an earlier version
  // of this code) — the filter above already removes any text-table that
  // would have overlapped, so every grid below is always the winning path
  // for its own Y-range.
  const gridConsumedLines = new Set();
  for (const grid of borderGrids) {
    const gridLines = [];
    for (let li = 0; li < lines.length; li++) {
      if (lineToTable.has(li)) continue;
      const ln = lines[li];
      if (ln.y >= grid.y - 4 && ln.y <= grid.y + grid.h + 4) gridLines.push({ li, ln });
    }
    if (!gridLines.length) continue;
    gridLines.sort((a, b) => b.ln.y - a.ln.y); // top first

    const rows = gridLines.map(({ ln }, idx) => {
      const rawCells      = _assignLineToGridCols(ln.items, grid.colXs);
      const rawFonts      = _assignLineToGridColsFonts(ln.items, grid.colXs);
      const activeDivider = _activeDividersForY(grid, ln.y);
      const cellGroups    = _groupGridCellsWithSpans(rawCells, activeDivider);
      const fontGroups    = _groupGridCellsWithSpans(rawFonts, activeDivider, (a, b) => a ?? b, undefined);
      return cellGroups.map(({ text, span }, ci) => ({ text, span, bold: idx === 0, fontFace: fontGroups[ci]?.text }));
    });
    for (const { li } of gridLines) gridConsumedLines.add(li);
    tableShapes.push({ x0: grid.x, x1: grid.x + grid.w, y0: grid.y + grid.h, y1: grid.y, rows });
  }

  // Baseline left margin — same concept _processLines (pdf2word) already
  // uses for LETTERED_RE's indent gate (a genuine sub-item is indented past
  // this; a false positive like "A. Smith wrote..." sits flush with it).
  let pageBaselineX = 0;
  {
    const xFreq = new Map();
    for (const ln of lines) {
      const x = ln.items[0]?.x;
      if (x === undefined) continue;
      const rounded = Math.round(x);
      xFreq.set(rounded, (xFreq.get(rounded) || 0) + 1);
    }
    let bestCount = 0;
    for (const [x, count] of xFreq) if (count > bestCount) { bestCount = count; pageBaselineX = x; }
  }

  // Same adaptive gap heuristic _p2wBuildParagraphs uses for visual-region
  // detection (js/processor.js's own _GAP_FACTOR/_MIN_GAP_PT), simplified
  // here to a single Y-band per gap rather than that function's full
  // render+ink-tightening refinement — a disclosed Stage 1 simplification
  // (see block comment above), not a correctness gap: the region still gets
  // captured as an image, just with a slightly looser crop box.
  const gapFactor = (() => {
    const t = Math.min(1, Math.max(0, (median - 8) / (14 - 8)));
    return 1.6 + t * (2.5 - 1.6);
  })();
  const gapThreshold = Math.max(20, median * gapFactor);

  const _isBoldHeadingLine = (items) => {
    if (!items.every(i => i.bold)) return false;
    const text = items.map(i => i.str).join('');
    if (MONEY_TOKEN_RE.test(text)) return false; // tabular/financial data, not a real heading
    const len = text.replace(/\s+/g, '').length;
    return len > 3 && len <= 100;
  };

  const textShapes   = [];
  const imageRegions = [];
  let buffer = []; // accumulates lines for the current text shape

  const flush = () => {
    if (!buffer.length) return;
    if (buffer.length === 1) {
      const raw = buffer[0].items.map(i => i.str).join('').trim();
      const t   = _normWatermark(raw);
      if (t === '' || repeatTextSet.has(t) || repeatPatternSet.has(_normDigits(t))) { buffer = []; return; }
    }
    const allItems = buffer.flatMap(ln => ln.items);
    const allText  = allItems.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
    if (!allText) { buffer = []; return; }
    const maxSize = Math.max(...allItems.map(i => i.fontSize));

    let heading = false;
    if (allText.length > 3) {
      if (maxSize >= median * 1.3) heading = true;
      else if (allText.length <= 100 && buffer.every(ln => _isBoldHeadingLine(ln.items))) heading = true;
    }

    const runs = buffer
      .map(ln => ({
        text:     ln.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim(),
        bold:     ln.items.every(i => i.bold),
        italic:   ln.items.every(i => i.italic),
        fontSize: Math.max(...ln.items.map(i => i.fontSize)),
        fontFace: ln.items.find(i => i.fontFamily)?.fontFamily,
      }))
      .filter(r => r.text);
    if (!runs.length) { buffer = []; return; }

    textShapes.push({
      x0: Math.min(...allItems.map(i => i.x)),
      x1: Math.max(...allItems.map(i => i.x + (i.width > 0 ? i.width : i.fontSize * i.str.length * 0.5))),
      y0: Math.max(...buffer.map(ln => ln.y)) + maxSize,
      y1: Math.min(...buffer.map(ln => ln.y)),
      runs, heading,
    });
    buffer = [];
  };

  // Gap scan BETWEEN consecutive text lines only — deliberately NOT
  // sentinel-padded from the page's top/bottom edge the way
  // _p2wBuildParagraphs's visualGaps is. That padding makes sense for a
  // flowing Word document (margins are just margins, never rendered as
  // literal blank page space), but a PPTX slide IS a literal fixed canvas —
  // ordinary, generous top/bottom margin whitespace (routine on real
  // slide-style source PDFs, not just report pages) would otherwise get
  // flagged as an "image region" and cropped into a pointless blank
  // picture. A genuine diagram sitting above the first line or below the
  // last line of a page with no other content is a real but rarer case,
  // deliberately left uncaptured here — a disclosed Stage 1 simplification.
  const _isHeadingSized = (ln) => Math.max(...ln.items.map(i => i.fontSize)) >= median * 1.3;
  for (let li = 0; li < lines.length - 1; li++) {
    if (lineToTable.has(li) || lineToTable.has(li + 1) || gridConsumedLines.has(li) || gridConsumedLines.has(li + 1)) continue;
    // A heading naturally carries extra leading space before/after it —
    // real, ordinary document structure, not evidence of a hidden diagram.
    // Without this, a normal heading-to-body gap (a large-font heading
    // directly followed by body text well below it) can exceed
    // gapThreshold on its own and get wrongly cropped as an image region.
    if (_isHeadingSized(lines[li]) || _isHeadingSized(lines[li + 1])) continue;
    const yAbove = lines[li].y, yBelow = lines[li + 1].y;
    if (yAbove - yBelow >= gapThreshold) imageRegions.push({ x0: xBounds.x0, x1: xBounds.x1, y0: yAbove, y1: yBelow });
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const ln  = lines[lineIdx];
    if (gridConsumedLines.has(lineIdx)) continue; // already emitted as a tableShape above
    const tbl = lineToTable.get(lineIdx);
    if (tbl) {
      flush();
      if (lineIdx === tbl.startIdx) {
        const tblLines = lines.slice(tbl.startIdx, tbl.endIdx + 1);
        // Per-cell font preservation, sourced from detectTables()'s own
        // parallel cellFonts[r][c] (matches competitor iLovePDF, whose real
        // TABLE shapes preserve font at the individual-cell-run level).
        tableShapes.push({
          x0: xBounds.x0, x1: xBounds.x1,
          y0: Math.max(...tblLines.map(l => l.y)) + median,
          y1: Math.min(...tblLines.map(l => l.y)) - median * 0.3,
          rows: tbl.rows.map((row, ri) => row.map((text, ci) => ({
            text: text || '', span: 1, bold: false, fontFace: tbl.cellFonts?.[ri]?.[ci],
          }))),
        });
      }
      continue;
    }

    // Page-number footer/header skip — same near-edge position proxy
    // (first/last 3 lines) _processLines already uses for this.
    const nearEdge = lineIdx < 3 || lineIdx >= lines.length - 3;
    if (nearEdge) {
      const raw = ln.items.map(i => i.str).join('').trim();
      if (/^\d+$/.test(raw) || repeatPatternSet.has(_normDigits(_normWatermark(raw)))) continue;
    }

    const lnRawText     = ln.items.map(i => i.str).join('').trim();
    const bulletMatch    = BULLET_RE.test(lnRawText);
    const numberedMatch  = !bulletMatch && NUMBERED_RE.test(lnRawText);
    const letteredMatch  = !bulletMatch && !numberedMatch && LETTERED_RE.test(lnRawText) &&
      (ln.items[0]?.x ?? 0) > pageBaselineX + 10;

    if (bulletMatch || letteredMatch || numberedMatch) {
      flush();
      const markerRe = bulletMatch ? BULLET_RE : letteredMatch ? LETTERED_RE : NUMBERED_RE;
      const text = lnRawText.replace(markerRe, '').trim();
      if (text) {
        const fontSize = Math.max(...ln.items.map(i => i.fontSize));
        textShapes.push({
          x0: Math.min(...ln.items.map(i => i.x)),
          x1: Math.max(...ln.items.map(i => i.x + (i.width > 0 ? i.width : i.fontSize * i.str.length * 0.5))),
          y0: ln.y + fontSize, y1: ln.y,
          runs: [{ text, bold: ln.items.every(i => i.bold), italic: ln.items.every(i => i.italic), fontSize,
                   fontFace: ln.items.find(i => i.fontFamily)?.fontFamily }],
          heading: false,
          // Lettered sub-items ("a."/"b.") render as bullet-style, not
          // pptxgenjs auto-numbering — they read as a nested list under a
          // numbered parent item, not their own independent 1/2/3 sequence.
          bullet: numberedMatch ? 'number' : 'bullet',
        });
      }
      continue;
    }

    if (buffer.length > 0) {
      const lastLn      = buffer[buffer.length - 1];
      const lastMaxFont = Math.max(...lastLn.items.map(i => i.fontSize));
      const curMaxFont  = Math.max(...ln.items.map(i => i.fontSize));
      const gap         = lastLn.y - ln.y;
      const lastIsHead  = lastMaxFont >= median * 1.3 || _isBoldHeadingLine(lastLn.items);
      const isHead      = curMaxFont  >= median * 1.3 || _isBoldHeadingLine(ln.items);
      if (isHead || lastIsHead || gap > lastMaxFont * 2.0) flush();
    }
    buffer.push(ln);
  }
  flush();

  return { textShapes, tableShapes, imageRegions };
}

// ── Stage 1-3 outer dispatcher: whole page, or once per detected column ────
// region — mirrors _p2wBuildParagraphs's own outer per-page loop (see that
// function's "Column-aware split" block) exactly: a straddling grid/table
// (spans across a column boundary) makes the page un-splittable, in which
// case it falls back to a single whole-page image region — never worse
// than pre-Stage-3 behavior. Otherwise each region gets its own
// _p2pBuildRegionShapes() call with region-scoped lines/grids/bounds, RTL-
// reversed via pageIsRtl() when the page reads right-to-left. A PPTX slide
// has no reading-order constraint (every shape carries its own absolute x/y
// — unlike a flowing Word document), so concatenating each region's shapes
// is correct with no interleaving step needed.
export function _p2pBuildSlideShapes(page, median, repeatTextSet, repeatPatternSet) {
  const { lines, pageW, pageH, borderGrids = [] } = page;
  if (!lines.length) return { textShapes: [], tableShapes: [], imageRegions: [], scanned: true };

  const regions = pageW ? detectColumnRegions(lines, pageW) : null;
  const splittable = regions && !borderGrids.some(g =>
    regions.filter(r => g.x < r.right && (g.x + g.w) > r.left).length > 1
  );

  if (!splittable) {
    if (regions) {
      // Column layout detected but a grid/table straddles a boundary — the
      // page can't be cleanly split. Whole page becomes one image region,
      // same fallback Stage 1/2 always used for every column page.
      return { textShapes: [], tableShapes: [], imageRegions: [{ x0: 0, x1: pageW, y0: pageH, y1: 0 }], scanned: false };
    }
    const result = _p2pBuildRegionShapes(lines, borderGrids, { x0: 0, x1: pageW }, median, repeatTextSet, repeatPatternSet);
    return { ...result, scanned: false };
  }

  const ordered = pageIsRtl(lines) ? [...regions].reverse() : regions;
  const textShapes = [], tableShapes = [], imageRegions = [];
  for (const region of ordered) {
    const inRegion = (it) => !!it && it.x >= region.left && it.x < region.right;
    // Filter ITEMS WITHIN each line, not whole lines by their first item —
    // the exact bug shipped fixed for pdf2word's own column handling
    // (commit 0cac6bda): a merged line's leftmost item is always the left
    // column's, so gating on it alone would route a still-merged line's
    // FULL content into whichever region contains its first item.
    const regionLines = lines
      .map(ln => ({ y: ln.y, items: ln.items.filter(inRegion) }))
      .filter(ln => ln.items.length);
    const regionGrids = borderGrids.filter(g => g.x >= region.left && (g.x + g.w) <= region.right);
    const result = _p2pBuildRegionShapes(
      regionLines, regionGrids, { x0: region.left, x1: region.right }, median, repeatTextSet, repeatPatternSet
    );
    textShapes.push(...result.textShapes);
    tableShapes.push(...result.tableShapes);
    imageRegions.push(...result.imageRegions);
  }
  return { textShapes, tableShapes, imageRegions, scanned: false };
}

// Crops a Y-band (full page width) out of an already-rendered page canvas
// and returns a PNG data URL. PNG (not the JPEG tiering the full-page image
// uses) — these crops are typically small (a table or diagram region, not a
// whole page), so the file-size cost of lossless output stays bounded, and
// it avoids JPEG block artifacts on what's often text-heavy table content.
export function _p2pCropCanvasRegion(sourceCanvas, xPx, yPx, wPx, hPx) {
  if (wPx <= 0 || hPx <= 0) return null;
  const clampedY = Math.max(0, Math.min(yPx, sourceCanvas.height - 1));
  const clampedH = Math.max(1, Math.min(hPx, sourceCanvas.height - clampedY));
  const temp = document.createElement('canvas');
  temp.width  = wPx;
  temp.height = clampedH;
  const tctx = temp.getContext('2d');
  tctx.drawImage(sourceCanvas, xPx, clampedY, wPx, clampedH, 0, 0, wPx, clampedH);
  const url = temp.toDataURL('image/png');
  temp.width = 0; temp.height = 0;
  return url;
}

// _isMostlyPUA/_rpBuildRegionBlocks/_rpBuildPageBlocks moved to
// js/pdf2readCore.js (imported above) — Read PDF's reflow block-builder,
// reused by packages/pdf2read-core/. _p2pCropCanvasRegion above stays here
// (real document.createElement('canvas') use — browser-only).

async function _runPdf2Ppt(filesSnapshot, { dpi = 150, mode = 'image' } = {}) {
  const file = filesSnapshot[0];
  if (!_checkSize(file, 150)) { _abortUI(); return; }

  setProgress(5, 'Loading libraries…');

  try {
    await loadPptxGenJs();
  } catch {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('pdf2ppt', 'PowerPoint library unavailable — check your internet connection.');
    return;
  }

  if (!window.pdfjsLib) {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('pdf2ppt', 'PDF engine not ready — reopen the tool.', 'renderer_not_loaded');
    return;
  }

  setProgress(8, 'Loading PDF…');

  let pdfDoc;
  try {
    const rawBuf = file._decryptedBuffer
      ? file._decryptedBuffer.slice(0)
      : await preprocessPdfBuffer(await file.arrayBuffer());
    pdfDoc = await window.pdfjsLib.getDocument({ isEvalSupported: false,
      data:              new Uint8Array(rawBuf),
      useSystemFonts:    false,
      verbosity:         0,
      disableJavaScript: true,
    }).promise;
  } catch (err) {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('pdf2ppt', err.message); return;
  }

  const pageCount = pdfDoc.numPages;

  // Slide size is fixed for the whole deck (.pptx format constraint) — derive
  // it from page 1 so the common case (uniform page size) renders at exact
  // source aspect ratio with no letterboxing.
  const firstPage = await pdfDoc.getPage(1);
  const vp1       = firstPage.getViewport({ scale: 1 });
  firstPage.cleanup?.();
  const layoutW = vp1.width  / 72;  // PDF points → inches
  const layoutH = vp1.height / 72;

  const pptx = new window.PptxGenJS();
  pptx.defineLayout({ name: 'PDF_PAGE', width: layoutW, height: layoutH });
  pptx.layout = 'PDF_PAGE';

  // Same quality tiering _p2wRenderImages() uses — lower JPEG quality on
  // large decks keeps peak RAM in check (pptxgenjs holds every slide's
  // image in memory until write()).
  const quality = pageCount > 300 ? 0.60 : pageCount > 150 ? 0.72 : 0.85;
  const scale   = dpi / 72;

  // "Editable text (beta)" mode: extract real structure ONCE for the whole
  // document up front, reusing pdf2word's own page-data pass (headings,
  // flat lists, tables, columns, footer suppression — see
  // _p2pBuildSlideShapes's own comment for exactly what's reused and what's
  // deliberately simplified for this first pass). This is a separate
  // pdf.js call (getTextContent+getOperatorList) from the per-page render
  // loop below (page.render, for the visual canvas) — not a redundant
  // re-parse of the same data, a genuinely different extraction.
  let textPageData = null, textMedian = 10, textRepeatSet = new Set(), textPatternSet = new Set();
  if (mode === 'text') {
    setProgress(8, 'Analyzing document structure…');
    ({ pageData: textPageData, median: textMedian, repeatTextSet: textRepeatSet,
       repeatPatternSet: textPatternSet } = await _p2wBuildPageData(pdfDoc, {
      onProgress:  (pct, label) => setProgress(pct, label),
      isCancelled: () => !isProcessing,
    }));
  }

  let canvas = document.createElement('canvas');
  const ctx  = canvas.getContext('2d', { willReadFrequently: true });

  try {
    let frameStart = performance.now();

    for (let p = 1; p <= pageCount; p++) {
      if (!isProcessing) break;
      setProgress(10 + Math.round((p / pageCount) * 80), `Rendering slide ${p}/${pageCount}…`);

      const page     = await pdfDoc.getPage(p);
      const viewport = page.getViewport({ scale });
      canvas.width   = Math.round(viewport.width);
      canvas.height  = Math.round(viewport.height);
      await page.render({ canvasContext: ctx, viewport }).promise;

      const pageHeightPt = viewport.height / scale; // undo the dpi/72 render scale, points

      // viewport is already this page's own size at scale=dpi/72, so
      // width/dpi and height/dpi recover its size in inches directly —
      // no extra getViewport({scale:1}) call needed.
      const pageW = viewport.width  / dpi;
      const pageH = viewport.height / dpi;
      const fit   = _p2pFitRect(pageW, pageH, layoutW, layoutH);

      const slide = pptx.addSlide();

      const shapes = (mode === 'text' && textPageData)
        ? _p2pBuildSlideShapes(textPageData[p - 1], textMedian, textRepeatSet, textPatternSet)
        : null;

      if (!shapes || shapes.scanned) {
        // Whole-page raster fallback — Image mode's own path (unchanged),
        // and Text mode's per-page fallback for a scanned/no-text page or a
        // multi-column page (Stage 1 scope, see _p2pBuildSlideShapes).
        // Must run before cleanup() — pulls from the same page object the
        // render just used. Always extracted here regardless of mode: a
        // scanned/multi-column page falling back to a raster slide in Text
        // mode should still get the same invisible search/copy layer Image
        // mode always provides — no reason to omit it just because the
        // OVERALL mode is 'text'.
        const textBlocks = await _p2pExtractTextBlocks(page);
        page.cleanup?.();

        // Tried using slide.background here for the common uniform-page-size
        // case (fit.scale === 1) instead of addImage, since pptxgenjs has no
        // lock/noSelect option for addImage and a real OOXML <p:bg> can't be
        // click-dragged the way a regular picture shape can. Verified against
        // the actual generated XML before keeping it, though — pptxgenjs
        // 3.12.0's slide.background silently emits the exact same <p:pic>
        // shape addImage would, not a <p:bg> element, so there was no locking
        // benefit to have. Reverted to always using the positioned addImage
        // path below (needed unconditionally anyway for the mixed-page-size
        // fit/letterbox fix — it's already correct for both cases).
        const fmt     = _p2wDetectFormat(canvas);
        const dataUrl = canvas.toDataURL(`image/${fmt}`, fmt === 'jpeg' ? quality : undefined);
        slide.addImage({ data: dataUrl, x: fit.x, y: fit.y, w: fit.w, h: fit.h });

        for (const block of textBlocks) {
          // PDF points, origin bottom-left → inches, origin top-left, then
          // through the same scale+offset the image itself was fit with, so
          // the invisible text stays aligned to the (possibly letterboxed)
          // image beneath it.
          const xIn    = block.x / 72;
          const yTopIn = (pageHeightPt - block.y - block.height) / 72;
          const wIn    = block.width  / 72;
          const hIn    = block.height / 72;

          slide.addText(block.text, {
            x: fit.x + xIn * fit.scale,
            y: fit.y + yTopIn * fit.scale,
            w: Math.max(0.05, wIn * fit.scale),
            h: Math.max(0.05, hIn * fit.scale),
            fontSize:    Math.max(1, block.fontSize * fit.scale),
            color:       '000000',
            transparency: 100,
            fill:        { type: 'none' },
            line:        { type: 'none' },
            margin:      0,
            wrap:        false,
          });
        }
      } else {
        // Real, positioned, formatted text shapes + cropped image regions
        // (tables/diagrams) — no whole-page background image at all here,
        // since the real text shapes already cover that same content;
        // adding the raster too would duplicate it underneath.
        page.cleanup?.();

        for (const shape of shapes.textShapes) {
          const xIn = shape.x0 / 72;
          const yTopIn = (pageHeightPt - shape.y0) / 72;
          const wIn = Math.max(0.1, (shape.x1 - shape.x0) / 72);
          const hIn = Math.max(0.1, (shape.y0 - shape.y1) / 72);

          const textRuns = shape.runs.map((r, i) => ({
            text: r.text + (i < shape.runs.length - 1 ? '\n' : ''),
            options: {
              bold:     r.bold,
              italic:   r.italic,
              fontSize: Math.max(1, Math.round(r.fontSize * fit.scale)),
              ...(r.fontFace ? { fontFace: r.fontFace } : {}),
            },
          }));

          const opts = {
            x: fit.x + xIn * fit.scale,
            y: fit.y + yTopIn * fit.scale,
            w: wIn * fit.scale,
            h: hIn * fit.scale,
            fontSize: Math.max(1, Math.round((shape.runs[0]?.fontSize ?? 12) * fit.scale)),
            color:    '000000',
            align:    'left',
            valign:   'top',
            margin:   0,
            wrap:     true,
          };
          // Preserve a genuinely serif/monospace source font (mapped to a
          // universally-installed PowerPoint equivalent by _pptxSafeFontFace,
          // js/processor.js) — real, competitor-verified gap: iLovePDF's own
          // editable-text output does this, pdfree previously emitted no
          // typeface at all, always falling back to PptxGenJS's own default.
          // Set at the paragraph level too (not just per-run) since a
          // single-run shape's own run-level fontFace can be overridden by
          // paragraph defaults in some pptxgenjs code paths.
          if (shape.runs[0]?.fontFace) opts.fontFace = shape.runs[0].fontFace;
          // pptxgenjs 3.12.0's own XML generator has a real bug: passing
          // `bullet: { type: 'bullet' }` silently produces NO bullet
          // character at all — its internal branch only fills in real XML
          // for `type: 'number'`; any other `.type` value falls through
          // every remaining branch as a no-op (verified directly against
          // the library's own bundled source, not assumed). `bullet: true`
          // (no `type` key) hits a DIFFERENT, working branch that emits the
          // library's own default bullet character correctly — used here
          // for bullet/lettered items; `{ type: 'number', ... }` is the one
          // shape.bullet value that genuinely needs the object form, and
          // does work as documented.
          if (shape.bullet === 'number') opts.bullet = { type: 'number' };
          else if (shape.bullet)         opts.bullet = true;
          slide.addText(textRuns, opts);
        }

        for (const tableShape of shapes.tableShapes) {
          const xIn = tableShape.x0 / 72;
          const yTopIn = (pageHeightPt - tableShape.y0) / 72;
          const wIn = Math.max(0.1, (tableShape.x1 - tableShape.x0) / 72);
          const hIn = Math.max(0.1, (tableShape.y0 - tableShape.y1) / 72);
          const fontSize = Math.max(1, Math.round(11 * fit.scale));

          const rows = tableShape.rows.map(row => row.map(cell => ({
            text: cell.text,
            options: {
              bold:     cell.bold,
              fontSize,
              colspan:  cell.span > 1 ? cell.span : undefined,
              ...(cell.fontFace ? { fontFace: cell.fontFace } : {}),
            },
          })));

          // pptxgenjs tables render with NO border by default (unlike
          // docx.js's own implicit table grid lines) — an explicit light
          // border keeps the reconstructed table visually usable rather
          // than looking like unaligned floating text. Confirmed directly
          // against the real generated OOXML before relying on it (see this
          // feature's own plan file).
          slide.addTable(rows, {
            x: fit.x + xIn * fit.scale,
            y: fit.y + yTopIn * fit.scale,
            w: wIn * fit.scale,
            h: hIn * fit.scale,
            fontSize,
            color:  '000000',
            border: { type: 'solid', color: 'D0D0D0', pt: 0.75 },
            autoPage: false,
          });
        }

        for (const region of shapes.imageRegions) {
          // x0/x1 are always real PDF-point bounds set by
          // _p2pBuildSlideShapes (full page width for a non-column page,
          // one column's own width for a Stage-3 column region) — a
          // diagram inside one column crops only that column's width, not
          // the whole page (which would otherwise pull in blank space or
          // the other column's content).
          const { x0, x1 } = region;
          const xLeftPx  = Math.round(x0 * scale);
          const xRightPx = Math.round(x1 * scale);
          const yTopPx = Math.round((pageHeightPt - region.y0) * scale);
          const yBotPx = Math.round((pageHeightPt - region.y1) * scale);
          const cropUrl = _p2pCropCanvasRegion(canvas, xLeftPx, yTopPx, xRightPx - xLeftPx, yBotPx - yTopPx);
          if (!cropUrl) continue;
          const xLeftIn = x0 / 72;
          const yTopIn  = (pageHeightPt - region.y0) / 72;
          const wIn     = Math.max(0.05, (x1 - x0) / 72);
          const hIn     = Math.max(0.05, (region.y0 - region.y1) / 72);
          slide.addImage({
            data: cropUrl,
            x: fit.x + xLeftIn * fit.scale, y: fit.y + yTopIn * fit.scale,
            w: wIn * fit.scale, h: hIn * fit.scale,
          });
        }
      }

      const now = performance.now();
      if (now - frameStart >= _FRAME_BUDGET_MS) {
        await _yieldToUI();
        frameStart = performance.now();
      }
    }
  } finally {
    canvas.width = 0; canvas.height = 0;
    canvas.remove(); canvas = null;
  }

  if (!isProcessing) return;

  setProgress(92, 'Building presentation…');

  const blob = await pptx.write({ outputType: 'blob' });
  const baseName = file.name.replace(/\.pdf$/i, '');
  const filename = `${baseName}.pptx`;
  const desc = `${pageCount} slide${pageCount !== 1 ? 's' : ''} · ${fmtSize(blob.size)}`;

  isProcessing = false;
  setFilesLocked(false);
  hideCancelBtn();
  setProgress(100, t('prog_done'));

  document.dispatchEvent(new CustomEvent('pdfree:success', {
    detail: { tool: 'pdf2ppt', blob, desc, filename }
  }));
}

// ── PDF → Markdown ───────────────────────────────────────────────
// Reuses pdf2word's line-grouping technique, font-size-ratio heading
// classifier (2.2×/1.7×/1.3× of median font size → H1/H2/H3, plus a
// same-size-but-bold fallback), watermark/page-number suppression, and —
// since the priority-2/3 fixes below — its column-split
// (_splitCrossColumnLines/detectColumnRegions) and commonObjs-based bold
// detection too. Simple tables ARE detected (detectTables()/
// looksLikeProseNotData(), shared with pdf2word) and rendered as real GFM
// pipe-table syntax. Images ARE extracted (_detectPageImages/
// _p2mdExtractImageBlob below) and referenced via ![](images/...) — output
// becomes a .zip (document.md + images/) instead of a plain .md the moment
// there's at least one image; see the pdf2md analysis in memory for the
// scope this shipped with (XObject images only, not inline/masked/rotated)
// and why. No longer "the lightest of the four PDF→Office/text tools" now
// that it has its own CDN-library (JSZip, image path only) and canvas-based
// image re-encoding step — that used to be true, isn't anymore.

// Formula-OCR callback handed to _p2mdExtractText's `ocrFormula` option —
// only constructed (and only ever lazy-loads the ~76MB Texo/FormulaNet
// engine) when the user has actually opted in via pdf2md's toggle, per
// _runPdf2Md below. Reuses the same progress bar pdf2md's own extraction
// already drives (getPct() returns the last real percentage that loop
// reported) rather than passing an undefined percent into setProgress,
// which would write an invalid "undefined%" CSS width — the bar's fill
// stays put at that percentage while a real download percentage (from
// transformers.js's own progress_callback: {status, file, progress,
// loaded, total} — confirmed directly from the library's real source,
// not assumed) drives the LABEL text, since a first-time ~76MB download
// is slow enough that "Loading formula recognition model…" alone left
// the user with no sense of whether it was working or stuck.
//
// Real failures (network, CORS/CSP, corrupt cache, inference error) are
// swallowed by pdf2mdCore.js's own try/catch around this callback — that
// is correct for THAT single formula (falls back to the existing image
// crop, unchanged), but the user was previously given no signal that
// anything went wrong at all. ocrFailures is bumped on every failure and
// surfaced once, after the whole document finishes, as a real toast (see
// _runPdf2Md below) rather than per-formula noise.
function _makeOcrFormulaCallback(getPct) {
  let modelReady = false;
  const state = { ocrFailures: 0 };
  state.fn = async (imageBlob) => {
    if (!modelReady) setProgress(getPct(), 'Loading formula recognition model…');
    const onModelProgress = modelReady ? undefined : (info) => {
      if (info?.status === 'progress' && typeof info.progress === 'number') {
        setProgress(getPct(), `Loading formula recognition model… ${Math.round(info.progress)}%`);
      }
    };
    try {
      const result = await recognizeFormula(imageBlob, onModelProgress);
      modelReady = true;
      return result;
    } catch (err) {
      // modelReady deliberately NOT set here — if the model genuinely never
      // finished loading, the NEXT formula candidate should still show real
      // loading progress on its own retry, not silently fail with no
      // feedback because a stale flag claimed it was already ready.
      state.ocrFailures++;
      throw err; // pdf2mdCore.js's own catch turns this into the existing image-crop fallback
    }
  };
  return state;
}

async function _runPdf2Md(filesSnapshot, { enableFormulaOcr = false } = {}) {
  const file = filesSnapshot[0];
  if (!_checkSize(file, 150)) { _abortUI(); return; }

  if (!window.pdfjsLib) {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('pdf2md', 'PDF engine not ready — reopen the tool.', 'renderer_not_loaded');
    return;
  }

  setProgress(8, 'Loading PDF…');

  let pdfDoc;
  try {
    const rawBuf = file._decryptedBuffer
      ? file._decryptedBuffer.slice(0)
      : await preprocessPdfBuffer(await file.arrayBuffer());
    pdfDoc = await window.pdfjsLib.getDocument({ isEvalSupported: false,
      data:              new Uint8Array(rawBuf),
      useSystemFonts:    false,
      verbosity:         0,
      disableJavaScript: true,
    }).promise;
  } catch (err) {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('pdf2md', err.message); return;
  }

  let blocks;
  let _ocrState = null;
  try {
    let _lastPct = 8;
    _ocrState = enableFormulaOcr ? _makeOcrFormulaCallback(() => _lastPct) : null;
    blocks = await _p2mdExtractText(pdfDoc, {
      onProgress:    (pct, label) => { _lastPct = pct; setProgress(pct, label); },
      isCancelled:   () => !isProcessing,
      canvasFactory: browserCanvasFactory,
      ocrFormula:    _ocrState?.fn,
    });
  } catch (err) {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('pdf2md', err.message); return;
  }

  if (!isProcessing) return;

  // Atlas structural check — same eri_core-derived scoring pdf2word already
  // surfaces (js/eriScoreMd.js, adapted for Markdown output — see its own
  // header for exactly what's reused vs. dropped from the DOCX version).
  // Best-effort, same pattern as pdf2word's own: a scoring failure never
  // blocks a conversion that already succeeded, atlasEri just stays null.
  let atlasEri = null;
  try {
    atlasEri = evaluateMarkdownStructural(blocks);
  } catch { /* ERI check is best-effort — see comment above */ }

  setProgress(92, 'Building Markdown…');

  const md       = _p2mdRender(blocks);
  const images   = blocks.filter(b => b.type === 'image' && b.blob);
  const baseName = file.name.replace(/\.pdf$/i, '');

  // Output contract: plain .md when there are no images (unchanged
  // behavior), .zip (document.md + images/*.png) when there are — same
  // "several files -> ZIP via JSZip" pattern _runSplit already uses, not a
  // new one invented for this tool. Base64-inlining images into the .md
  // directly was deliberately rejected: it would keep the single-file
  // simplicity but directly fights this tool's own AI/RAG-readiness goal —
  // base64 massively inflates token count, exactly the "noise" this tool
  // already goes out of its way to strip elsewhere (watermarks, page
  // numbers, repeated headers).
  let blob, filename;
  if (images.length) {
    setProgress(95, 'Packaging images…');
    await loadJSZip();
    const zip = new window.JSZip();
    zip.file('document.md', md);
    const imgFolder = zip.folder('images');
    for (const img of images) imgFolder.file(img.filename.replace(/^images\//, ''), img.blob);
    blob     = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    filename = `${baseName}.zip`;
  } else {
    blob     = new Blob([md], { type: 'text/markdown' });
    filename = `${baseName}.md`;
  }
  const desc = `${pdfDoc.numPages} page${pdfDoc.numPages !== 1 ? 's' : ''}` +
    (images.length ? ` · ${images.length} image${images.length !== 1 ? 's' : ''}` : '') +
    ` · ${fmtSize(blob.size)}`;

  isProcessing = false;
  setFilesLocked(false);
  hideCancelBtn();
  setProgress(100, t('prog_done'));

  document.dispatchEvent(new CustomEvent('pdfree:success', {
    detail: { tool: 'pdf2md', blob, desc, filename, atlasEri }
  }));

  // Real OCR failures (network/model/inference) are swallowed per-formula by
  // pdf2mdCore.js's own fallback — correct for that formula (unchanged image
  // crop), but the user previously had no signal anything went wrong at all.
  // Deliberately NOT shown immediately: app.js's own success handler (just
  // triggered above) fires an auto-download confirmation toast at +400ms for
  // ~3000ms (`download_toast`) that reuses the SAME #toast element — showing
  // this one right away would just get silently clobbered a moment later
  // (confirmed for real via Playwright: a forced-failure run correctly fell
  // back to the image crop, but the warning toast never became visible at
  // all before the download toast overwrote it). Anchored to THIS dispatch
  // point specifically, not to extraction finishing earlier in this
  // function — packaging (zip) time between the two would otherwise let the
  // ordering vary run to run.
  if (_ocrState?.ocrFailures > 0) {
    const failCount = _ocrState.ocrFailures;
    setTimeout(() => {
      showToast(tp(failCount, 'p2m_formula_ocr_fail_one', 'p2m_formula_ocr_fail_many', { n: failCount }), 6000);
    }, 4000);
  }
}

// Word (.docx) -> PDF, entirely client-side — see js/docxToPdfCore.js for
// the real conversion (docx-preview renders into DOM, walked into a
// pdfmake document definition -> real vector PDF, not a rasterized
// image). 60MB cap: generous for a real Word document (even one with
// several embedded images) while still guarding against something
// absurd hanging docx-preview's DOM rendering in the browser tab.
async function _runDocx2Pdf(filesSnapshot, _extraParams) {
  const file = filesSnapshot[0];
  if (!_checkSize(file, 60)) { _abortUI(); return; }

  setProgress(5, 'Reading document…');

  let blob;
  try {
    blob = await docxToPdf(file, {
      isCancelled: () => !isProcessing,
      onProgress:  (pct) => setProgress(pct, pct < 60 ? 'Reading document…' : 'Building PDF…'),
    });
  } catch (err) {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    if (err.message === 'cancelled') return; // isCancelled() bail — not a real error, no toast
    _handleError('docx2pdf', err.message); return;
  }

  if (!isProcessing) return;

  const filename = file.name.replace(/\.docx$/i, '.pdf');
  const desc = fmtSize(blob.size);

  isProcessing = false;
  setFilesLocked(false);
  hideCancelBtn();
  setProgress(100, t('prog_done'));

  document.dispatchEvent(new CustomEvent('pdfree:success', {
    detail: { tool: 'docx2pdf', blob, desc, filename }
  }));
}

// pdf2md's extraction/render core (_detectPageImages/_p2mdExtractImageBlob/
// _p2mdExtractText/_p2mdRender) moved to js/pdf2mdCore.js — browser-
// independent, reused by packages/pdf2md-core/ (standalone npm package).
// _runPdf2Md below is the thin browser orchestration wrapper that calls it.

// ── Unlock PDF ───────────────────────────────────────────────────
// Reuses the same QPDF WASM pipeline decryptPdf.js already runs silently
// (empty password) for every uploaded PDF — decryptWithPassword() ends up
// being the identical call with a user-supplied password. No new WASM
// module, no new dependency, no worker.js changes.

async function _runUnlock(filesSnapshot, { password } = {}) {
  const file = filesSnapshot[0];
  if (!_checkSize(file, 150)) { _abortUI(); return; }

  setProgress(20, 'Checking password…');

  let decrypted;
  try {
    if (file._decryptedBuffer) {
      // Already unlocked earlier (silent owner-only preflight in files.js,
      // or a prior Unlock run on this same file) — reuse it instead of a
      // redundant WASM round-trip.
      decrypted = new Uint8Array(file._decryptedBuffer.slice(0));
    } else {
      const bytes = new Uint8Array(await file.arrayBuffer());
      decrypted = await decryptWithPassword(bytes, password ?? '');
    }
  } catch (err) {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('unlock', err.message); return;
  }

  if (!decrypted) {
    isProcessing = false; setFilesLocked(false); hideCancelBtn();
    _handleError('unlock', t('err_unlock_wrong_password'), 'wrong_password');
    return;
  }

  if (!isProcessing) return;

  setProgress(95, 'Finalising…');

  // Cache onto the file object so switching to another tool (Compress,
  // Merge, OCR…) on this same file doesn't prompt for the password again.
  file._decryptedBuffer = decrypted.buffer;
  if (file._pdfMeta) file._pdfMeta.isEncrypted = false;

  const blob     = new Blob([decrypted], { type: 'application/pdf' });
  const baseName = file.name.replace(/\.pdf$/i, '');
  const filename = `${baseName}-unlocked.pdf`;
  const desc     = t('desc_unlock', { size: fmtSize(blob.size) });

  isProcessing = false;
  setFilesLocked(false);
  hideCancelBtn();
  setProgress(100, t('prog_done'));

  document.dispatchEvent(new CustomEvent('pdfree:success', {
    detail: { tool: 'unlock', blob, desc, filename }
  }));
}

// _visualRTLToLogical/_splitCrossColumnLines moved to textLayoutUtils.js
// (shared with pdf2md's core, js/pdf2mdCore.js).

// _p2wBuildPageData moved to js/pdf2readCore.js (imported above) so it can
// be reused outside the browser tool (packages/pdf2read-core/) without
// pulling in this file's own Worker orchestration / DOM progress+cancel UI —
// same reasoning as js/pdf2mdCore.js's own extraction. Text extraction: uses
// PDF.js getTextContent → builds docx paragraphs. Pass 1 (in pdf2readCore.js)
// parses the PDF into per-page line/text data (the expensive part — pdf.js
// getTextContent() + border-grid detection for every page). Returns data
// consumed by _p2wBuildParagraphs() below, which can be re-run cheaply on
// the same pageData without repeating this parse — see _runPdf2Word()'s
// ERI-scored table retry.

// Pass 2: builds Word paragraphs/tables from pageData already extracted by
// _p2wBuildPageData() — no PDF re-parsing, safe to call twice.
// useTables:false skips text-detected AND border-grid tables entirely (all
// their lines flow through the normal paragraph path instead) — used as the
// conservative fallback when the first attempt's tables look mis-detected.
export async function _p2wBuildParagraphs(pdfDoc, pageData, median, repeatTextSet, cs, { useTables = true, repeatPatternSet = new Set() } = {}) {
  const { Paragraph, TextRun, HeadingLevel,
          Table, TableRow, TableCell, WidthType, ImageRun } = window.docx;
  const _repeatTextSet    = repeatTextSet;
  const _repeatPatternSet = repeatPatternSet;
  const _cs = { ...cs, totalTables: 0, totalGapVisuals: 0, totalInlineVisuals: 0 };

  // Adaptive gap factor: linearly interpolates from 1.6 (small fonts / dense technical
  // PDFs) to 2.5 (large fonts / presentations) over the 8–14pt range.
  // Smaller factor → more sensitive gap detection for tight-spaced documents;
  // larger factor → avoids false positives on double-spaced or large-font layouts.
  const _GAP_FACTOR = (() => {
    const t = Math.min(1, Math.max(0, (median - 8) / (14 - 8)));
    return 1.6 + t * (2.5 - 1.6);
  })();
  const _MIN_GAP_PT = 20;    // minimum gap in PDF points (~0.28 inch); was 30 but
                              // CamScanner math PDFs have diagrams with tighter gaps

  // Builds a single-line Paragraph for a detected bullet/numbered list item,
  // marker stripped so Word's own bullet/numbering supplies it instead of
  // duplicating it as literal text. Flattens the line to one TextRun (bold
  // only when every item on the line is bold, matching _isBoldHeadingLine's
  // convention) rather than tracking per-item runs — list items are
  // overwhelmingly plain single-style text, and the string surgery needed to
  // strip a marker that may span or sit inside an item boundary makes
  // per-item run preservation not worth the complexity here.
  const _buildListParagraph = (ln, markerRe, listProps) => {
    const rawText = ln.items.map(i => i.str).join('');
    const text = rawText.replace(markerRe, '').trim();
    if (!text) return null;
    const bold   = ln.items.every(i => i.bold);
    const italic = ln.items.every(i => i.italic);
    const size   = Math.max(16, Math.round(Math.max(...ln.items.map(i => i.fontSize)) * 2));
    return new Paragraph({
      ...listProps,
      children: [new TextRun({ text, bold, italics: italic, size })],
      spacing: { after: 80 },
    });
  };

  const paragraphs  = [];
  const _paraBuffer = [];   // accumulates lines that should be merged into one Paragraph

  // Same-size-but-bold section headings are common in formal/legal PDFs —
  // found on a real 19-page contract where every heading (including the
  // document title) used the EXACT same point size as body text, only
  // distinguished by bold. The font-size-ratio check below never fires
  // there, silently merging headings into the preceding paragraph. Checking
  // the WHOLE line (not just some items) matters: inline emphasis like
  // "«Инвестиционный посредник»" is bold only within a longer non-bold
  // sentence, not a heading — a partial-line bold run must not qualify.
  const _isBoldHeadingLine = (items) => {
    if (!items.every(i => i.bold)) return false;
    const text = items.map(i => i.str).join('');
    if (MONEY_TOKEN_RE.test(text)) return false; // tabular/financial data, not a real heading
    const len = text.replace(/\s+/g, '').length;
    return len > 3 && len <= 100;
  };

  // Flushes the buffered lines as a single Paragraph, then clears the buffer.
  // Called before tables, grids, and at end of each page's event loop.
  const _flushPara = () => {
    if (!_paraBuffer.length) return;

    // Suppress repeated watermark / header / footer lines (e.g. "CamScanner").
    // Normalise with _normWatermark so that "CamScannerCamScanner" and "cs]"
    // variants also match the canonical form stored in _repeatTextSet.
    if (_paraBuffer.length === 1) {
      const t = _normWatermark(_paraBuffer[0].items.map(i => i.str).join('').trim());
      if (t === '' || _repeatTextSet.has(t)) { _paraBuffer.length = 0; return; }
    }

    const allText = _paraBuffer.flatMap(ln => ln.items).map(i => i.str).join('');
    const maxSize = Math.max(..._paraBuffer.flatMap(ln => ln.items.map(i => i.fontSize)));
    const hasRtl  = _paraBuffer.some(ln => ln.rtl);

    let heading;
    // Only promote to heading if the total text is long enough to be a real
    // heading. CamScanner OCR noise ("EE", "cs]") sometimes carries a large
    // fontSize on a 1–3 character fragment — that should stay as body text.
    const allTextTrimmed = allText.replace(/\s+/g, '');
    if (allTextTrimmed.length > 3) {
      if      (maxSize >= median * 2.2) heading = HeadingLevel.HEADING_1;
      else if (maxSize >= median * 1.7) heading = HeadingLevel.HEADING_2;
      else if (maxSize >= median * 1.3) heading = HeadingLevel.HEADING_3;
      else if (allTextTrimmed.length <= 100 && _paraBuffer.every(ln => _isBoldHeadingLine(ln.items))) {
        // No font-size jump, but every line is entirely bold — same-size-bold
        // section titles (see _isBoldHeadingLine above). All-caps gets the
        // higher level, matching how these documents actually distinguish
        // top-level sections ("ФОРС-МАЖОР") from sub-labels ("Клиент не вправе:").
        const letters    = allText.replace(/[^\p{L}]/gu, '');
        const isAllCaps  = letters.length > 0 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
        heading = isAllCaps ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2;
      }
    }

    const runs = [];
    for (let li = 0; li < _paraBuffer.length; li++) {
      const ln = _paraBuffer[li];
      for (let idx = 0; idx < ln.items.length; idx++) {
        const item = ln.items[idx];
        const prev = ln.items[idx - 1];

        const text0 = item.str;
        let text = text0;

        if (idx === 0 && li > 0) {
          // First item of a continuation line: insert space at the boundary if neither
          // side already has one (fixes word merging across RTL and LTR line wraps).
          const prevLn  = _paraBuffer[li - 1];
          const lastStr = prevLn.items[prevLn.items.length - 1]?.str ?? '';
          if (!lastStr.endsWith(' ') && !text0.startsWith(' ')) {
            text = ' ' + text;
          }
        } else if (prev && !ln.rtl && !prev.str.endsWith(' ') && !text0.startsWith(' ')) {
          // LTR only: gap-based space insertion within the same line
          const prevW = (prev.width > 0) ? prev.width : prev.fontSize * prev.str.length * 0.5;
          const gap   = item.x - (prev.x + prevW);
          // Devanagari (Hindi) spaces are narrower — use 10% of fontSize instead of 20%
          const thr   = (_isDevanagari(prev.str) || _isDevanagari(text0))
            ? item.fontSize * 0.1 : item.fontSize * 0.2;
          if (gap > thr) text = ' ' + text;
        }
        runs.push(new TextRun({
          text,
          bold:    item.bold,
          italics: item.italic,
          size:    Math.max(16, Math.round(item.fontSize * 2)),
        }));
      }
    }

    const hasCjk = _isCjk(allText);
    paragraphs.push(new Paragraph({
      ...(heading !== undefined ? { heading } : {}),
      ...(hasRtl ? { bidirectional: true } : {}),
      children: runs,
      // CJK paragraphs: zero spacing so merged lines don't overflow DOCX pages
      spacing:  { after: hasCjk ? 0 : 80 },
    }));

    _paraBuffer.length = 0;
  };

  // ── Column-aware per-page body ────────────────────────────────────────────
  // Extracted so it can run once per detected column region
  // (js/pdf2wordColumns.js) instead of once per page. Everything below is
  // relative to its own `lines` parameter (lineIdx, consumedLines, etc.),
  // never a page-global index, so calling it multiple times per page — once
  // per column — is safe without any further change to the logic itself.
  // `textItems` intentionally stays the FULL page's items even when
  // processing a single column: _p2wRenderAllVisuals's "subtract known
  // text — what's left is a visual" logic needs to see the WHOLE page's
  // text, or it would misread the OTHER (not-yet-processed-in-this-call)
  // column's text as an inline visual while processing this one.
  async function _processLines(pi, lines, rotatedItems, borderGrids, textItems, pageH) {
    setProgress(50 + Math.round((pi / pageData.length) * 40),
                `Building page ${pi + 1}/${pageData.length}…`);

    // Baseline left margin for THIS lines set (whole page, or one column
    // region after a column split) — the most common first-item X. Used
    // below to gate lettered sub-list detection (LETTERED_RE): a line only
    // counts as a lettered list marker when it's indented past this
    // baseline, which is what separates a real sub-item from a false
    // positive like "A. Smith wrote the report." sitting flush with
    // ordinary body text.
    let pageBaselineX = 0;
    {
      const xFreq = new Map();
      for (const ln of lines) {
        const x = ln.items[0]?.x;
        if (x === undefined) continue;
        const rounded = Math.round(x);
        xFreq.set(rounded, (xFreq.get(rounded) || 0) + 1);
      }
      let bestCount = 0;
      for (const [x, count] of xFreq) {
        if (count > bestCount) { bestCount = count; pageBaselineX = x; }
      }
    }

    // Detect tables on this page (skipped entirely in the conservative retry —
    // useTables:false means every line below falls through to the normal
    // paragraph path instead of becoming a Table).
    // Filtered through looksLikeProseNotData() + looksLikeEnumeratedList()
    // (pdf2wordTables.js): a real 19-page contract had detectTables() emit 3
    // false-positive "tables" that were actually numbered legal clause lists
    // (clause number in column 1, clause prose in column 2 — e.g. "5.11. |
    // а) при биржевых торгах..."), plus one more from two unrelated text
    // blocks (a wrapped address + a label/value signature block) that
    // happened to align by X-coordinate. pdf2md already gates on
    // looksLikeProseNotData for the same reason (no post-build check to
    // catch it downstream there); pdf2word has a post-build ERI retry
    // (_ERI_TABLE_RETRY_THRESHOLD below) but that only rebuilds the WHOLE
    // document tables-free on a bad aggregate score — too blunt to fix
    // individual false positives sitting next to genuinely good tables.
    // Text-detected tables that Y-overlap a border grid are dropped in favor
    // of the grid — border grids carry real merge/span line data
    // (colDividers) that pure X-position clustering can never recover (a
    // merged cell just looks like "an item missing from this column" to
    // detectTables(), indistinguishable from ordinary sparse/optional data).
    // This precedence gap was always latent but only surfaced once
    // detectTables()'s _columnAlignScore stopped over-penalizing legitimately
    // sparse rows (see its own comment) — before that fix, a row genuinely
    // missing a column-grid's merged cell's "item" was ALSO usually rejected
    // outright by the old stricter scoring, so this conflict never fired in
    // practice. Confirmed via tests/pdf2wordParagraphs.test.js's real
    // gridSpan-merge regression test, which failed without this filter.
    const tables = useTables
      ? detectTables(lines)
          .filter(t => !looksLikeProseNotData(t.rows) && !looksLikeEnumeratedList(t.rows))
          .filter(t => {
            const tMinY = Math.min(lines[t.startIdx].y, lines[t.endIdx].y);
            const tMaxY = Math.max(lines[t.startIdx].y, lines[t.endIdx].y);
            return !borderGrids.some(g => tMinY <= g.y + g.h && g.y <= tMaxY);
          })
      : [];

    // Build set: lineIdx → table object (for O(1) lookup)
    const lineToTable = new Map();
    for (const t of tables) {
      for (let li = t.startIdx; li <= t.endIdx; li++) {
        lineToTable.set(li, t);
      }
    }

    // ── Gap detection: find vertical gaps between text lines that likely contain
    // diagrams, grids, or other vector graphics not captured by text extraction.
    // Sentinel nodes at pageH (top) and 0 (bottom) extend the same gap logic to
    // diagrams at page edges without special-casing — classic sentinel pattern.
    const gapThreshold = Math.max(_MIN_GAP_PT, median * _GAP_FACTOR);
    const visualGaps   = [];
    const gapLines     = [{ y: pageH }, ...lines, { y: 0 }];
    for (let si = 0; si < gapLines.length - 1; si++) {
      const yAbove = gapLines[si].y;
      const yBelow = gapLines[si + 1].y;
      // si maps to original line index as: liA = si-1, liB = si
      // (si=0 is the top sentinel → liA=-1; si=N+1 is bottom → liB=N)
      const liA = si - 1;
      const liB = si;
      if ((liA >= 0 && lineToTable.has(liA)) || (liB < lines.length && lineToTable.has(liB))) continue;
      if (yAbove - yBelow < gapThreshold) continue;
      // Skip if a border grid already covers this gap — it will be rendered as a
      // Word Table by the 'grid' event handler; inserting an ImageRun here too
      // would duplicate the same content in the DOCX output. When useTables is
      // false, grids are never rendered as tables, so this region must be free
      // to become a visual-gap image instead — otherwise it's silently dropped.
      const coveredByGrid = useTables && borderGrids.some(g =>
        (g.y + g.h) <= yAbove + 10 && g.y >= yBelow - 10
      );
      if (!coveredByGrid) visualGaps.push({ yAbove, yBelow });
    }
    // Render page once and crop image regions for detected gaps and inline visuals.
    // .catch() degrades gracefully — rest of the document is still produced.
    const gapRunsArr  = [];
    const inlineVisuals = [];
    if (visualGaps.length > 0 && isProcessing) {
      setProgress(
        50 + Math.round((pi / pageData.length) * 40),
        `Capturing visuals on page ${pi + 1}/${pageData.length}…`,
      );
      const { gapRuns, inlineRuns } = await _p2wRenderAllVisuals(
        pdfDoc, pi + 1, pageH, visualGaps, textItems,
        borderGrids, median, ImageRun,
      ).catch(() => ({ gapRuns: [], inlineRuns: [] }));
      gapRunsArr.push(...gapRuns);
      inlineVisuals.push(...inlineRuns);
    }

    // Accumulate confidence stats from Pass 2
    _cs.totalTables        += tables.length;
    _cs.totalGapVisuals    += gapRunsArr.length;
    _cs.totalInlineVisuals += inlineVisuals.length;

    // Match rotated column-header items to tables by Y-range overlap.
    // rotatedHeaders: tableStartIdx → array of column label strings (left-to-right).
    const rotatedHeaders = new Map();
    if (rotatedItems.length > 0) {
      const groups = _p2wGroupRotated(rotatedItems);
      for (const t of tables) {
        const tYBottom = lines[t.endIdx].y;
        const tYTop    = lines[t.startIdx].y;
        const matched  = groups.filter(g => {
          const ys   = g.items.map(i => i.y);
          const gMin = Math.min(...ys);
          const gMax = Math.max(...ys);
          return gMax >= tYBottom - 20 && gMin <= tYTop + 50;
        });
        if (matched.length >= 2) rotatedHeaders.set(t.startIdx, matched.map(g => g.text));
      }
    }

    // ── Build combined event list: text lines + border-detected grids ─────────
    // Text-based detector misses tables whose body rows are completely empty
    // (no text content at all). Border grids fill that gap.

    const events = lines.map((ln, lineIdx) => ({ type: 'line', y: ln.y, lineIdx }));

    // Add border grids that aren't already covered by a text-detected table.
    // Skipped when useTables is false — grid lines instead flow through as
    // ordinary 'line' events (already in `events` above) and become plain
    // paragraphs; the visual-gap logic above picks up their empty regions.
    if (useTables) {
      const textYRanges = tables.map(t => ({
        minY: lines[t.endIdx].y, maxY: lines[t.startIdx].y,
      }));
      for (const grid of borderGrids) {
        const covered = textYRanges.some(r =>
          (grid.y + grid.h) >= r.minY - 20 && grid.y <= r.maxY + 20
        );
        if (!covered) events.push({ type: 'grid', y: grid.y + grid.h, grid });
      }
    }

    // Add visual region events for detected diagram/graphic gaps.
    // Event Y = yAbove - 0.1: fires just after the text line above the gap
    // (or at pageH - 0.1 for top-of-page sentinel gaps).
    for (const { yAbove, imgRun } of gapRunsArr) {
      events.push({ type: 'visual-region', y: yAbove - 0.1, imgRun });
    }
    // Add inline visual events (render-and-subtract regions — catches raster
    // XObjects AND vector charts not separated by large enough gaps)
    for (const { pdfY, imgRun } of inlineVisuals) {
      events.push({ type: 'visual-region', y: pdfY, imgRun });
    }

    // Sort by Y descending (top of page first).
    // At equal Y, grid events come before line events so header lines are
    // consumed before being emitted as standalone paragraphs.
    events.sort((a, b) => {
      if (b.y !== a.y) return b.y - a.y;
      if (a.type === 'grid' && b.type !== 'grid') return -1;
      if (b.type === 'grid' && a.type !== 'grid') return  1;
      return 0;
    });

    const consumedLines = new Set();

    for (const event of events) {
      if (!isProcessing) break;

      if (event.type === 'line') {
        const { lineIdx } = event;
        if (consumedLines.has(lineIdx)) continue;

        const tbl = lineToTable.get(lineIdx);

        if (tbl && lineIdx === tbl.startIdx) {
          _flushPara();   // emit any buffered paragraph before the table
          // ── Emit rotated column headers (if any) above the table ──────────
          const hdrTexts = rotatedHeaders.get(tbl.startIdx);
          if (hdrTexts) {
            paragraphs.push(new Paragraph({
              children: hdrTexts.flatMap((txt, i) => [
                ...(i > 0 ? [new TextRun({ text: ' │ ', color: 'AAAAAA' })] : []),
                new TextRun({ text: txt, bold: true }),
              ]),
              spacing: { before: 60, after: 40 },
            }));
          }

          // ── Emit docx Table ───────────────────────────────────────────────
          paragraphs.push(new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: tbl.rows.map(row =>
              new TableRow({
                children: row.map(cellText =>
                  new TableCell({
                    children: [new Paragraph({
                      children: [new TextRun({ text: cellText || '' })],
                      spacing: { after: 0 },
                    })],
                  })
                ),
              })
            ),
          }));
          paragraphs.push(new Paragraph({ children: [], spacing: { after: 120 } }));

          // Mark all lines in this table consumed
          for (let li2 = tbl.startIdx; li2 <= tbl.endIdx; li2++) consumedLines.add(li2);

        } else if (tbl) {
          consumedLines.add(lineIdx); // inner table line — already handled

        } else {
          // ── Buffer this line; flush when a paragraph break is detected ─────
          // A paragraph break occurs when:
          //   • the Y gap is larger than 2.0 × the previous line's font size
          //     (handles 1.5× line-spaced PDFs where gap ≈ 1.5×fontSize;
          //      was 1.5× which caused word-wrapped Cyrillic lines to not merge)
          //   • either the buffered or incoming line is a heading (large font)
          //     — headings must never merge with adjacent body lines
          const ln      = lines[lineIdx];

          // Skip embedded page numbers: a line in the bottom region of the page
          // (last 3 lines) that contains only a pure integer. Checking only the
          // very last line missed cases where the CamScanner watermark line is
          // below the page number, making the number the second-to-last line.
          if (lineIdx >= lines.length - 3 && ln.items.length === 1 && !lineToTable.has(lineIdx)) {
            const t = ln.items[0].str.trim();
            if (/^\d+$/.test(t)) continue;
          }

          // Skip variable page-number footers/headers ("Page 1 of 4", "1/4",
          // "- 4 -", ...): near the top or bottom of the page (first/last 3
          // lines, same edge proxy as the bare-integer check above) AND
          // already confirmed to recur across most pages once its own digits
          // are normalized away (_repeatPatternSet, built in
          // _p2wBuildPageData — see that block's own comment for why the
          // recurrence check keeps this safe for a genuinely one-off body
          // line that happens to contain a number).
          if ((lineIdx < 3 || lineIdx >= lines.length - 3) && !lineToTable.has(lineIdx)) {
            const raw = ln.items.map(i => i.str).join('').trim();
            if (_repeatPatternSet.has(_normDigits(_normWatermark(raw)))) continue;
          }

          const maxFont = Math.max(...ln.items.map(i => i.fontSize));
          const isHead  = maxFont >= median * 1.3 || _isBoldHeadingLine(ln.items);

          // List items never merge into the surrounding paragraph, and get
          // real Word list formatting (native bullet, or auto-numbering for
          // flat "1./2./3." markers) instead of the marker surviving as
          // literal text — same "never merge" treatment headings already get.
          //
          // Exception: a numbered line that ALSO reads as a heading (bold or
          // a real font-size jump — same isHead signal used just above/below)
          // is kept as a heading instead, "1. " prefix and all, so it falls
          // through to the normal buffering path below. A numbered SECTION
          // TITLE ("1. Scope of Work") should stay a heading; a numbered
          // ITEM in body text ("1. Bring photo ID") should still become a
          // real Word list. Bullets are left alone — a bulleted heading is
          // not a real-world pattern worth the extra branch.
          const lnRawText     = ln.items.map(i => i.str).join('').trim();
          const bulletMatch   = BULLET_RE.test(lnRawText);
          const numberedMatch = !bulletMatch && NUMBERED_RE.test(lnRawText);
          // Lettered sub-item ("a.", "b)") — only when ALSO indented past
          // this region's baseline left margin (pageBaselineX above). See
          // LETTERED_RE's own comment (textLayoutUtils.js) for why the
          // indent requirement is what makes this safe to detect at all.
          const letteredMatch = !bulletMatch && !numberedMatch && LETTERED_RE.test(lnRawText) &&
            (ln.items[0]?.x ?? 0) > pageBaselineX + 10;
          if (bulletMatch || letteredMatch || (numberedMatch && !isHead)) {
            _flushPara();
            const p = bulletMatch
              ? _buildListParagraph(ln, BULLET_RE, { bullet: { level: 0 } })
              : letteredMatch
              ? _buildListParagraph(ln, LETTERED_RE, { bullet: { level: 0 } })
              : _buildListParagraph(ln, NUMBERED_RE, { numbering: { reference: _P2W_NUMBERED_LIST_REF, level: 0 } });
            if (p) paragraphs.push(p);
            continue;
          }

          if (_paraBuffer.length > 0) {
            const lastLn      = _paraBuffer[_paraBuffer.length - 1];
            const lastMaxFont = Math.max(...lastLn.items.map(i => i.fontSize));
            const gap         = lastLn.y - ln.y;
            const lastIsHead  = lastMaxFont >= median * 1.3 || _isBoldHeadingLine(lastLn.items);

            // CJK PDFs often use 2.0×–2.5× line spacing, so a fixed 2.0× threshold
            // incorrectly splits word-wrapped lines into separate paragraphs.
            // Use a looser threshold when the previous CJK line does NOT end with
            // sentence-ending punctuation (indicating word wrap, not a paragraph break).
            // If it DOES end with 。！？ it's likely the last line of a paragraph → keep 2.0×.
            const lastText       = lastLn.items.map(i => i.str).join('');
            const lastIsCjk      = _isCjk(lastText);
            const lastIsRtl      = lastLn.rtl;
            const lastEndsSent   = /[。！？…]$/.test(lastText.trimEnd());
            const mergeThreshold = (lastIsCjk && !lastEndsSent)
              ? lastMaxFont * 3.5   // CJK continuation line — absorb generous leading
              : lastIsRtl
              ? lastMaxFont * 1.3   // RTL (Arabic/Hebrew): paragraph gaps are typically
                                    // 1.5×+ fontSize, line spacing ~1.0–1.2× — split earlier
              : lastMaxFont * 2.0;  // LTR/Cyrillic — conservative merge

            if (isHead || lastIsHead || gap > mergeThreshold) _flushPara();
          }
          _paraBuffer.push(ln);
        }

      } else if (event.type === 'visual-region') {
        // ── Visual region: diagram/graphic captured from canvas crop ──────────
        _flushPara();
        paragraphs.push(new Paragraph({
          children: [event.imgRun],
          spacing:  { before: 60, after: 60 },
        }));

      } else {
        // ── 'grid' event: border-detected table ────────────────────────────────
        // Originally only ever fed empty template forms (blank rows, header
        // text only), hence "hdrLines" below. Since detectTableGrids() can now
        // also find merged-cell tables that carry real body text (see
        // pdf2wordBorders.js), this same path may receive dozens of populated
        // lines — only the FIRST is a genuine header, the rest are data rows
        // and must not all render bold.
        _flushPara();   // emit any buffered paragraph before the grid
        const { grid } = event;

        // Consume text lines inside the grid's Y range → become table row(s)
        const hdrLines = [];
        for (let li2 = 0; li2 < lines.length; li2++) {
          const ln = lines[li2];
          if (!consumedLines.has(li2) && !lineToTable.has(li2) &&
              ln.y >= grid.y - 4 && ln.y <= grid.y + grid.h + 4) {
            hdrLines.push(ln);
            consumedLines.add(li2);
          }
        }
        hdrLines.sort((a, b) => b.y - a.y); // top first

        // Distribute each line's items across columns by X position; only
        // the first line is treated as a header (bold). Cells whose divider
        // is missing for THIS row (grid.colDividers, via
        // _activeDividersForY) are merged into a real docx columnSpan
        // instead of silently becoming an empty neighboring cell.
        const gridRows = hdrLines.map((ln, idx) => {
          const rawCells      = _assignLineToGridCols(ln.items, grid.colXs);
          const activeDivider = _activeDividersForY(grid, ln.y);
          const cellGroups    = _groupGridCellsWithSpans(rawCells, activeDivider);
          return new TableRow({
            children: cellGroups.map(({ text, span }) =>
              new TableCell({
                ...(span > 1 ? { columnSpan: span } : {}),
                children: [new Paragraph({
                  children: [new TextRun({ text, bold: idx === 0 })],
                  spacing: { after: 0 },
                })],
              })
            ),
          });
        });

        // Empty body rows
        const emptyCount = Math.max(0, grid.rowCount - hdrLines.length);
        for (let r = 0; r < emptyCount; r++) {
          gridRows.push(new TableRow({
            children: Array.from({ length: grid.colCount }, () =>
              new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: '' })], spacing: { after: 0 } })],
              })
            ),
          }));
        }

        if (gridRows.length > 0) {
          paragraphs.push(new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: gridRows,
          }));
          paragraphs.push(new Paragraph({ children: [], spacing: { after: 120 } }));
        }
      }
    }
    _flushPara();   // flush last paragraph at end of each page's content (or column's, when split)
  }

  // ── Outer per-page loop: dispatches to _processLines once (no columns
  // detected — the common case) or once per detected column region ────────
  for (let pi = 0; pi < pageData.length; pi++) {
    if (!isProcessing) break;

    if (pi > 0) {
      paragraphs.push(new Paragraph({ children: [], pageBreakBefore: true }));
    }

    const { lines, rotatedItems, borderGrids, items: textItems, pageH, pageW } = pageData[pi];

    // Pages with no extractable text (diagram-only pages in scanned PDFs):
    // render the full page as a single ImageRun so content is not lost.
    if (!lines.length) {
      if (isProcessing) {
        const imgRun = await _p2wRenderFullPage(pdfDoc, pi + 1, ImageRun).catch(() => null);
        if (imgRun) {
          paragraphs.push(new Paragraph({
            children: [imgRun],
            spacing:  { before: 60, after: 60 },
          }));
        }
      }
      continue;
    }

    // ── Column-aware split ────────────────────────────────────────────────
    // "Prefer false negatives": detectColumnRegions() already returns null
    // for anything short of confident multi-column evidence. On top of
    // that, a table/grid whose own footprint spans ACROSS a detected column
    // boundary (a wide results table in an otherwise 2-column paper, e.g.)
    // means the page can't be cleanly split at all — fall back to today's
    // single, unsplit pass rather than attempt to split a structure that
    // straddles the boundary. A page that can't be split cleanly should
    // stay exactly as accurate as it already is, not get worse.
    const regions = pageW ? detectColumnRegions(lines, pageW) : null;
    const splittable = regions && !borderGrids.some(g =>
      regions.filter(r => g.x < r.right && (g.x + g.w) > r.left).length > 1
    );

    if (!splittable) {
      await _processLines(pi, lines, rotatedItems, borderGrids, textItems, pageH);
    } else {
      // RTL pages read their rightmost column first — a page-level signal
      // (majority of the page's own lines), entirely separate from the
      // existing per-line BiDi text shaping, which is untouched.
      const ordered = pageIsRtl(lines) ? [...regions].reverse() : regions;
      for (const region of ordered) {
        if (!isProcessing) break;
        const inRegion = (it) => !!it && it.x >= region.left && it.x < region.right;
        // Filter ITEMS WITHIN each line, not whole lines by their first item.
        // In the normal case _splitCrossColumnLines() (textLayoutUtils.js,
        // called from _p2wBuildPageData before this pass ever runs) has
        // already re-split every Y-merged line into clean single-region
        // lines using this SAME detectColumnRegions() call, so by the time
        // this loop runs, ln.items[0] alone is usually enough. But that
        // pre-split is itself keyed to detectColumnRegions() returning the
        // same regions both times — gating on just the first item here has
        // no upside over filtering the line's own items and is one
        // incorrect edge case away from silently routing a still-merged
        // line's FULL content (both columns concatenated) into whichever
        // region contains its leftmost item, and leaving the other region's
        // pass empty for that row. Filtering items directly costs nothing
        // and stays correct even if that invariant ever breaks.
        const colLines = lines
          .map(ln => ({ y: ln.y, items: ln.items.filter(inRegion) }))
          .filter(ln => ln.items.length);
        const colRotatedItems = rotatedItems.filter(inRegion);
        const colBorderGrids  = borderGrids.filter(g => g.x >= region.left && (g.x + g.w) <= region.right);
        await _processLines(pi, colLines, colRotatedItems, colBorderGrids, textItems, pageH);
      }
    }
  }

  return { paragraphs, cs: _cs };
}

// Computes a confidence score from accumulated conversion stats.
// Returns { score, level, detected, warnings } for UI display.
export function _p2wConfidence(cs, medianFontSize) {
  let score = 100;
  const detected = [];
  const warnings = [];

  // Positive findings (shown regardless of score)
  detected.push(`${cs.totalPages} page${cs.totalPages !== 1 ? 's' : ''}`);
  if (cs.totalTables > 0)
    detected.push(`${cs.totalTables} table${cs.totalTables !== 1 ? 's' : ''}`);
  const totalVisuals = cs.totalGapVisuals + cs.totalInlineVisuals;
  if (totalVisuals > 0)
    detected.push(`${totalVisuals} diagram${totalVisuals !== 1 ? 's' : ''}/image${totalVisuals !== 1 ? 's' : ''}`);

  // Penalty: scanned pages (no text layer)
  if (cs.fullPageFallbacks > 0) {
    score -= Math.round(Math.min(50, (cs.fullPageFallbacks / cs.totalPages) * 60));
    warnings.push('Scanned pages — text layer missing');
  }

  // Penalty: mathematical formulas (Greek + math operator Unicode blocks)
  if (cs.totalChars > 0 && cs.mathChars / cs.totalChars > 0.03) {
    score -= 25;
    warnings.push('Mathematical formulas may not convert accurately');
  }

  // Penalty: very small fonts → unreliable line grouping
  if (medianFontSize < 9) {
    score -= 10;
    warnings.push('Small fonts — text grouping may be imprecise');
  }

  // Penalty: heavy RTL content (BiDi is handled but not perfectly)
  if (cs.totalLines > 0 && cs.rtlLines / cs.totalLines > 0.3) {
    score -= 10;
    warnings.push('Right-to-left text — layout may vary in Word');
  }

  // Penalty: dense inline visuals (strip-scan may produce false positives)
  if (cs.totalInlineVisuals > 5) {
    score -= 5;
    warnings.push('Dense visual content — some elements may shift');
  }

  score = Math.max(0, Math.min(100, score));
  const level = score >= 80 ? 'high' : score >= 55 ? 'medium' : 'low';
  return { score, level, detected, warnings };
}

// Groups rotated text items (vertical column headers) by X-coordinate proximity.
// Returns clusters sorted left-to-right; each cluster's items are sorted
// top-to-bottom (descending Y) to reconstruct natural reading order.
function _p2wGroupRotated(items, xTol = 20) {
  const groups = [];
  for (const item of items) {
    let best = null, bestDist = Infinity;
    for (const g of groups) {
      const d = Math.abs(g.cx - item.x);
      if (d < bestDist) { bestDist = d; best = g; }
    }
    if (best && bestDist <= xTol) {
      best.items.push(item);
      best.cx = best.items.reduce((s, i) => s + i.x, 0) / best.items.length;
    } else {
      groups.push({ cx: item.x, items: [item] });
    }
  }
  groups.sort((a, b) => a.cx - b.cx);
  for (const g of groups) {
    g.items.sort((a, b) => b.y - a.y);
    g.text = g.items.map(i => i.str).join('');
  }
  return groups;
}

// Distributes text items in a line across grid columns by X position.
// colXs: sorted array of column boundary X values [x0, x1, x2, ...].
// Returns string[] with one entry per column interval.
//
// GRID_SLACK is intentionally small (not the full border-detection SNAP=4
// px from pdf2wordBorders.js): colXs values are snapped to a 4px grid, so
// an item's "true" boundary can be off by up to SNAP/2=2px from rounding —
// that's the only slack genuinely needed here. A ±4px slack (the SNAP
// value itself) was tried first and found to double-count near each
// boundary: real left-aligned cell text often starts only ~5px past its
// OWN column's left edge (completely normal — e.g. a synthetic report
// fixture with "Kategorie" drawn 5px right of a divider at x=164 still
// landed at x=167, just 3px past the boundary), and a ±4px zone on both
// sides of that boundary swallowed it back into the PREVIOUS column
// instead. This barely mattered while grids only ever held near-empty
// template rows (this function's original use case), but now that
// pdf2wordBorders.js can also detect real, densely-populated merged-cell
// tables, a misassigned column silently corrupts real data instead of
// just a decorative header cell.
const GRID_SLACK = 2;

export function _assignLineToGridCols(items, colXs) {
  const colCount = colXs.length - 1;
  const cells = Array.from({ length: colCount }, () => []);
  for (const item of items) {
    let col = colCount - 1;
    for (let c = 0; c < colCount; c++) {
      if (item.x >= colXs[c] - GRID_SLACK && item.x < colXs[c + 1] + GRID_SLACK) { col = c; break; }
    }
    cells[col].push(item.str);
  }
  return cells.map(parts => parts.join(' '));
}

// Sibling of _assignLineToGridCols() above — identical column-bucketing (same
// GRID_SLACK-based assignment) but collects each column's first resolved
// fontFamily instead of joining text. Kept as a separate function rather than
// changing _assignLineToGridCols()'s own return shape, since that function is
// also called from pdf2word's own grid-table path, which has no use for font
// info — this keeps that call site untouched. Only pdf2ppt calls this one, for
// per-cell font preservation in reconstructed PPTX tables.
export function _assignLineToGridColsFonts(items, colXs) {
  const colCount = colXs.length - 1;
  const fonts = Array.from({ length: colCount }, () => undefined);
  for (const item of items) {
    let col = colCount - 1;
    for (let c = 0; c < colCount; c++) {
      if (item.x >= colXs[c] - GRID_SLACK && item.x < colXs[c + 1] + GRID_SLACK) { col = c; break; }
    }
    if (fonts[col] === undefined && item.fontFamily) fonts[col] = item.fontFamily;
  }
  return fonts;
}

// For a text line at Y, finds which of grid.rowYs' row-bands it falls into,
// then reports — per internal column divider — whether that divider's line
// segment(s) cover a majority of that row-band's height. A divider that's
// NOT covered means this row's cell has no real border there: it's a
// genuine colspan (gridSpan), not just an empty neighboring cell.
export function _activeDividersForY(grid, y) {
  const { rowYs, colDividers } = grid;
  let top = rowYs[0], bottom = rowYs[rowYs.length - 1];
  for (let r = 0; r < rowYs.length - 1; r++) {
    if (y <= rowYs[r] + GRID_SLACK && y >= rowYs[r + 1] - GRID_SLACK) {
      top = rowYs[r]; bottom = rowYs[r + 1];
      break;
    }
  }
  const bandHeight = Math.max(1, top - bottom);
  return colDividers.map(d => {
    const covered = d.spans.reduce((sum, [a, b]) =>
      sum + Math.max(0, Math.min(b, top) - Math.max(a, bottom)), 0);
    return covered >= bandHeight * 0.5;
  });
}

// Merges _assignLineToGridCols()'s raw per-column cell text into spanning
// cells wherever activeDividers[i] is false — i.e. wherever this specific
// row has no real divider between raw columns i and i+1. Returns
// {text, span}[]; span > 1 becomes a real docx columnSpan, not an empty
// neighboring cell hiding a merge.
//
// `mergeFn`/`emptyValue` default to the original text-joining behavior
// (unchanged for pdf2word's own call site, which never passes a 3rd/4th
// argument). pdf2ppt reuses this same span-grouping logic for
// _assignLineToGridColsFonts()'s parallel font array too — passing
// `(a, b) => a ?? b` ("first resolved font wins") and an explicit
// `emptyValue: undefined` (an unresolved cell must stay undefined, not
// become the text path's '' placeholder) — rather than duplicating the
// activeDividers walk a second time.
//
// emptyValue is deliberately read via arguments.length, NOT a `= ''` default
// parameter: JS defaults trigger on an explicitly-passed `undefined` too, so
// a default parameter here would silently turn pdf2ppt's real
// `emptyValue: undefined` argument back into '', reintroducing exactly the
// bug this parameter exists to avoid.
export function _groupGridCellsWithSpans(rawCells, activeDividers, mergeFn, emptyValue) {
  const join  = mergeFn ?? ((a, b) => [a, b].filter(Boolean).join(' '));
  const empty = arguments.length >= 4 ? emptyValue : '';
  const out = [];
  let buf = rawCells[0] ?? empty;
  let span = 1;
  for (let i = 0; i < activeDividers.length; i++) {
    if (activeDividers[i]) {
      out.push({ text: buf, span });
      buf = rawCells[i + 1] ?? empty;
      span = 1;
    } else {
      buf = join(buf, rawCells[i + 1] ?? empty);
      span++;
    }
  }
  out.push({ text: buf, span });
  return out;
}

// Classifies a canvas crop as diagram (→ PNG) or photo (→ JPEG) using a fast
// flat-area ratio heuristic.  Diagrams/schematics are 70–90% uniform solid
// areas (white background, thick lines); photos have near-zero flat pairs.
// Downscales to ≤150px before analysis so cost is always ≤22 500 comparisons.
// Returns 'png' or 'jpeg'.
function _p2wDetectFormat(canvas) {
  const _THUMB_MAX   = 150;   // max dimension of analysis thumbnail
  const _FLAT_DIFF   = 15;    // Manhattan RGB diff threshold for "flat" pair
  const _FLAT_THRESH = 0.65;  // flat-pair ratio above which we choose PNG

  const scale = Math.min(1, _THUMB_MAX / canvas.width, _THUMB_MAX / canvas.height);
  const w     = Math.max(1, Math.floor(canvas.width  * scale));
  const h     = Math.max(1, Math.floor(canvas.height * scale));

  const thumb = document.createElement('canvas');
  thumb.width  = w;
  thumb.height = h;
  const tCtx  = thumb.getContext('2d', { willReadFrequently: true });
  tCtx.drawImage(canvas, 0, 0, w, h);
  const px = tCtx.getImageData(0, 0, w, h).data;
  thumb.width = 0; thumb.height = 0;

  // Compare each pixel with its right neighbor, respecting row boundaries.
  let flat = 0, total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      const diff = Math.abs(px[i]   - px[i + 4]) +
                   Math.abs(px[i+1] - px[i + 5]) +
                   Math.abs(px[i+2] - px[i + 6]);
      if (diff < _FLAT_DIFF) flat++;
      total++;
    }
  }

  return total > 0 && flat / total > _FLAT_THRESH ? 'png' : 'jpeg';
}

// Renders a PDF page once at 150 DPI, crops the Y-bands corresponding to
// detected visual gaps (diagrams, grids, graphics absent from text extraction),
// and returns ImageRun objects for non-blank crops.
// gaps: [{gi, yAbove, yBelow}] — yAbove/yBelow in PDF points (bottom-up coords)
// Returns [{gi, imgRun}] — only for gaps that pass the ink-density check.
// Renders one page to canvas (once) and returns:
//   gapRuns    — ImageRuns for inter-line gaps (replaces _p2wRenderRegions)
//   inlineRuns — ImageRuns for inline visual regions detected via render-and-subtract
//                (catches raster XObjects AND vector charts with low text coverage)
async function _p2wRenderAllVisuals(pdfDoc, pageNum, pageH, gaps, textItems, borderGrids, medianFontSize, ImageRun) {
  const _RENDER_DPI = 150;
  const _MAX_W_PX   = 594;    // max width in px at 96 DPI (fits A4 and Letter margins)
  const _INK_THRESH = 0.02;   // gap crop: skip if < 2% of the tightened content's own bbox is non-white
  // Inline visual detection
  const _STRIP_H         = 20;    // strip height in canvas px (~10pt at 150 DPI)
  const _TEXT_COV_THRESH = 0.60;  // strip is >60% covered by text bboxes → skip
  const _INK_THRESH_INL  = 0.07;  // strip needs >7% ink to qualify as visual
  const _INK_STEP_INL    = 4;     // sample every 4th pixel in strip scan
  const _MIN_VIS_H_PX    = 60;    // merged region must be at least 60 canvas px tall
  const _BG_AREA_THRESH  = 0.65;  // skip inline regions covering >65% of page height (background/scan)

  const scale  = _RENDER_DPI / 72;
  const page   = await pdfDoc.getPage(pageNum);
  const vp     = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup?.();

  // Crops `src` to its actual ink bounding box (+ small padding) in BOTH
  // dimensions, instead of leaving it at the full band the caller cropped
  // out of the page. Both crop paths below (gap runs, inline runs) hand
  // this a canvas that's the full canvas width, and — for gap runs — a
  // height padded by the text-line-gap heuristic (medianFontSize-based
  // margins above/below), not the actual content's extent. Left
  // untightened, a small logo/icon in a corner gets stretched to fill the
  // whole content width in Word AND carries a lot of blank vertical margin
  // into its height, badly distorting both its size and aspect ratio
  // relative to how it looked in the source PDF (confirmed on a real 1"×1"
  // square logo: came out as 6.19"×0.96" before this fix, full content
  // width with the wrong aspect ratio). Returns `{ canvas, width, height }`
  // — `canvas` is `src` itself, untouched, when there's no meaningful
  // tightening to do (ink already spans ~the whole band, e.g. a genuine
  // full-width diagram/chart).
  //
  // Scans every pixel (no stride) — this is the edge-finding pass, not a
  // coarse density pre-check. A QR code's modules are only a few px each at
  // render DPI, so a coarse sampling grid can straddle past the last
  // row/column of modules and lock the box in short, visibly clipping the
  // code. The full canvas is already resident in memory either way
  // (getImageData), so scanning every pixel only costs loop iterations,
  // which stay cheap even for a full-page band (a couple million
  // iterations, low tens of ms).
  //
  // Also returns `density`: ink pixels divided by the TIGHT bbox area, not
  // the padded band `src` started as. Callers used to gate on density
  // measured over the full padded band, which dilutes small-but-real
  // content — a 1"×1" QR code sitting in a large layout gap measured ~1.6%
  // ink over the whole band (below the 2% "is this real content" cutoff)
  // and was silently dropped whole, not just cropped loosely. Measuring
  // density over the content's own bounding box is what the threshold was
  // actually meant to test.
  function _tightenToInk(src) {
    const d = src.getContext('2d').getImageData(0, 0, src.width, src.height).data;
    let minX = src.width, maxX = -1, minY = src.height, maxY = -1;
    let inkCount = 0;
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const idx = (y * src.width + x) * 4;
        if (d[idx] < 240 || d[idx + 1] < 240 || d[idx + 2] < 240) {
          inkCount++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return { canvas: src, width: src.width, height: src.height, density: 0 };
    const PAD = 8; // canvas px — keeps edges of the actual content from being clipped
    const x0 = Math.max(0, minX - PAD);
    const x1 = Math.min(src.width, maxX + PAD);
    const y0 = Math.max(0, minY - PAD);
    const y1 = Math.min(src.height, maxY + PAD);
    const w  = x1 - x0;
    const h  = y1 - y0;
    const density = (w * h) > 0 ? inkCount / (w * h) : 0;
    if (w >= src.width - PAD && h >= src.height - PAD) {
      return { canvas: src, width: src.width, height: src.height, density }; // already ~the full band
    }
    const cropped = document.createElement('canvas');
    cropped.width  = w;
    cropped.height = h;
    cropped.getContext('2d').drawImage(src, x0, y0, w, h, 0, 0, w, h);
    return { canvas: cropped, width: w, height: h, density };
  }

  // ── Part 1: gap runs ────────────────────────────────────────────────────────
  const gapRuns = [];
  // Track gap canvas Y ranges so inline scanner skips them (already captured)
  const gapCanvasRanges = [];

  for (const { yAbove, yBelow } of gaps) {
    const pdfTop    = yAbove - medianFontSize * 0.5;
    const pdfBottom = yBelow + medianFontSize * 1.2;
    const cyTop     = Math.max(0,             Math.round((pageH - pdfTop)    * scale));
    const cyBottom  = Math.min(canvas.height, Math.round((pageH - pdfBottom) * scale));
    const cropH     = cyBottom - cyTop;
    if (cropH <= 4) continue;

    gapCanvasRanges.push({ cyTop, cyBottom });

    const tmp  = document.createElement('canvas');
    tmp.width  = canvas.width;
    tmp.height = cropH;
    tmp.getContext('2d').drawImage(canvas, 0, cyTop, canvas.width, cropH, 0, 0, canvas.width, cropH);

    // Density is checked AFTER tightening, over the content's own bounding
    // box — not over this padded band, which can be much larger than a
    // small graphic sitting inside a wide layout gap and would dilute a
    // real image's ink ratio below threshold (see _tightenToInk).
    const { canvas: tight, width: tightW, height: tightH, density } = _tightenToInk(tmp);
    if (density < _INK_THRESH) {
      if (tight !== tmp) { tight.width = 0; tight.height = 0; }
      tmp.width = 0; tmp.height = 0;
      continue;
    }

    const fmt  = _p2wDetectFormat(tight);
    const blob = await new Promise(res =>
      tight.toBlob(res, `image/${fmt}`, fmt === 'jpeg' ? 0.92 : undefined));
    if (tight !== tmp) { tight.width = 0; tight.height = 0; }
    tmp.width = 0; tmp.height = 0;
    if (!blob) continue;
    const buf = await blob.arrayBuffer();

    let w = Math.round(tightW * 96 / _RENDER_DPI);
    let h = Math.round(tightH * 96 / _RENDER_DPI);
    if (w > _MAX_W_PX) { h = Math.round(h * _MAX_W_PX / w); w = _MAX_W_PX; }

    gapRuns.push({ yAbove, imgRun: new ImageRun({ data: buf, transformation: { width: w, height: h }, type: fmt === 'png' ? 'png' : 'jpg' }) });
  }

  // ── Part 2: inline visual runs (render-and-subtract) ───────────────────────
  // Build exclusion zones in canvas Y coords: gap bands + border grid bands.
  // Strips inside these zones are skipped to avoid duplicating already-captured content.
  const exclusions = [...gapCanvasRanges];
  for (const g of borderGrids) {
    exclusions.push({
      cyTop:    Math.max(0,             Math.round((pageH - (g.y + g.h)) * scale)),
      cyBottom: Math.min(canvas.height, Math.round((pageH - g.y)          * scale)),
    });
  }

  const numStrips = Math.ceil(canvas.height / _STRIP_H);

  // Pre-compute text coverage per strip from PDF text item bboxes.
  // Each item occupies [x, x+width] in X and [y, y+fontSize] in Y (PDF coords).
  const stripTextCov = new Float32Array(numStrips).fill(0);
  for (const item of textItems) {
    if (!item.width || item.width <= 0) continue;
    const cyItemTop    = Math.round((pageH - (item.y + item.fontSize)) * scale);
    const cyItemBottom = Math.round((pageH - item.y)                   * scale);
    const itemW        = Math.round(item.width * scale);
    const s0 = Math.max(0,           Math.floor(cyItemTop    / _STRIP_H));
    const s1 = Math.min(numStrips-1, Math.floor(cyItemBottom / _STRIP_H));
    for (let s = s0; s <= s1; s++) stripTextCov[s] += itemW;
  }
  for (let s = 0; s < numStrips; s++) {
    stripTextCov[s] = Math.min(1, stripTextCov[s] / Math.max(1, canvas.width));
  }

  // Compute ink density per strip from the already-rendered canvas.
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = imageData.data;

  const isVisual = new Uint8Array(numStrips);
  for (let s = 0; s < numStrips; s++) {
    // Skip strips in exclusion zones
    const stripTop = s * _STRIP_H;
    const stripBot = Math.min(canvas.height, stripTop + _STRIP_H);
    const excluded = exclusions.some(e => stripTop < e.cyBottom && stripBot > e.cyTop);
    if (excluded) continue;
    if (stripTextCov[s] >= _TEXT_COV_THRESH) continue;

    const yEnd = Math.min(canvas.height, (s + 1) * _STRIP_H);
    let ink = 0, total = 0;
    for (let y = stripTop; y < yEnd; y++) {
      for (let x = 0; x < canvas.width; x += _INK_STEP_INL) {
        const idx = (y * canvas.width + x) * 4;
        if (px[idx] < 240 || px[idx+1] < 240 || px[idx+2] < 240) ink++;
        total++;
      }
    }
    if (total > 0 && ink / total >= _INK_THRESH_INL) isVisual[s] = 1;
  }

  // Merge adjacent visual strips; filter by minimum height; crop and encode.
  const inlineRuns = [];
  let s = 0;
  while (s < numStrips) {
    if (!isVisual[s]) { s++; continue; }
    let sEnd = s;
    while (sEnd + 1 < numStrips && isVisual[sEnd + 1]) sEnd++;

    const cyTop  = s    * _STRIP_H;
    const cyBot  = Math.min(canvas.height, (sEnd + 1) * _STRIP_H);
    const cropH  = cyBot - cyTop;

    // Skip regions covering >65% of page height — background image or full-page scan.
    if (cropH >= _MIN_VIS_H_PX && cropH / canvas.height < _BG_AREA_THRESH) {
      const tmp  = document.createElement('canvas');
      tmp.width  = canvas.width;
      tmp.height = cropH;
      tmp.getContext('2d').drawImage(canvas, 0, cyTop, canvas.width, cropH, 0, 0, canvas.width, cropH);

      const { canvas: tight, width: tightW, height: tightH } = _tightenToInk(tmp);

      const fmt  = _p2wDetectFormat(tight);
      const blob = await new Promise(res =>
        tight.toBlob(res, `image/${fmt}`, fmt === 'jpeg' ? 0.92 : undefined));
      if (tight !== tmp) { tight.width = 0; tight.height = 0; }
      tmp.width = 0; tmp.height = 0;
      if (blob) {
        const buf = await blob.arrayBuffer();
        let w = Math.round(tightW * 96 / _RENDER_DPI);
        let h = Math.round(tightH * 96 / _RENDER_DPI);
        if (w > _MAX_W_PX) { h = Math.round(h * _MAX_W_PX / w); w = _MAX_W_PX; }
        const pdfY = pageH - cyTop / scale;
        inlineRuns.push({
          pdfY,
          imgRun: new ImageRun({ data: buf, transformation: { width: w, height: h }, type: fmt === 'png' ? 'png' : 'jpg' }),
        });
      }
    }
    s = sEnd + 1;
  }

  canvas.width = 0; canvas.height = 0;
  canvas.remove();
  return { gapRuns, inlineRuns };
}

// Renders a PDF page that has no extractable text (diagram-only page) as a
// single full-page ImageRun. Used when lines.length === 0 in text mode.
async function _p2wRenderFullPage(pdfDoc, pageNum, ImageRun) {
  const _RENDER_DPI = 150;
  const _MAX_W_PX   = 594;

  const scale  = _RENDER_DPI / 72;
  const page   = await pdfDoc.getPage(pageNum);
  const vp     = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup?.();

  const fmt  = _p2wDetectFormat(canvas);
  const blob = await new Promise(res =>
    canvas.toBlob(res, `image/${fmt}`, fmt === 'jpeg' ? 0.92 : undefined));
  canvas.width = 0; canvas.height = 0;
  canvas.remove();
  if (!blob) return null;

  const buf = await blob.arrayBuffer();
  let w = Math.round(vp.width  * 96 / _RENDER_DPI);
  let h = Math.round(vp.height * 96 / _RENDER_DPI);
  if (w > _MAX_W_PX) { h = Math.round(h * _MAX_W_PX / w); w = _MAX_W_PX; }

  return new ImageRun({ data: buf, transformation: { width: w, height: h }, type: fmt === 'png' ? 'png' : 'jpg' });
}

// Image mode: render each page to canvas → embed JPEG in docx.
// Uses same canvas yield strategy as _runPdf2Jpg.
//
// Memory note: all ImageRun buffers live in RAM simultaneously until
// Packer.toBuffer() flushes them into the ZIP. The page cap (MAX_IMAGE_PAGES)
// in _runPdf2Word prevents unbounded accumulation.
// Quality is auto-reduced on large PDFs to minimise per-page buffer size.
async function _p2wRenderImages(pdfDoc, dpi, pageLimit) {
  const { Paragraph, ImageRun } = window.docx;
  const scale = dpi / 72;

  // Automatically lower JPEG quality for large page counts to reduce peak RAM.
  // At 150 DPI: 0.85 → ~500 KB/page; 0.72 → ~360 KB/page; 0.60 → ~260 KB/page.
  const quality = pageLimit > 300 ? 0.60
                : pageLimit > 150 ? 0.72
                : 0.85;

  let canvas  = document.createElement('canvas');
  const ctx   = canvas.getContext('2d');
  const paragraphs = [];

  try {
    let frameStart = performance.now();

    for (let p = 1; p <= pageLimit; p++) {
      if (!isProcessing) break;
      setProgress(10 + Math.round((p / pageLimit) * 80),
                  `Rendering page ${p}/${pageLimit}…`);

      const page     = await pdfDoc.getPage(p);
      const viewport = page.getViewport({ scale });
      canvas.width   = Math.round(viewport.width);
      canvas.height  = Math.round(viewport.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup?.();

      const blob        = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
      const arrayBuffer = await blob.arrayBuffer();

      // docx ImageRun.transformation: pixel dimensions at 96 DPI
      // 594 px = 6.19 inches @ 96 DPI — fits A4 (6.27") and Letter (6.5") default margins
      const MAX_W = 594;
      let w = Math.round(canvas.width  * 96 / dpi);
      let h = Math.round(canvas.height * 96 / dpi);
      if (w > MAX_W) { h = Math.round(h * MAX_W / w); w = MAX_W; }

      // pageBreakBefore on the image paragraph itself — avoids the separate
      // empty paragraph that Word counts as content and renders as a blank page.
      paragraphs.push(new Paragraph({
        pageBreakBefore: p > 1,
        children: [new ImageRun({ data: arrayBuffer, transformation: { width: w, height: h }, type: 'jpg' })],
      }));

      const now = performance.now();
      if (now - frameStart >= _FRAME_BUDGET_MS) {
        await _yieldToUI();
        frameStart = performance.now();
      }
    }
  } finally {
    canvas.width = 0; canvas.height = 0;
    canvas.remove(); canvas = null;
  }

  return paragraphs;
}

// ── Script-detection helpers ──────────────────────────────────

// RTL: Hebrew U+0590–05FF, Arabic U+0600–06FF / U+0750–077F / U+FB50–FDFF / U+FE70–FEFF,
//      and associated presentation forms / extended blocks.
function _isRtl(str) {
  return /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\uFB1D-\uFB4F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(str);
}

// _isCjk moved to textLayoutUtils.js (shared with pdf2md's core).

// Devanagari: U+0900–097F (used for Hindi, Marathi, Sanskrit, Nepali …)
function _isDevanagari(str) {
  return /[\u0900-\u097F]/.test(str);
}

// ── Stub ──────────────────────────────────────────────────────

async function _runStub(tool) {
  const msg = TOOLS[tool]?.comingSoon || '🚧 This tool is coming soon!';
  await new Promise(r => setTimeout(r, 400));
  if (!isProcessing) return;
  isProcessing = false;
  setFilesLocked(false);
  hideCancelBtn();
  hideProgress();
  setButtonReady(TOOLS[tool].btn);
  showToast(msg, 5000);
}

// ── Error ──────────────────────────────────────────────────────

// Deterministic 4-hex-char hash — same (tool, errorType) pair always
// produces the same code, so recurring reports of the same underlying
// failure show up as the same quotable ID (e.g. "MERGE-7F32") instead of a
// fresh one each time. Not a request/session ID — there's no backend store
// to look it up in, so a per-instance ID would be unactionable. This is
// closer to a Windows/Stripe-style error *code*: enough to tell "is this
// the same bug as last week's report" apart from "a new one", by eye, in a
// Telegram thread with no database behind it.
function _hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).toUpperCase().padStart(4, '0').slice(-4);
}

function _errorId(tool, errorType) {
  return `${tool.toUpperCase()}-${_hashCode(`${tool}:${errorType}`)}`;
}

function _handleError(tool, message, errorType = null) {
  hideProgress();
  setButtonReady(TOOLS[tool]?.btn || 'Try again');

  // Classify + translate worker error codes into user-friendly messages.
  // Skipped entirely when the caller already passed an explicit errorType —
  // that means the caller already knows exactly what went wrong and built
  // the right message for it (e.g. unlock's "The password is incorrect"),
  // so re-sniffing that message for keywords must not run: it used to
  // clobber that exact message, because it contains the substring
  // "password", with the generic encrypted/corrupted-PDF text below —
  // showing "unusual or corrupted structure" for an ordinary wrong-password
  // case (real bug, reported by a user via feedback).
  let friendly = message;
  if (errorType !== null) {
    // caller already classified this — trust their message as-is.
  } else if (message?.includes('ENCRYPTOR_UNAVAILABLE')) {
    friendly   = t('err_enc_unavailable');
    errorType  = 'enc_lib_failed';
  } else if (message?.includes('ENCRYPTOR_')) {
    friendly   = t('err_enc_failed');
    errorType  = 'enc_failed';
  } else if (
    // pdf-lib throws this when AES-encrypted objects can't be parsed.
    // The PDF has owner-password restrictions (e.g. copy:no, change:no).
    // ignoreEncryption:true bypasses the header check but not AES decryption.
    message?.toLowerCase().includes('pdfdict') ||
    message?.toLowerCase().includes('expected instance') ||
    message?.toLowerCase().includes('encrypt') ||
    message?.toLowerCase().includes('password')
  ) {
    friendly   = t('err_encrypted_pdf');
    errorType  = 'pdf_restricted';
  } else if (
    // Raw JS-engine error text (V8/JSC), not something this app's own code
    // constructs — thrown directly by `new ArrayBuffer(n)` (or an internal
    // equivalent inside pdf-lib/JSZip) when the browser can't get the
    // requested memory block. Real device/browser memory ceiling, most
    // common on large multi-hundred-page PDFs in a "separate files" mode
    // (many buffers held at once) or on a low-RAM device. Previously fell
    // through with no classification — the user saw this exact raw engine
    // string verbatim, no explanation, no suggested next step.
    message?.toLowerCase().includes('array buffer allocation failed') ||
    message?.toLowerCase().includes('invalid array buffer length') ||
    message?.toLowerCase().includes('out of memory') ||
    message?.toLowerCase().includes('allocation failed')
  ) {
    friendly   = t('err_out_of_memory');
    errorType  = 'out_of_memory';
  } else if (message?.includes('Unexpected result')) {
    errorType  = 'worker_crash';
  } else if (message?.toLowerCase().includes('worker error') || message?.toLowerCase().includes('worker crash')) {
    errorType  = 'worker_crash';
  }

  const resolvedType = errorType ?? 'unknown';
  const errorId = _errorId(tool, resolvedType);
  trackToolError(tool, resolvedType);
  // Clickable toast: the moment of an actual failure is the highest-signal
  // point to hear from a user — opens the same feedback modal used on
  // success, pre-filled with the tool + error as read-only context.
  showToast(
    t('error_msg', { msg: friendly }) + t('error_report_hint') + '  ' + t('error_id_label', { id: errorId }),
    8000,
    () => openFeedback('error', { tool, message: friendly, errorId }),
  );
}

// ── True PDF Redaction ─────────────────────────────────────────
// Renders redacted pages to canvas (text physically removed) and
// assembles final PDF in a dedicated worker. Non-redacted pages
// are copied from the original, preserving text layer and quality.

async function _runRedactTrue(filesSnapshot, params) {
  const file = filesSnapshot[0];
  if (!file) { _abortUI(); return; }

  // opacity intentionally not destructured from params — see the fillHex comment below,
  // true-redact always fills fully opaque regardless of what the UI would have sent.
  const { rectsByPage = {}, applyAll = false, fillColor = [0,0,0], removeMetadata = false } = params;

  setProgress(8, 'Reading PDF…');
  const pdfBytes = await (file._decryptedBuffer ? file._decryptedBuffer.slice(0) : file.arrayBuffer());

  // ── Build set of page indices that have redactions (0-based) ──
  let redactedPageSet = new Set();
  if (applyAll) {
    const rects = params.rects || [];
    if (rects.length > 0) {
      // Will apply to all pages — we find out count from PDF.js
      redactedPageSet = 'all';
    }
  } else {
    for (const k in rectsByPage) {
      if (rectsByPage[k]?.length > 0) redactedPageSet.add(parseInt(k, 10) - 1); // 0-based
    }
  }

  if (redactedPageSet !== 'all' && redactedPageSet.size === 0) {
    showToast('Draw at least one area to redact');
    _abortUI();
    return;
  }

  setProgress(15, 'Loading PDF renderer…');
  await loadPdfJs();

  const pdfDoc = await window.pdfjsLib.getDocument({ isEvalSupported: false,
    data: new Uint8Array(pdfBytes.slice(0)),
    disableWorker: true,
  }).promise;

  const pageCount = pdfDoc.numPages;
  if (redactedPageSet === 'all') {
    redactedPageSet = new Set(Array.from({ length: pageCount }, (_, i) => i));
  }

  // ── Render each redacted page to canvas ───────────────────────
  setProgress(20, 'Rendering redacted pages…');

  const redactedImages = {};
  const RENDER_SCALE = 2; // 2× for good print quality

  const [fr, fg, fb] = fillColor;
  // Security invariant, not a style choice: this is the TRUE-redact path (canvas-flatten,
  // "cannot be recovered" per rdct_banner_true) — the fill MUST be fully opaque. At any
  // opacity < 1, ctx.fillRect's source-over alpha compositing leaves the original pixel
  // value linearly recoverable (original = result / (1 - alpha)), so params.opacity is
  // deliberately ignored here regardless of what the UI slider was set to.
  const fillHex = `rgba(${Math.round(fr*255)},${Math.round(fg*255)},${Math.round(fb*255)},1)`;

  for (const pageIdx of redactedPageSet) {
    const pageNum = pageIdx + 1; // pdf.js is 1-based
    if (pageNum < 1 || pageNum > pageCount) continue;

    const progressVal = 20 + Math.round((pageIdx / pageCount) * 35);
    setProgress(progressVal, `Rendering page ${pageNum} of ${pageCount}…`);

    const page = await pdfDoc.getPage(pageNum);
    const vp0  = page.getViewport({ scale: 1 });
    const vp   = page.getViewport({ scale: RENDER_SCALE });

    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(vp.width, vp.height)  // eslint-disable-line compat/compat
      : Object.assign(document.createElement('canvas'), { width: vp.width, height: vp.height });
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    // Draw redaction rectangles — coordinates are in PDF points (scale=1)
    const rects = applyAll ? (params.rects || []) : (rectsByPage[pageNum] || []);
    ctx.fillStyle = fillHex;
    for (const r of rects) {
      if (r.type && r.type !== 'rect') continue; // only rect shapes are true redaction
      // PDF coords: origin bottom-left; canvas origin top-left
      const cx = r.x * RENDER_SCALE;
      const cy = (vp0.height - r.y - r.h) * RENDER_SCALE;
      const cw = r.w * RENDER_SCALE;
      const ch = r.h * RENDER_SCALE;
      ctx.fillRect(cx, cy, cw, ch);
    }

    const blob = canvas.convertToBlob
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise(r => canvas.toBlob(r, 'image/png'));
    const dataUrl = await _blobToDataUrl(blob);
    redactedImages[pageIdx] = { dataUrl, width: vp.width, height: vp.height };
  }

  // ── Launch redact-worker.js ────────────────────────────────────
  setProgress(60, 'Permanently removing content…');

  await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./redact-worker.js', import.meta.url));

    worker.onmessage = (ev) => {
      const data = ev.data;
      if (data.type === 'progress') {
        setProgress(data.value, data.label);
      } else if (data.type === 'done') {
        worker.terminate();
        isProcessing = false;
        setFilesLocked(false);
        hideCancelBtn();
        setProgress(100, t('prog_done'));

        const blob = new Blob([data.result], { type: 'application/pdf' });
        const baseName = file.name.replace(/\.pdf$/i, '');
        const redactedPageCount = Object.keys(redactedImages).length;
        const preservedCount    = pageCount - redactedPageCount;

        // Count rects by source tag for the report
        const sourceCounts = {};
        for (const pageIdx of redactedPageSet) {
          const pageNum = pageIdx + 1;
          const rects = applyAll ? (params.rects || []) : (rectsByPage[pageNum] || []);
          for (const r of rects) {
            const src = r.source || 'area';
            sourceCounts[src] = (sourceCounts[src] || 0) + 1;
          }
        }
        const totalAreas = Object.values(sourceCounts).reduce((a, b) => a + b, 0);

        const SOURCE_LABELS = { email: 'email', phone: 'phone number', cc: 'credit card number', iban: 'IBAN', url: 'URL', text: 'text match', regex: 'pattern match', area: 'area' };
        const sourceLines = Object.entries(sourceCounts)
          .map(([src, n]) => `${n} ${SOURCE_LABELS[src] || src}${n !== 1 && !SOURCE_LABELS[src]?.endsWith('s') ? 's' : ''}`)
          .join(', ');

        const desc = [
          `${redactedPageCount} page${redactedPageCount !== 1 ? 's' : ''} redacted`,
          `${preservedCount} preserved`,
          totalAreas > 0 ? sourceLines : null,
          removeMetadata ? 'metadata removed' : null,
        ].filter(Boolean).join(' · ');

        document.dispatchEvent(new CustomEvent('pdfree:success', {
          detail: { tool: 'redact', blob, desc, filename: `${baseName}_redacted.pdf` }
        }));
        resolve();
      } else if (data.type === 'error') {
        worker.terminate();
        reject(new Error(data.message));
      }
    };

    worker.onerror = (ev) => {
      worker.terminate();
      reject(new Error(ev.message || 'redact-worker crashed'));
    };

    worker.postMessage({ pdfBytes: pdfBytes.slice(0), redactedImages, removeMetadata });
  });
}

function _blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}
