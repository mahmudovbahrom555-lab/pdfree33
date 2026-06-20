// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  processor.js — PDF processing via Web Worker
// ============================================================

import { fmtSize } from './utils.js';
import { t, tp } from './i18n.js';
import { setProgress, hideProgress, setButtonProcessing, setButtonReady,
         showCancelBtn, hideCancelBtn, showToast } from './ui.js';
import { selectedFiles, setFilesLocked } from './files.js';
import { trackToolError } from './analytics.js';
import { TOOLS, MAX_COMPRESS_MB } from './config.js';
import { getRunner, getWorkerTool } from './toolRegistry.js';
import { loadJSZip, loadDocx } from './lazyLibs.js';
import { preprocessPdfBuffer } from './decryptPdf.js';
import { detectTables } from './pdf2wordTables.js';
import { detectTableGrids } from './pdf2wordBorders.js';

// Hard cap for image mode — defined here to avoid coupling with pdf2wordUI.js.
// Must match MAX_IMAGE_PAGES in pdf2wordUI.js.
const _P2W_IMAGE_CAP = 500;

let _worker = _createWorker();
export let isProcessing = false;
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

// ── Cancel ────────────────────────────────────────────────────

export function cancelProcess(currentTool) {
  if (!isProcessing) return;
  _worker.terminate();
  _worker      = _createWorker();
  isProcessing = false;
  setFilesLocked(false);
  hideProgress();
  hideCancelBtn();
  setButtonReady(TOOLS[currentTool].btn);
  showToast(t('cancelled'));
}

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
  isProcessing = true;
  _currentTool = currentTool;
  _processStartMs = Date.now();

  const filesSnapshot = [...selectedFiles];

  setFilesLocked(true);
  setButtonProcessing();
  setProgress(5, t('prog_reading'));
  showCancelBtn();

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
    worker:   () => _runWorkerTool(getWorkerTool(currentTool) ?? currentTool, filesSnapshot, extraParams),
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

