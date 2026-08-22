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
import { chipGroup, sliderRow, checkbox, presetRememberCard } from './uiComponents.js';
import { formatPageNumber } from './pageNumUtils.js';
import { t } from './i18n.js';
import { loadPreset, clearPreset } from './presets.js';
import { loadPdfLib } from './lazyLibs.js';

// ── State ──────────────────────────────────────────────────────
let _position  = 'bottom-center'; // 'bottom-center'|'bottom-right'|'bottom-left'|'top-center'|'book'
let _format    = 'arabic';        // 'arabic'|'roman'|'alpha'
let _fromPage  = 1;               // first PDF page to number (1-based)
let _toPage    = null;            // last PDF page to number (null = last page)
let _startAt   = 1;               // number shown on the first numbered page
let _autoStart = true;            // true = startAt mirrors fromPage automatically
let _fontSize  = 10;
let _showTotal = false;           // show "1 / N" instead of just "1"
let _rememberLoaded = false;      // "Remember my settings" applied once per tool session
// 0 = not known yet (or read failed) — validate() in toolRegistrations.js skips
// the bounds check in that case rather than risk a false-positive block; the
// worker's own clamp (js/worker.js) stays the last-resort safety net either way.
let _pageCount = 0;
let _pageCountGen = 0; // guards against a slower earlier read overwriting a later file's count

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
    // Real page count of the current (first/representative) file, once known —
    // 0 means "not read yet or unreadable". See toolRegistrations.js's pagenum
    // `validate`, which uses this to catch an out-of-range From/To that would
    // otherwise silently number zero pages (see js/worker.js's own clamp).
    pageCount: _pageCount,
  };
}

// ── Public API ─────────────────────────────────────────────────

