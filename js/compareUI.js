// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

import { loadPdfJs }  from './pdf2jpgUI.js';
import { showToast }  from './ui.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const RENDER_SCALE   = 1.5;  // scale for page rendering
const DIFF_THRESHOLD = 15;   // per-channel pixel difference to count as "changed"
const PAGE_LIMIT     = 50;   // show choice dialog above this many pages

// ── State ─────────────────────────────────────────────────────────────────────
let _files         = [];
let _viewMode      = 'diff'; // 'left' | 'right' | 'diff'
let _pageData      = [];     // [{ urlLeft, urlRight, urlDiff, diffPct, pageIndex }]
let _n1            = 0;      // page count of doc1 (set at start of _runCompare)
let _n2            = 0;      // page count of doc2
let _clickHandler  = null;   // kept so we can removeEventListener on hide
let _cancelled     = false;  // set in hideCompareOptions to abort in-progress run
let _resolveChoice = null;   // set during _showPageLimitChoice; resolved on hide to unblock
let _startTime     = 0;      // set at loop start for time-remaining estimate

// ── Public API ────────────────────────────────────────────────────────────────

export function initCompareOptions(files) {
  const el = document.getElementById('compareOptions');
  if (!el) return;
  el.style.display = '';
  _files = Array.isArray(files) ? files : [files];
  _bindCompareBtn();
  _renderInitUI(el);
}

