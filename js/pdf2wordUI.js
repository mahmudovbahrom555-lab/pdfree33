// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

import { id } from './utils.js';
import { loadPdfJs } from './pdf2jpgUI.js';
import { preprocessPdfBuffer } from './decryptPdf.js';
import { chipGroup, group, loadingRow } from './uiComponents.js';
import { detectTables } from './pdf2wordTables.js';

// ── Constants ─────────────────────────────────────────────────────────────────
// JPEG compression ratio at quality 0.85 over typical PDF content
// (mix of text, graphics). Actual ratio: 10–16×; 12× is a safe middle estimate.
const JPEG_RATIO       = 12;
const WARN_MB          = 80;    // yellow warning threshold
const DANGER_MB        = 200;   // red warning threshold + strong message
const MAX_IMAGE_PAGES  = 500;   // hard cap for image mode (browser memory safety)

// ── State ─────────────────────────────────────────────────────────────────────
let _file      = null;
let _mode      = 'text';
let _dpi       = 150;
let _pageCount = 0;
let _vpW       = 0;    // first page width in PDF points (for size estimation)
let _vpH       = 0;    // first page height in PDF points
let _loading   = false;
let _scanGen   = 0;    // incremented on each new file — cancels stale background scans

export function getPdf2WordParams() {
  return { mode: _mode, dpi: _dpi, pageCount: _pageCount, loading: _loading };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function initPdf2WordOptions(file) {
  const el = id('pdf2wordOptions');
  if (!el) return;

  _file    = file;
  _loading = true;
  el.innerHTML    = loadingRow('Analysing PDF…');
  el.style.display = '';

  try {
    await loadPdfJs();
    const rawBuf = file._decryptedBuffer
      ? file._decryptedBuffer.slice(0)
      : await preprocessPdfBuffer(await file.arrayBuffer());
    const doc = await window.pdfjsLib.getDocument({
      data:              new Uint8Array(rawBuf),
      useSystemFonts:    false,
      verbosity:         0,
      disableJavaScript: true,
    }).promise;

    _pageCount = doc.numPages;

    // First page dimensions → used for real-time size estimation
    const firstPage = await doc.getPage(1);
    const vp        = firstPage.getViewport({ scale: 1 });
    _vpW = vp.width;
    _vpH = vp.height;
    firstPage.cleanup?.();

    // Background table scan — runs on first 5 pages max to keep init fast.
    // Results shown in UI for debug/tuning; doesn't block rendering.
    const _thisGen = ++_scanGen;
    _scanTablesBackground(doc, _thisGen).catch(() => {});

    _loading = false;
    _render(file);
  } catch (err) {
    _loading = false;
    el.innerHTML = `
      <div class="compress-scan compress-scan--found" role="alert">
        Cannot read PDF: ${_esc(err.message)}
      </div>`;
  }
}

export function hidePdf2WordOptions() {
  const el = id('pdf2wordOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  _file = null; _mode = 'text'; _dpi = 150;
  _pageCount = 0; _vpW = 0; _vpH = 0; _loading = false;
  ++_scanGen; // cancel any in-flight background scan
}

// ── Size estimation ───────────────────────────────────────────────────────────
// Returns estimated .docx file size in MB for current dpi + pageCount.
// Formula: (pixels per page × RGB channels / compression ratio) × pages
function _estimateMB(dpi) {
  if (!_vpW || !_vpH) return null;
  const scale = dpi / 72;
  const w     = _vpW * scale;
  const h     = _vpH * scale;
  return (w * h * 3 / JPEG_RATIO / 1024 / 1024) * _pageCount;
}

// ── Render ────────────────────────────────────────────────────────────────────

function _render(file) {
  const el = id('pdf2wordOptions');
  if (!el) return;

  const name = file.name.length > 35 ? file.name.slice(0, 32) + '…' : file.name;

  el.innerHTML = `
    <div class="compress-info">
      <span class="compress-info__name" title="${_esc(file.name)}">${name}</span>
      <span class="compress-info__dot">·</span>
      <span class="compress-info__meta">${_pageCount} page${_pageCount !== 1 ? 's' : ''}</span>
    </div>

    ${group('Output mode', chipGroup('p2wMode', [
      { value: 'text',  label: 'Text (editable)' },
      { value: 'image', label: 'Pages as images' },
    ], _mode, 'Conversion mode'))}

    <div id="p2wImageBlock" style="${_mode === 'image' ? '' : 'display:none'}">
      ${group('Resolution', `
        <div class="j2p-chips" role="group" aria-label="Image resolution">
          ${_dpiChip('72',  'Compact',        '72',  _dpi)}
          ${_dpiChip('150', 'Balanced',       '150', _dpi, true)}
          ${_dpiChip('300', 'High quality',   '300', _dpi)}
        </div>
      `)}
      <div id="p2wSizeHint" style="margin-top:8px">${_sizeHintHTML(_dpi)}</div>
    </div>

    <div id="p2wModeHint" class="compress-scan compress-scan--ok" role="status" aria-live="polite">
      ${_modeHintText()}
    </div>
  `;

  el.removeEventListener('change', _onChange);
  el.addEventListener('change', _onChange);
}

// A DPI chip that renders "Compact · 72 dpi", with optional "★ Recommended" badge
function _dpiChip(value, label, display, current, recommended = false) {
  const active  = current === parseInt(value) ? ' j2p-chip--active' : '';
  const checked = current === parseInt(value) ? ' checked' : '';
  const badge   = recommended
    ? ' <span style="font-size:10px;opacity:.7;font-weight:600">★</span>'
    : '';
  return `<label class="j2p-chip${active}" data-value="${value}" data-name="p2wDpi">
    <input type="radio" name="p2wDpi" value="${value}"${checked}>
    ${label}${badge} <span style="opacity:.55;font-size:11px">${display} dpi</span>
  </label>`;
}

// Real-time size estimate HTML with colour-coded severity
function _sizeHintHTML(dpi) {
  const mb  = _estimateMB(dpi);
  if (!mb)  return '';

  const mbStr = mb < 1 ? '<1' : Math.round(mb);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  if (mb >= DANGER_MB) {
    const pages = _pageCount;
    return `<div class="compress-scan compress-scan--found" style="margin:0" role="alert">
      ⚠️ Estimated .docx: <strong>~${mbStr} MB</strong> — very large.
      ${pages > MAX_IMAGE_PAGES
        ? `Conversion is limited to ${MAX_IMAGE_PAGES} pages in image mode.`
        : 'Your browser may run out of memory. Try <strong>Compact</strong> resolution or switch to Text mode.'}
      ${isSafari ? '<br><small>Safari may close the tab. Chrome or Firefox handle large files better.</small>' : ''}
    </div>`;
  }

  if (mb >= WARN_MB) {
    return `<div class="compress-scan" style="margin:0;background:rgba(200,130,0,.08);border:1px solid rgba(200,130,0,.3);border-radius:8px;padding:10px 12px;font-size:13px;color:var(--text2)">
      📦 Estimated .docx: <strong>~${mbStr} MB</strong>${isSafari ? ' · Consider <strong>Compact</strong> on Safari' : ''}.
    </div>`;
  }

  return `<div style="font-size:12px;color:var(--text3);padding:4px 0">
    📦 Estimated .docx: ~${mbStr} MB
  </div>`;
}

function _modeHintText() {
  return _mode === 'text'
    ? '📄 Text mode — readable and editable in Word. Headings, bold, italic preserved. Complex layouts may differ.'
    : '🖼️ Image mode — pixel-perfect visual copy of each page. Text cannot be edited in Word.';
}

// ── Events ────────────────────────────────────────────────────────────────────

function _onChange(e) {
  if (e.target.name === 'p2wMode') {
    _mode = e.target.value;

    const imageBlock = id('p2wImageBlock');
    if (imageBlock) imageBlock.style.display = _mode === 'image' ? '' : 'none';

    const hint = id('p2wModeHint');
    if (hint) hint.textContent = _modeHintText();

    document.querySelectorAll('[data-name="p2wMode"]').forEach(el => {
      el.classList.toggle('j2p-chip--active', el.dataset.value === _mode);
    });
  }

  if (e.target.name === 'p2wDpi') {
    _dpi = parseInt(e.target.value);
    document.querySelectorAll('[data-name="p2wDpi"]').forEach(el => {
      el.classList.toggle('j2p-chip--active', el.dataset.value === String(_dpi));
    });
    // Live-update the size estimate
    const sizeHint = id('p2wSizeHint');
    if (sizeHint) sizeHint.innerHTML = _sizeHintHTML(_dpi);
  }
}

function _esc(str) {
  const d = document.createElement('div'); d.textContent = str; return d.innerHTML.replace(/"/g, '&quot;');
}

// ── Background table scanner ──────────────────────────────────────────────────
// Runs detectTables() on first N pages after PDF loads.
// Shows a compact info badge in the UI when tables are found.
const SCAN_PAGES = 5;   // scan only first N pages to keep init snappy
const YTOL       = 6;   // must match processor.js _p2wExtractText (was 4; see processor.js:865)

async function _scanTablesBackground(doc, gen) {
  const pageLimit = Math.min(doc.numPages, SCAN_PAGES);
  let totalTables = 0;
  const details   = [];

  for (let p = 1; p <= pageLimit; p++) {
    const page    = await doc.getPage(p);
    const content = await page.getTextContent({ normalizeWhitespace: false });
    page.cleanup?.();

    // Build lines (identical logic to _p2wExtractText in processor.js)
    const items = content.items
      .filter(item => 'str' in item && item.str.trim())
      .map(item => ({
        str:      item.str,
        x:        item.transform[4],
        y:        item.transform[5],
        fontSize: (item.height > 0 ? item.height : Math.abs(item.transform[3])) || 10,
      }));

    const lines = [];
    for (const item of [...items].sort((a, b) => b.y - a.y)) {
      let merged = false;
      for (const ln of lines) {
        if (Math.abs(ln.y - item.y) <= YTOL) { ln.items.push(item); merged = true; break; }
      }
      if (!merged) lines.push({ y: item.y, items: [item] });
    }
    lines.forEach(ln => ln.items.sort((a, b) => a.x - b.x));

    const tables = detectTables(lines, { debug: true });
    totalTables += tables.length;
    if (tables.length) {
      details.push(`p${p}: ${tables.length}×(${tables.map(t =>
        `${t.rows.length}r×${t.colCount}c conf=${(t.confidence*100).toFixed(0)}%`
      ).join(', ')})`);
    }
  }

  // Abort if a newer file was loaded while we were scanning
  if (gen !== _scanGen) return;

  // Update UI badge (only visible when tables found)
  const el = id('pdf2wordOptions');
  if (!el) return;
  const badge = el.querySelector('#p2wTableBadge');
  const scanned = pageLimit < doc.numPages ? `first ${pageLimit} pages` : 'all pages';

  if (totalTables > 0) {
    const msg = `🗂️ ${totalTables} table(s) detected in ${scanned} — ${details.join(' · ')}`;
    if (badge) {
      badge.textContent = msg;
    } else {
      const hint = id('p2wModeHint');
      if (hint) {
        const div = document.createElement('div');
        div.id        = 'p2wTableBadge';
        div.className = 'compress-scan';
        div.style.cssText = 'margin-top:8px;font-size:12px;color:var(--text3);padding:6px 10px';
        div.textContent   = msg;
        hint.after(div);
      }
    }
  } else if (badge) {
    badge.remove();
  }
}

// Export for processor.js (needs the cap value)
export { MAX_IMAGE_PAGES };
