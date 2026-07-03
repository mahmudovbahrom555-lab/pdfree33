// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

import { loadPdfJs }  from './pdf2jpgUI.js';
import { showToast }  from './ui.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const RENDER_SCALE   = 1.5;
const DIFF_THRESHOLD = 15;
const PAGE_LIMIT     = 50;

// ── State ─────────────────────────────────────────────────────────────────────
let _files              = [];
let _viewMode           = 'diff'; // 'left' | 'right' | 'diff'
let _pageData           = [];     // [{ urlLeft, urlRight, urlDiff, diffPct, pageIndex }]
let _n1                 = 0;
let _n2                 = 0;
let _clickHandler       = null;
let _cancelled          = false;
let _resolveChoice      = null;
let _startTime          = 0;
let _changedPageIndices = []; // page indices with diffPct >= 0.05 or missing page
let _navIdx             = -1; // current position in _changedPageIndices (−1 = not yet navigated)
let _filterActive       = false;

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
  _cancelled = true;
  if (_resolveChoice) { _resolveChoice(0); _resolveChoice = null; }
  const el = document.getElementById('compareOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  const btn = document.getElementById('mergeBtn');
  if (btn && _clickHandler) {
    btn.removeEventListener('click', _clickHandler, true);
    delete btn._compareBound;
  }
  _clickHandler       = null;
  _revokePageData();
  _files              = [];
  _viewMode           = 'diff';
  _pageData           = [];
  _n1                 = 0;
  _n2                 = 0;
  _changedPageIndices = [];
  _navIdx             = -1;
  _filterActive       = false;
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
        <span style="padding:4px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:12px;color:var(--text);">📄 ${_esc(_truncName(_files[0].name))}</span>
        <span style="padding:4px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:12px;color:var(--text);">📄 ${_esc(_truncName(_files[1].name))}</span>
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
  _cancelled          = false;
  _filterActive       = false;
  _changedPageIndices = [];
  _navIdx             = -1;

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

    // Render both pages in parallel
    const [canvasLeft, canvasRight] = await Promise.all([
      i <= _n1 ? _renderPage(doc1, i) : Promise.resolve(null),
      i <= _n2 ? _renderPage(doc2, i) : Promise.resolve(null),
    ]);
    if (_cancelled) { _freeCanvas(canvasLeft); _freeCanvas(canvasRight); break; }

    let canvasDiff = null;
    let diffPct    = null;
    if (canvasLeft && canvasRight) {
      const result = _buildDiff(canvasLeft, canvasRight);
      canvasDiff   = result.canvas;
      diffPct      = result.diffPct;
    }

    // Blob URLs: JPEG-compressed, no base64 overhead — ~6× less RAM than toDataURL
    const urlLeft  = canvasLeft  ? await _canvasToURL(canvasLeft)  : null;
    const urlRight = canvasRight ? await _canvasToURL(canvasRight) : null;
    const urlDiff  = canvasDiff  ? await _canvasToURL(canvasDiff)  : (urlLeft ?? urlRight);

    // Release GPU textures immediately
    _freeCanvas(canvasLeft);
    _freeCanvas(canvasRight);
    _freeCanvas(canvasDiff);

    const pageEntry = { urlLeft, urlRight, urlDiff, diffPct, pageIndex: i };
    _pageData.push(pageEntry);
    _appendPageCard(pageEntry);

    // Time estimate
    const elapsed   = Date.now() - _startTime;
    const remaining = Math.round((maxPages - i) * (elapsed / i) / 1000);
    const timeHint  = maxPages > i && remaining > 0 ? ` · ~${remaining}s left` : '';
    _updateProgress(15 + Math.round(i / maxPages * 75), `Compared ${i} of ${maxPages}${timeHint}`);

    // Yield: let browser paint the card before starting the next diff
    await new Promise(r => setTimeout(r, 0));
  }

  doc1.destroy();
  doc2.destroy();

  if (!_cancelled) {
    _updateProgress(95, 'Finalising…');
    _finalizeSummary();
    _buildControls();
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
  const seen = new Set();
  for (const p of _pageData) {
    for (const url of [p.urlLeft, p.urlRight, p.urlDiff]) {
      if (url && !seen.has(url)) { URL.revokeObjectURL(url); seen.add(url); }
    }
  }
}

