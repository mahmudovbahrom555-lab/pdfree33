// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  app.js — Main entry point
//  Роутинг, состояние, склейка всех модулей
// ============================================================

import { TOOLS, APP_VERSION }                     from './config.js';
import { id, hide, setText }                      from './utils.js';

// Fires on every load — open DevTools Console to confirm active version.
// If you see an old version here after deploying, clear SW cache:
//   DevTools → Application → Service Workers → Unregister → Ctrl+F5
console.info(`[PDFree] v${APP_VERSION} loaded — rotate implemented: ${TOOLS.rotate?.implemented}`);
import { showHomePage, showToolPage,
         renderToolHeader, setButtonReady,
         setButtonDisabled, hideCancelBtn,
         showToast, setDropHint }                 from './ui.js';
import { initFileListeners, setCurrentTool,
         clearFiles, selectedFiles }              from './files.js';
import { doProcess, isProcessing,
         cancelProcess,
         getProcessStartMs }                      from './processor.js';
import { hideAllToolOptions, initToolOptions,
         collectToolParams, notifyToolSuccess }  from './toolRegistry.js';
import './toolRegistrations.js';                 // side-effect: registers all tools
import { trackToolStart, trackToolSuccess,
         trackToolCancel, trackFileAdded,
         trackToolOpen, trackInstallPrompt,
         trackToolError }                         from './analytics.js';
import { t }                                      from './i18n.js';

// ── Module-level constants ────────────────────────────────────
const TOOL_SLUGS = {
  jpg2pdf:  '/jpg2pdf/',   pdf2jpg:  '/pdf2jpg/',
  merge:    '/merge-large-pdf-files/', split:    '/split-pdf/',
  compress: '/compress-large-pdf-free/', extract: '/extract-pdf/',
  watermark:'/watermark-pdf/', pagenum: '/add-page-numbers-to-pdf/',
  meta:     '/meta-pdf/', redact:   '/redact-pdf/',
  rotate:   '/rotate-pdf/', protect: '/protect-pdf/',
  fill:     '/fill/',
};

// ── App state ─────────────────────────────────────────────────
let currentTool    = 'merge';
let _resultUrl     = null;
let _resultBlob    = null;   // kept for Web Share API (not revoked after share)
let _resultFilename = 'document.pdf';

function _freeResultUrl() {
  if (_resultUrl) { URL.revokeObjectURL(_resultUrl); _resultUrl = null; }
  _resultBlob    = null;
  _resultFilename = 'document.pdf';
  // Hide share button — blob is gone, sharing would produce an empty file
  const shareBtn = id('shareBtn');
  if (shareBtn) shareBtn.style.display = 'none';
}

