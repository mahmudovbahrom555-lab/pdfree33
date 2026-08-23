// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  app.js — Main entry point
//  Роутинг, состояние, склейка всех модулей
// ============================================================

// Prevent browser scroll restoration — always start at top of page
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

import { TOOLS, APP_VERSION, getLocalizedTool }   from './config.js';
import { id, hide, setText, fmtSize, truncateMiddle } from './utils.js';

// Fires on every load — open DevTools Console to confirm active version.
// If you see an old version here after deploying, clear SW cache:
//   DevTools → Application → Service Workers → Unregister → Ctrl+F5
console.info(`[PDFree] v${APP_VERSION} loaded — rotate implemented: ${TOOLS.rotate?.implemented}`);
import { showHomePage, showToolPage,
         renderToolHeader, setButtonReady,
         setButtonDisabled, hideCancelBtn,
         showToast, setDropHint, setBatchHint }    from './ui.js';
import { initFileListeners, setCurrentTool,
         clearFiles, selectedFiles, addFiles,
         renderList }                             from './files.js';
import { doProcess, isProcessing,
         cancelProcess, cancelCompressScan, cancelMergeScan,
         startCompressScan, startMergeBatchScan,
         getProcessStartMs }                      from './processor.js';
import { hideAllToolOptions, initToolOptions,
         collectToolParams, notifyToolSuccess,
         getPresetFilter }                        from './toolRegistry.js';
import { savePreset } from './presets.js';
import { updateMergeDefaultFilename } from './toolRegistrations.js';
import { renderWorkerScanReport }               from './compressUI.js';
import { trackToolStart, trackToolSuccess,
         trackToolCancel, trackFileAdded,
         trackToolOpen, trackInstallPrompt,
         trackToolError, trackDownload,
         trackSearchQuery, trackSearchMiss,
         trackSearchSelect,
         trackHeroFileSelect, trackChipClick,
         trackShareTool }                           from './analytics.js';
import { buildIndex, search, trackMiss }           from './search.js';
import { loadPdfLib }                              from './lazyLibs.js';
import { checkReturnVisit, recordDownload,
         checkAndRecordConversion,
         checkAutoDownloadRecovery }               from './behavioralSignals.js';
import { initHomepageEngagement }                 from './homepageEngagement.js';
import { initRageClickDetection }                 from './rageClicks.js';
import { t }                                      from './i18n.js';
import { saveHandoff, restoreHandoff }            from './handoff.js';

// ── Module-level constants ────────────────────────────────────
const TOOL_SLUGS = {
  jpg2pdf:  '/jpg2pdf/',   pdf2jpg:  '/pdf2jpg/',
  scanDocument: '/scan-document/',
  glossary: '/glossary-pdf/',
  merge:    '/merge-pdf/',             split:    '/split-pdf/',
  compress: '/compress-pdf/',          extract: '/extract-pdf/',
  watermark:'/watermark-pdf/', pagenum: '/pagenum-pdf/',
  meta:     '/metadata-pdf/', redact:   '/redact-pdf/',
  rotate:   '/rotate-pdf/', protect: '/protect-pdf/',
  fill:     '/fill/',
  'compress-email': '/compress-pdf-for-email/',
  'draw-pdf':       '/draw-on-pdf/',
  'ocr':            '/ocr-pdf/',
  flatten:          '/flatten-pdf/',
  compare:          '/compare-pdf/',
  cleanScan:        '/clean-scan/',
  ereader:          '/optimize-pdf-for-ereader/',
  organize:         '/organize-pdf/',
  resize:           '/resize-pdf-for-printing/',
  mangaSplit:       '/split-manga-pages/',
  unlock:           '/unlock-pdf/',
  pdf2word:         '/pdf-to-word/',
  pdf2excel:        '/pdf-to-excel/',
  pdf2ppt:          '/pdf-to-powerpoint/',
  pdf2md:           '/pdf-to-markdown/',
  pdf2pdfa:         '/pdf-to-pdfa/',
};

// Reverse map pathname → tool key (primary tool slug URLs).
// CSP blocks inline <script> tags so window.PDFREE_INITIAL_TOOL is unreliable.
// Tool detection priority: data-tool body attribute → URL path → query param.
const _PATH_TO_TOOL = Object.fromEntries(
  Object.entries(TOOL_SLUGS).map(([tool, slug]) => [slug, tool])
);

function _toolFromPath(pathname) {
  const p = pathname.endsWith('/') ? pathname : pathname + '/';
  return _PATH_TO_TOOL[p] || null;
}

function _detectTool() {
  // 1. data-tool on <body> — set by template, CSP-safe, works for all landing pages
  const bodyTool = document.body.dataset.tool;
  if (bodyTool && TOOLS[bodyTool]) return bodyTool;
  // 2. URL path — works for primary tool slug URLs even without data-tool
  return _toolFromPath(location.pathname)
      || new URLSearchParams(location.search).get('tool')
      || null;
}

// ── App state ─────────────────────────────────────────────────
let currentTool    = 'merge';
let _resultUrl     = null;
let _resultBlob    = null;   // kept for Web Share API (not revoked after share)
let _resultFilename = 'document.pdf';
let _successGen    = 0;      // incremented on each success to cancel stale timeouts

// Returns the current result blob if it is a PDF and still in memory.
// Used by the handoff click interceptor before navigating to the next tool.
function _getResultForHandoff() {
  if (!_resultBlob || _resultBlob.type !== 'application/pdf') return null;
  return { blob: _resultBlob, filename: _resultFilename };
}

function _freeResultUrl() {
  if (_resultUrl) { URL.revokeObjectURL(_resultUrl); _resultUrl = null; }
  _resultBlob    = null;
  _resultFilename = 'document.pdf';
  // Hide share button — blob is gone, sharing would produce an empty file
  const shareBtn = id('shareBtn');
  if (shareBtn) shareBtn.style.display = 'none';
}

// Returns true only on devices/browsers that can share files natively
function _canShareFiles() {
  if (!navigator.share || !navigator.canShare) return false;
  try {
    const testFile = new File([new Uint8Array(1)], 'test.pdf', { type: 'application/pdf' });
    return navigator.canShare({ files: [testFile] });
  } catch { return false; }
}

async function _doShare() {
  if (!_resultBlob) return;
  const shareBtn = id('shareBtn');

  try {
    const file = new File([_resultBlob], _resultFilename, {
      type: _resultBlob.type || 'application/pdf',
    });
    await navigator.share({ files: [file] });

    // User completed the share (didn't cancel)
    if (shareBtn) {
      shareBtn.disabled    = true;
      shareBtn.textContent = t('sent');
    }

  } catch (err) {
    // AbortError = user dismissed the share sheet — do nothing
    if (err.name !== 'AbortError') console.warn('[PDFree] Share failed:', err.message);
  }
}

// ── Share this tool (referral link, not the output file) ──────
// Separate from _doShare()/#shareBtn above — that shares the converted
// PDF via Web Share API's file support. This shares a link to the tool
// itself so the recipient lands on the exact page that was used.

function _closeShareFallback() {
  const menu = id('shareFallbackMenu');
  const btn  = id('shareToolBtn');
  if (menu) { menu.hidden = true; menu.innerHTML = ''; }
  if (btn)  btn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', _onShareFallbackOutsideClick);
}

function _onShareFallbackOutsideClick(e) {
  const wrap = id('shareToolBtn')?.closest('.share-tool-menu-wrap');
  if (wrap && !wrap.contains(e.target)) _closeShareFallback();
}

