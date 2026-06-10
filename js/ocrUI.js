// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

import { loadPdfJs } from './pdf2jpgUI.js';
import { t } from './i18n.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const TESSERACT_CDN       = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const TEXT_CHAR_THRESHOLD = 100; // min chars across sampled pages → classified as text PDF (items-count was 5 — too low)

// Non-Latin scripts where Tesseract confidence is structurally lower even for correct text.
// Used for two purposes:
//   1. Lower confidence threshold (45 vs 55) so valid glyphs aren't discarded.
//   2. Skip OCR quality score display — calibrated Latin tiers (90/80/60%) mislead
//      users of these scripts until per-language baselines are established from real data.
// Note: kor (Korean) included — Hangul confidence patterns match other complex scripts.
const COMPLEX_LANGS = new Set(['ara', 'jpn', 'chi_sim', 'chi_tra', 'kor', 'hin', 'tha']);

// ── State ────────────────────────────────────────────────────────────────────
let _file            = null;
let _isTextPdf       = false;
let _ocrReady        = false;
let _loading         = false;
let _generation      = 0;        // incremented on each new file; stale _analyse calls bail early
let _deferredInstall = null;
let _selectedLang    = 'eng';
let _downloadAsTxt   = false;

// ── Last result — stored so the download button in success card can re-trigger
let _lastResultBlob  = null;   // Blob for re-download from success card
let _lastResultName  = null;   // Download filename

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredInstall = e;
});

// ── Language definitions ─────────────────────────────────────────────────────
const LANGUAGES = {
  european: [
    { code: 'eng', name: 'English',    size: '4 MB',  isDefault: true },
    { code: 'fra', name: 'French',     size: '5 MB'  },
    { code: 'deu', name: 'German',     size: '6 MB'  },
    { code: 'spa', name: 'Spanish',    size: '5 MB'  },
    { code: 'ita', name: 'Italian',    size: '5 MB'  },
    { code: 'por', name: 'Portuguese', size: '5 MB'  },
    { code: 'rus', name: 'Russian',    size: '5 MB'  },
    { code: 'nld', name: 'Dutch',      size: '5 MB'  },
    { code: 'pol', name: 'Polish',     size: '5 MB'  },
    { code: 'tur', name: 'Turkish',    size: '4 MB'  },
  ],
  complex: [
    { code: 'ara',     name: 'Arabic',                size: '1.5 MB', rtl: true },
    { code: 'jpn',     name: 'Japanese',              size: '10 MB'  },
    { code: 'chi_sim', name: 'Chinese (Simplified)',  size: '15 MB'  },
    { code: 'chi_tra', name: 'Chinese (Traditional)', size: '15 MB'  },
    { code: 'kor',     name: 'Korean',                size: '5 MB'   },
    { code: 'hin',     name: 'Hindi',                 size: '5 MB'   },
    { code: 'tha',     name: 'Thai',                  size: '4 MB'   },
  ],
};


// ── Public API ───────────────────────────────────────────────────────────────
export function initOcrOptions(file) {
  const el = document.getElementById('ocrOptions');
  if (!el) return;
  el.style.display = '';
  _file    = file;
  _loading = true;
  el.innerHTML = _spinnerHTML('Analysing PDF…');
  _analyse(file, el);
}