export function hideCompareOptions() {
  // Abort any in-progress comparison and unblock the page-limit choice dialog
  _cancelled = true;
  if (_resolveChoice) { _resolveChoice(0); _resolveChoice = null; }

  const el = document.getElementById('compareOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }

  // Remove capture-phase listener so it doesn't block other tools' buttons
  const btn = document.getElementById('mergeBtn');
  if (btn && _clickHandler) {
    btn.removeEventListener('click', _clickHandler, true);
    delete btn._compareBound;
  }
  _clickHandler = null;
  _revokePageData();  // free blob URLs before clearing _pageData
  _files    = [];
  _viewMode = 'diff';
  _pageData = [];
  _n1 = 0;
  _n2 = 0;
}

export function getCompareParams() {
  return {
    hasFiles: _files.length >= 2,
    file1:    _files[0] || null,
    file2:    _files[1] || null,
  };
}

// ── Initial UI ────────────────────────────────────────────────────────────────

function _renderInitUI(container) {
  const count = _files.length;
  if (count === 0) {
    container.innerHTML = _infoBoxHTML('Drop two PDF files above to compare them.');
    return;
  }
  if (count === 1) {
    container.innerHTML = _infoBoxHTML(
      `<strong>${_esc(_files[0].name)}</strong> loaded — drop or add a second PDF to compare.`
    );
    return;
  }
  container.innerHTML = `
    <div style="padding:14px 16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);">
      <p style="margin:0 0 8px;font-size:13px;color:var(--text2);font-weight:600;">Ready to compare:</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
        <span style="padding:4px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:12px;color:var(--text);">A: ${_esc(_truncName(_files[0].name))}</span>
        <span style="padding:4px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:12px;color:var(--text);">B: ${_esc(_truncName(_files[1].name))}</span>
      </div>
    </div>`;
}

// ── Button binding ────────────────────────────────────────────────────────────

function _bindCompareBtn() {
  const btn = document.getElementById('mergeBtn');
  if (!btn || btn._compareBound) return;
  btn._compareBound = true;

  _clickHandler = async e => {
    const mode = btn.dataset.mode || 'process';
    if (mode === 'reset') return;
    if (_files.length < 2) {
      showToast('Please select two PDF files to compare.');
      e.stopImmediatePropagation();
      return;
    }
    e.stopImmediatePropagation();
    btn.disabled = true;
    const bar = document.getElementById('progressBar');
    if (bar) bar.hidden = false;
    try {
      await _runCompare();
    } catch (err) {
      if (!_cancelled) showToast('Error: ' + err.message);
    } finally {
      btn.disabled = false;
      if (bar) bar.hidden = true;
    }
  };

  btn.addEventListener('click', _clickHandler, true);
}

// ── Main comparison pipeline ──────────────────────────────────────────────────

async function _runCompare() {
  _cancelled = false;

  _updateProgress(5, 'Loading PDF.js…');
  await loadPdfJs();

  _updateProgress(10, 'Opening PDFs…');
  const [doc1, doc2] = await Promise.all([
    _openPdf(_files[0]),
    _openPdf(_files[1]),
  ]);

  _n1 = doc1.numPages;
  _n2 = doc2.numPages;
  const rawMax = Math.max(_n1, _n2);

  // Ask user when PDF is large — don't silently cap
  let maxPages = rawMax;
  if (rawMax > PAGE_LIMIT) {
    maxPages = await _showPageLimitChoice(rawMax);
    if (_cancelled || maxPages === 0) { doc1.destroy(); doc2.destroy(); return; }
  }

  _pageData  = [];
  _startTime = Date.now();
  _initResultsContainer();

  for (let i = 1; i <= maxPages; i++) {
    if (_cancelled) break;

    const pct = 15 + Math.round((i - 1) / maxPages * 75);
    _updateProgress(pct, `Comparing page ${i} of ${maxPages}…`);

    // Render both pages in parallel — ~2× faster than sequential await
    const [canvasLeft, canvasRight] = await Promise.all([
      i <= _n1 ? _renderPage(doc1, i) : Promise.resolve(null),
      i <= _n2 ? _renderPage(doc2, i) : Promise.resolve(null),
    ]);
    if (_cancelled) { _freeCanvas(canvasLeft); _freeCanvas(canvasRight); break; }

    let canvasDiff = null;
    let diffPct    = null;
    if (canvasLeft && canvasRight) {
      const result = _buildDiff(canvasLeft, canvasRight); // frees normalised copies internally
      canvasDiff   = result.canvas;
      diffPct      = result.diffPct;
    }

    // Blob URLs: JPEG-compressed, no base64 overhead — ~6× less RAM than toDataURL
    const urlLeft  = canvasLeft  ? await _canvasToURL(canvasLeft)  : null;
    const urlRight = canvasRight ? await _canvasToURL(canvasRight) : null;
    const urlDiff  = canvasDiff  ? await _canvasToURL(canvasDiff)  : (urlLeft ?? urlRight);

    // Release GPU textures immediately after extracting blob URLs
    _freeCanvas(canvasLeft);
    _freeCanvas(canvasRight);
    _freeCanvas(canvasDiff);

    const pageEntry = { urlLeft, urlRight, urlDiff, diffPct, pageIndex: i };
    _pageData.push(pageEntry);

    // Stream: show this page now, don't wait for the rest
    _appendPageCard(pageEntry);

    // Update progress with elapsed-time estimate
    const elapsed   = Date.now() - _startTime;
    const remaining = Math.round((maxPages - i) * (elapsed / i) / 1000);
    const timeHint  = maxPages > i && remaining > 0 ? ` · ~${remaining}s left` : '';
    _updateProgress(15 + Math.round(i / maxPages * 75), `Compared ${i} of ${maxPages}${timeHint}`);

    // Yield: let browser paint the new card before starting the next diff
    await new Promise(r => setTimeout(r, 0));
  }

  doc1.destroy();
  doc2.destroy();

  if (!_cancelled) {
    _updateProgress(95, 'Finalising…');
    _finalizeSummary();
    _updateProgress(100, 'Done');
  }
}

// ── PDF helpers ───────────────────────────────────────────────────────────────

async function _openPdf(file) {
  const buf = await file.arrayBuffer();
  return window.pdfjsLib.getDocument({
    data: new Uint8Array(buf),
    verbosity: 0,
    disableJavaScript: true,
    ignoreEncryption: true,
  }).promise;
}

async function _renderPage(doc, pageNum) {
  const page    = await doc.getPage(pageNum);
  const vp      = page.getViewport({ scale: RENDER_SCALE });
  const canvas  = document.createElement('canvas');
  canvas.width  = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  return canvas;
}

// ── Pixel diff ────────────────────────────────────────────────────────────────

function _buildDiff(canvasA, canvasB) {
  const w = Math.max(canvasA.width,  canvasB.width);
  const h = Math.max(canvasA.height, canvasB.height);

  const ctxA = _normaliseCanvas(canvasA, w, h);
  const ctxB = _normaliseCanvas(canvasB, w, h);

  const imgA = ctxA.getImageData(0, 0, w, h);
  const imgB = ctxB.getImageData(0, 0, w, h);

  // Free normalised copies now that we have their pixel data
  ctxA.canvas.width = 0; ctxA.canvas.height = 0;
  ctxB.canvas.width = 0; ctxB.canvas.height = 0;

  const dA    = imgA.data;
  const dB    = imgB.data;

  const diffCanvas  = document.createElement('canvas');
  diffCanvas.width  = w;
  diffCanvas.height = h;
  const diffCtx     = diffCanvas.getContext('2d');
  const diffImg     = diffCtx.createImageData(w, h);
  const dDiff       = diffImg.data;

  let changed = 0;
  const total = w * h;

  for (let i = 0; i < dA.length; i += 4) {
    const dr = Math.abs(dA[i]   - dB[i]);
    const dg = Math.abs(dA[i+1] - dB[i+1]);
    const db = Math.abs(dA[i+2] - dB[i+2]);
    if (dr > DIFF_THRESHOLD || dg > DIFF_THRESHOLD || db > DIFF_THRESHOLD) {
      dDiff[i]   = 220;
      dDiff[i+1] = 50;
      dDiff[i+2] = 50;
      dDiff[i+3] = 220;
      changed++;
    } else {
      const avg  = Math.round(dA[i] * 0.299 + dA[i+1] * 0.587 + dA[i+2] * 0.114);
      dDiff[i]   = avg;
      dDiff[i+1] = avg;
      dDiff[i+2] = avg;
      dDiff[i+3] = 160;
    }
  }

  diffCtx.putImageData(diffImg, 0, 0);
  return { canvas: diffCanvas, diffPct: total > 0 ? (changed / total * 100) : 0 };
}

function _normaliseCanvas(src, w, h) {
  const dst = document.createElement('canvas');
  dst.width  = w;
  dst.height = h;
  const ctx  = dst.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0);
  return ctx;
}