async function _runMerge(filesSnapshot, { removeWatermarks = false } = {}) {
  if (!_checkTotalSize(filesSnapshot, 300)) { _abortUI(); return; }
  // Use pre-decrypted buffer when files.js already ran QPDF at file-add time.
  // .slice(0) copies so the cached buffer survives the postMessage transfer.
  const buffers = await Promise.all(filesSnapshot.map(async f =>
    f._decryptedBuffer ? f._decryptedBuffer.slice(0) : await preprocessPdfBuffer(await f.arrayBuffer())
  ));
  setProgress(10, t('prog_merging'));

  // ⚠️  TRANSFERABLE: all buffers in `buffers` are transferred to the worker.
  //     They are DETACHED here immediately after postMessage — do not read them.
  //     Filenames are passed separately (plain strings, not Transferable) so the
  //     worker can include them in error reports for the "skipped files" toast.
  const names = filesSnapshot.map(f => f.name);
  _worker.postMessage({ tool: 'merge', files: buffers, names, removeWatermarks }, buffers);

  _worker.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'progress') {
      setProgress(data.value, data.label);
    } else if (data.type === 'done') {
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

      document.dispatchEvent(new CustomEvent('pdfree:success', {
        detail: { tool: 'merge', blob, desc, filename: 'merged_document.pdf' }
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
      isProcessing = false;
      setFilesLocked(false);
      hideCancelBtn();
      _handleError('merge', data.message);
    }
  };
  _worker.onerror = (e) => {
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

// ── Compress ───────────────────────────────────────────────────

async function _runCompress(filesSnapshot, { preset = 'medium', preserveText = true, removeWatermarks = false, targetDpi = null, quality = null } = {}, toolKey = 'compress') {
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
    { tool: 'compress', file: buffer, options: { preset, preserveText, removeWatermarks, targetDpi, quality } },
    [buffer]
  );

  _worker.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'progress') {
      _resetWatchdog();
      setProgress(data.value, data.label);
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
  // Read all images as ArrayBuffers and transfer to worker
  const buffers = await Promise.all(filesSnapshot.map(f => f.arrayBuffer()));
  setProgress(5, t('prog_loading_imgs'));

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

async function _runPdf2Jpg(filesSnapshot, { pages, format, dpi, zip }) {
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
    pdfDoc = await window.pdfjsLib.getDocument({
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
  //   zip=true   → streaming into JSZip as pages render
  //   zip=false  → buffer only 1 page (already bounded)
  if (zip) await loadJSZip();
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

        if (!zip || validPages.length === 1) {
          if (!singleResult) singleResult = { name, buffer: buf }; // zip=false: first page only
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
  if (!zip || validPages.length === 1) {
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

async function _runWorkerTool(tool, filesSnapshot, params) {
  const file   = filesSnapshot[0];
  const limits = { watermark: 200, pagenum: 200, meta: 200, protect: 200, rotate: 150, redact: 150, fill: 200, flatten: 200 };
  if (!_checkSize(file, limits[tool] ?? 200)) { _abortUI(); return; }
  const buffer = file._decryptedBuffer ? file._decryptedBuffer.slice(0) : await preprocessPdfBuffer(await file.arrayBuffer());

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
    pdfDoc = await window.pdfjsLib.getDocument({
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
  try {
    if (mode === 'text') {
      setProgress(10, 'Extracting text…');
      paragraphs = await _p2wExtractText(pdfDoc);
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

  const { Document, Packer } = window.docx;
  const doc = new Document({
    creator:     'PDFree',
    description: 'Converted from PDF by PDFree.io',
    sections: [{ children: paragraphs }],
  });

  // toBlob() uses JSZip type:"blob" — browser-native, no polyfill needed.
  // toBuffer() uses type:"nodebuffer" which JSZip does not support in browsers.
  const blob = await Packer.toBlob(doc);
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
    detail: { tool: 'pdf2word', blob, desc, filename }
  }));
}

// Converts a pdf.js RTL item string from visual (left-to-right screen) order to Unicode
// logical order that Word's BiDi engine expects.  Character-level reverse() corrupts
// embedded LTR words (e.g. "(Arabic)" → "(cibarA)"); this splits by run direction,
// reverses only RTL runs, applies bidi mirroring to brackets in LTR runs, then reverses
// the run order so the overall reading order is restored.
function _visualRTLToLogical(s) {
  const BIDI_MIRROR = {'(':')',')':'(','[':']',']':'[','{':'}','}':'{','<':'>','>':'<'};
  // Arabic-Indic digits (U+0660–0669) and Extended Arabic-Indic (U+06F0–06F9) have
  // BiDi class AN — they run left-to-right even within RTL text, so exclude them
  // from the RTL set to prevent reversal (e.g. "١٢٣" must not become "٣٢١").
  const isRTL = cp =>
    !((cp >= 0x0660 && cp <= 0x0669) || (cp >= 0x06F0 && cp <= 0x06F9)) &&
    ((cp >= 0x0590 && cp <= 0x05FF) || (cp >= 0x0600 && cp <= 0x06FF) ||
     (cp >= 0x0750 && cp <= 0x077F) || (cp >= 0xFB1D && cp <= 0xFB4F) ||
     (cp >= 0xFB50 && cp <= 0xFDFF) || (cp >= 0xFE70 && cp <= 0xFEFF));
  const segs = [];
  for (const ch of [...s]) {
    const rtl = isRTL(ch.codePointAt(0));
    if (!segs.length || segs[segs.length - 1].rtl !== rtl) segs.push({ rtl, chars: [ch] });
    else segs[segs.length - 1].chars.push(ch);
  }
  // Move trailing spaces from an LTR run into the following RTL run so the space
  // ends up between the Arabic text and the embedded LTR word after run-order reversal.
  for (let i = 0; i < segs.length - 1; i++) {
    if (!segs[i].rtl && segs[i + 1].rtl) {
      while (segs[i].chars.length && segs[i].chars[segs[i].chars.length - 1] === ' ')
        segs[i + 1].chars.unshift(segs[i].chars.pop());
    }
  }
  return segs.reverse()
    .map(seg => seg.rtl
      ? seg.chars.reverse().join('')
      : seg.chars.map(c => BIDI_MIRROR[c] ?? c).join(''))
    .join('');
}

// Text extraction: uses PDF.js getTextContent → builds docx paragraphs.
// Groups items into lines, runs table detection per page, emits docx.Table
// for detected tables and docx.Paragraph for everything else.
async function _p2wExtractText(pdfDoc) {
  const { Paragraph, TextRun, HeadingLevel,
          Table, TableRow, TableCell, WidthType, ImageRun } = window.docx;

  const YTOL = 6;   // px — items within 6px on Y → same line (was 4; increased to group
                   //  characters with slight baseline variation, e.g. Cyrillic in some PDFs)

  // ── Pass 1: collect all items + compute global median font size ────────────
  const pageData = [];
  const allSizes = [];

  for (let p = 1; p <= pdfDoc.numPages; p++) {
    if (!isProcessing) break;
    setProgress(10 + Math.round((p / pdfDoc.numPages) * 40),
                `Reading page ${p}/${pdfDoc.numPages}…`);

    const page    = await pdfDoc.getPage(p);
    const pageH   = page.getViewport({ scale: 1 }).height;
    const [content, borderGrids] = await Promise.all([
      page.getTextContent({ normalizeWhitespace: false }),
      detectTableGrids(page).catch(() => []),
    ]);
    const allMapped = content.items
      .filter(item => 'str' in item && item.str.split('\u0000').join('').trim())
      .map(item => {
        const fontSize  = (item.height > 0 ? item.height : Math.abs(item.transform[3])) || 10;
        const style     = content.styles[item.fontName] || {};
        const fam       = (style.fontFamily || '').toLowerCase();
        // Rotation detected when b-component dominates a-component in the transform matrix.
        // Normal text: [a≈size, b≈0, …]. Rotated 90°: [a≈0, b≈size, …].
        const isRotated = Math.abs(item.transform[1]) > Math.abs(item.transform[0]) * 0.5;
        // pdf.js returns dir:'rtl' items in visual (left-to-right screen) order.
        // _visualRTLToLogical restores Unicode logical order while preserving embedded
        // LTR words (plain reverse() would corrupt e.g. "(Arabic)" → "(cibarA)").
        // Strip NUL bytes produced by fonts without ToUnicode CMap — they corrupt DOCX XML.
        const str = ((item.dir === 'rtl') ? _visualRTLToLogical(item.str) : item.str)
          .split('\u0000').join('');
        return {
          str,
          x:        item.transform[4],
          y:        item.transform[5],
          width:    item.width || 0,
          fontSize,
          rotated:  isRotated,
          bold:     /bold|heavy|black/.test(fam),
          italic:   /italic|oblique/.test(fam),
        };
      });

    // Rotated items (vertical column headers in tables) are processed separately
    // so they don't pollute normal line-grouping.
    const items        = allMapped.filter(i => !i.rotated);
    const rotatedItems = allMapped.filter(i =>  i.rotated);

    // Group normal items into lines
    const lines = [];
    for (const item of [...items].sort((a, b) => b.y - a.y)) {
      let merged = false;
      for (const ln of lines) {
        if (Math.abs(ln.y - item.y) <= YTOL) { ln.items.push(item); merged = true; break; }
      }
      if (!merged) lines.push({ y: item.y, items: [item] });
    }
    lines.forEach(ln => {
      const txt    = ln.items.map(i => i.str).join('');
      const rtlCnt = (txt.match(/[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\uFB1D-\uFB4F\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
      ln.rtl = rtlCnt > 0;  // any RTL chars -> paragraph gets <w:bidi/>
      // RTL lines: keep pdf.js content-stream order (logical Unicode order for well-formed PDFs).
      // Sorting by X would reverse word order on pure-Arabic lines and break mixed
      // lines like "Arabic (العربية)" where LTR words have lower X than RTL words.
      // Word's built-in BiDi algorithm handles display when bidirectional:true is set.
      if (rtlCnt === 0) ln.items.sort((a, b) => a.x - b.x);
    });

    allSizes.push(...items.map(i => i.fontSize).filter(s => s > 0));
    pageData.push({ lines, rotatedItems, borderGrids, pageH });
    page.cleanup?.();
  }

  const sorted = [...allSizes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 10;

  // ── Post-Pass-1: Uzbek CamScanner OCR normalization ───────────────────────
  // CamScanner's OCR maps the Uzbek modifier letters oʻ (U+02BB) and gʻ to
  // the byte sequence that pdf.js decodes as "oâ" / "gâ".
  // We fix this ONLY when the document is detected as Uzbek OCR:
  //   ratio = count(oâ | gâ | Oâ | Gâ) / count(all â) > 0.75
  // This keeps French/Portuguese/Romanian/Vietnamese â intact — in those
  // languages â appears after many letters (b, c, ch, t, m, p…), so the
  // oâ+gâ ratio stays well below 0.75.
  {
    let totalAcirc = 0, uzbekAcirc = 0;
    for (const { lines } of pageData) {
      for (const ln of lines) {
        for (const item of ln.items) {
          const all  = (item.str.match(/â/g)       || []).length;
          const uz   = (item.str.match(/[oOgG]â/g) || []).length;
          totalAcirc += all;
          uzbekAcirc += uz;
        }
      }
    }
    if (totalAcirc >= 3 && uzbekAcirc / totalAcirc > 0.75) {
      for (const { lines } of pageData) {
        for (const ln of lines) {
          for (const item of ln.items) {
            item.str = item.str
              .replace(/oâ/g, 'oʻ').replace(/Oâ/g, 'Oʻ')
              .replace(/gâ/g, 'gʻ').replace(/Gâ/g, 'Gʻ');
          }
        }
      }
    }
  }

  // ── Post-Pass-1: build watermark filter ───────────────────────────────────
  // Short text appearing on ≥ ⅔ of pages (min 3) is treated as a repeated
  // watermark / header / footer and suppressed in DOCX output.

  // CamScanner adds a stamp at the bottom of every scanned page. pdf.js
  // sometimes extracts it as two separate items on the same line, so joining
  // produces "CamScannerCamScanner" instead of "CamScanner". Normalise to
  // a single canonical form so the frequency counter sees one string, not two.
  // Also collapse the "cs]" logo abbreviation and bare "-" separator line.
  const _normWatermark = t =>
    t.replace(/^(CamScanner)+$/i, 'CamScanner')
     .replace(/^[Cc][Ss]\]?$/, 'CamScanner')
     .replace(/^-$/, '');

  const _repeatTextSet = new Set();
  {
    const freq = new Map();   // lineText → number of pages it appears on
    for (const { lines } of pageData) {
      const seenOnPage = new Set();
      for (const ln of lines) {
        const raw = ln.items.map(i => i.str).join('').trim();
        const t   = _normWatermark(raw);
        if (t.length > 0 && t.length <= 60 && !seenOnPage.has(t)) {
          seenOnPage.add(t);
          freq.set(t, (freq.get(t) || 0) + 1);
        }
      }
    }
    // Text must appear on ≥ ⅔ of pages (min 3) to be treated as a watermark.
    // Using ⅓ was too aggressive: on a 9-page doc a heading on 3 pages (33%)
    // would be suppressed. ⅔ preserves legitimate section titles that happen to
    // repeat while still catching CamScanner stamps (100% frequency).
    const minPages = Math.max(3, Math.ceil(pageData.length * 2 / 3));
    for (const [t, cnt] of freq) {
      // Never suppress pure integers — those are handled separately as page numbers
      if (cnt >= minPages && !/^\d+$/.test(t)) _repeatTextSet.add(t);
    }
  }

  // ── Pass 2: build Word content ─────────────────────────────────────────────
  const _GAP_FACTOR = 2.5;   // gap > N × medianFontSize triggers a visual region
  const _MIN_GAP_PT = 20;    // minimum gap in PDF points (~0.28 inch); was 30 but
                              // CamScanner math PDFs have diagrams with tighter gaps

  const paragraphs  = [];
  const _paraBuffer = [];   // accumulates lines that should be merged into one Paragraph

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

  for (let pi = 0; pi < pageData.length; pi++) {
    if (!isProcessing) break;

    if (pi > 0) {
      paragraphs.push(new Paragraph({ children: [], pageBreakBefore: true }));
    }

    const { lines, rotatedItems, borderGrids } = pageData[pi];

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

    setProgress(50 + Math.round((pi / pageData.length) * 40),
                `Building page ${pi + 1}/${pageData.length}…`);

    // Detect tables on this page
    const tables = detectTables(lines);

    // Build set: lineIdx → table object (for O(1) lookup)
    const lineToTable = new Map();
    for (const t of tables) {
      for (let li = t.startIdx; li <= t.endIdx; li++) {
        lineToTable.set(li, t);
      }
    }

    // ── Gap detection: find vertical gaps between text lines that likely contain
    // diagrams, grids, or other vector graphics not captured by text extraction.
    // Lines are already sorted descending by Y (top of page first).
    const gapThreshold   = Math.max(_MIN_GAP_PT, median * _GAP_FACTOR);
    const visualGaps     = [];
    for (let gi = 0; gi < lines.length - 1; gi++) {
      if (lineToTable.has(gi) || lineToTable.has(gi + 1)) continue;
      const gap = lines[gi].y - lines[gi + 1].y;
      if (gap < gapThreshold) continue;
      // Skip if a border grid already covers this gap — it will be rendered as a
      // Word Table by the 'grid' event handler; inserting an ImageRun here too
      // would duplicate the same content in the DOCX output.
      const coveredByGrid = borderGrids.some(g =>
        (g.y + g.h) <= lines[gi].y + 10 && g.y >= lines[gi + 1].y - 10
      );
      if (!coveredByGrid) visualGaps.push({ gi, yAbove: lines[gi].y, yBelow: lines[gi + 1].y });
    }
    // Render page once and crop image regions for all detected gaps.
    // .catch(() => []) degrades gracefully if a page render fails — the rest of
    // the document is still produced without the missing visual region.
    const giToImgRun = new Map();
    if (visualGaps.length > 0 && isProcessing) {
      setProgress(
        50 + Math.round((pi / pageData.length) * 40),
        `Capturing visuals on page ${pi + 1}/${pageData.length}…`,
      );
      const regionRuns = await _p2wRenderRegions(
        pdfDoc, pi + 1, pageData[pi].pageH, visualGaps, median, ImageRun,
      ).catch(() => []);
      for (const { gi, imgRun } of regionRuns) giToImgRun.set(gi, imgRun);
    }

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

    // Add border grids that aren't already covered by a text-detected table
    const textYRanges = tables.map(t => ({
      minY: lines[t.endIdx].y, maxY: lines[t.startIdx].y,
    }));
    for (const grid of borderGrids) {
      const covered = textYRanges.some(r =>
        (grid.y + grid.h) >= r.minY - 20 && grid.y <= r.maxY + 20
      );
      if (!covered) events.push({ type: 'grid', y: grid.y + grid.h, grid });
    }

    // Add visual region events for detected diagram/graphic gaps
    for (const [gi, imgRun] of giToImgRun) {
      // Insert just below lines[gi] so this fires after that line is processed
      // but before lines[gi+1] is processed
      events.push({ type: 'visual-region', y: lines[gi].y - 0.1, imgRun });
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

          const maxFont = Math.max(...ln.items.map(i => i.fontSize));
          const isHead  = maxFont >= median * 1.3;

          if (_paraBuffer.length > 0) {
            const lastLn      = _paraBuffer[_paraBuffer.length - 1];
            const lastMaxFont = Math.max(...lastLn.items.map(i => i.fontSize));
            const gap         = lastLn.y - ln.y;
            const lastIsHead  = lastMaxFont >= median * 1.3;

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
        // ── 'grid' event: border-detected table (empty body rows) ─────────────
        _flushPara();   // emit any buffered paragraph before the grid
        const { grid } = event;

        // Consume text lines inside the grid's Y range → become header row(s)
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

        // Header rows — distribute items across columns by X position
        const gridRows = hdrLines.map(ln =>
          new TableRow({
            children: _assignLineToGridCols(ln.items, grid.colXs).map(cellText =>
              new TableCell({
                children: [new Paragraph({
                  children: [new TextRun({ text: cellText, bold: true })],
                  spacing: { after: 0 },
                })],
              })
            ),
          })
        );

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
    _flushPara();   // flush last paragraph at end of each page's content
  }

  return paragraphs;
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
function _assignLineToGridCols(items, colXs) {
  const colCount = colXs.length - 1;
  const cells = Array.from({ length: colCount }, () => []);
  for (const item of items) {
    let col = colCount - 1;
    for (let c = 0; c < colCount; c++) {
      if (item.x >= colXs[c] - 4 && item.x < colXs[c + 1] + 4) { col = c; break; }
    }
    cells[col].push(item.str);
  }
  return cells.map(parts => parts.join(' '));
}

// Renders a PDF page once at 150 DPI, crops the Y-bands corresponding to
// detected visual gaps (diagrams, grids, graphics absent from text extraction),
// and returns ImageRun objects for non-blank crops.
// gaps: [{gi, yAbove, yBelow}] — yAbove/yBelow in PDF points (bottom-up coords)
// Returns [{gi, imgRun}] — only for gaps that pass the ink-density check.
async function _p2wRenderRegions(pdfDoc, pageNum, pageH, gaps, medianFontSize, ImageRun) {
  const _RENDER_DPI  = 150;
  const _MAX_W_PX    = 594;   // max width in px at 96 DPI (fits A4 and Letter margins)
  const _INK_THRESH  = 0.02;  // skip region if < 2% sampled pixels are non-white
  const _INK_STEP    = 8;     // sample every 8th pixel (200× faster than full scan)

  const scale  = _RENDER_DPI / 72;
  const page   = await pdfDoc.getPage(pageNum);
  const vp     = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup?.();

  const result = [];
  for (const { gi, yAbove, yBelow } of gaps) {
    // Convert PDF (bottom-up) gap bounds to canvas (top-down) crop coords.
    // Add small margins so crop doesn't clip ascenders/descenders of adjacent text.
    const pdfTop    = yAbove - medianFontSize * 0.5;   // just below the upper baseline
    const pdfBottom = yBelow + medianFontSize * 1.2;   // just above the lower ascender
    const cyTop     = Math.max(0,             Math.round((pageH - pdfTop)    * scale));
    const cyBottom  = Math.min(canvas.height, Math.round((pageH - pdfBottom) * scale));
    const cropH     = cyBottom - cyTop;
    if (cropH <= 4) continue;

    // Crop the Y-band into a temporary canvas
    const tmp    = document.createElement('canvas');
    tmp.width    = canvas.width;
    tmp.height   = cropH;
    const tCtx   = tmp.getContext('2d');
    tCtx.drawImage(canvas, 0, cyTop, canvas.width, cropH, 0, 0, canvas.width, cropH);

    // Ink-density check: sample pixels to detect nearly-blank crops (margins, etc.)
    const d = tCtx.getImageData(0, 0, tmp.width, cropH).data;
    let ink = 0, total = 0;
    for (let i = 0; i < d.length; i += 4 * _INK_STEP) {
      if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) ink++;
      total++;
    }
    if (total === 0 || ink / total < _INK_THRESH) continue;

    // Convert to JPEG blob → ArrayBuffer → ImageRun; release crop canvas immediately
    const blob = await new Promise(res => tmp.toBlob(res, 'image/jpeg', 0.85));
    tmp.width = 0; tmp.height = 0;
    if (!blob) continue;
    const buf = await blob.arrayBuffer();

    // Scale to Word doc dimensions at 96 DPI
    let w = Math.round(canvas.width * 96 / _RENDER_DPI);
    let h = Math.round(cropH        * 96 / _RENDER_DPI);
    if (w > _MAX_W_PX) { h = Math.round(h * _MAX_W_PX / w); w = _MAX_W_PX; }

    result.push({ gi, imgRun: new ImageRun({ data: buf, transformation: { width: w, height: h }, type: 'jpg' }) });
  }

  // Release GPU texture memory
  canvas.width = 0; canvas.height = 0;
  canvas.remove();
  return result;
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

  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
  canvas.width = 0; canvas.height = 0;
  canvas.remove();
  if (!blob) return null;

  const buf = await blob.arrayBuffer();
  let w = Math.round(vp.width  * 96 / _RENDER_DPI);
  let h = Math.round(vp.height * 96 / _RENDER_DPI);
  if (w > _MAX_W_PX) { h = Math.round(h * _MAX_W_PX / w); w = _MAX_W_PX; }

  return new ImageRun({ data: buf, transformation: { width: w, height: h }, type: 'jpg' });
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

// CJK: Hiragana/Katakana, CJK Unified Ideographs, Hangul syllables, CJK Extension A/B.
function _isCjk(str) {
  return /[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF\u3400-\u4DBF\uF900-\uFAFF]/.test(str);
}

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

function _handleError(tool, message, errorType = null) {
  hideProgress();
  setButtonReady(TOOLS[tool]?.btn || 'Try again');

  // Classify + translate worker error codes into user-friendly messages
  let friendly = message;
  if (message?.includes('ENCRYPTOR_UNAVAILABLE')) {
    friendly   = t('err_enc_unavailable');
    errorType ??= 'enc_lib_failed';
  } else if (message?.includes('ENCRYPTOR_')) {
    friendly   = t('err_enc_failed');
    errorType ??= 'enc_failed';
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
    errorType ??= 'pdf_restricted';
  } else if (message?.includes('Unexpected result')) {
    errorType ??= 'worker_crash';
  } else if (message?.toLowerCase().includes('worker error') || message?.toLowerCase().includes('worker crash')) {
    errorType ??= 'worker_crash';
  }

  trackToolError(tool, errorType ?? 'unknown');
  showToast(t('error_msg', { msg: friendly }), 8000);
}