function _openShareFallback(tool, url, msg, copyLabel, copiedLabel) {
  const menu = id('shareFallbackMenu');
  const btn  = id('shareToolBtn');
  if (!menu || !btn) return;

  trackShareTool('fallback_open', tool);

  const encodedText = encodeURIComponent(`${msg} ${url}`);
  const encodedUrl  = encodeURIComponent(url);
  menu.innerHTML = `
    <button type="button" class="share-fallback-item" id="shareCopyLink" role="menuitem">${copyLabel}</button>
    <a class="share-fallback-item" role="menuitem" target="_blank" rel="noopener" href="https://wa.me/?text=${encodedText}">WhatsApp</a>
    <a class="share-fallback-item" role="menuitem" target="_blank" rel="noopener" href="https://t.me/share/url?url=${encodedUrl}&text=${encodeURIComponent(msg)}">Telegram</a>
    <a class="share-fallback-item" role="menuitem" href="mailto:?subject=${encodeURIComponent('PDFree')}&body=${encodedText}">Email</a>
  `;
  menu.querySelector('#shareCopyLink').onclick = async () => {
    trackShareTool('copy_link', tool);
    try {
      await navigator.clipboard.writeText(url);
      const item = menu.querySelector('#shareCopyLink');
      item.textContent = copiedLabel;
      setTimeout(_closeShareFallback, 900);
    } catch { /* clipboard unavailable — leave menu open */ }
  };
  menu.querySelectorAll('a.share-fallback-item').forEach(a => {
    a.addEventListener('click', () => {
      const channel = a.href.includes('wa.me') ? 'whatsapp'
                    : a.href.includes('t.me')   ? 'telegram'
                    :                              'email';
      trackShareTool(channel, tool);
    });
  });

  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  // Defer so this click doesn't immediately trigger the outside-click listener.
  setTimeout(() => document.addEventListener('click', _onShareFallbackOutsideClick), 0);
}

async function _doShareTool(tool) {
  const btn = id('shareToolBtn');
  if (!btn) return;

  trackShareTool('open', tool);

  const url          = location.href.split('#')[0].split('?')[0];
  const msg           = btn.dataset.msg || 'PDFree';
  const copyLabel     = btn.dataset.copy   || 'Copy link';
  const copiedLabel   = btn.dataset.copied || 'Link copied!';

  if (navigator.share) {
    try {
      // Some share targets (WhatsApp, SMS, etc.) only surface `text` and
      // silently drop the separate `url` field — fold the link into the
      // text so the recipient always gets it.
      await navigator.share({ title: 'PDFree', text: `${msg} ${url}` });
      trackShareTool('success', tool);
    } catch (err) {
      if (err.name === 'AbortError') {
        trackShareTool('cancel', tool);
      } else {
        _openShareFallback(tool, url, msg, copyLabel, copiedLabel);
      }
    }
  } else {
    _openShareFallback(tool, url, msg, copyLabel, copiedLabel);
  }
}

// ── Navigation ────────────────────────────────────────────────

function goHome() {
  if (isProcessing) { showToast(t('wait_processing')); return; }
  showHomePage();                                    // visual feedback — immediate
  history.pushState({}, 'PDFree', location.pathname);
  document.title = t('home_title');
  requestAnimationFrame(() => hideAllToolOptions()); // heavy DOM — after paint
}

function showTool(tool, pushHistory = true, preFiles = null) {
  if (!TOOLS[tool]) return;
  if (isProcessing) { showToast(t('wait_processing')); return; }
  if (!TOOLS[tool].implemented) {
    showToast(TOOLS[tool].comingSoon || t('coming_soon'), 4000);
    return;
  }

  currentTool = tool;
  const lt = getLocalizedTool(TOOLS[tool]);
  trackToolOpen(tool);

  // Visual feedback — immediate so browser paints before heavy DOM work
  showToolPage();
  window.scrollTo({ top: 0, behavior: 'instant' }); // scroll before first paint
  if (pushHistory) {
    history.pushState({ tool }, lt.title, TOOL_SLUGS[tool] || `/${tool}-pdf/`);
  }

  // Heavy DOM work deferred to after first paint — keeps INP under 200ms
  requestAnimationFrame(() => {
    renderToolHeader(lt);
    setCurrentTool(tool, lt.accept);
    setDropHint(lt.accept);
    setBatchHint(lt.batch);
    id('fileInput').multiple = lt.multi;
    id('fileInput').accept   = lt.accept;
    resetState();   // already calls hideAllToolOptions internally
    if (preFiles) addFiles(preFiles);
  });
}

// Tools with inline:false have no options container in the homepage-embedded
// #toolArea (only their dedicated page HTML has it) — calling showTool() with
// preFiles for one of these would silently no-op (container missing) instead
// of rendering the tool. Route those through a real navigation + IndexedDB
// handoff instead, same mechanism already used by cross-sell result links.
function _openToolWithFiles(key, files) {
  if (TOOLS[key]?.inline === false && files[0]) {
    const href = TOOL_SLUGS[key] || `/${key}-pdf/`;
    saveHandoff(files[0], files[0].name, currentTool, href)
      .catch(() => {})
      .then(() => { location.href = href; });
    return;
  }
  showTool(key, true, files);
}

// ── State reset ───────────────────────────────────────────────

function resetState() {
  if (isProcessing) return;

  ++_successGen;   // invalidate any in-flight 1500ms download timeout
  clearFiles();
  _freeResultUrl();
  hideAllToolOptions();
  id('compressReport')?.remove();   // убираем breakdown из success card
  id('targetVerdict')?.remove();    // убираем target size verdict (Fix 3)

  id('fileList').innerHTML = '';
  hide('fileCount');
  hide('reorderHint');
  hide('successCard');
  id('privacyCleared')?.classList.remove('visible');
  const dlBtn = id('downloadBtn');
  if (dlBtn) { dlBtn.textContent = '⬇ Download'; dlBtn.disabled = false; dlBtn.style.opacity = ''; }
  const autoHint = id('successAutoHint');
  if (autoHint) autoHint.style.display = 'none';
  const shareBtn = id('shareBtn');
  if (shareBtn) { shareBtn.style.display = 'none'; shareBtn.disabled = false; }
  _closeShareFallback();
  hide('progressBar');
  hide('progressLabel');
  id('progressFill').style.width = '0%';

  hideCancelBtn();

  const btn        = id('mergeBtn');
  btn.dataset.mode = 'process';
  setButtonReady(getLocalizedTool(TOOLS[currentTool]).btn);
  setButtonDisabled();
}

// ── Success handler ───────────────────────────────────────────

