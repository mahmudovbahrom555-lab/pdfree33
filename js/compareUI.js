// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

import { loadPdfJs }  from './pdf2jpgUI.js';
import { showToast }  from './ui.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const RENDER_SCALE = 1.5;   // scale for page rendering
const DIFF_THRESHOLD = 15;  // per-channel pixel difference to count as "changed"

// ── State ─────────────────────────────────────────────────────────────────────
let _files       = [];   // [File, File]
let _viewMode    = 'diff'; // 'left' | 'right' | 'diff'
let _pageData    = [];   // [{ urlLeft, urlRight, urlDiff, diffPct, pageIndex }]
let _clickHandler = null; // reference kept so we can removeEventListener on hide

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
  const el = document.getElementById('compareOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  // Remove the capture-phase listener so it doesn't block other tools' buttons
  const btn = document.getElementById('mergeBtn');
  if (btn && _clickHandler) {
    btn.removeEventListener('click', _clickHandler, true);
    delete btn._compareBound;
  }
  _clickHandler = null;
  _files    = [];
  _viewMode = 'diff';
  _pageData = [];
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

  // Two files ready
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
      showToast('Error: ' + err.message);
    } finally {
      btn.disabled = false;
      if (bar) bar.hidden = true;
    }
  };

  btn.addEventListener('click', _clickHandler, true);
}

// ── Main comparison pipeline ──────────────────────────────────────────────────

async function _runCompare() {
  _updateProgress(5, 'Loading PDF.js…');
  await loadPdfJs();

  _updateProgress(10, 'Opening PDFs…');
  const [doc1, doc2] = await Promise.all([
    _openPdf(_files[0]),
    _openPdf(_files[1]),
  ]);

  const n1 = doc1.numPages;
  const n2 = doc2.numPages;
  const maxPages = Math.max(n1, n2);

  _pageData = [];

  for (let i = 1; i <= maxPages; i++) {
    const pct = 15 + Math.round((i - 1) / maxPages * 75);
    _updateProgress(pct, `Comparing page ${i} of ${maxPages}…`);

    const canvasLeft  = i <= n1 ? await _renderPage(doc1, i) : null;
    const canvasRight = i <= n2 ? await _renderPage(doc2, i) : null;

    let canvasDiff = null;
    let diffPct    = null;

    if (canvasLeft && canvasRight) {
      const result  = _buildDiff(canvasLeft, canvasRight);
      canvasDiff    = result.canvas;
      diffPct       = result.diffPct;
    }

    // Cache data URLs now — avoids re-encoding on every mode switch
    const urlLeft  = canvasLeft  ? canvasLeft.toDataURL()  : null;
    const urlRight = canvasRight ? canvasRight.toDataURL() : null;
    const urlDiff  = canvasDiff  ? canvasDiff.toDataURL()
                   : (urlLeft ?? urlRight);

    _pageData.push({ urlLeft, urlRight, urlDiff, diffPct, pageIndex: i });
  }

  doc1.destroy();
  doc2.destroy();

  _updateProgress(95, 'Rendering results…');
  _showResults(n1, n2);
  _updateProgress(100, 'Done');
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
  const page = await doc.getPage(pageNum);
  const vp   = page.getViewport({ scale: RENDER_SCALE });

  const canvas  = document.createElement('canvas');
  canvas.width  = Math.round(vp.width);
  canvas.height = Math.round(vp.height);

  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}

// ── Pixel diff ────────────────────────────────────────────────────────────────