// ── Canvas / URL helpers ──────────────────────────────────────────────────────

function _canvasToURL(canvas) {
  return new Promise(resolve =>
    canvas.toBlob(blob => resolve(URL.createObjectURL(blob)), 'image/jpeg', 0.9)
  );
}

function _freeCanvas(canvas) {
  if (canvas) { canvas.width = 0; canvas.height = 0; }
}

function _revokePageData() {
  // Use a Set to guard against revoking the same URL twice (urlDiff may equal urlLeft/urlRight)
  const seen = new Set();
  for (const p of _pageData) {
    for (const url of [p.urlLeft, p.urlRight, p.urlDiff]) {
      if (url && !seen.has(url)) { URL.revokeObjectURL(url); seen.add(url); }
    }
  }
}

// ── Page limit choice ─────────────────────────────────────────────────────────

function _showPageLimitChoice(rawMax) {
  return new Promise(resolve => {
    _resolveChoice = resolve;
    const container = document.getElementById('compareOptions');
    if (!container) { resolve(PAGE_LIMIT); return; }

    container.innerHTML = `
      <div style="padding:16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);">
        <p style="margin:0 0 6px;font-size:14px;font-weight:600;color:var(--text);">Large document</p>
        <p style="margin:0 0 14px;font-size:13px;color:var(--text2);">
          This comparison has <strong>${rawMax} pages</strong>.
          Comparing all pages may use significant memory and take several minutes.
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="cmpAll" type="button" style="
            padding:8px 16px;border:1px solid var(--border);border-radius:8px;
            background:var(--bg);color:var(--text);font-size:13px;font-weight:600;
            cursor:pointer;font-family:inherit;">
            Compare all ${rawMax} pages
          </button>
          <button id="cmpFirst" type="button" style="
            padding:8px 16px;border:none;border-radius:8px;
            background:var(--green);color:#fff;font-size:13px;font-weight:600;
            cursor:pointer;font-family:inherit;">
            Compare first ${PAGE_LIMIT} pages
          </button>
        </div>
      </div>`;

    container.querySelector('#cmpAll').addEventListener('click', () => {
      _resolveChoice = null; resolve(rawMax);
    });
    container.querySelector('#cmpFirst').addEventListener('click', () => {
      _resolveChoice = null; resolve(PAGE_LIMIT);
    });
  });
}