function _handleSuccess({ tool, blob, desc, filename, compressionReport, batchCompressSummary, pageCounts, confidence, atlasEri }) {
  _freeResultUrl();
  _resultUrl      = URL.createObjectURL(blob);
  _resultBlob     = blob;
  _resultFilename = filename;

  // Analytics: track success with file size bucket
  trackToolSuccess(tool, { outputSize: blob.size });

  const card = id('successCard');
  card.style.display = 'block';

  // "Moment of value" — show processing time + privacy confirmation at peak loyalty
  const startMs    = getProcessStartMs();
  const elapsedRaw = startMs ? (Date.now() - startMs) / 1000 : null;
  // Show "< 1s" if under a second — "0.0s" looks broken even if correct
  const elapsedStr = elapsedRaw === null  ? null
                   : elapsedRaw < 1       ? '< 1'
                   :                        elapsedRaw.toFixed(1);
  const speedMsg = elapsedStr
    ? t('done_time', { time: elapsedStr })
    : t('done_no_time');

  setText('successTitle', speedMsg);
  setText('successDesc',  desc);

  // Capture URL at wiring time — module-level _resultUrl changes on next conversion.
  const _capturedUrl = _resultUrl;
  // Generation token — prevents stale 1500ms timeout from corrupting the next result.
  const _thisGen = ++_successGen;

  // Auto-download: trigger immediately so user gets the file without an extra click.
  // We do NOT revoke the blob here — the "Download again" button still needs it.
  trackDownload(tool, blob.size);
  recordDownload(tool);
  const _autoA = document.createElement('a');
  _autoA.href = _capturedUrl; _autoA.download = filename;
  document.body.appendChild(_autoA); _autoA.click(); document.body.removeChild(_autoA);
  const _autoDownloadAtMs = Date.now();

  // Show hint + update button to "Download again" fallback. Truncated for
  // DISPLAY only — a long OS-generated name (screenshots, camera exports)
  // would otherwise wrap the confirmation onto 3+ lines; the actual saved
  // file above still uses the full, untruncated filename.
  const _displayName = truncateMiddle(filename);
  const _hint = id('successAutoHint');
  if (_hint) { _hint.textContent = t('auto_download_hint', { filename: _displayName }); _hint.style.display = ''; }

  // Second, more transient confirmation channel — slight delay so it
  // doesn't visually compete with the auto-download/card update that
  // just happened in the same instant.
  setTimeout(() => showToast(t('download_toast', { filename: _displayName }), 3000), 400);
  const _dlBtn = id('downloadBtn');
  if (_dlBtn) {
    _dlBtn.textContent = t('download_again');
    _dlBtn.onclick = () => {
      // A manual click landing seconds after the automatic download fired
      // is the strongest available signal that the automatic one silently
      // failed (blocked, dismissed save dialog, iOS opening instead of saving).
      checkAutoDownloadRecovery(tool, _autoDownloadAtMs);
      // Disable immediately to prevent double-download on rapid re-click.
      _dlBtn.disabled = true;
      const a = document.createElement('a');
      a.href = _capturedUrl; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      // Show privacy-cleared banner 1.5s after manual download, then revoke blob.
      // Guard with generation token — if a new result arrived in < 1.5s, abort.
      setTimeout(() => {
        if (_successGen !== _thisGen) return;
        const banner = id('privacyCleared');
        if (banner) banner.classList.add('visible');
        _freeResultUrl();
        _dlBtn.textContent    = t('saved_device');
        _dlBtn.disabled       = true;
        _dlBtn.style.opacity  = '0.5';
        const shareBtn = id('shareBtn');
        if (shareBtn) shareBtn.style.display = 'none';
      }, 1500);
    };
  }

  // Wire share button — show only where Web Share API supports files
  const shareBtn = id('shareBtn');
  if (shareBtn) {
    if (_canShareFiles()) {
      shareBtn.style.display = 'inline-flex';
      shareBtn.disabled      = false;
      shareBtn.innerHTML     = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> Send';
      shareBtn.onclick = _doShare;
    } else {
      shareBtn.style.display = 'none';
    }
  }

  // Wire "Share this tool" — always shown on real success, closed/reset on each new run.
  const shareToolBtn = id('shareToolBtn');
  if (shareToolBtn) {
    _closeShareFallback();
    shareToolBtn.onclick = () => _doShareTool(tool);
  }

  const btn        = id('mergeBtn');
  btn.textContent  = t('process_again');
  btn.disabled     = false;
  btn.dataset.mode = 'reset';

  hide('progressBar');
  hide('progressLabel');
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  notifyToolSuccess(tool, { compressionReport, batchCompressSummary, confidence, atlasEri });

  if (tool === 'merge' && pageCounts?.length > 1) {
    const breakdown = pageCounts
      .map(f => `${f.name.replace(/\.pdf$/i, '')} (${f.pages}p)`)
      .join(' + ');
    const existingDesc = id('successDesc');
    if (existingDesc) existingDesc.textContent += ` — ${breakdown}`;
  }

  if (tool === 'merge' && blob.size > 10 * 1024 * 1024) {
    showToast(`📦 ${fmtSize(blob.size)} merged — consider compressing it to reduce size`, 6000);
  }

  _maybeShowPwaNudge();
}

// ── PWA install nudge ────────────────────────────────────────

function _maybeShowPwaNudge() {
  if (!_installPromptEvent) return;
  const nudge = id('pwaNudge');
  if (!nudge) return;
  nudge.style.display = 'flex';

  id('pwaNudgeBtn')?.addEventListener('click', async () => {
    nudge.style.display = 'none';
    _installPromptEvent.prompt();
    const { outcome } = await _installPromptEvent.userChoice;
    if (outcome === 'accepted') _installPromptEvent = null;
  }, { once: true });

  id('pwaNudgeSkip')?.addEventListener('click', () => {
    nudge.style.display = 'none';
    _installPromptEvent = null;
  }, { once: true });
}


// ── Button handler ────────────────────────────────────────────

// Tools with a dedicated UI module that owns button, progress, and result
// entirely on their own. app.js must NOT call doProcess for these — doing so
// would fire _runStub (no registry runner) and show a "coming soon" toast.
//
// NOTE: registering in capture phase does NOT help when both listeners are on
// the same element (#mergeBtn). Order is determined by registration time, not
// phase. The guard below is the reliable fix.
//
// To add a new self-managed tool: append its key here + build its own UI module.
const SELF_MANAGED_TOOLS = new Set(['ocr', 'compare', 'pdf2pdfa']);

// "Remember my settings" — only tools with a registered presetFilter are
// eligible (see toolRegistrations.js). The checkbox lives in that tool's
// own options panel as #<tool>RememberCheck; each XOptions container is
// mounted in the DOM simultaneously (one visible at a time), so the id
// is tool-prefixed to avoid duplicate-id collisions across panels.
function _maybeSavePreset(tool, params) {
  const filter = getPresetFilter(tool);
  if (!filter) return;
  if (!id(`${tool}RememberCheck`)?.checked) return;
  const filtered = filter(params);
  if (filtered) savePreset(tool, filtered);
}

function _onMergeBtnClick() {
  const mode = id('mergeBtn').dataset.mode || 'process';
  if (mode === 'reset') {
    resetState();
    return;
  }

  if (SELF_MANAGED_TOOLS.has(currentTool)) return;

  // Registry dispatch — no more if-else per tool
  const { params, error } = collectToolParams(currentTool);
  if (error) { showToast(error); return; }
  _maybeSavePreset(currentTool, params);
  checkAndRecordConversion(currentTool, selectedFiles[0]);  // fire-and-forget
  trackToolStart(currentTool);
  doProcess(currentTool, params);
}

// ── Events ────────────────────────────────────────────────────

