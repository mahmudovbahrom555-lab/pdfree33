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
          singleResult = { name, buffer: buf };
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
  } catch (err) {
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

// Text extraction: uses PDF.js getTextContent → builds docx paragraphs.
// Groups items into lines, runs table detection per page, emits docx.Table
// for detected tables and docx.Paragraph for everything else.
async function _p2wExtractText(pdfDoc) {
  const { Paragraph, TextRun, HeadingLevel,
          Table, TableRow, TableCell, WidthType } = window.docx;

  const YTOL = 4;   // px — items within 4px on Y → same line

  // ── Pass 1: collect all items + compute global median font size ────────────
  const pageData = [];
  const allSizes = [];

  for (let p = 1; p <= pdfDoc.numPages; p++) {
    setProgress(10 + Math.round((p / pdfDoc.numPages) * 40),
                `Reading page ${p}/${pdfDoc.numPages}…`);

    const page    = await pdfDoc.getPage(p);
    const content = await page.getTextContent({ normalizeWhitespace: false });
    const items   = content.items
      .filter(item => 'str' in item && item.str.trim())
      .map(item => {
        const fontSize = (item.height > 0 ? item.height : Math.abs(item.transform[3])) || 10;
        const style    = content.styles[item.fontName] || {};
        const fam      = (style.fontFamily || '').toLowerCase();
        return {
          str:      item.str,
          x:        item.transform[4],
          y:        item.transform[5],
          fontSize,
          bold:     /bold|heavy|black/.test(fam),
          italic:   /italic|oblique/.test(fam),
        };
      });

    // Group into lines
    const lines = [];
    for (const item of [...items].sort((a, b) => b.y - a.y)) {
      let merged = false;
      for (const ln of lines) {
        if (Math.abs(ln.y - item.y) <= YTOL) { ln.items.push(item); merged = true; break; }
      }
      if (!merged) lines.push({ y: item.y, items: [item] });
    }
    lines.forEach(ln => ln.items.sort((a, b) => a.x - b.x));

    allSizes.push(...items.map(i => i.fontSize).filter(s => s > 0));
    pageData.push(lines);
  }

  const sorted = [...allSizes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 10;

  // ── Pass 2: build Word content ─────────────────────────────────────────────
  const paragraphs = [];

  for (let pi = 0; pi < pageData.length; pi++) {
    if (!isProcessing) break;

    if (pi > 0) {
      paragraphs.push(new Paragraph({ children: [], pageBreakBefore: true }));
    }

    const lines = pageData[pi];
    if (!lines.length) continue;

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

    let li = 0;
    while (li < lines.length) {
      const tbl = lineToTable.get(li);

      if (tbl && li === tbl.startIdx) {
        // ── Emit docx Table ─────────────────────────────────────────────────
        paragraphs.push(
          new Table({
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
          })
        );
        // Add spacing after table
        paragraphs.push(new Paragraph({ children: [], spacing: { after: 120 } }));
        li = tbl.endIdx + 1;

      } else if (tbl) {
        // Line inside a table — already handled above, skip
        li++;

      } else {
        // ── Emit regular Paragraph ───────────────────────────────────────────
        const ln      = lines[li];
        const maxSize = Math.max(...ln.items.map(i => i.fontSize));

        let heading;
        if      (maxSize >= median * 2.2) heading = HeadingLevel.HEADING_1;
        else if (maxSize >= median * 1.7) heading = HeadingLevel.HEADING_2;
        else if (maxSize >= median * 1.3) heading = HeadingLevel.HEADING_3;

        const runs = ln.items.map(i => new TextRun({
          text:    i.str,
          bold:    i.bold,
          italics: i.italic,
          size:    Math.max(16, Math.round(i.fontSize * 2)),
        }));

        paragraphs.push(new Paragraph({
          ...(heading !== undefined ? { heading } : {}),
          children: runs,
          spacing:  { after: 80 },
        }));
        li++;
      }
    }
  }

  return paragraphs;
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

      const blob        = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
      const arrayBuffer = await blob.arrayBuffer();

      // docx ImageRun.transformation: pixel dimensions at 96 DPI
      const MAX_W = 700;   // ~7.3 inches at 96 DPI — fits within default Word margins
      let w = Math.round(canvas.width  * 96 / dpi);
      let h = Math.round(canvas.height * 96 / dpi);
      if (w > MAX_W) { h = Math.round(h * MAX_W / w); w = MAX_W; }

      // pageBreakBefore on the image paragraph itself — avoids the separate
      // empty paragraph that Word counts as content and renders as a blank page.
      paragraphs.push(new Paragraph({
        pageBreakBefore: p > 1,
        children: [new ImageRun({ data: arrayBuffer, transformation: { width: w, height: h }, type: 'jpg' })],
      }));

      page.cleanup?.();

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