// ── Streaming result display ──────────────────────────────────────────────────

function _initResultsContainer() {
  const container = document.getElementById('compareOptions');
  if (!container) return;

  let headerMsg = '';
  if (_n1 !== _n2) {
    headerMsg = `<div style="margin-bottom:12px;padding:10px 14px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;font-size:13px;color:#92400e;">
      Page count differs: PDF A has ${_n1} page${_n1 !== 1 ? 's' : ''}, PDF B has ${_n2} page${_n2 !== 1 ? 's' : ''}.
    </div>`;
  }

  container.innerHTML = `
    <div id="compareResults">
      ${headerMsg}
      ${_modeSwitcherHTML()}
      <div id="compareSummary"></div>
      <div id="comparePages"></div>
    </div>`;

  container.querySelectorAll('[data-cmode]').forEach(btn => {
    btn.addEventListener('click', () => {
      _viewMode = btn.dataset.cmode;
      _refreshModeUI(container);
    });
  });
}

function _appendPageCard(pageEntry) {
  const pagesEl = document.getElementById('comparePages');
  if (!pagesEl) return;
  const div = document.createElement('div');
  div.innerHTML = _pageCardHTML(pageEntry);
  pagesEl.appendChild(div.firstElementChild);
}

function _finalizeSummary() {
  const el = document.getElementById('compareSummary');
  if (!el) return;
  const total        = _pageData.length;
  const totalChanged = _pageData.filter(p => p.diffPct !== null && p.diffPct >= 0.05).length;
  el.innerHTML = `
    <div style="margin-bottom:16px;font-size:13px;color:var(--text2);">
      <strong style="color:var(--text)">${total} page${total !== 1 ? 's' : ''} compared</strong>
      &nbsp;&middot;&nbsp;
      ${totalChanged === 0
        ? '<span style="color:#16a34a;">&#x2713; No differences found</span>'
        : `<span style="color:#dc2626;">${totalChanged} page${totalChanged !== 1 ? 's' : ''} with differences</span>`
      }
    </div>`;
}

function _modeSwitcherHTML() {
  return `
    <div style="display:flex;gap:6px;margin-bottom:16px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:4px;">
      ${['left', 'right', 'diff'].map(m => `
        <button data-cmode="${m}" type="button" style="
          flex:1;padding:6px 0;border:none;border-radius:6px;font-size:13px;font-weight:600;
          cursor:pointer;font-family:inherit;transition:background .15s,color .15s;
          ${_viewMode === m
            ? 'background:var(--green);color:#fff;'
            : 'background:transparent;color:var(--text2);'
          }">
          ${m === 'left' ? 'PDF A' : m === 'right' ? 'PDF B' : 'Diff'}
        </button>`).join('')}
    </div>`;
}