function initEvents() {
  // Landing pages use <a class="logo"> without id="logo" — skip SPA handler,
  // let the <a href> navigate normally. Use ?. to avoid crash on null.
  id('logo')?.addEventListener('click',   goHome);
  id('logo')?.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    goHome();
  });

  document.querySelectorAll('[data-tool]').forEach(el => {
    // <body data-tool> is for routing only — never a click target.
    if (el.tagName === 'BODY') return;
    // <a> elements navigate via their href — nav links and standalone tool
    // cards that need their own page (draw-on-pdf, etc.). Only <div>/<button>
    // tool cards do SPA navigation.
    if (el.tagName === 'A') return;
    const handler = (e) => {
      if (e.type === 'keydown' && e.key !== 'Enter') return;
      e.preventDefault();
      showTool(el.dataset.tool, true);
    };
    el.addEventListener('click',   handler);
    el.addEventListener('keydown', handler);
  });

  id('mergeBtn')?.addEventListener('click', _onMergeBtnClick);

  const cancelBtn = id('cancelBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    trackToolCancel(currentTool);
    cancelProcess(currentTool);
  });

  id('dropZone').addEventListener('click', e => {
    // Skip synthetic event from fileInput.click() itself bubbling back up.
    if (e.target === id('fileInput')) return;
    // Skip clicks on the choose-files label — the native <label for> association
    // already activated the input; calling .click() again causes a double-open
    // that immediately closes the picker (invisible bug on iOS).
    if (e.target.closest('#chooseFilesBtn')) return;
    id('fileInput').click();
  });
  id('dropZone').addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    id('fileInput').click();
  });
  // chooseFilesBtn is a <label for="fileInput"> — the browser opens the picker
  // natively without any JS. No click handler needed here.

  // Zone B: после первого файла
  document.addEventListener('pdfree:files-added', () => {
    // Analytics: track first file per tool session
    if (selectedFiles.length === 1) {
      trackFileAdded(currentTool, selectedFiles[0]?.size ?? 0);
    }
  });

  // Tool-specific UI init — dispatched through registry
  document.addEventListener('pdfree:files-added', () => {
    initToolOptions(currentTool, [...selectedFiles]);
  });

  // Re-init after a file is removed so the active tool always uses the current files[0].
  // Without this, tools like OCR keep a stale _file reference to the removed file.
  document.addEventListener('pdfree:file-removed', () => {
    initToolOptions(currentTool, [...selectedFiles]);
    if (currentTool === 'compress' || currentTool === 'compress-email') {
      cancelCompressScan();
    }
    if (currentTool === 'merge') {
      cancelMergeScan();
    }
  });

  // Background compress scan: runs in worker as soon as a file is dropped,
  // so recommendations and preset auto-selection appear before the user clicks Compress.
  // Real race condition found while auditing this for the 2026-08-20/21
  // testing pass: startCompressScan(file) is async and can take real time
  // on a large file — if the user removes that file and drops a different
  // one before the scan resolves, the OLD file's scan (wrong page count,
  // wrong recommended preset, wrong encrypted badge) would render onto the
  // panel for the NEW file, since renderWorkerScanReport only checked that
  // the panel was visible, never that the report still matched the current
  // selection. Guarded by capturing the file reference before awaiting and
  // discarding the result if it no longer matches selectedFiles[0].
  document.addEventListener('pdfree:files-added', async () => {
    if (currentTool !== 'compress' && currentTool !== 'compress-email') return;
    const file = selectedFiles[0];
    if (!file) return;
    const report = await startCompressScan(file);
    if (report && selectedFiles[0] === file) renderWorkerScanReport(report);
  });

  // Background merge page-count scan: runs as soon as files are added to the merge list,
  // so "contract.pdf · 2.4 MB · 12p" appears in the file list before the user clicks Merge.
  document.addEventListener('pdfree:files-added', async () => {
    if (currentTool !== 'merge') return;
    updateMergeDefaultFilename([...selectedFiles]);
    const unscanned = selectedFiles.filter(f => f._mergePageCount == null);
    if (unscanned.length === 0) return;
    const results = await startMergeBatchScan(unscanned);
    results.forEach(({ index, pageCount }) => {
      // Store unconditionally so 0-page/corrupt files don't retry on every files-added event
      if (unscanned[index]) unscanned[index]._mergePageCount = pageCount;
    });
    renderList(true);
  });

  // Re-init after silent owner-password decryption completes (files.js dispatches this).
  // First init ran before WASM finished — decrypted bytes weren't available yet.
  document.addEventListener('pdfree:file-decrypted', () => {
    initToolOptions(currentTool, [...selectedFiles]);
  });

  // Merge's process button depends partly on the shared watermark-removal toggle
  // (see files.js's _updateMeta) — refresh it the moment the toggle changes, not
  // just on the next file add/remove.
  document.addEventListener('pdfree:wm-remove-changed', () => renderList(true));

  document.addEventListener('pdfree:success', e => _handleSuccess(e.detail));

  // Cross-sell handoff: when user clicks a link with data-handoff and a result
  // PDF is still in memory, save it to IndexedDB before navigating so the
  // destination tool page can auto-load it without requiring a re-upload.
  document.addEventListener('click', e => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return; // let new-tab intent through
    const link = e.target.closest('a[data-handoff]');
    if (!link) return;
    const result = _getResultForHandoff();
    if (!result) return;              // blob already revoked → normal navigation
    e.preventDefault();
    saveHandoff(result.blob, result.filename, currentTool, link.href)
      .catch(() => {})               // IDB failure → still navigate
      .then(() => { location.href = link.href; });
  });

  // Compress scan findings arrive from worker mid-compression — update the
  // scan banner in #compressOptions with real data instead of the placeholder.
  document.addEventListener('pdfree:scan-report', e => {
    renderWorkerScanReport(e.detail.report);
  });

  window.addEventListener('popstate', e => {
    if (e.state?.tool) showTool(e.state.tool, false);
    else goHome();
  });
}

// ── Intent search ────────────────────────────────────────────

// Tool order for chips: first slot changes based on pending file count
const CHIP_TOOLS_DEFAULT  = ['merge', 'compress', 'split', 'pdf2jpg', 'protect', 'pdf2word'];
const CHIP_TOOLS_ONE_FILE = ['compress', 'split', 'pdf2jpg', 'protect', 'merge'];
const CHIP_TOOLS_MULTI    = ['merge', 'compress', 'split', 'pdf2jpg', 'protect'];