function _buildDiff(canvasA, canvasB) {
  // Normalise dimensions — pad smaller canvas to match larger
  const w = Math.max(canvasA.width,  canvasB.width);
  const h = Math.max(canvasA.height, canvasB.height);

  const ctxA = _normaliseCanvas(canvasA, w, h);
  const ctxB = _normaliseCanvas(canvasB, w, h);

  const imgA = ctxA.getImageData(0, 0, w, h);
  const imgB = ctxB.getImageData(0, 0, w, h);
  const dA   = imgA.data;
  const dB   = imgB.data;

  // Diff canvas
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
      // Highlight changed pixels in red/pink
      dDiff[i]   = 220;
      dDiff[i+1] = 50;
      dDiff[i+2] = 50;
      dDiff[i+3] = 220;
      changed++;
    } else {
      // Keep identical pixels at reduced opacity (greyed out) so diff pops
      const avg = Math.round((dA[i] * 0.299 + dA[i+1] * 0.587 + dA[i+2] * 0.114));
      dDiff[i]   = avg;
      dDiff[i+1] = avg;
      dDiff[i+2] = avg;
      dDiff[i+3] = 160;
    }
  }

  diffCtx.putImageData(diffImg, 0, 0);

  const diffPct = total > 0 ? (changed / total * 100) : 0;
  return { canvas: diffCanvas, diffPct };
}

/** Draw srcCanvas into a new canvas of (w, h), padding with white. */
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

// ── Result display ────────────────────────────────────────────────────────────

function _showResults(n1, n2) {
  const container = document.getElementById('compareOptions');
  if (!container) return;

  const maxPages = _pageData.length;
  // Use same threshold as the page badge (0.05%) so summary matches card labels
  const totalChanged = _pageData.filter(p => p.diffPct !== null && p.diffPct >= 0.05).length;

  // Header info
  let headerMsg = '';
  if (n1 !== n2) {
    headerMsg = `<div style="margin-bottom:12px;padding:10px 14px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;font-size:13px;color:#92400e;">
      Page count differs: PDF A has ${n1} page${n1 !== 1 ? 's' : ''}, PDF B has ${n2} page${n2 !== 1 ? 's' : ''}.
    </div>`;
  }

  // Mode switcher
  const modeSwitcher = `
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

  // Summary line
  const summary = `
    <div style="margin-bottom:16px;font-size:13px;color:var(--text2);">
      <strong style="color:var(--text)">${maxPages} page${maxPages !== 1 ? 's' : ''} compared</strong>
      &nbsp;&middot;&nbsp;
      ${totalChanged === 0
        ? '<span style="color:#16a34a;">&#x2713; No differences found</span>'
        : `<span style="color:#dc2626;">${totalChanged} page${totalChanged !== 1 ? 's' : ''} with differences</span>`
      }
    </div>`;

  // Pages
  const pagesHTML = _pageData.map(p => _pageCardHTML(p, n1, n2)).join('');

  container.innerHTML = `
    <div id="compareResults">
      ${headerMsg}
      ${modeSwitcher}
      ${summary}
      <div id="comparePages">${pagesHTML}</div>
    </div>`;

  // Mode switcher events
  container.querySelectorAll('[data-cmode]').forEach(btn => {
    btn.addEventListener('click', () => {
      _viewMode = btn.dataset.cmode;
      _refreshModeUI(container);
    });
  });
}

function _pageCardHTML({ urlLeft, urlRight, urlDiff, diffPct, pageIndex }, n1, n2) {
  const hasA = urlLeft  !== null;
  const hasB = urlRight !== null;

  let badge = '';
  if (!hasA)      badge = '<span style="font-size:11px;padding:2px 7px;background:#fef3c7;color:#92400e;border-radius:4px;font-weight:600;">Only in B</span>';
  else if (!hasB) badge = '<span style="font-size:11px;padding:2px 7px;background:#fef3c7;color:#92400e;border-radius:4px;font-weight:600;">Only in A</span>';
  else if (diffPct !== null) {
    const pctStr = diffPct < 0.1 ? '< 0.1' : diffPct.toFixed(1);
    if (diffPct < 0.05) {
      badge = '<span style="font-size:11px;padding:2px 7px;background:#dcfce7;color:#166534;border-radius:4px;font-weight:600;">Identical</span>';
    } else {
      badge = `<span style="font-size:11px;padding:2px 7px;background:#fee2e2;color:#991b1b;border-radius:4px;font-weight:600;">${pctStr}% changed</span>`;
    }
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

  // Update each page canvas using cached URLs (no toDataURL re-encoding)
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
