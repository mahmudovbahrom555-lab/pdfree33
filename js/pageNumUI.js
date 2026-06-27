// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  pageNumUI.js — Add Page Numbers options panel
//
//  Two separate concerns, clearly separated in the UI:
//  PAGE RANGE  — which PDF pages to number (fromPage / toPage)
//  NUMBERING   — what numbers to show (format / startAt / showTotal)
//  POSITION    — where on the page (position chips)
// ============================================================

import { id } from './utils.js';
import { chipGroup, sliderRow, checkbox } from './uiComponents.js';
import { formatPageNumber } from './pageNumUtils.js';

// ── State ──────────────────────────────────────────────────────
let _position  = 'bottom-center'; // 'bottom-center'|'bottom-right'|'bottom-left'|'top-center'|'book'
let _format    = 'arabic';        // 'arabic'|'roman'|'alpha'
let _fromPage  = 1;               // first PDF page to number (1-based)
let _toPage    = null;            // last PDF page to number (null = last page)
let _startAt   = 1;               // number shown on the first numbered page
let _autoStart = true;            // true = startAt mirrors fromPage automatically
let _fontSize  = 10;
let _showTotal = false;           // show "1 / N" instead of just "1"

export function getPageNumParams() {
  return {
    position:  _position,
    format:    _format,
    fromPage:  _fromPage,
    toPage:    _toPage,
    startAt:   _startAt,
    fontSize:  _fontSize,
    showTotal: _showTotal,
    // legacy compat: skipFirst = fromPage > 1
    skipFirst: _fromPage > 1,
  };
}

// ── Public API ─────────────────────────────────────────────────

export function initPageNumOptions() {
  const container = id('pageNumOptions');
  if (!container) return;
  container.style.display = 'block';
  _render();
}

export function hidePageNumOptions() {
  const container = id('pageNumOptions');
  if (!container) return;
  container.style.display = 'none';
  container.innerHTML = '';
  _position  = 'bottom-center';
  _format    = 'arabic';
  _fromPage  = 1;
  _toPage    = null;
  _startAt   = 1;
  _autoStart = true;
  _fontSize  = 10;
  _showTotal = false;
}

// ── Render ─────────────────────────────────────────────────────

const INPUT_STYLE = `
  width:64px;text-align:center;
  border:1px solid var(--border);border-radius:6px;
  padding:5px 6px;font-size:14px;font-weight:500;
  background:var(--surface);color:var(--text);
  -moz-appearance:textfield;
`.replace(/\n\s*/g, '');

function _numInput(id, value, placeholder = '') {
  return `<input
    type="number" id="${id}" min="1" max="9999" step="1"
    value="${value ?? ''}" placeholder="${placeholder}"
    style="${INPUT_STYLE}"
    aria-label="${id}">`;
}