export function hideOcrOptions() {
  const el = document.getElementById('ocrOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  _file = null; _isTextPdf = false; _loading = false;
  _lastResultBlob = null; _lastResultName = null;
}

export function getOcrParams() {
  return {
    hasFile:    !!_file,
    loading:    _loading,
    isOcrReady: _ocrReady,
    isTextPdf:  _isTextPdf,
  };
}

// ── Auto-load Tesseract for returning users ───────────────────────────────────
async function _autoLoadIfInstalled() {
  let flag;
  try { flag = localStorage.getItem('pdfree_ocr_installed'); } catch { return; }
  if (flag !== '1') return;
  if (window.Tesseract) { _ocrReady = true; return; }
  try {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src     = TESSERACT_CDN;
      s.onload  = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    _ocrReady = true;
  } catch {
    // CDN unreachable — clear flag so install button shows normally
    try { localStorage.removeItem('pdfree_ocr_installed'); } catch { /* private browsing */ }
  }
}

// ── Analysis ─────────────────────────────────────────────────────────────────
async function _analyse(file, container) {
  const myGen = ++_generation;
  try {
    await loadPdfJs();
    if (myGen !== _generation) return;

    const buf = await file.arrayBuffer();
    let pdfDoc;
    try {
      pdfDoc = await window.pdfjsLib.getDocument({
        data: new Uint8Array(buf), verbosity: 0, disableJavaScript: true, ignoreEncryption: true,
      }).promise;

      // Sample up to 3 pages — hybrid PDFs may have blank first page.
      // Count total characters (not items): a scanned PDF may have a few header
      // items (<20 chars total) while a real text PDF has hundreds per page.
      const samplePages = Math.min(3, pdfDoc.numPages);
      let totalChars = 0;
      for (let p = 1; p <= samplePages; p++) {
        const pg = await pdfDoc.getPage(p);
        const tc = await pg.getTextContent();
        totalChars += tc.items.reduce((s, i) => s + i.str.trim().length, 0);
      }
      _isTextPdf = totalChars >= TEXT_CHAR_THRESHOLD;
    } finally {
      pdfDoc?.destroy();
    }

    if (myGen !== _generation) return;

    // Auto-load Tesseract only for scanned PDFs — text PDFs never need it
    if (!_isTextPdf) await _autoLoadIfInstalled();

    if (myGen !== _generation) return;

    _loading = false;
    _renderUI(container);
    _bindMergeBtn();
  } catch (err) {
    if (myGen !== _generation) return;
    _loading = false;
    container.innerHTML = _errorHTML(err.message);
  }
}

// ── UI rendering ─────────────────────────────────────────────────────────────
function _langSelectHTML() {
  const euOptions = LANGUAGES.european
    .map(l => `<option value="${l.code}"${l.isDefault ? ' selected' : ''}>${l.name} &middot; ${l.size}</option>`)
    .join('\n        ');
  const cxOptions = LANGUAGES.complex
    .map(l => `<option value="${l.code}">${l.name} &middot; ${l.size}</option>`)
    .join('\n        ');

  return `
  <div id="ocrLangBlock" style="margin-top:12px;padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--surface);">
    <label for="ocrLangSelect" style="display:block;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:var(--text3);margin-bottom:8px;">
      Document language
    </label>
    <select id="ocrLangSelect" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font-size:15px;font-family:inherit;margin-bottom:0;cursor:pointer;">
      <optgroup label="European languages">
        ${euOptions}
      </optgroup>
      <optgroup label="Complex scripts (larger download)">
        ${cxOptions}
      </optgroup>
    </select>
    <div id="complexLangBlock" style="display:none;margin-top:10px;">
      <p style="margin:0 0 8px;font-size:12px;color:var(--text3);">Selected language requires a larger download:</p>
      <button id="btnDownloadLang" type="button" style="
        display:block;width:100%;padding:10px 14px;
        background:var(--surface);color:var(--green);border:1.5px solid var(--green);border-radius:8px;
        font-size:13px;font-weight:600;cursor:pointer;text-align:center;">
        Download language data
      </button>
      <div id="langDownloadStatus" style="display:none;font-size:12px;color:var(--text3);margin-top:6px;"></div>
    </div>
  </div>`;
}

function _txtCheckboxHTML() {
  return `
  <div style="margin-top:10px;display:flex;align-items:center;gap:8px;">
    <input type="checkbox" id="ocrTxtCheck" style="width:16px;height:16px;cursor:pointer;accent-color:var(--green);">
    <label for="ocrTxtCheck" style="font-size:13px;color:var(--text2);cursor:pointer;">Also download .txt copy</label>
  </div>`;
}

function _renderUI(container) {
  if (_isTextPdf) {
    container.innerHTML = `
      <div style="padding:16px;border:1px solid var(--green);border-radius:10px;background:var(--surface);">
        <p style="margin:0 0 12px;font-size:14px;color:var(--text);">
          &#x2713; This PDF has a text layer &mdash; extracting directly (no OCR needed)
        </p>
        ${_txtCheckboxHTML()}
      </div>`;
    _bindCheckbox();
    _bindMergeBtn();
    return;
  }

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent.toLowerCase()) && !window.MSStream;

  if (_ocrReady) {
    _ocrReady = true;
    container.innerHTML = `
      <div id="ocrInstallBlock" style="padding:16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);">
        <p style="margin:0 0 12px;font-size:14px;color:var(--text);">This PDF is scanned &mdash; OCR required to extract text.</p>
        <div id="ocrReadyMsg" style="padding:10px 14px;border:1px solid var(--green);border-radius:8px;font-size:13px;color:var(--text);background:var(--surface);">
          &#x2713; OCR ready &mdash; click &ldquo;Make PDF Searchable&rdquo; to start
        </div>
        ${_langSelectHTML()}
        ${_txtCheckboxHTML()}
      </div>`;
    _bindLangSelect();
    _bindCheckbox();
    return;
  }

  container.innerHTML = `
    <div id="ocrInstallBlock" style="padding:16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);">
      <p style="margin:0 0 12px;font-size:14px;color:var(--text);">This PDF is scanned &mdash; OCR required to extract text.</p>

      ${isIos ? '' : `
      <button id="btnInstallOcr" type="button" style="
        display:block;width:100%;padding:12px 16px;
        background:var(--green);color:#fff;border:none;border-radius:8px;
        font-size:14px;font-weight:600;cursor:pointer;text-align:center;">
        Install OCR PDF &middot; ~17 MB
      </button>`}

      <div id="iosInstallHint" style="display:${isIos ? '' : 'none'};padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);margin-top:8px;">
        <p style="margin:0 0 10px;font-size:13px;color:var(--text);">To install the app: tap Share &rarr; Add to Home Screen</p>
        <button id="btnDownloadOcrOnly" type="button" style="
          display:block;width:100%;padding:10px 14px;
          background:var(--surface);color:var(--green);border:1.5px solid var(--green);border-radius:8px;
          font-size:13px;font-weight:600;cursor:pointer;text-align:center;">
          Download OCR Engine &middot; ~17 MB
        </button>
      </div>

      <div id="ocrReadyMsg" style="display:none;padding:10px 14px;margin-top:12px;border:1px solid var(--green);border-radius:8px;font-size:13px;color:var(--text);background:var(--surface);">
        &#x2713; OCR ready &mdash; click &ldquo;Make PDF Searchable&rdquo; to start
      </div>

      ${_langSelectHTML()}
      ${_txtCheckboxHTML()}
    </div>`;

  const btnInstall  = document.getElementById('btnInstallOcr');
  const btnDownload = document.getElementById('btnDownloadOcrOnly');
  if (btnInstall)  btnInstall.addEventListener('click',  _installOcr);
  if (btnDownload) btnDownload.addEventListener('click', _loadTesseract);
  _bindLangSelect();
  _bindCheckbox();
}