function initSearch() {
  const searchEl    = id('toolSearch');
  const resultEl    = id('searchResult');
  const missEl      = id('searchMiss');
  const popularEl   = id('searchPopular');
  const srIcon      = id('srIcon');
  const srName      = id('srName');
  const srDesc      = id('srDesc');
  const srFileInput   = id('srFileInput');
  const srDropHint    = id('srDropHint');
  const srInfoLabel   = id('srInfoLabel');
  const srPendingFile = id('srPendingFile');

  // Hero drop zone refs
  const heroSection     = id('hero');
  const heroDetected    = id('heroDetected');
  const heroBanner      = id('heroBanner');
  const heroChipsLabel  = id('heroChipsLabel');
  const heroDropZone    = id('heroDropZone');
  const heroFileInput   = id('heroFileInput');
  const heroDropIdle    = id('heroDropIdle');
  const heroDropReady   = id('heroDropReady');
  const heroFileName    = id('heroFileName');
  const heroClearFile   = id('heroClearFile');
  const heroDropLabel   = id('heroDropLabel');
  const heroDropOr      = id('heroDropOr');
  const heroDropChoose  = id('heroDropChooseBtn');
  const searchOrLabel   = id('searchOrLabel');

  if (!searchEl) return;
  if (!heroDropZone) return;  // safety: only exists on homepage

  // Localize search result card strings
  searchEl.placeholder = t('search_placeholder');
  searchEl.setAttribute('aria-label', t('search_aria'));
  if (srDropHint)  srDropHint.textContent  = t('search_drop');

  // Localize hero drop zone strings
  if (heroDropLabel)  heroDropLabel.textContent  = t('hero_drop');
  if (heroDropOr)     heroDropOr.textContent     = t('hero_or');
  if (heroDropChoose) heroDropChoose.textContent = t('hero_drop_choose');
  if (searchOrLabel)  searchOrLabel.textContent  = t('hero_or_search');

  const lang  = document.documentElement.lang || 'en';
  const index = buildIndex(TOOLS, lang, window.PDFREE_LOCALE?.search_tags);

  // ── Hero drop zone ──────────────────────────────────────────────
  let _pendingFiles     = null;
  let _pendingKind      = null;   // 'pdf' | 'image' — which flow _pendingFiles belongs to
  let _heroHintEl       = null;   // created once, reused
  let _bannerDismissed  = false;  // stays true once user closes banner this session

  // Hero accepts PDF or image (JPG/PNG) — routes to the right tool by type.
  // MIME type is trusted first (reliable in Chromium/Firefox drag&drop and
  // most file pickers); extension is the fallback for the cases noted
  // elsewhere in this file where MIME can be empty (e.g. iOS PDFs).
  const _isPdfFile   = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  const _isImageFile = f => /^image\/(jpeg|png)$/.test(f.type) || /\.(jpe?g|png)$/i.test(f.name);
  function _classifyHeroFiles(files) {
    if (files.every(_isPdfFile))   return 'pdf';
    if (files.every(_isImageFile)) return 'image';
    return 'mixed';
  }

  id('heroBannerClose')?.addEventListener('click', () => {
    _bannerDismissed = true;
    if (heroBanner) heroBanner.hidden = true;
  });

  function _fmtSize(bytes) {
    return bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function _showHeroDetected(files) {
    if (!heroDetected) return;

    heroDetected.innerHTML = '';

    const kind = _classifyHeroFiles(files); // 'mixed' can't reach here — _setHeroFiles rejects it first

    // Multi-file: summary card + type-appropriate recs grid
    if (files.length > 1) {
      const totalSize = files.reduce((s, f) => s + f.size, 0);
      const summary = document.createElement('div');
      summary.className = 'hero-det-card';
      const row = document.createElement('div');
      row.className = 'hero-det-row';
      const iconEl = document.createElement('span');
      iconEl.className = 'hero-det-icon';
      iconEl.textContent = kind === 'image' ? '🖼️' : '📄';
      const metaEl = document.createElement('div');
      metaEl.className = 'hero-det-meta';
      const nameEl = document.createElement('span');
      nameEl.className = 'hero-det-name';
      nameEl.textContent = t(kind === 'image' ? 'hero_multi_image_label' : 'hero_multi_pdf_label', { n: files.length });
      const sizeEl = document.createElement('span');
      sizeEl.className = 'hero-det-size';
      sizeEl.textContent = _fmtSize(totalSize);
      metaEl.append(nameEl, sizeEl);
      const changeBtn = document.createElement('button');
      changeBtn.type = 'button';
      changeBtn.className = 'hero-det-replace';
      changeBtn.textContent = 'Change';
      changeBtn.addEventListener('click', () => heroFileInput.click());
      row.append(iconEl, metaEl, changeBtn);
      summary.appendChild(row);
      heroDetected.appendChild(summary);
      heroDetected.appendChild(kind === 'image'
        ? _buildRecsGrid(['jpg2pdf'], 'jpg2pdf')
        : _buildRecsGrid(['merge', 'compress', 'protect', 'split'], 'merge'));
      heroDetected.hidden = false;
      return;
    }

    // Single file: card immediately, grid appended after scan (PDF only —
    // an image has nothing to scan, its recs grid is immediate too)
    const file = files[0];
    const card = document.createElement('div');
    card.className = 'hero-det-card';

    const row = document.createElement('div');
    row.className = 'hero-det-row';

    const iconEl = document.createElement('span');
    iconEl.className = 'hero-det-icon';
    iconEl.textContent = kind === 'image' ? '🖼️' : '📄';

    const metaEl = document.createElement('div');
    metaEl.className = 'hero-det-meta';
    const nameEl = document.createElement('span');
    nameEl.className = 'hero-det-name';
    nameEl.textContent = file.name;
    const sizeEl = document.createElement('span');
    sizeEl.className = 'hero-det-size';
    sizeEl.textContent = _fmtSize(file.size);
    metaEl.append(nameEl, sizeEl);

    const badgesEl = document.createElement('div');
    badgesEl.className = 'hero-det-badges';

    if (kind === 'image') {
      row.append(iconEl, metaEl);
      card.appendChild(row);
      heroDetected.appendChild(card);
      heroDetected.appendChild(_buildRecsGrid(['jpg2pdf'], 'jpg2pdf'));
      heroDetected.hidden = false;
      return;
    }

    const loadingBadge = document.createElement('span');
    loadingBadge.className = 'hero-det-badge';
    loadingBadge.textContent = 'Analyzing…';
    badgesEl.appendChild(loadingBadge);

    const replaceBtn = document.createElement('button');
    replaceBtn.type = 'button';
    replaceBtn.className = 'hero-det-replace';
    replaceBtn.textContent = 'Replace';
    replaceBtn.addEventListener('click', () => heroFileInput.click());

    row.append(iconEl, metaEl, badgesEl, replaceBtn);
    card.appendChild(row);
    heroDetected.appendChild(card);
    heroDetected.hidden = false;

    _scanHeroFile(file, card, badgesEl);
  }

  async function _scanHeroFile(file, card, badgesEl) {
    try {
      await loadPdfLib();
      const { PDFDocument, PDFName, PDFRawStream } = window.PDFLib;
      const buf = await file.arrayBuffer();
      const pdf = await PDFDocument.load(buf, { ignoreEncryption: true });
      const pages       = pdf.getPageCount();
      const isEncrypted = pdf.isEncrypted;
      const hasForms    = pdf.catalog.has(PDFName.of('AcroForm'));

      // Detect scanned / image-dominant PDF (same heuristic as compressUI)
      let imageBytes = 0, imageCount = 0;
      pdf.context.enumerateIndirectObjects().forEach(([, obj]) => {
        if (!(obj instanceof PDFRawStream)) return;
        if (obj.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') {
          imageBytes += obj.contents.length;
          imageCount++;
        }
      });
      const isScanned = imageCount > 0 && (imageBytes / file.size) > 0.5;

      if (!card.isConnected) return;
      badgesEl.innerHTML = '';

      const _badge = (text, mod) => {
        const b = document.createElement('span');
        b.className = 'hero-det-badge' + (mod ? ' hero-det-badge--' + mod : '');
        b.textContent = text;
        badgesEl.appendChild(b);
      };
      _badge(isScanned ? 'Scanned PDF' : 'Text PDF', isScanned ? 'scan' : '');
      _badge(`${pages} page${pages !== 1 ? 's' : ''}`);
      _badge(isEncrypted ? '🔒 Protected' : 'No password', isEncrypted ? 'warn' : 'ok');
      if (!isScanned) {
        _badge(hasForms ? 'Fillable form' : 'No forms', hasForms ? 'info' : 'ok');
        _badge('Not scanned', 'ok');
      }

      // Contextual recommendations grid
      let tools, bestMatch;
      if (isScanned) {
        tools = ['ocr', 'compress', 'split', 'pdf2jpg'];   bestMatch = 'ocr';
      } else if (hasForms) {
        tools = ['fill', 'protect', 'compress', 'pdf2word']; bestMatch = 'fill';
      } else if (isEncrypted) {
        tools = ['protect', 'compress', 'split', 'pdf2word']; bestMatch = null;
      } else {
        tools = ['compress', 'pdf2word', 'merge', 'split']; bestMatch = null;
      }

      heroDetected.appendChild(_buildRecsGrid(tools, bestMatch));
    } catch {
      if (!card.isConnected) return;
      badgesEl.innerHTML = '';
      const b = document.createElement('span');
      b.className = 'hero-det-badge';
      b.textContent = 'Could not analyze';
      badgesEl.appendChild(b);
      heroDetected.appendChild(_buildRecsGrid(['compress', 'pdf2word', 'merge', 'split'], null));
    }
  }

  function _buildRecsGrid(tools, bestMatchKey) {
    const REC_CTA = {
      compress: 'Compress',
      pdf2word: 'Convert to Word',
      merge:    'Merge',
      split:    'Split',
      ocr:      'Extract text',
      pdf2jpg:  'Export images',
      protect:  'Protect',
      fill:     'Fill form',
    };
    const wrapper = document.createElement('div');
    const labelEl = document.createElement('p');
    labelEl.className = 'hero-chips-label';
    labelEl.textContent = "What's best to do with this file?";
    wrapper.appendChild(labelEl);
    const grid = document.createElement('div');
    grid.className = 'hero-recs';
    tools.forEach(key => {
      const tool = TOOLS[key];
      if (!tool) return;
      const isBest = key === bestMatchKey;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hero-rec-card' + (isBest ? ' hero-rec-card--best' : '');
      const iconEl = document.createElement('span');
      iconEl.className = 'hero-rec-icon';
      iconEl.textContent = tool.icon || '📄';
      const nameEl = document.createElement('span');
      nameEl.className = 'hero-rec-name';
      nameEl.textContent = tool.title;
      btn.append(iconEl, nameEl);
      if (isBest) {
        const matchEl = document.createElement('span');
        matchEl.className = 'hero-rec-match';
        matchEl.textContent = '⭐ Best Match';
        btn.appendChild(matchEl);
      }
      const ctaEl = document.createElement('span');
      ctaEl.className = 'hero-rec-cta';
      ctaEl.textContent = (REC_CTA[key] || tool.title) + ' →';
      btn.appendChild(ctaEl);
      btn.addEventListener('click', () => {
        if (_pendingFiles) showTool(key, true, _pendingFiles);
      });
      grid.appendChild(btn);
    });
    wrapper.appendChild(grid);
    return wrapper;
  }

  function _getHintEl() {
    if (!_heroHintEl) {
      _heroHintEl = document.createElement('p');
      _heroHintEl.className = 'hero-drop-zone__hint';
      _heroHintEl.addEventListener('click', () => {
        const key = _heroHintEl.dataset.toolKey;
        if (key && _pendingFiles) {
          trackChipClick(key, 'file-first');
          showTool(key, true, _pendingFiles);
        }
      });
      heroDropZone.appendChild(_heroHintEl);
    }
    return _heroHintEl;
  }

  function _setHeroFiles(files, source = 'drop') {
    const kind = _classifyHeroFiles(files);
    if (kind === 'mixed') {
      showToast(t('hero_mixed_files'));
      return;
    }
    _pendingFiles = files;
    _pendingKind  = kind;
    heroFileInput.value = ''; // reset so re-selecting the same file fires change
    heroDropIdle.hidden = true;
    heroFileName.textContent = files.length === 1
      ? t('hero_file_single', { name: files[0].name, size: _fmtSize(files[0].size) })
      : t('hero_file_multi',  { n: files.length });
    heroDropReady.hidden = false;
    heroDropZone.classList.add('has-file');
    if (heroSection) heroSection.classList.add('has-file');

    // Recommendation hint for multi-file context (clickable shortcut)
    const hintEl = _getHintEl();
    if (files.length > 1) {
      const recEntry = index.find(e => e.key === (kind === 'image' ? 'jpg2pdf' : 'merge'));
      if (recEntry) {
        hintEl.textContent = t('hero_hint_multi', { tool: `${recEntry.icon} ${recEntry.displayName}` });
        hintEl.dataset.toolKey = recEntry.key;
        hintEl.style.cursor = 'pointer';
        hintEl.hidden = false;
      }
    } else {
      hintEl.hidden = true;
      hintEl.dataset.toolKey = '';
    }

    trackHeroFileSelect(files.length, source);
    if (heroBanner && !_bannerDismissed) heroBanner.hidden = false;
    if (heroChipsLabel) heroChipsLabel.hidden = true;
    _showHeroDetected(files);
    _renderChips();
    searchEl.focus();
  }

  function _clearHeroFiles() {
    _pendingFiles = null;
    _pendingKind  = null;
    heroDropIdle.hidden = false;
    heroDropReady.hidden = true;
    heroDropZone.classList.remove('has-file');
    if (heroSection) heroSection.classList.remove('has-file');
    if (heroBanner)     heroBanner.hidden     = true;
    if (heroChipsLabel) heroChipsLabel.hidden = true;
    if (heroDetected)   heroDetected.hidden   = true;
    heroFileInput.value = '';
    if (_heroHintEl) _heroHintEl.hidden = true;
    _renderChips();
    // Re-render result card if open: remove file name, restore "Choose File →"
    if (_activeResult) _applyResult(_activeResult);
  }

  heroFileInput.addEventListener('change', () => {
    // accept=".pdf,image/*" filters the OS picker, but a picker can still
    // return a mix (some let you multi-select across an "All files" toggle)
    // — _setHeroFiles rejects that explicitly rather than guessing.
    const files = Array.from(heroFileInput.files);
    if (files.length) _setHeroFiles(files, 'button');
  });

  heroClearFile.addEventListener('click', _clearHeroFiles);

  heroDropZone.addEventListener('dragover', e => {
    e.preventDefault();
    heroDropZone.classList.add('drag-over');
  });
  heroDropZone.addEventListener('dragleave', e => {
    if (!heroDropZone.contains(e.relatedTarget)) heroDropZone.classList.remove('drag-over');
  });
  heroDropZone.addEventListener('drop', e => {
    e.preventDefault();
    heroDropZone.classList.remove('drag-over');
    const allFiles = Array.from(e.dataTransfer.files);
    const files = allFiles.filter(f => _isPdfFile(f) || _isImageFile(f));
    if (files.length) {
      _setHeroFiles(files, 'drop');
    } else if (allFiles.length) {
      // Previously a silent no-op — dropping e.g. a .docx just reset back to
      // idle with zero explanation. Real bug, found via drag&drop testing
      // (accept= only filters the native picker dialog, never drag&drop).
      showToast(t('hero_unsupported_file'));
    }
  });

  // ── File picker (shown when multi-files + single-file tool clicked) ─
  function _showFilePicker(entry) {
    heroDropReady.hidden = true;

    const pick = document.createElement('div');
    pick.className = 'hero-drop-zone__pick';

    const label = document.createElement('p');
    label.className = 'hero-drop-zone__pick-label';
    label.textContent = `${entry.icon} ${entry.displayName} — ${t('hero_pick_which')}`;
    pick.appendChild(label);

    const filesRow = document.createElement('div');
    filesRow.className = 'hero-drop-zone__pick-files';
    _pendingFiles.forEach(file => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hero-drop-zone__pick-file';
      btn.textContent = file.name;
      btn.title = file.name;
      btn.addEventListener('click', () => {
        pick.remove();
        heroDropReady.hidden = false;
        trackChipClick(entry.key, 'file-first');
        showTool(entry.key, true, [file]);
      });
      filesRow.appendChild(btn);
    });
    pick.appendChild(filesRow);

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'hero-drop-zone__pick-back';
    backBtn.textContent = t('hero_pick_back');
    backBtn.addEventListener('click', () => {
      pick.remove();
      heroDropReady.hidden = false;
    });
    pick.appendChild(backBtn);

    heroDropZone.appendChild(pick);
  }

  // ── Chips (re-rendered on file state change) ─────────────────────
  function _renderChips() {
    popularEl.innerHTML = '';
    const multiFiles = _pendingFiles && _pendingFiles.length > 1;
    const toolOrder = _pendingFiles
      ? (multiFiles ? CHIP_TOOLS_MULTI : CHIP_TOOLS_ONE_FILE)
      : CHIP_TOOLS_DEFAULT;

    toolOrder.forEach(key => {
      const entry = index.find(e => e.key === key);
      if (!entry) return;
      const chip = document.createElement('button');

      // Visual: when multi files, dim chips that don't support multi
      let cls = 'search-chip';
      if (_pendingFiles) cls += ' search-chip--active';
      if (multiFiles && !entry.multi) cls += ' search-chip--single-only';
      chip.className = cls;
      const singleSuffix = (multiFiles && !entry.multi)
        ? ` (${t('hero_chip_one_file')})`
        : '';
      chip.textContent = `${entry.icon} ${entry.displayName}${singleSuffix}`;

      chip.addEventListener('click', () => {
        if (_pendingFiles) {
          if (!entry.multi && _pendingFiles.length > 1) {
            // Single-file tool + multiple files → let user pick which file
            _showFilePicker(entry);
            return;
          }
          trackChipClick(key, 'file-first');
          showTool(key, true, _pendingFiles);
          return;
        }
        trackChipClick(key, 'search-first');
        searchEl.value = entry.displayName;
        _applyResult(entry);
      });
      popularEl.appendChild(chip);
    });
  }

  _renderChips();

  // ── Intent search ────────────────────────────────────────────────
  let _debounce = null;
  let _activeResult = null;

  // Narrowing candidate list: sits between the search input and the applied-
  // result card. A query can match several tools at once (e.g. "pdf2" or
  // "pdf to" plausibly means any of pdf2word/pdf2excel/pdf2ppt/pdf2md/
  // pdf2jpg) — rather than silently guessing one and hiding the rest, the
  // top guess is still applied to the result card below (so the fast path
  // — type, drop a file — stays instant for the common single-match case),
  // and every candidate is also listed here as a click-to-pick alternative.
  // The same element/rendering doubles as the empty-query-miss fallback:
  // when nothing matches at all, it's populated with the popular-tools
  // list instead of leaving the user looking at blank space.
  const candidatesEl = document.createElement('div');
  candidatesEl.className = 'search-candidates';
  candidatesEl.hidden = true;
  candidatesEl.setAttribute('role', 'listbox');
  candidatesEl.setAttribute('aria-label', t('search_candidates_label'));
  resultEl.insertAdjacentElement('beforebegin', candidatesEl);

  const MAX_CANDIDATES = 5;

  function _renderCandidates(entries, flow) {
    candidatesEl.innerHTML = '';
    const shown = entries.slice(0, MAX_CANDIDATES);
    if (!shown.length) { candidatesEl.hidden = true; return; }
    shown.forEach(entry => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'search-chip';
      chip.setAttribute('role', 'option');
      chip.textContent = `${entry.icon} ${entry.displayName}`;
      chip.addEventListener('click', () => {
        trackChipClick(entry.key, flow);
        searchEl.value = entry.displayName;
        _applyResult(entry);
        candidatesEl.hidden = true;
      });
      candidatesEl.appendChild(chip);
    });
    candidatesEl.hidden = false;
  }

  searchEl.addEventListener('input', () => {
    clearTimeout(_debounce);
    _debounce = setTimeout(() => _runSearch(searchEl.value), 200);
  });

  function _runSearch(query) {
    const q = query.trim();
    if (q.length < 2) { _clearResult(); return; }

    const results = search(q, index);
    if (results.length) {
      trackSearchQuery(q, results.length);
      _applyResult(results[0]);
      // The list is for genuinely plausible alternatives, not every hit —
      // scores below 50 are the typo-tolerance/description tiers, which
      // exist so a real typo still resolves to *something*, but are too
      // weak to display as a second option once a confident (score ≥50)
      // match already exists (e.g. "merge" exact-matches merge at 100, but
      // also coincidentally fuzzy-matches "large" in compress-email's tags
      // at a distance of 2 — real but not worth surfacing next to a 100).
      const listable = results.filter(r => r.score >= 50);
      if (listable.length > 1) _renderCandidates(listable, 'search-candidate');
      else candidatesEl.hidden = true;
    } else {
      trackSearchMiss(q);
      trackMiss(q);
      resultEl.hidden = true;
      _activeResult   = null;
      // A short/early query (e.g. still mid-word) isn't a real "miss" yet —
      // only label it as not-found once it's long enough to plausibly be a
      // finished, deliberate attempt. Either way, show the popular tools
      // instead of leaving the user looking at nothing.
      if (q.length >= 4) {
        missEl.textContent = t('search_miss', { q });
        missEl.hidden = false;
      } else {
        missEl.hidden = true;
      }
      const fallback = CHIP_TOOLS_DEFAULT.map(key => index.find(e => e.key === key)).filter(Boolean);
      _renderCandidates(fallback, 'search-fallback');
    }
  }

  function _applyResult(entry) {
    _activeResult = entry;
    if (srDesc) srDesc.textContent = entry.desc || '';
    srFileInput.accept    = entry.accept || '.pdf,application/pdf';
    srFileInput.multiple  = !!entry.multi;

    // If user already has a file in the hero zone: fold the CTA into the title
    // itself (e.g. "🔄 Rotate PDF") — entry.btn already carries the icon prefix,
    // so hide the separate icon span to avoid showing it twice.
    if (_pendingFiles) {
      const label = _pendingFiles.length === 1
        ? `📄 ${_pendingFiles[0].name}`
        : `📄 ${_pendingFiles.length} PDFs`;
      if (srPendingFile) { srPendingFile.textContent = label; srPendingFile.hidden = false; }
      if (srIcon) srIcon.hidden = true;
      srName.textContent = entry.btn || t('search_start');
      if (srDropHint)  srDropHint.hidden = true;
    } else {
      if (srPendingFile) srPendingFile.hidden = true;
      if (srIcon) { srIcon.hidden = false; srIcon.textContent = entry.icon; }
      srName.textContent = entry.displayName;
      if (srDropHint)  srDropHint.hidden = false;
    }

    resultEl.hidden = false;
    missEl.hidden   = true;
  }

  function _clearResult() {
    resultEl.hidden = true;
    missEl.hidden   = true;
    candidatesEl.hidden = true;
    _activeResult   = null;
    if (srPendingFile) srPendingFile.hidden = true;
    if (srDropHint)  srDropHint.hidden = false;
  }

  // Whole info row (icon + name + desc) is a <label for="srFileInput"> — clicking
  // it opens the native file picker by default. When a file is already pending,
  // intercept and launch the tool directly instead of re-prompting for a file.
  if (srInfoLabel) {
    srInfoLabel.addEventListener('click', e => {
      if (_pendingFiles && _activeResult) {
        e.preventDefault();
        if (!_activeResult.multi && _pendingFiles.length > 1) {
          _showFilePicker(_activeResult);
          return;
        }
        trackChipClick(_activeResult.key, 'file-first');
        _openToolWithFiles(_activeResult.key, _pendingFiles);
      }
    });
  }

  // File chosen via search result card (no pending file path)
  srFileInput.addEventListener('change', () => {
    const files = Array.from(srFileInput.files);
    srFileInput.value = ''; // reset so re-selecting the same file fires change again
    if (!files.length || !_activeResult) return;
    trackSearchSelect(searchEl.value.trim(), _activeResult.key);
    _openToolWithFiles(_activeResult.key, files);
  });

  // Drag-and-drop on search result card drop zone
  srDropHint.addEventListener('dragover', e => {
    e.preventDefault();
    srDropHint.classList.add('drag-over');
  });
  srDropHint.addEventListener('dragleave', () => srDropHint.classList.remove('drag-over'));
  srDropHint.addEventListener('drop', e => {
    e.preventDefault();
    srDropHint.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
    if (!files.length || !_activeResult) return;
    trackSearchSelect(searchEl.value.trim(), _activeResult.key);
    _openToolWithFiles(_activeResult.key, files);
  });

  // When files are loaded in the hero zone, intercept nav and featured-card
  // clicks so the tool opens inline with the pending files instead of
  // navigating away and losing them.
  // Tools with inline:false in config require dedicated-page HTML and
  // must always navigate (they are not intercepted here).
  document.addEventListener('click', e => {
    if (!_pendingFiles) return;
    const anchor = e.target.closest('a[data-tool]');
    if (!anchor) return;
    const tool = anchor.dataset.tool;
    if (!TOOLS[tool] || !TOOLS[tool].implemented) return;
    if (TOOLS[tool].inline === false) return;
    e.preventDefault();
    showTool(tool, true, _pendingFiles);
  }, true); // capture phase: runs before inline onclick, after analytics
}