export function initPageNumOptions(file) {
  // Restore saved settings once per tool session — fromPage/toPage are never
  // part of the saved preset (this document's own page range, see
  // presetFilter in toolRegistrations.js), so numbering always starts fresh
  // from the top for a new document.
  if (!_rememberLoaded) {
    _rememberLoaded = true;
    const saved = loadPreset('pagenum');
    if (saved) {
      _position  = saved.position  ?? _position;
      _format    = saved.format    ?? _format;
      _fontSize  = saved.fontSize  ?? _fontSize;
      _showTotal = saved.showTotal ?? _showTotal;
    }
  }

  const container = id('pageNumOptions');
  if (!container) return;
  container.style.display = 'block';

  // Lightweight page-count read (for validate()'s bounds check only — no
  // thumbnails/rotation-reading like rotateUI.js, this panel doesn't need
  // them). Runs on every init call, independent of the render-guard below,
  // so it stays current even when a later file replaces files[0] in the
  // batch queue while the panel is already open. Generation-guarded so a
  // slower read for an earlier file can't clobber a newer one that resolved
  // first.
  if (file) {
    const myGen = ++_pageCountGen;
    (async () => {
      try {
        await loadPdfLib();
        const { PDFDocument } = window.PDFLib;
        const buf = await file.arrayBuffer();
        const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
        if (myGen !== _pageCountGen) return; // superseded by a newer file
        _pageCount = doc.getPageCount();
      } catch {
        if (myGen !== _pageCountGen) return;
        _pageCount = 0; // unknown — validate() skips the bounds check
      }
    })();
  }

  // pagenum is multi:true/batch:true — dropping a 2nd file into the queue
  // re-fires 'pdfree:files-added' → this function again, while the panel
  // (file-independent: no filename/page-count content) is already open.
  // Same bug class as protectUI.js's fix in this same audit pass: an
  // unconditional _render() here rebuilds every input from scratch,
  // dropping focus/cursor position on whichever field the user is
  // mid-typing (From/To page, Start at, font size). State values
  // themselves survive (closure vars, not reset here), but the DOM node
  // identity doesn't — skip the rebuild entirely if already rendered.
  //
  // The From/To inputs' visible `max` stays the hardcoded 9999 even after
  // _pageCount is known — this guard is exactly why (see CAUTION above this
  // comment previously): switch to merge.js/jpg2pdf.js's static/per-file
  // split if this panel ever needs to reflect the real count in the DOM
  // itself. validate() below is what actually catches an out-of-range value
  // regardless, so this doesn't reopen the silent-no-op bug.
  if (id('pnFromInput')) return;
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
  _rememberLoaded = false;
  _pageCount = 0;
  _pageCountGen++; // invalidate any in-flight read from the file that just left
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
    { value: 'bottom-center', label: t('pn_pos_bottom_center') },
    { value: 'bottom-right',  label: t('pn_pos_bottom_right')  },
    { value: 'bottom-left',   label: t('pn_pos_bottom_left')   },
    { value: 'top-center',    label: t('pn_pos_top_center')    },
    { value: 'book',          label: t('pn_pos_book')          },
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
      <div class="pn-section-label">${t('pn_apply_to_pages')}</div>
      <div class="pn-row">
        <div class="pn-field">
          <span class="pn-field-label">${t('pn_from_page')}</span>
          <div class="pn-row">
            <button type="button" class="pn-stepper" id="pnFromMinus" aria-label="${t('pn_aria_dec_from')}">−</button>
            ${_numInput('pnFromInput', _fromPage)}
            <button type="button" class="pn-stepper" id="pnFromPlus" aria-label="${t('pn_aria_inc_from')}">+</button>
          </div>
        </div>
        <div style="font-size:20px;color:var(--text3);padding-top:18px">→</div>
        <div class="pn-field">
          <span class="pn-field-label">${t('pn_to_page')} <span style="opacity:.5;font-weight:400">${t('pn_to_page_all')}</span></span>
          <div class="pn-row">
            <button type="button" class="pn-stepper" id="pnToMinus" aria-label="${t('pn_aria_dec_to')}">−</button>
            ${_numInput('pnToInput', _toPage, '∞')}
            <button type="button" class="pn-stepper" id="pnToPlus" aria-label="${t('pn_aria_inc_to')}">+</button>
          </div>
        </div>
      </div>
    </div>

    <hr class="pn-divider">

    <!-- ── NUMBERING ── -->
    <div class="pn-section">
      <div class="pn-section-label">${t('pn_section_numbering')}</div>
      ${chipGroup('pnFmt', fmtOpts, _format, t('pn_aria_number_format'), { radius: '8px' })}

      <!-- Start number card — compact, not dominant -->
      <div style="
        margin-top:12px;
        background:var(--surface);border:1px solid var(--border);
        border-radius:8px;padding:10px 14px;
      ">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);margin-bottom:6px">
          ${t('pn_start_label')}
        </div>

        <!-- Auto body -->
        <div id="pnAutoStartRow" style="display:${_autoStart ? 'flex' : 'none'};align-items:flex-start;justify-content:space-between;gap:8px;transition:opacity .15s">
          <div>
            <span style="font-size:11px;font-weight:600;background:var(--green-light);color:var(--green);padding:2px 8px;border-radius:10px;display:inline-block;margin-bottom:4px">${t('pn_auto_tag')}</span>
            <div id="pnAutoStartHint" style="font-size:22px;font-weight:700;color:var(--text);line-height:1.1;transition:opacity .15s">
              ${_formatNum(_startAt, _format)}
            </div>
            <div style="font-size:11px;color:var(--text3);margin-top:3px">${t('pn_auto_follows')}</div>
          </div>
          <button type="button" id="pnCustomizeBtn"
            style="flex-shrink:0;margin-top:2px;border:1px solid var(--border);border-radius:6px;background:var(--surface);cursor:pointer;font-size:13px;color:var(--text2);padding:6px 12px;display:flex;align-items:center;gap:5px;white-space:nowrap">
            <span style="font-size:16px;line-height:1">📝</span>${t('pn_customize')}
          </button>
        </div>

        <!-- Custom body -->
        <div id="pnCustomStartRow" style="display:${_autoStart ? 'none' : 'block'};transition:opacity .15s">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px">
            <span style="font-size:11px;font-weight:600;border:1px solid var(--border);color:var(--text2);padding:2px 8px;border-radius:10px">${t('pn_custom_tag')}</span>
            <button type="button" id="pnResetStartBtn"
              style="border:1px solid var(--border);border-radius:6px;background:var(--surface);cursor:pointer;font-size:12px;color:var(--text2);padding:5px 10px;display:flex;align-items:center;gap:4px">
              ${t('pn_back_auto')}
            </button>
          </div>
          <div class="pn-row">
            <button type="button" class="pn-stepper" id="pnStartMinus" aria-label="${t('pn_aria_dec_start')}">−</button>
            ${_numInput('pnStartInput', _startAt)}
            <button type="button" class="pn-stepper" id="pnStartPlus" aria-label="${t('pn_aria_inc_start')}">+</button>
          </div>
        </div>
      </div>
    </div>

    <hr class="pn-divider">

    <!-- ── POSITION ── -->
    <div class="pn-section">
      <div class="pn-section-label">${t('pn_section_position')}</div>
      ${chipGroup('pnPos', posOpts, _position, t('pn_section_position'), { vertical: true, radius: '8px' })}
    </div>

    <hr class="pn-divider">

    <!-- ── OPTIONS ── -->
    <div class="pn-section">
      <div class="pn-section-label">${t('pn_section_options')}</div>
      ${checkbox({ id: 'pnShowTotal', checked: _showTotal,
                   title: t('pn_show_total_title'), subtitle: t('pn_show_total_subtitle') })}
    </div>

    <!-- ── SIZE ── -->
    ${sliderRow({ id: 'pnFontSize', label: t('pn_size_label'), valId: 'pnFontSizeVal',
                  valText: _fontSize + 'pt', min: 7, max: 16, step: 1,
                  value: _fontSize, ariaLabel: t('pn_aria_font_size', { size: _fontSize }) })}

    ${presetRememberCard({
      id:       'pagenumRememberCheck',
      checked:  loadPreset('pagenum') !== null,
      title:    '💾 ' + t('preset_remember_title'),
      subtitle: t('preset_remember_sub'),
      ariaLabel: t('preset_remember_title'),
    })}

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
    ? `<span class="pn-preview__label" style="margin-left:8px;opacity:.6">${t('pn_preview_range', { from: _fromPage, to: _toPage })}</span>`
    : (_fromPage > 1 ? `<span class="pn-preview__label" style="margin-left:8px;opacity:.6">${t('pn_preview_from', { from: _fromPage })}</span>` : '');
  return `<span class="pn-preview__label">${t('pn_preview_label')}</span>
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
    // Unchecking forgets immediately — saving happens centrally in app.js
    // (_maybeSavePreset) right before processing starts.
    if (e.target.id === 'pagenumRememberCheck' && !e.target.checked) {
      clearPreset('pagenum');
    }
  });

  // Helper: sync startAt to fromPage when in auto mode + microanimation
  function _syncAutoStart() {
    if (!_autoStart) return;
    _startAt = _fromPage;
    const hint = id('pnAutoStartHint');
    if (!hint) return;
    // Fade out → update → fade in
    hint.style.opacity = '0.2';
    setTimeout(() => {
      hint.textContent = _formatNum(_startAt, _format);
      hint.style.opacity = '1';
    }, 120);
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
  function _switchToCustom() {
    _autoStart = false;
    const autoRow   = id('pnAutoStartRow');
    const customRow = id('pnCustomStartRow');
    if (autoRow)   { autoRow.style.opacity = '0'; setTimeout(() => { autoRow.style.display = 'none'; autoRow.style.opacity = '1'; }, 150); }
    if (customRow) { customRow.style.opacity = '0'; customRow.style.display = 'block'; requestAnimationFrame(() => { customRow.style.opacity = '1'; }); }
    const input = id('pnStartInput');
    if (input) { input.value = _startAt; setTimeout(() => { input.focus(); input.select(); }, 160); }
  }

  function _switchToAuto() {
    _autoStart = true;
    _startAt   = _fromPage;
    const autoRow   = id('pnAutoStartRow');
    const customRow = id('pnCustomStartRow');
    if (customRow) { customRow.style.opacity = '0'; setTimeout(() => { customRow.style.display = 'none'; customRow.style.opacity = '1'; }, 150); }
    if (autoRow)   { autoRow.style.opacity = '0'; autoRow.style.display = 'flex'; requestAnimationFrame(() => { autoRow.style.opacity = '1'; }); }
    const hint = id('pnAutoStartHint');
    if (hint) hint.textContent = _formatNum(_startAt, _format);
    _refreshPreview();
  }

  id('pnCustomizeBtn')?.addEventListener('click', _switchToCustom);
  id('pnResetStartBtn')?.addEventListener('click', _switchToAuto);

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