function _bindCheckbox() {
  const cb = document.getElementById('ocrTxtCheck');
  if (!cb) return;
  cb.checked = _downloadAsTxt;
  cb.addEventListener('change', () => { _downloadAsTxt = cb.checked; });
}

function _bindLangSelect() {
  const sel = document.getElementById('ocrLangSelect');
  if (!sel) return;
  sel.value = _selectedLang;
  sel.addEventListener('change', e => {
    const val = e.target.value;
    _selectedLang = val;   // always set immediately so OCR uses the right model
    const complexLang = LANGUAGES.complex.find(l => l.code === val);
    if (complexLang) {
      _showComplexLangDownload(complexLang);
    } else {
      _hideComplexLangDownload();
    }
  });
}

function _showComplexLangDownload(lang) {
  const block = document.getElementById('complexLangBlock');
  const btn   = document.getElementById('btnDownloadLang');
  if (!block || !btn) return;
  block.style.display = '';
  btn.disabled = false;
  btn.textContent = `Download ${lang.name} · ${lang.size}`;
  btn.onclick = () => {
    // Tesseract.js v5 downloads lang data from CDN automatically when worker starts.
    // We just mark the selection here; actual download happens at OCR time.
    _selectedLang = lang.code;
    btn.disabled = true;
    btn.textContent = `${lang.name} selected ✔`;
    const status = document.getElementById('langDownloadStatus');
    if (status) {
      status.style.display = '';
      status.textContent = 'Language data will be downloaded when OCR starts';
    }
  };
}

function _hideComplexLangDownload() {
  const block = document.getElementById('complexLangBlock');
  if (block) block.style.display = 'none';
}

// ── OCR engine install ────────────────────────────────────────────────────────
async function _installOcr() {
  if (_deferredInstall) {
    _deferredInstall.prompt();
    await _deferredInstall.userChoice;
    _deferredInstall = null;
  }
  await _loadTesseract();
}