function _render() {
  const container = id('pageNumOptions');
  if (!container) return;

  const posOpts = [
    { value: 'bottom-center', label: '↓ Bottom center'           },
    { value: 'bottom-right',  label: '↘ Bottom right'            },
    { value: 'bottom-left',   label: '↙ Bottom left'             },
    { value: 'top-center',    label: '↑ Top center'              },
    { value: 'book',          label: '📖 Book style (outer edge)' },
  ];
  const fmtOpts = [
    { value: 'arabic', label: '1  2  3'   },
    { value: 'roman',  label: 'I  II  III' },
    { value: 'alpha',  label: 'A  B  C'    },
  ];

  container.innerHTML = `
    <style>
      .pn-section { margin-bottom:18px; }
      .pn-section-label {
        font-size:11px;font-weight:700;text-transform:uppercase;
        letter-spacing:.6px;color:var(--text3);margin-bottom:10px;
      }
      .pn-row { display:flex;align-items:center;gap:8px;flex-wrap:wrap; }
      .pn-field { display:flex;flex-direction:column;gap:4px; }
      .pn-field-label { font-size:12px;color:var(--text2); }
      .pn-stepper {
        width:30px;height:30px;border:1px solid var(--border);
        border-radius:6px;background:var(--surface);color:var(--text);
        font-size:16px;cursor:pointer;display:flex;align-items:center;
        justify-content:center;flex-shrink:0;
      }
      .pn-stepper:hover { background:var(--border); }
      .pn-divider { border:none;border-top:1px solid var(--border);margin:16px 0; }
      input[type=number]::-webkit-inner-spin-button,
      input[type=number]::-webkit-outer-spin-button { -webkit-appearance:none; }
    </style>

    <!-- ── PAGE RANGE ── -->
    <div class="pn-section">
      <div class="pn-section-label">Page range</div>
      <div class="pn-row">
        <div class="pn-field">
          <span class="pn-field-label">From page</span>
          <div class="pn-row">
            <button type="button" class="pn-stepper" id="pnFromMinus" aria-label="Decrease from page">−</button>
            ${_numInput('pnFromInput', _fromPage)}
            <button type="button" class="pn-stepper" id="pnFromPlus" aria-label="Increase from page">+</button>
          </div>
        </div>
        <div style="font-size:20px;color:var(--text3);padding-top:18px">→</div>
        <div class="pn-field">
          <span class="pn-field-label">To page <span style="opacity:.5;font-weight:400">(∞ = all)</span></span>
          <div class="pn-row">
            <button type="button" class="pn-stepper" id="pnToMinus" aria-label="Decrease to page">−</button>
            ${_numInput('pnToInput', _toPage, '∞')}
            <button type="button" class="pn-stepper" id="pnToPlus" aria-label="Increase to page">+</button>
          </div>
        </div>
      </div>
    </div>

    <hr class="pn-divider">

    <!-- ── NUMBERING ── -->
    <div class="pn-section">
      <div class="pn-section-label">Numbering</div>
      ${chipGroup('pnFmt', fmtOpts, _format, 'Number format', { radius: '8px' })}

      <!-- Auto start: shows hint + customize link -->
      <div id="pnAutoStartRow" style="margin-top:12px;display:${_autoStart ? 'block' : 'none'}">
        <div style="
          display:flex;align-items:center;justify-content:space-between;gap:10px;
          background:var(--green-light);border:1px solid rgba(45,122,79,0.25);
          border-radius:8px;padding:10px 14px;
        ">
          <div>
            <div style="font-size:12px;color:var(--green);font-weight:600;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px">
              Start number
            </div>
            <div style="font-size:20px;font-weight:700;color:var(--text);line-height:1">
              <span id="pnAutoStartHint">${_formatNum(_startAt, _format)}</span>
            </div>
            <div style="font-size:11px;color:var(--green);margin-top:2px">↑ linked to page range</div>
          </div>
          <button type="button" id="pnCustomizeBtn"
            style="
              background:var(--surface);border:1px solid var(--border);
              border-radius:6px;cursor:pointer;
              font-size:12px;font-weight:500;color:var(--text);
              padding:6px 12px;white-space:nowrap;flex-shrink:0;
            ">
            Customize →
          </button>
        </div>
      </div>

      <!-- Custom start: input + indicator + reset -->
      <div id="pnCustomStartRow" style="margin-top:10px;display:${_autoStart ? 'none' : 'block'}">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap">
          <span style="font-size:12px;color:var(--text3)">↑ custom numbering</span>
          <button type="button" id="pnResetStartBtn"
            style="background:none;border:none;cursor:pointer;font-size:12px;color:var(--green);padding:0;margin-left:auto">
            ↺ Reset to auto
          </button>
        </div>
        <div class="pn-row">
          <button type="button" class="pn-stepper" id="pnStartMinus" aria-label="Decrease start">−</button>
          ${_numInput('pnStartInput', _startAt)}
          <button type="button" class="pn-stepper" id="pnStartPlus" aria-label="Increase start">+</button>
        </div>
      </div>
    </div>

    <hr class="pn-divider">

    <!-- ── POSITION ── -->
    <div class="pn-section">
      <div class="pn-section-label">Position</div>
      ${chipGroup('pnPos', posOpts, _position, 'Position', { vertical: true, radius: '8px' })}
    </div>

    <hr class="pn-divider">

    <!-- ── OPTIONS ── -->
    <div class="pn-section">
      <div class="pn-section-label">Options</div>
      ${checkbox({ id: 'pnShowTotal', checked: _showTotal,
                   title: 'Show total (1 / N)', subtitle: 'Displays current page out of total' })}
    </div>

    <!-- ── SIZE ── -->
    ${sliderRow({ id: 'pnFontSize', label: 'Size', valId: 'pnFontSizeVal',
                  valText: _fontSize + 'pt', min: 7, max: 16, step: 1,
                  value: _fontSize, ariaLabel: `Font size ${_fontSize}pt` })}

    <!-- ── PREVIEW ── -->
    <div class="pn-preview" aria-hidden="true">
      ${_previewHTML()}
    </div>
  `;

  _bindEvents();
}