function _pageCardHTML({ urlLeft, urlRight, urlDiff, diffPct, pageIndex }) {
  const hasA = urlLeft  !== null;
  const hasB = urlRight !== null;

  let badge = '';
  if (!hasA)      badge = '<span style="font-size:11px;padding:2px 7px;background:#fef3c7;color:#92400e;border-radius:4px;font-weight:600;">Only in B</span>';
  else if (!hasB) badge = '<span style="font-size:11px;padding:2px 7px;background:#fef3c7;color:#92400e;border-radius:4px;font-weight:600;">Only in A</span>';
  else if (diffPct !== null) {
    const pctStr = diffPct < 0.1 ? '< 0.1' : diffPct.toFixed(1);
    badge = diffPct < 0.05
      ? '<span style="font-size:11px;padding:2px 7px;background:#dcfce7;color:#166534;border-radius:4px;font-weight:600;">Identical</span>'
      : `<span style="font-size:11px;padding:2px 7px;background:#fee2e2;color:#991b1b;border-radius:4px;font-weight:600;">${pctStr}% changed</span>`;
  }

  const dataUrl = _getPageUrl({ urlLeft, urlRight, urlDiff, hasA, hasB });

  return `
    <div class="compare-page-card" data-page="${pageIndex}" style="
      margin-bottom:16px;padding:12px;
      border:1px solid var(--border);border-radius:10px;background:var(--surface);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <span style="font-size:13px;font-weight:600;color:var(--text);">Page ${pageIndex}</span>
        ${badge}
      </div>
      <div class="compare-canvas-wrap" style="text-align:center;background:var(--bg);border-radius:6px;padding:8px;overflow:auto;">
        ${dataUrl
          ? `<img src="${dataUrl}" alt="Page ${pageIndex}" style="max-width:100%;height:auto;border-radius:4px;">`
          : `<div style="padding:24px;color:var(--text3);font-size:13px;">Page not available in this PDF</div>`
        }
      </div>
    </div>`;
}

function _getPageUrl({ urlLeft, urlRight, urlDiff, hasA, hasB }) {
  if (_viewMode === 'left')  return hasA ? urlLeft  : null;
  if (_viewMode === 'right') return hasB ? urlRight : null;
  return urlDiff ?? null;
}

function _refreshModeUI(container) {
  // Update button styles
  container.querySelectorAll('[data-cmode]').forEach(btn => {
    const active = btn.dataset.cmode === _viewMode;
    btn.style.background = active ? 'var(--green)' : 'transparent';
    btn.style.color      = active ? '#fff' : 'var(--text2)';
  });
  // Swap images using cached blob URLs — no re-encoding
  _pageData.forEach(p => {
    const card = container.querySelector(`[data-page="${p.pageIndex}"]`);
    if (!card) return;
    const wrap = card.querySelector('.compare-canvas-wrap');
    if (!wrap) return;
    const hasA = p.urlLeft  !== null;
    const hasB = p.urlRight !== null;
    const url  = _getPageUrl({ ...p, hasA, hasB });
    wrap.innerHTML = url
      ? `<img src="${url}" alt="Page ${p.pageIndex}" style="max-width:100%;height:auto;border-radius:4px;">`
      : `<div style="padding:24px;color:var(--text3);font-size:13px;">Page not available in this PDF</div>`;
  });
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function _infoBoxHTML(msg) {
  return `<div style="padding:14px 16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);font-size:13px;color:var(--text2);">${msg}</div>`;
}

function _updateProgress(pct, label) {
  const fill = document.getElementById('progressFill');
  const lbl  = document.getElementById('progressLabel');
  const bar  = document.getElementById('progressBar');
  if (bar)  bar.hidden  = false;
  if (fill) fill.style.width = pct + '%';
  if (lbl)  lbl.textContent  = label;
}

function _truncName(name) {
  return name.length > 40 ? name.slice(0, 37) + '…' : name;
}

function _esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