async function _loadTesseract() {
  if (window.Tesseract) { _ocrReady = true; _showOcrReady(); return; }

  const btn = document.getElementById('btnInstallOcr') || document.getElementById('btnDownloadOcrOnly');
  if (btn) { btn.disabled = true; btn.textContent = 'Downloading OCR engine…'; }

  try {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TESSERACT_CDN;
      s.onload  = resolve;
      s.onerror = () => reject(new Error('Failed to load Tesseract.js'));
      document.head.appendChild(s);
    });

    _ocrReady = true;
    localStorage.setItem('pdfree_ocr_installed', '1');
    _showOcrReady();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Install OCR PDF · ~17 MB'; }
    _showToast('Could not load OCR engine: ' + err.message);
  }
}

function _showOcrReady() {
  const installBtn = document.getElementById('btnInstallOcr');
  if (installBtn) installBtn.style.display = 'none';
  const dlBtn = document.getElementById('btnDownloadOcrOnly');
  if (dlBtn) dlBtn.style.display = 'none';
  const readyMsg = document.getElementById('ocrReadyMsg');
  if (readyMsg) readyMsg.style.display = '';

  const mergeBtn = document.getElementById('mergeBtn');
  if (mergeBtn) mergeBtn.disabled = false;
}

// ── Main button binding ──────────────────────────────────────────────────────
function _bindMergeBtn() {
  const btn = document.getElementById('mergeBtn');
  if (!btn || btn._ocrBound) return;
  btn._ocrBound = true;

  btn.textContent = _isTextPdf ? 'Extract Text' : 'Make PDF Searchable';

  // Capture phase so this fires before app.js bubble-phase listener,
  // allowing stopImmediatePropagation to prevent doProcess (stub runner).
  btn.addEventListener('click', async e => {
    if (!_file) return;
    const mode = btn.dataset.mode || 'process';
    if (mode === 'reset') return;

    // Gate: only intercept when OCR is the active tool.
    // If OCR engine is not installed, show a toast and bail — do NOT fall through
    // to the bubble-phase handler, which would call doProcess() on a stub runner.
    if (!_isTextPdf && !_ocrReady) {
      _showToast(t('install_ocr_first'));
      e.stopImmediatePropagation();
      return;
    }

    e.stopImmediatePropagation();

    btn.disabled = true;
    _updateProgress(5, 'Starting…');
    const bar = document.getElementById('progressBar');
    if (bar) bar.hidden = false;

    try {
      if (_isTextPdf) {
        const text = await _extractTextDirect(_file);
        // Store for re-download from success card
        _lastResultBlob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        _lastResultName = _file.name.replace(/\.pdf$/i, '.txt');
        _downloadText(text, _file.name);
        _showSuccess('Text extracted and saved to your device.');
      } else {
        const myGen = ++_generation;
        const { ocrPages, fullText, avgConfidence } = await _runOcr(_file, myGen);
        if (myGen !== _generation) return;   // new file dropped mid-OCR — discard partial result
        // Build searchable PDF
        _updateProgress(95, 'Building searchable PDF…');
        const pdfBytes = await _buildSearchablePdf(_file, ocrPages, _selectedLang);
        // Store for re-download from success card
        _lastResultBlob = new Blob([pdfBytes], { type: 'application/pdf' });
        _lastResultName = _file.name.replace(/\.pdf$/i, '_searchable.pdf');
        _downloadPdf(pdfBytes, _file.name);
        if (_downloadAsTxt && fullText) {
          _downloadText(fullText, _file.name);
        }
        const qualityLabel = _ocrQualityLabel(avgConfidence, _selectedLang);
        _showSuccess(`Searchable PDF saved — you can now select and copy text in any PDF reader.${qualityLabel}`);
      }
    } catch (err) {
      _showToast('Error: ' + err.message);
    } finally {
      btn.disabled = false;
      if (bar) bar.hidden = true;
    }
  }, true);
}