// ── Initial routing ──────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  checkReturnVisit();   // check if user returned shortly after downloading
  // Detect tool via data-tool attribute or URL — both CSP-safe.
  const requestedTool = _detectTool();

  // Show #toolArea immediately on tool landing pages, before any other init.
  if (requestedTool) showToolPage();

  initFileListeners();
  initEvents();
  initRageClickDetection();
  _initPWA();
  _prefetchHeavyAssets();

  if (requestedTool && TOOLS[requestedTool]) {
    showTool(requestedTool, false);
    // Restore a handoff blob from the previous tool page (if any).
    // IDB resolves asynchronously — by then showTool's RAF has already run,
    // so addFiles() fires into a fully-initialised tool UI.
    restoreHandoff().then(handoff => {
      if (!handoff) return;
      const file = new File([handoff.blob], handoff.filename, { type: 'application/pdf' });
      requestAnimationFrame(() => {
        addFiles([file]);
        showToast(`📂 PDF ready — continue without re-uploading`);
      });
    }).catch(() => {});
  } else {
    showHomePage();
    initSearch();
    initHomepageEngagement();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
});

// ── Lazy prefetch of heavy assets ────────────────────────────
// pdf.worker.min.js (1 MB) and pdf.min.js (~500 KB) are NOT loaded
// on page start. They are prefetched with requestIdleCallback so the
// browser downloads them in the background when the CPU is idle,
// after the critical path (FCP, LCP) is done.
// This gives 2-3s faster First Contentful Paint on 3G/4G while
// ensuring the assets are already cached when the user opens a PDF tool.

