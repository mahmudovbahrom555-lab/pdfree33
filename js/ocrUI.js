// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

import { loadPdfJs } from './pdf2jpgUI.js';

let _file       = null;
let _isTextPdf  = false;
let _ocrReady   = false;
let _loading    = false;
let _deferredInstall = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredInstall = e;
});

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

function _renderUI(container) {
  if (_isTextPdf) {
    container.innerHTML = `
      <div style="padding:16px;border:1px solid var(--green);border-radius:10px;background:var(--surface);">
        <p style="margin:0;font-size:14px;color:var(--text);">
          &#x2713; This PDF has a text layer &mdash; extracting directly (no OCR needed)
        </p>
      </div>`;
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
          &#x2713; OCR ready &mdash; click &ldquo;Extract Text&rdquo; to start
        </div>
      </div>`;
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
        &#x2713; OCR ready &mdash; click &ldquo;Extract Text&rdquo; to start
      </div>
    </div>`;

  const btnInstall  = document.getElementById('btnInstallOcr');
  const btnDownload = document.getElementById('btnDownloadOcrOnly');
  if (btnInstall)  btnInstall.addEventListener('click',  _installOcr);
  if (btnDownload) btnDownload.addEventListener('click', _loadTesseract);
}

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

function _bindMergeBtn() {
  const btn = document.getElementById('mergeBtn');
  if (!btn || btn._ocrBound) return;
  btn._ocrBound = true;

  // Capture phase so this fires before app.js bubble-phase listener,
  // allowing stopImmediatePropagation to prevent doProcess (stub runner).
  btn.addEventListener('click', async (e) => {
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
      const text = _isTextPdf
        ? await _extractTextDirect(_file)
        : await _runOcr(_file);
      _downloadText(text, _file.name);
      const sc = document.getElementById('successCard');
      if (sc) {
        sc.style.display = 'block';
        const title = document.getElementById('successTitle');
        if (title) title.textContent = 'Done!';
        const desc = document.getElementById('successDesc');
        if (desc) desc.textContent = 'Text extracted and saved to your device.';
        sc.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    } catch (err) {
      _showToast('Error: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  }, true);
}

async function _runOcr(file) {
  await loadPdfJs();
  const buf    = await file.arrayBuffer();
  const pdfDoc = await window.pdfjsLib.getDocument({
    data: new Uint8Array(buf), verbosity: 0, disableJavaScript: true,
  }).promise;

  const worker = await window.Tesseract.createWorker('eng', 1, {
    logger: m => {
      if (m.status === 'recognizing text') {
        const pct = Math.round(m.progress * 100);
        _updateProgress(pct, 'Recognizing text…');
      }
    },
  });

  const total = pdfDoc.numPages;
  const texts = [];

  for (let p = 1; p <= total; p++) {
    const pct = Math.round((p - 1) / total * 90);
    _updateProgress(pct, `OCR page ${p} of ${total}…`);

    const page = await pdfDoc.getPage(p);
    const vp   = page.getViewport({ scale: 2 });

    const canvas  = document.createElement('canvas');
    canvas.width  = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    const { data: { text } } = await worker.recognize(canvas);
    texts.push(`--- Page ${p} ---\n${text.trim()}`);
  }

  await worker.terminate();
  _updateProgress(100, 'Done');

  return texts.join('\n\n');
}

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