function _previewHTML() {
  const ex1 = _formatNum(_startAt,     _format);
  const ex2 = _formatNum(_startAt + 1, _format);
  const ex3 = _formatNum(_startAt + 2, _format);
  const sfx = n => _showTotal ? ` / ${_formatNum(_startAt + 9, _format)}` : '';
  const p1  = _fromPage > 1 ? '—' : ex1 + sfx(1);
  const rangeHint = _toPage !== null
    ? `<span class="pn-preview__label" style="margin-left:8px;opacity:.6">pages ${_fromPage}–${_toPage}</span>`
    : (_fromPage > 1 ? `<span class="pn-preview__label" style="margin-left:8px;opacity:.6">from page ${_fromPage}</span>` : '');
  return `<span class="pn-preview__label">Preview:</span>
    <span class="pn-preview__ex">${p1}</span>
    <span class="pn-preview__ex">${ex2 + sfx(2)}</span>
    <span class="pn-preview__ex">${ex3 + sfx(3)}</span>
    <span class="pn-preview__dots">…</span>${rangeHint}`;
}

// ── Events ─────────────────────────────────────────────────────

function _numStepper(inputId, getVal, setVal, min = 1, max = 9999) {
  const input = id(inputId);
  input?.addEventListener('input', e => {
    const v = parseInt(e.target.value, 10);
    if (!isNaN(v) && v >= min && v <= max) { setVal(v); _refreshPreview(); }
  });
  input?.addEventListener('change', e => {
    const raw = e.target.value.trim();
    const v   = raw === '' ? null : Math.max(min, Math.min(max, parseInt(raw, 10) || min));
    setVal(v); e.target.value = v ?? ''; _refreshPreview();
  });
}