function _prefetchHeavyAssets() {
  if (!('requestIdleCallback' in window)) return;  // Safari 15- fallback: just skip
  requestIdleCallback(() => {
    // Resolve absolute URL to /js/ folder regardless of current page location.
    // CRITICAL for localized subfolders — without this, prefetch hits /de/js/...
    const baseUrl = new URL('./', import.meta.url).toString();
    // Prefetch via <link rel="prefetch"> — tells browser to fetch when idle,
    // but not execute. The actual loading is triggered by _ensurePdfJs() / loadPdfJs().
    for (const path of [
      'vendor/pdf.worker.min.js',
    ]) {
      try {
        const link = document.createElement('link');
        link.rel  = 'prefetch';
        link.href = baseUrl + path;
        link.as   = 'script';
        document.head.appendChild(link);
      } catch { /* non-critical */ }
    }
  }, { timeout: 3000 });
}

// ── PWA Install prompt ────────────────────────────────────────
// Capture the browser's beforeinstallprompt and show our own
// tasteful prompt after the first successful tool use.
// We never show it on first visit — only after demonstrated value.

let _installPromptEvent = null;

function _initPWA() {
  // Register service worker
  if ('serviceWorker' in navigator) {
    // Capture BEFORE registration — distinguishes first-install from update.
    // On first install: controller is null → hadController = false → no reload.
    // On update: controller already exists → hadController = true → reload.
    const hadController = !!navigator.serviceWorker.controller;

    // SW uses skipWaiting() so it activates immediately (no "waiting" phase).
    // controllerchange fires when the new SW takes over all tabs via clients.claim().
    // This is the reliable signal to reload and serve fresh files.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;  // first-time install, not an update
      if (isProcessing) {
        // User is mid-operation — show banner, let them choose when to reload
        _showUpdateBanner(null);
      } else {
        window.location.reload();
      }
    });

    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(reg => {
      // Fallback: show banner if a waiting SW already exists on page load
      // (can happen if skipWaiting() was not in the older SW version)
      if (reg.waiting && navigator.serviceWorker.controller) {
        _showUpdateBanner(reg);
      }

      // The browser only checks '/sw.js' for a new version on navigation —
      // a tab left open for hours/days (no reload, no new nav) can sit on a
      // stale worker indefinitely, since nothing here re-triggers the check.
      // A real report: merge-pdf silently doing nothing on both Windows
      // Chrome and Mac Safari, but working fine in a fresh incognito window
      // — same stale-SW shape on two unrelated engines/OSes, ruled out as
      // an app bug once it reproduced on neither Chromium nor WebKit here.
      // Re-check whenever the tab regains focus (the common "left it open,
      // came back later" case) and on a slow interval as a backstop for
      // tabs that are simply never backgrounded.
      const _recheckForUpdate = () => reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') _recheckForUpdate();
      });
      // 30 min backstop for tabs that are simply never backgrounded.
      // Codebase convention here is self-rescheduling setTimeout, not
      // setInterval (see eslint globals — setInterval isn't allow-listed).
      (function _scheduleRecheck() {
        setTimeout(() => { _recheckForUpdate(); _scheduleRecheck(); }, 30 * 60 * 1000);
      })();

      // ── Share Target: retrieve file sent via OS share sheet ─
      const sharedUuid = new URL(location.href).searchParams.get('shared');
      if (sharedUuid && navigator.serviceWorker.controller) {
        history.replaceState(null, '', location.pathname);
        _retrieveSharedFile(sharedUuid);
      }
    }).catch(err => console.warn('[SW] Registration failed:', err));
  }

  // ── File Handler API (launchQueue) — open PDFs clicked in OS ─
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async launchParams => {
      if (!launchParams.files.length) return;
      try {
        const files = await Promise.all(launchParams.files.map(h => h.getFile()));
        if (files.length) addFiles(files);
      } catch { /* file handle revoked or permission denied */ }
    });
  }

  // Capture the deferred install prompt
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    _installPromptEvent = e;
    trackInstallPrompt('available');
  });

  window.addEventListener('appinstalled', () => {
    _installPromptEvent = null;
    trackInstallPrompt('accepted');
    id('pwaPrompt')?.remove();
  });
}