function _isChangedPage(p) {
  return p.diffPct === null || p.diffPct >= 0.05;
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
      Page count differs: ${_esc(_truncName(_files[0].name))} has ${_n1} page${_n1 !== 1 ? 's' : ''}, ${_esc(_truncName(_files[1].name))} has ${_n2} page${_n2 !== 1 ? 's' : ''}.
    </div>`;
  }

  container.innerHTML = `
    <div id="compareResults">
      ${headerMsg}
      ${_modeSwitcherHTML()}
      <div id="compareLegend" style="display:flex;gap:14px;margin-bottom:10px;font-size:11px;color:var(--text2);">
        <span style="display:flex;align-items:center;gap:4px;">
          <span style="display:inline-block;width:12px;height:12px;border-radius:2px;flex-shrink:0;background:rgba(220,50,50,0.85);"></span>Changed pixels
        </span>
        <span style="display:flex;align-items:center;gap:4px;">
          <span style="display:inline-block;width:12px;height:12px;border-radius:2px;flex-shrink:0;background:rgba(150,150,150,0.4);"></span>Identical content
        </span>
      </div>
      <div id="compareSummary"></div>
      <div id="compareControls" style="display:none;margin-bottom:14px;"></div>
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
  if (!el || !_pageData.length) return;

  const total     = _pageData.length;
  const identical = _pageData.filter(p =>  p.urlLeft && p.urlRight && p.diffPct !== null && p.diffPct < 0.05).length;
  const changed   = _pageData.filter(p =>  p.urlLeft && p.urlRight && p.diffPct !== null && p.diffPct >= 0.05).length;
  const onlyA     = _pageData.filter(p =>  p.urlLeft && !p.urlRight).length;
  const onlyB     = _pageData.filter(p => !p.urlLeft &&  p.urlRight).length;

  const parts = [`<strong style="color:var(--text)">${total} page${total !== 1 ? 's' : ''} compared</strong>`];
  if (identical > 0) parts.push(`<span style="color:#16a34a;">&#x2713; ${identical} identical</span>`);
  if (changed   > 0) parts.push(`<span style="color:#dc2626;">&#x26A0;&#xFE0E; ${changed} changed</span>`);
  if (onlyA     > 0) parts.push(`<span style="color:#92400e;">${onlyA} only in ${_esc(_tabLabel(0))}</span>`);
  if (onlyB     > 0) parts.push(`<span style="color:#92400e;">${onlyB} only in ${_esc(_tabLabel(1))}</span>`);

  el.innerHTML = `<div style="margin-bottom:12px;font-size:13px;color:var(--text2);">${parts.join('&nbsp;&nbsp;·&nbsp;&nbsp;')}</div>`;
}