function _bindEvents() {
  const container = id('pageNumOptions');

  container.addEventListener('change', e => {
    if (e.target.name === 'pnPos') {
      _position = e.target.value;
      container.querySelectorAll('[data-name="pnPos"]').forEach(el =>
        el.classList.toggle('j2p-chip--active', el.dataset.value === _position));
    }
    if (e.target.name === 'pnFmt') {
      _format = e.target.value;
      container.querySelectorAll('[data-name="pnFmt"]').forEach(el =>
        el.classList.toggle('j2p-chip--active', el.dataset.value === _format));
      // Update auto-start hint when format changes
      const hint = id('pnAutoStartHint');
      if (hint && _autoStart) hint.textContent = _formatNum(_startAt, _format);
      _refreshPreview();
    }
    if (e.target.id === 'pnShowTotal') { _showTotal = e.target.checked; _refreshPreview(); }
  });

  // Helper: sync startAt to fromPage when in auto mode
  function _syncAutoStart() {
    if (!_autoStart) return;
    _startAt = _fromPage;
    const hint = id('pnAutoStartHint');
    if (hint) hint.textContent = _formatNum(_startAt, _format);
  }

  // From page — syncs startAt when auto mode
  id('pnFromInput')?.addEventListener('input', e => {
    const v = parseInt(e.target.value, 10);
    if (!isNaN(v) && v >= 1 && v <= 9999) { _fromPage = v; _syncAutoStart(); _refreshPreview(); }
  });
  id('pnFromInput')?.addEventListener('change', e => {
    const v = Math.max(1, Math.min(9999, parseInt(e.target.value, 10) || 1));
    _fromPage = v; e.target.value = v; _syncAutoStart(); _refreshPreview();
  });
  id('pnFromMinus')?.addEventListener('click', () => {
    if (_fromPage > 1) { _fromPage--; const el = id('pnFromInput'); if (el) el.value = _fromPage; _syncAutoStart(); _refreshPreview(); }
  });
  id('pnFromPlus')?.addEventListener('click', () => {
    if (_fromPage < 9999) { _fromPage++; const el = id('pnFromInput'); if (el) el.value = _fromPage; _syncAutoStart(); _refreshPreview(); }
  });

  // To page
  id('pnToInput')?.addEventListener('input', e => {
    const raw = e.target.value.trim();
    _toPage = (raw === '' || raw === '∞') ? null : Math.max(1, Math.min(9999, parseInt(raw, 10) || 1));
    _refreshPreview();
  });
  id('pnToInput')?.addEventListener('change', e => {
    const raw = e.target.value.trim();
    _toPage = (raw === '' || raw === '∞') ? null : Math.max(1, Math.min(9999, parseInt(raw, 10) || 1));
    e.target.value = _toPage ?? ''; _refreshPreview();
  });
  id('pnToMinus')?.addEventListener('click', () => {
    const cur = _toPage ?? 2;
    if (cur > 1) { _toPage = cur - 1; const el = id('pnToInput'); if (el) el.value = _toPage; _refreshPreview(); }
  });
  id('pnToPlus')?.addEventListener('click', () => {
    _toPage = (_toPage ?? _fromPage) + 1;
    const el = id('pnToInput'); if (el) el.value = _toPage; _refreshPreview();
  });

  // Progressive disclosure — Customize / Reset
  id('pnCustomizeBtn')?.addEventListener('click', () => {
    _autoStart = false;
    const autoRow   = id('pnAutoStartRow');
    const customRow = id('pnCustomStartRow');
    if (autoRow)   autoRow.style.display   = 'none';
    if (customRow) customRow.style.display = 'block';
    const input = id('pnStartInput');
    if (input) { input.value = _startAt; input.focus(); input.select(); }
  });
  id('pnResetStartBtn')?.addEventListener('click', () => {
    _autoStart = true;
    _startAt   = _fromPage;
    const autoRow   = id('pnAutoStartRow');
    const customRow = id('pnCustomStartRow');
    if (autoRow)   autoRow.style.display   = 'flex';
    if (customRow) customRow.style.display = 'none';
    const hint = id('pnAutoStartHint');
    if (hint) hint.textContent = _formatNum(_startAt, _format);
    _refreshPreview();
  });

  // Custom start number
  id('pnStartInput')?.addEventListener('input', e => {
    const v = parseInt(e.target.value, 10);
    if (!isNaN(v) && v >= 1 && v <= 9999) { _startAt = v; _refreshPreview(); }
  });
  id('pnStartInput')?.addEventListener('change', e => {
    const v = Math.max(1, Math.min(9999, parseInt(e.target.value, 10) || 1));
    _startAt = v; e.target.value = v; _refreshPreview();
  });
  id('pnStartMinus')?.addEventListener('click', () => {
    if (_startAt > 1) { _startAt--; const el = id('pnStartInput'); if (el) el.value = _startAt; _refreshPreview(); }
  });
  id('pnStartPlus')?.addEventListener('click', () => {
    if (_startAt < 9999) { _startAt++; const el = id('pnStartInput'); if (el) el.value = _startAt; _refreshPreview(); }
  });

  // Font size
  id('pnFontSize')?.addEventListener('input', e => {
    _fontSize = parseInt(e.target.value, 10);
    const val = id('pnFontSizeVal');
    if (val) val.textContent = e.target.value + 'pt';
  });
}

function _refreshPreview() {
  const prev = id('pageNumOptions')?.querySelector('.pn-preview');
  if (prev) prev.innerHTML = _previewHTML();
}

// ── Numeral formatters ─────────────────────────────────────────
export { formatPageNumber };
function _formatNum(n, fmt) { return formatPageNumber(n, fmt); }