// ── Update banner ─────────────────────────────────────────────

function _showUpdateBanner(reg) {
  const banner = id('swUpdateBanner');
  if (!banner || banner.dataset.shown) return;
  banner.dataset.shown = '1';
  banner.style.display = 'flex';

  id('swUpdateNow')?.addEventListener('click', () => {
    banner.style.display = 'none';
    if (reg?.waiting) {
      // Older path: SW is waiting — tell it to skip waiting, then reload on controllerchange
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      navigator.serviceWorker.addEventListener('controllerchange',
        () => location.reload(), { once: true });
    } else {
      // New path: SW already activated (skipWaiting in install) — just reload
      location.reload();
    }
  }, { once: true });

  id('swUpdateLater')?.addEventListener('click', () => {
    banner.style.display = 'none';
  }, { once: true });
}

// ── Share Target file retrieval ───────────────────────────────

function _retrieveSharedFile(uuid) {
  const channel = new MessageChannel();
  channel.port1.onmessage = ({ data }) => {
    if (data.files?.length) addFiles(data.files);
  };
  navigator.serviceWorker.controller.postMessage(
    { type: 'GET_SHARED_FILE', uuid },
    [channel.port2]
  );
}

// ── Global error handlers ────────────────────────────────────
// Catches errors that no individual try/catch handles — worker crashes,
// CDN load failures, unexpected exceptions. Closed over `currentTool`
// so no window global needed.
window.addEventListener('unhandledrejection', event => {
  console.error('[PDFree] Unhandled rejection:', event.reason);
  trackToolError(currentTool, 'unhandled_rejection');
});

window.addEventListener('error', event => {
  if (!event.message) return;          // some browser events fire without message
  console.error('[PDFree] Uncaught error:', event.message);
  trackToolError(currentTool, 'js_error');
});