function _showSuccess(desc) {
  const sc = document.getElementById('successCard');
  if (!sc) return;

  sc.style.display = 'block';
  const title = document.getElementById('successTitle');
  if (title) title.textContent = 'Done!';
  const descEl = document.getElementById('successDesc');
  if (descEl) descEl.textContent = desc;

  // Wire the download button so user can re-download from the success card.
  // app.js's _handleSuccess is never called by the OCR tool (no pdfree:success
  // event is dispatched), so we wire the button directly here.
  const dlBtn = document.getElementById('downloadBtn');
  if (dlBtn && _lastResultBlob && _lastResultName) {
    dlBtn.disabled = false;
    dlBtn.style.opacity = '';
    dlBtn.textContent = '⬇ Download';
    dlBtn.onclick = () => {
      const url = URL.createObjectURL(_lastResultBlob);
      const a   = document.createElement('a');
      a.href     = url;
      a.download = _lastResultName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      dlBtn.textContent = t('saved_device');
      dlBtn.disabled    = true;
      dlBtn.style.opacity = '0.5';
    };
  }

  sc.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── OCR pipeline ─────────────────────────────────────────────────────────────
const MAX_OCR_PX   = 3000;
const MAX_FILE_MB  = 200;
// Mobile Safari aggressively kills tabs under memory pressure.
// Limit page count on iOS/iPadOS to prevent mid-job tab termination.
// Users can still OCR longer documents by splitting the PDF first.
const MAX_PAGES_IOS = 30;

async function _runOcr(file, gen) {
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    throw new Error(
      `File is ${Math.round(file.size / 1024 / 1024)} MB — OCR is limited to ${MAX_FILE_MB} MB. ` +
      `Split the PDF first to process it in parts.`
    );
  }
  await loadPdfJs();
  const buf    = await file.arrayBuffer();
  let pdfDoc;
  try {
    pdfDoc = await window.pdfjsLib.getDocument({
      data: new Uint8Array(buf), verbosity: 0, disableJavaScript: true, ignoreEncryption: true,
    }).promise;
  } catch (err) {
    throw new Error('Could not open PDF: ' + err.message, { cause: err });
  }

  // Guard: warn and cap on Mobile Safari to avoid tab kill under memory pressure
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIos && pdfDoc.numPages > MAX_PAGES_IOS) {
    const proceed = window.confirm(
      `This PDF has ${pdfDoc.numPages} pages. Mobile Safari may run out of memory on large documents.\n\n` +
      `Only the first ${MAX_PAGES_IOS} pages will be processed. ` +
      `Split the PDF first to process remaining pages.\n\nContinue?`
    );
    if (!proceed) {
      pdfDoc.destroy();
      throw new Error('Cancelled by user.');
    }
  }

  const langLabel = _getLangName(_selectedLang);
  let worker;
  try {
  worker = await window.Tesseract.createWorker(_selectedLang, 1, {
    logger: m => {
      if (m.status === 'recognizing text') {
        _updateProgress(Math.round(m.progress * 100), `Recognizing text (${langLabel})…`);
      } else if (m.status && m.progress != null) {
        // Shows download/init progress for language data
        _updateProgress(Math.round(m.progress * 15), `Loading ${langLabel}…`);
      }
    },
  });

  const total      = isIos ? Math.min(pdfDoc.numPages, MAX_PAGES_IOS) : pdfDoc.numPages;
  const ocrPages   = [];
  const txtPages   = [];
  const pageErrors = [];
  let   confSum    = 0;
  let   confCount  = 0;

  for (let p = 1; p <= total; p++) {
    const basePct = 15 + Math.round((p - 1) / total * 75);
    _updateProgress(basePct, `OCR page ${p} of ${total} · ${langLabel}`);

    let canvas;
    try {
      const page = await pdfDoc.getPage(p);

      // Adaptive scale — cap at MAX_OCR_PX to limit memory on mobile
      const vp0 = page.getViewport({ scale: 1 });
      let scale = 2;
      if (vp0.width * 2 > MAX_OCR_PX || vp0.height * 2 > MAX_OCR_PX) {
        scale = Math.min(MAX_OCR_PX / vp0.width, MAX_OCR_PX / vp0.height);
      }
      const vp = page.getViewport({ scale });

      canvas        = document.createElement('canvas');
      canvas.width  = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      const result = await worker.recognize(canvas);
      // Adaptive confidence threshold — see COMPLEX_LANGS constant.
      // Latin (eng/fra/…): 55% — Tesseract is reliable; below 55% is almost always garbage.
      // Complex (ara/jpn/kor/hin/tha/…): 45% — correct glyphs routinely score 40–50%,
      // so 55% would silently discard real text for these scripts.
      const MIN_CONF = COMPLEX_LANGS.has(_selectedLang) ? 45 : 55;
      const words    = result.data.words.flatMap(w => {
        const text = w.text.normalize('NFC').trim();
        if (!text || w.confidence < MIN_CONF) return [];
        confSum += w.confidence;
        confCount++;
        return [{ text, confidence: w.confidence, bbox: w.bbox }];
      });

      // Store viewport transform — used in _buildSearchablePdf to map canvas→PDF coords
      // correctly for any page rotation (0, 90, 180, 270°)
      ocrPages.push({
        pageNum: p, words,
        canvasW: canvas.width, canvasH: canvas.height,
        vpTransform: Array.from(vp.transform),
      });

      // Build plain text from paragraph/line structure
      const paragraphs = result.data.paragraphs
        .map(para => para.lines
          .map(line => line.words.map(w => w.text).join(' ').trim())
          .filter(Boolean)
          .join('\n'))
        .filter(Boolean);
      txtPages.push(`--- Page ${p} ---\n${paragraphs.join('\n\n') || result.data.text.trim()}`);

    } catch (pageErr) {
      // One bad page must not kill the whole job — skip and continue
      pageErrors.push({ page: p, error: pageErr.message });
    } finally {
      // Always release canvas memory regardless of success or error
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    }

    // Bail early if user started a new OCR (new file selected or button re-clicked)
    if (gen !== _generation) break;
  }

  if (gen === _generation) _updateProgress(92, 'OCR complete');

  // Surface per-page failures as a non-fatal warning toast
  if (pageErrors.length > 0) {
    const nums = pageErrors.map(e => e.page).join(', ');
    _showToast(t('warn_page_fail', { page: nums, msg: pageErrors[0].error }));
  }

  const avgConfidence = confCount > 0 ? Math.round(confSum / confCount) : null;
  return { ocrPages, fullText: txtPages.join('\n\n'), avgConfidence };
  } finally {
    // Always terminate — prevents thread leak if recognize() or render() throws
    await worker?.terminate();
    pdfDoc.destroy();
  }
}