// Returns true only on devices/browsers that can share files natively
function _canShareFiles(blob) {
  if (!navigator.canShare) return false;
  try {
    const testFile = new File([blob.slice(0, 0)], 'test.pdf', { type: 'application/pdf' });
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

// ── Navigation ────────────────────────────────────────────────

function goHome() {
  if (isProcessing) { showToast(t('wait_processing')); return; }
  showHomePage();                                    // visual feedback — immediate
  history.pushState({}, 'PDFree', location.pathname);
  document.title = 'PDFree — Free PDF Tools, No Limits';
  requestAnimationFrame(() => hideAllToolOptions()); // heavy DOM — after paint
}

function showTool(tool, pushHistory = true) {
  if (!TOOLS[tool]) return;
  if (isProcessing) { showToast(t('wait_processing')); return; }
  if (!TOOLS[tool].implemented) {
    showToast(TOOLS[tool].comingSoon || t('coming_soon'), 4000);
    return;
  }

  currentTool = tool;
  const t = TOOLS[tool];
  trackToolOpen(tool);

  // Visual feedback — immediate so browser paints before heavy DOM work
  showToolPage();
  if (pushHistory) {
    history.pushState({ tool }, t.title, TOOL_SLUGS[tool] || `/${tool}-pdf/`);
  }

  // Heavy DOM work deferred to after first paint — keeps INP under 200ms
  requestAnimationFrame(() => {
    renderToolHeader(t);
    setCurrentTool(tool, t.accept);
    setDropHint(t.accept);
    id('fileInput').multiple = t.multi;
    id('fileInput').accept   = t.accept;
    resetState();   // already calls hideAllToolOptions internally
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// ── State reset ───────────────────────────────────────────────

function resetState() {
  if (isProcessing) return;

  clearFiles();
  _freeResultUrl();
  hideAllToolOptions();
  id('compressReport')?.remove();  // убираем breakdown из success card

  id('fileList').innerHTML = '';
  hide('fileCount');
  hide('reorderHint');
  hide('successCard');
  id('privacyCleared')?.classList.remove('visible');
  const dlBtn = id('downloadBtn');
  if (dlBtn) { dlBtn.textContent = '⬇ Download'; dlBtn.disabled = false; dlBtn.style.opacity = ''; }
  const shareBtn = id('shareBtn');
  if (shareBtn) { shareBtn.style.display = 'none'; shareBtn.disabled = false; }
  hide('progressBar');
  hide('progressLabel');
  id('progressFill').style.width = '0%';

  hideCancelBtn();

  const btn        = id('mergeBtn');
  btn.dataset.mode = 'process';
  setButtonReady(TOOLS[currentTool].btn);
  setButtonDisabled();
}

// ── Success handler ───────────────────────────────────────────

function _handleSuccess({ tool, blob, desc, filename, compressionReport }) {
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

  id('downloadBtn').onclick = () => {
    const a = document.createElement('a');
    a.href = _resultUrl; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    // Show privacy-cleared banner 1.5s after download, then revoke blob so file is truly gone
    setTimeout(() => {
      const banner = id('privacyCleared');
      if (banner) banner.classList.add('visible');
      _freeResultUrl();                          // revoke blob URL — file now truly unreadable
      const btn = id('downloadBtn');
      if (btn) {
        btn.textContent = t('saved_device');
        btn.disabled    = true;
        btn.style.opacity = '0.5';
      }
      // Share button is now useless — blob is gone
      const shareBtn = id('shareBtn');
      if (shareBtn) shareBtn.style.display = 'none';
    }, 1500);
  };

  // Wire share button — show only where Web Share API supports files
  const shareBtn = id('shareBtn');
  if (shareBtn) {
    if (_canShareFiles(blob)) {
      shareBtn.style.display = 'inline-flex';
      shareBtn.disabled      = false;
      shareBtn.innerHTML     = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> Send';
      shareBtn.onclick = _doShare;
    } else {
      shareBtn.style.display = 'none';
    }
  }

  const btn        = id('mergeBtn');
  btn.textContent  = t('process_again');
  btn.disabled     = false;
  btn.dataset.mode = 'reset';

  hide('progressBar');
  hide('progressLabel');
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  notifyToolSuccess(tool, { compressionReport });

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
  }, { once: true });
}


// ── Button handler ────────────────────────────────────────────

function _onMergeBtnClick() {
  const mode = id('mergeBtn').dataset.mode || 'process';
  if (mode === 'reset') {
    resetState();
    return;
  }

  // Registry dispatch — no more if-else per tool
  const { params, error } = collectToolParams(currentTool);
  if (error) { showToast(error); return; }
  trackToolStart(currentTool);
  doProcess(currentTool, params);
}

// ── Events ────────────────────────────────────────────────────

function initEvents() {
  // Landing pages use <a class="logo"> without id="logo" — skip SPA handler,
  // let the <a href> navigate normally. Use ?. to avoid crash on null.
  id('logo')?.addEventListener('click',   goHome);
  id('logo')?.addEventListener('keydown', e => e.key === 'Enter' && goHome());

  document.querySelectorAll('[data-tool]').forEach(el => {
    // On standalone tool pages (PDFREE_INITIAL_TOOL set), <a> nav links should
    // navigate normally via href — do not hijack with SPA. SPA stays on homepage.
    if (el.tagName === 'A' && window.PDFREE_INITIAL_TOOL) return;
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
    // Skip if the click was synthetically dispatched by fileInput.click() itself —
    // that call creates a bubbling event back up to dropZone, causing a double-open
    // that immediately closes the file dialog (invisible to the user).
    if (e.target === id('fileInput')) return;
    id('fileInput').click();
  });
  id('dropZone').addEventListener('keydown', e => e.key === 'Enter' && id('fileInput').click());
  id('chooseFilesBtn').addEventListener('click', e => { e.stopPropagation(); id('fileInput').click(); });

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

  document.addEventListener('pdfree:success', e => _handleSuccess(e.detail));

  window.addEventListener('popstate', e => {
    if (e.state?.tool) showTool(e.state.tool, false);
    else goHome();
  });
}

// ── Initial routing ──────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initFileListeners();
  initEvents();
  _initPWA();
  _prefetchHeavyAssets();

  // Priority 1: global var set by SEO sub-pages (e.g. compress-pdf/index.html)
  // Priority 2: URL path  (/compress-pdf/ → compress, /jpg2pdf/ → jpg2pdf)
  // Priority 3: legacy query param  ?tool=compress  (backwards compat)
  let requestedTool = window.PDFREE_INITIAL_TOOL || null;
  if (!requestedTool) {
    const match = location.pathname.match(/\/([a-z0-9]+)(?:-pdf)?\/?$/);
    if (match && TOOLS[match[1]]) requestedTool = match[1];
  }
  if (!requestedTool) {
    requestedTool = new URLSearchParams(location.search).get('tool');
  }
  if (requestedTool && TOOLS[requestedTool]) {
    showTool(requestedTool, false);
  } else {
    showHomePage();
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
    navigator.serviceWorker.register('/sw.js')
      .catch(err => console.warn('[SW] Registration failed:', err));
    // No controllerchange reload — hash-versioned URLs (?v=HASH) on app.js and
    // worker.js guarantee fresh assets on each deploy without a forced reload.
    // The old reload caused a "flash": tool visible briefly then hidden after SW
    // took control and called showHomePage() on the second load.
  }

  // Capture the deferred prompt
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

