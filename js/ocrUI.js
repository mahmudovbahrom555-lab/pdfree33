// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

import { loadPdfJs } from './pdf2jpgUI.js';

// ── State ────────────────────────────────────────────────────────────────────
let _file            = null;
let _isTextPdf       = false;
let _ocrReady        = false;
let _loading         = false;
let _deferredInstall = null;
let _selectedLang    = 'eng';
let _downloadAsTxt   = false;

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
}

export function getOcrParams() {
  return {
    hasFile:    !!_file,
    loading:    _loading,
    isOcrReady: _ocrReady,
    isTextPdf:  _isTextPdf,
  };
}

// ── Analysis ─────────────────────────────────────────────────────────────────
async function _analyse(file, container) {
  try {
    await loadPdfJs();
    const buf    = await file.arrayBuffer();
    const pdfDoc = await window.pdfjsLib.getDocument({
      data: new Uint8Array(buf), verbosity: 0, disableJavaScript: true,
    }).promise;

    const page = await pdfDoc.getPage(1);
    const tc   = await page.getTextContent();
    _isTextPdf = tc.items.filter(i => i.str.trim()).length > 5;
    _loading   = false;
    _renderUI(container);
    _bindMergeBtn();
  } catch (err) {
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
  const alreadyInstalled = localStorage.getItem('pdfree_ocr_installed') === '1' && window.Tesseract;

  if (alreadyInstalled) {
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
    const complexLang = LANGUAGES.complex.find(l => l.code === val);
    if (complexLang) {
      _showComplexLangDownload(complexLang);
    } else {
      _selectedLang = val;
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
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
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

  // Update button label to reflect the output type
  if (!_isTextPdf) {
    btn.textContent = 'Make PDF Searchable';
  }

  // Capture phase so this fires before app.js bubble-phase listener,
  // allowing stopImmediatePropagation to prevent doProcess (stub runner).
  btn.addEventListener('click', async e => {
    if (!_file) return;
    const mode = btn.dataset.mode || 'process';
    if (mode === 'reset') return;

    // Gate: only intercept when OCR is the active tool
    if (!_isTextPdf && !_ocrReady) return;

    e.stopImmediatePropagation();

    btn.disabled = true;
    _updateProgress(5, 'Starting…');
    const bar = document.getElementById('progressBar');
    if (bar) bar.hidden = false;

    try {
      if (_isTextPdf) {
        const text = await _extractTextDirect(_file);
        _downloadText(text, _file.name);
        _showSuccess('Text extracted and saved to your device.');
      } else {
        const { ocrPages, fullText } = await _runOcr(_file);
        // Build searchable PDF
        _updateProgress(95, 'Building searchable PDF…');
        const pdfBytes = await _buildSearchablePdf(_file, ocrPages);
        _downloadPdf(pdfBytes, _file.name);
        if (_downloadAsTxt && fullText) {
          _downloadText(fullText, _file.name);
        }
        _showSuccess('Searchable PDF saved — you can now select and copy text in any PDF reader.');
      }
    } catch (err) {
      _showToast('Error: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  }, true);
}

function _showSuccess(desc) {
  const sc = document.getElementById('successCard');
  if (sc) {
    sc.style.display = 'block';
    const title = document.getElementById('successTitle');
    if (title) title.textContent = 'Done!';
    const descEl = document.getElementById('successDesc');
    if (descEl) descEl.textContent = desc;
    sc.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ── OCR pipeline ─────────────────────────────────────────────────────────────
const MAX_OCR_PX = 3000;

async function _runOcr(file) {
  await loadPdfJs();
  const buf    = await file.arrayBuffer();
  const pdfDoc = await window.pdfjsLib.getDocument({
    data: new Uint8Array(buf), verbosity: 0, disableJavaScript: true,
  }).promise;

  const langLabel = _getLangName(_selectedLang);
  const worker = await window.Tesseract.createWorker(_selectedLang, 1, {
    logger: m => {
      if (m.status === 'recognizing text') {
        const pct = Math.round(m.progress * 100);
        _updateProgress(pct, `Recognizing text (${langLabel})…`);
      }
    },
  });

  const total    = pdfDoc.numPages;
  const ocrPages = [];
  const txtPages = [];

  for (let p = 1; p <= total; p++) {
    const basePct = Math.round((p - 1) / total * 90);
    _updateProgress(basePct, `OCR page ${p} of ${total} · ${langLabel}`);

    const page = await pdfDoc.getPage(p);

    // Adaptive scale — cap at MAX_OCR_PX to limit memory
    const vp0 = page.getViewport({ scale: 1 });
    let scale = 2;
    if (vp0.width * 2 > MAX_OCR_PX || vp0.height * 2 > MAX_OCR_PX) {
      scale = Math.min(MAX_OCR_PX / vp0.width, MAX_OCR_PX / vp0.height);
    }
    const vp = page.getViewport({ scale });

    const canvas  = document.createElement('canvas');
    canvas.width  = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    const result = await worker.recognize(canvas);
    const words  = result.data.words.map(w => ({
      text:       w.text,
      confidence: w.confidence,
      bbox:       w.bbox,  // {x0, y0, x1, y1} in canvas coords
    }));

    ocrPages.push({ pageNum: p, words, canvasW: canvas.width, canvasH: canvas.height });

    // Build plain text from paragraph/line structure
    const paragraphs = result.data.paragraphs
      .map(para => para.lines
        .map(line => line.words.map(w => w.text).join(' ').trim())
        .filter(Boolean)
        .join('\n'))
      .filter(Boolean);
    txtPages.push(`--- Page ${p} ---\n${paragraphs.join('\n\n') || result.data.text.trim()}`);

    // Release canvas memory after each page
    canvas.width  = 0;
    canvas.height = 0;
  }

  await worker.terminate();
  _updateProgress(92, 'OCR complete');

  return { ocrPages, fullText: txtPages.join('\n\n') };
}

function _getLangName(code) {
  const all = [...LANGUAGES.european, ...LANGUAGES.complex];
  const found = all.find(l => l.code === code);
  return found ? found.name : code;
}

// ── Direct text extraction (text-layer PDFs) ─────────────────────────────────
async function _extractTextDirect(file) {
  await loadPdfJs();
  const buf    = await file.arrayBuffer();
  const pdfDoc = await window.pdfjsLib.getDocument({
    data: new Uint8Array(buf), verbosity: 0, disableJavaScript: true,
  }).promise;

  const texts = [];
  const total = pdfDoc.numPages;
  for (let p = 1; p <= total; p++) {
    _updateProgress(Math.round(p / total * 90), `Extracting page ${p} of ${total}…`);
    const page = await pdfDoc.getPage(p);
    const tc   = await page.getTextContent();
    const text = tc.items.map(i => i.str).join(' ');
    texts.push(`--- Page ${p} ---\n${text.trim()}`);
  }
  _updateProgress(100, 'Done');
  return texts.join('\n\n');
}

// ── Searchable PDF builder ────────────────────────────────────────────────────
async function _buildSearchablePdf(file, ocrPages) {
  if (!window.PDFLib) {
    throw new Error('pdf-lib not loaded — cannot build searchable PDF');
  }
  const { PDFDocument, StandardFonts } = window.PDFLib;

  const buf    = await file.arrayBuffer();
  const pdfDoc = await PDFDocument.load(new Uint8Array(buf), { ignoreEncryption: true });
  const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages  = pdfDoc.getPages();

  for (const { pageNum, words, canvasW, canvasH } of ocrPages) {
    const page = pages[pageNum - 1];
    if (!page) continue;
    const { width: pdfW, height: pdfH } = page.getSize();

    const scaleX = pdfW / canvasW;
    const scaleY = pdfH / canvasH;

    for (const w of words) {
      if (!w.text.trim() || w.confidence < 30) continue;
      const { x0, y0, x1, y1 } = w.bbox;
      const wordW  = (x1 - x0) * scaleX;
      const wordH  = (y1 - y0) * scaleY;
      const fontSize = Math.max(4, Math.min(wordH * 0.85, 72));

      // PDF Y-axis is bottom-up; canvas Y-axis is top-down
      const pdfX = x0 * scaleX;
      const pdfY = pdfH - y1 * scaleY;

      try {
        page.drawText(w.text, {
          x:        pdfX,
          y:        pdfY,
          size:     fontSize,
          font,
          opacity:  0,         // invisible but searchable/selectable
          maxWidth: wordW + 2,
        });
      } catch {
        // Skip words with malformed bbox or unsupported glyphs
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