function _buildControls() {
  const el = document.getElementById('compareControls');
  if (!el) return;

  _changedPageIndices = _pageData.filter(_isChangedPage).map(p => p.pageIndex);
  const totalChanged  = _changedPageIndices.length;
  const totalPages    = _pageData.length;
  if (totalChanged === 0) return;

  el.style.display = '';
  const btnStyle = `padding:5px 12px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;`;

  el.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      ${totalChanged < totalPages ? `
        <button id="cmpFilterBtn" type="button" style="${btnStyle}border:1px solid var(--border);background:var(--bg);color:var(--text);">
          Show changed only&nbsp;(${totalChanged})
        </button>` : ''}
      <div style="display:flex;gap:6px;align-items:center;margin-left:auto;">
        <button id="cmpPrev" type="button" style="${btnStyle}border:1px solid var(--border);background:var(--bg);color:var(--text);" aria-label="Previous change">← Prev</button>
        <span id="cmpNavPos" style="font-size:12px;color:var(--text2);min-width:48px;text-align:center;">– / ${totalChanged}</span>
        <button id="cmpNext" type="button" style="${btnStyle}border:1px solid var(--border);background:var(--bg);color:var(--text);" aria-label="Next change">Next →</button>
      </div>
    </div>`;

  const filterBtn = el.querySelector('#cmpFilterBtn');
  if (filterBtn) {
    filterBtn.addEventListener('click', () => {
      _filterActive = !_filterActive;
      filterBtn.textContent = _filterActive
        ? `Show all (${totalPages})`
        : `Show changed only (${totalChanged})`;
      filterBtn.style.background = _filterActive ? 'var(--green)' : 'var(--bg)';
      filterBtn.style.color      = _filterActive ? '#fff'         : 'var(--text)';
      filterBtn.style.border     = _filterActive ? 'none'         : '1px solid var(--border)';
      _applyFilter();
    });
  }

  el.querySelector('#cmpPrev').addEventListener('click', () => {
    _navIdx = _navIdx < 0
      ? totalChanged - 1
      : (_navIdx - 1 + totalChanged) % totalChanged;
    _updateNavDisplay(totalChanged);
    _scrollToChanged(_navIdx);
  });

  el.querySelector('#cmpNext').addEventListener('click', () => {
    _navIdx = _navIdx < 0
      ? 0
      : (_navIdx + 1) % totalChanged;
    _updateNavDisplay(totalChanged);
    _scrollToChanged(_navIdx);
  });
}

function _updateNavDisplay(total) {
  const pos = document.getElementById('cmpNavPos');
  if (!pos) return;
  pos.textContent = _navIdx >= 0
    ? `${_navIdx + 1} / ${total ?? _changedPageIndices.length}`
    : `– / ${total ?? _changedPageIndices.length}`;
}

function _scrollToChanged(idx) {
  const pageIndex = _changedPageIndices[idx];
  if (pageIndex == null) return;
  const card = document.querySelector(`[data-page="${pageIndex}"]`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function _applyFilter() {
  _pageData.forEach(p => {
    const card = document.querySelector(`[data-page="${p.pageIndex}"]`);
    if (!card) return;
    card.style.display = _filterActive && !_isChangedPage(p) ? 'none' : '';
  });
}

// ── Mode switcher & card rendering ───────────────────────────────────────────

function _modeSwitcherHTML() {
  return `
    <div style="display:flex;gap:6px;margin-bottom:12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:4px;">
      ${['left', 'right', 'diff'].map(m => `
        <button data-cmode="${m}" type="button" style="
          flex:1;padding:6px 0;border:none;border-radius:6px;font-size:13px;font-weight:600;
          cursor:pointer;font-family:inherit;transition:background .15s,color .15s;
          ${_viewMode === m
            ? 'background:var(--green);color:#fff;'
            : 'background:transparent;color:var(--text2);'
          }">
          ${m === 'left' ? _tabLabel(0) : m === 'right' ? _tabLabel(1) : 'Differences'}
        </button>`).join('')}
    </div>`;
}

function _pageCardHTML({ urlLeft, urlRight, urlDiff, diffPct, pageIndex }) {
  const hasA = urlLeft  !== null;
  const hasB = urlRight !== null;

  let badge = '';
  if (!hasA)      badge = `<span style="font-size:11px;padding:2px 7px;background:#fef3c7;color:#92400e;border-radius:4px;font-weight:600;">Only in ${_esc(_tabLabel(1))}</span>`;
  else if (!hasB) badge = `<span style="font-size:11px;padding:2px 7px;background:#fef3c7;color:#92400e;border-radius:4px;font-weight:600;">Only in ${_esc(_tabLabel(0))}</span>`;
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
  container.querySelectorAll('[data-cmode]').forEach(btn => {
    const active = btn.dataset.cmode === _viewMode;
    btn.style.background = active ? 'var(--green)' : 'transparent';
    btn.style.color      = active ? '#fff' : 'var(--text2)';
  });

  // Legend is only meaningful in Differences mode
  const leg = document.getElementById('compareLegend');
  if (leg) leg.style.display = _viewMode === 'diff' ? 'flex' : 'none';

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

function _tabLabel(idx) {
  const name = _files[idx]?.name ?? `File ${idx + 1}`;
  return name.length > 20 ? name.slice(0, 17) + '…' : name;
}

function _esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