function _getLangName(code) {
  const all = [...LANGUAGES.european, ...LANGUAGES.complex];
  const found = all.find(l => l.code === code);
  return found ? found.name : code;
}

function _ocrQualityLabel(avgConf, lang) {
  // Complex-script confidence is structurally lower even for correct text — the Latin
  // tiers (90/80/60%) would show "Poor" for valid Arabic/Japanese output and mislead
  // users. Skip the label until per-language baselines are established from real data.
  if (avgConf === null || COMPLEX_LANGS.has(lang)) return '';
  let tier;
  if (avgConf >= 90)      tier = `Excellent (${avgConf}%)`;
  else if (avgConf >= 80) tier = `Good (${avgConf}%)`;
  else if (avgConf >= 60) tier = `Fair (${avgConf}%)`;
  else                    tier = `Poor (${avgConf}%) — consider rescanning at higher DPI`;
  return ` · OCR quality: ${tier}`;
}

// ── Direct text extraction (text-layer PDFs) ─────────────────────────────────
async function _extractTextDirect(file) {
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    throw new Error(
      `File is ${Math.round(file.size / 1024 / 1024)} MB — text extraction is limited to ${MAX_FILE_MB} MB.`
    );
  }
  await loadPdfJs();
  const buf    = await file.arrayBuffer();
  const pdfDoc = await window.pdfjsLib.getDocument({
    data: new Uint8Array(buf), verbosity: 0, disableJavaScript: true, ignoreEncryption: true,
  }).promise;

  const texts = [];
  const total = pdfDoc.numPages;
  for (let p = 1; p <= total; p++) {
    _updateProgress(Math.round(p / total * 90), `Extracting page ${p} of ${total}…`);
    const page = await pdfDoc.getPage(p);
    const tc   = await page.getTextContent();
    // Group items into lines by Y position (items within 4pt of same baseline → same line).
    // 4pt tolerance handles baseline variation in real PDFs without merging adjacent lines.
    const lines = [];
    for (const item of tc.items) {
      if (!item.str.trim()) continue;
      const iy = Math.round(item.transform[5]);
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - iy) <= 4) {
        last.words.push(item.str);
      } else {
        lines.push({ y: iy, words: [item.str] });
      }
    }
    // Sort lines top-to-bottom (higher Y = higher on page in PDF coords)
    lines.sort((a, b) => b.y - a.y);
    const text = lines.map(l => l.words.join(' ')).join('\n');
    texts.push(`--- Page ${p} ---\n${text.trim()}`);
  }
  pdfDoc.destroy();
  _updateProgress(100, 'Done');
  return texts.join('\n\n');
}

// ── Searchable PDF builder ────────────────────────────────────────────────────

// Languages whose scripts fall outside Latin-1 (Windows-1252).
// Helvetica only covers codepoints 0-255; everything here starts at U+0400+.
const NON_LATIN_LANGS = new Set(['ara', 'jpn', 'chi_sim', 'chi_tra', 'kor', 'hin', 'tha', 'rus', 'pol']);

// TTF URLs from Google Fonts CDN (variable fonts; verified 2026-05).
// pdf-lib requires TTF or OTF — WOFF/WOFF2 cannot be embedded.
const NOTO_FONT_URLS = {
  ara:     'https://fonts.gstatic.com/s/notosansarabic/v33/nwpPtLGrOAZMl5nJ_wfgRg3DrWFZQML36H986K0.ttf',
  jpn:     'https://fonts.gstatic.com/s/notosansjp/v56/-F62fjtqLzI2JPCgQBnw7HFoxgIO2lZ9hg.ttf',
  chi_sim: 'https://fonts.gstatic.com/s/notosanssc/v40/k3kXo84MPvpLmixcA63oeALhKYiJ-Q7m8w.ttf',
  chi_tra: 'https://fonts.gstatic.com/s/notosanstc/v39/-nF7OG829Oofr2wohFbTp9iFPysLA_ZJ1g.ttf',
  kor:     'https://fonts.gstatic.com/s/notosanskr/v39/PbykFmXiEBPT4ITbgNA5Cgm21nTs4JMMuA.ttf',
  hin:     'https://fonts.gstatic.com/s/notosansdevanagari/v30/TuGOUUFzXI5FBtUq5a8bjKYTZjtRU6Sgv2lRdRhtCC4d.ttf',
  tha:     'https://fonts.gstatic.com/s/notosansthai/v29/iJWdBXeUZi_OHPqn4wq6hQ2_hah-5c-dUX0x.ttf',
  // Cyrillic (Russian, Polish use extended Latin too — Noto Sans covers both)
  rus:     'https://fonts.gstatic.com/s/notosans/v42/o-0IIpQlx3QUlC5A4PNb4j5Ba_2c7A.ttf',
  pol:     'https://fonts.gstatic.com/s/notosans/v42/o-0IIpQlx3QUlC5A4PNb4j5Ba_2c7A.ttf',
};

// In-memory cache of fetched Noto TTF bytes — avoids re-downloading on
// repeated exports within the same session (CJK fonts can be 10–17 MB).
const _notoFontCache = new Map();

// Register fontkit with pdf-lib so that custom TTF fonts can be embedded
// and subset (only used glyphs included — keeps file size small for CJK fonts).
// fontkit.umd.js exposes window.fontkit; must be loaded before this runs.
function _ensureFontkitRegistered(pdfDoc) {
  if (window.fontkit && !pdfDoc._fontkitRegistered) {
    pdfDoc.registerFontkit(window.fontkit);
    pdfDoc._fontkitRegistered = true;
  }
}

// Returns an embedded font suitable for the selected OCR language.
// Latin languages: Helvetica (no network request).
// Non-Latin: fetch the appropriate Noto Sans TTF from Google Fonts CDN,
// register fontkit, and embed with subset:true so only the glyphs that
// actually appear in the document are included — prevents CJK fonts from
// inflating the output PDF by 10–18 MB.
async function _getFontForLang(pdfDoc, lang) {
  const { StandardFonts } = window.PDFLib;

  if (!NON_LATIN_LANGS.has(lang)) {
    return pdfDoc.embedFont(StandardFonts.Helvetica);
  }

  const url = NOTO_FONT_URLS[lang];
  try {
    let bytes = _notoFontCache.get(lang);
    if (!bytes) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      bytes = await resp.arrayBuffer();
      _notoFontCache.set(lang, bytes);
    }
    // fontkit must be registered before embedFont can accept raw TTF bytes.
    // subset:true keeps only the glyphs that appear in the document — critical
    // for CJK fonts (Noto Sans SC is 17 MB full; a typical page uses <100 KB).
    _ensureFontkitRegistered(pdfDoc);
    if (!window.fontkit) {
      // fontkit script not yet loaded — Noto cannot be embedded; use Helvetica.
      // Invisible layer will lack non-Latin glyphs but PDF will not be corrupted.
      return pdfDoc.embedFont(StandardFonts.Helvetica);
    }
    return pdfDoc.embedFont(bytes, { subset: true });
  } catch {
    // CDN unreachable or embed failed — fall back to Helvetica.
    // The invisible text layer will not contain non-Latin glyphs,
    // but the PDF itself will not be corrupted.
    return pdfDoc.embedFont(StandardFonts.Helvetica);
  }
}

// Invert a 6-element affine transform [a,b,c,d,e,f].
// Used to map canvas pixel coords back to PDF user-space coords — handles
// any page rotation (0/90/180/270°) without special-casing each angle.
function _invertTransform([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-10) return null;
  return [d/det, -b/det, -c/det, a/det, (c*f - d*e)/det, (b*e - a*f)/det];
}

function _applyTransform([a, b, c, d, e, f], x, y) {
  return { x: a*x + c*y + e, y: b*x + d*y + f };
}

async function _buildSearchablePdf(file, ocrPages, lang) {
  if (!window.PDFLib) {
    throw new Error('pdf-lib not loaded — cannot build searchable PDF');
  }
  const { PDFDocument, TextRenderingMode } = window.PDFLib;

  const buf    = await file.arrayBuffer();
  const pdfDoc = await PDFDocument.load(new Uint8Array(buf), { ignoreEncryption: true });
  const font   = await _getFontForLang(pdfDoc, lang ?? 'eng');
  const pages  = pdfDoc.getPages();

  for (const { pageNum, words, vpTransform } of ocrPages) {
    const page = pages[pageNum - 1];
    if (!page) continue;

    // Invert the pdf.js viewport transform to map canvas px → PDF user-space.
    // This is correct for rotation 0/90/180/270° without any special-casing.
    const inv = vpTransform ? _invertTransform(vpTransform) : null;
    if (!inv) continue;

    for (const w of words) {
      if (!w.text.trim() || w.confidence < 20) continue;
      const { x0, y0, x1, y1 } = w.bbox;

      // Transform all four bbox corners to PDF user-space, then derive the
      // axis-aligned bounding box. This is rotation-agnostic: for 0°/180° pages
      // the canvas x-axis is the PDF x-axis; for 90°/270° they are swapped.
      // Dividing canvas-pixel deltas by a scalar scale factor does NOT undo the
      // axis swap — only the full matrix inverse does.
      const corners = [
        _applyTransform(inv, x0, y0),
        _applyTransform(inv, x0, y1),
        _applyTransform(inv, x1, y0),
        _applyTransform(inv, x1, y1),
      ];
      const pdfX0 = Math.min(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
      const pdfY0 = Math.min(corners[0].y, corners[1].y, corners[2].y, corners[3].y);
      const pdfX1 = Math.max(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
      const pdfY1 = Math.max(corners[0].y, corners[1].y, corners[2].y, corners[3].y);

      const wordW    = pdfX1 - pdfX0;
      const wordH    = pdfY1 - pdfY0;
      const fontSize = Math.max(4, Math.min(wordH * 0.85, 72));
      const origin   = { x: pdfX0, y: pdfY0 };

      try {
        page.drawText(w.text, {
          x:             origin.x,
          y:             origin.y,
          size:          fontSize,
          font,
          renderingMode: TextRenderingMode.Invisible,  // ISO 32000-1 Tr=3
          maxWidth:      wordW + 2,
        });
      } catch {
        // Skip words with unsupported glyphs or out-of-bounds coords
      }
    }
  }

  _updateProgress(98, 'Saving PDF…');
  const bytes = await pdfDoc.save({ useObjectStreams: true });
  _updateProgress(100, 'Done');
  return bytes;
}

// ── Download helpers ──────────────────────────────────────────────────────────
function _downloadPdf(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename.replace(/\.pdf$/i, '_searchable.pdf');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function _downloadText(text, filename) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename.replace(/\.pdf$/i, '.txt');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function _updateProgress(pct, label) {
  const fill = document.getElementById('progressFill');
  const lbl  = document.getElementById('progressLabel');
  const bar  = document.getElementById('progressBar');
  if (bar)  bar.hidden  = false;
  if (fill) fill.style.width = pct + '%';
  if (lbl)  lbl.textContent  = label;
}

function _showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 4000);
}

function _spinnerHTML(msg) {
  return `<div style="padding:24px 16px;text-align:center;color:var(--text3);font-size:14px;">
    <div style="font-size:24px;margin-bottom:8px;">&#x23F3;</div>${msg}</div>`;
}

function _errorHTML(msg) {
  return `<div style="padding:16px;border:1px solid #fca5a5;border-radius:10px;background:#fff1f2;color:#dc2626;font-size:13px;">
    Could not analyse PDF: ${msg}
  </div>`;
}

