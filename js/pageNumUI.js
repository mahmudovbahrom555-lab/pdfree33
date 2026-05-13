// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  pageNumUI.js — Add Page Numbers options panel
//
//  🎯 Сверх ТЗ:
//  1. Roman / Arabic / Alpha numeration (I II III vs 1 2 3 vs A B C)
//  2. Skip first page — обложка остаётся без номера
//  3. Odd/even side — номера справа на нечётных, слева на чётных
//     (как в книгах) — одна опция заменяет сложную настройку
//  4. Стартовый номер — нумерация с любого числа
// ============================================================

import { id } from './utils.js';
import { chip, chipGroup, sliderRow, checkbox, group, row } from './uiComponents.js';
import { formatPageNumber, toRoman, toAlpha } from './pageNumUtils.js';

// ── State ──────────────────────────────────────────────────────
let _position   = 'bottom-center'; // 'bottom-center'|'bottom-right'|'bottom-left'|'top-center'|'book'
let _format     = 'arabic';        // 'arabic'|'roman'|'alpha'
let _startAt    = 1;
let _skipFirst  = false;
let _fontSize   = 10;
let _showTotal  = false;           // show "1 / N" instead of just "1"

export function getPageNumParams() {
  return { position: _position, format: _format, startAt: _startAt,
           skipFirst: _skipFirst, fontSize: _fontSize, showTotal: _showTotal };
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
  _startAt   = 1;
  _skipFirst = false;
  _fontSize  = 10;
  _showTotal = false;
}

// ── Render ─────────────────────────────────────────────────────

function _render() {
  const container = id('pageNumOptions');
  if (!container) return;

  const posOpts = [
    { value: 'bottom-center', label: '↓ Bottom center'            },
    { value: 'bottom-right',  label: '↘ Bottom right'             },
    { value: 'bottom-left',   label: '↙ Bottom left'              },
    { value: 'top-center',    label: '↑ Top center'               },
    { value: 'book',          label: '📖 Book style (outer edge)'  },
  ];
  const fmtOpts = [
    { value: 'arabic', label: '1  2  3'   },
    { value: 'roman',  label: 'I  II  III' },
    { value: 'alpha',  label: 'A  B  C'    },
  ];

  container.innerHTML = `
    ${row(
      group('Position', chipGroup('pnPos', posOpts, _position, 'Position', { vertical: true, radius: '8px' })),
      group('Format', `
        ${chipGroup('pnFmt', fmtOpts, _format, 'Numeration format', { vertical: true, radius: '8px' })}
        <div class="j2p-label" style="margin-top:12px">Start at</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
          <button type="button" class="pn-stepper" id="pnStartMinus" aria-label="Decrease">−</button>
          <span class="pn-start-val" id="pnStartVal" aria-live="polite">${_formatNum(_startAt, _format)}</span>
          <button type="button" class="pn-stepper" id="pnStartPlus" aria-label="Increase">+</button>
        </div>
        <div class="j2p-label" style="margin-top:12px">Options</div>
        ${checkbox({ id: 'pnSkipFirst', checked: _skipFirst, style: 'margin-top:4px',
                     title: 'Skip first page', subtitle: "Don't number the cover / title page" })}
        ${checkbox({ id: 'pnShowTotal', checked: _showTotal, style: 'margin-top:8px',
                     title: 'Show total (1 / N)', subtitle: 'Displays current page out of total' })}
      `)
    )}

    ${sliderRow({ id: 'pnFontSize', label: 'Size', valId: 'pnFontSizeVal',
                  valText: _fontSize + 'pt', min: 7, max: 16, step: 1,
                  value: _fontSize, ariaLabel: `Font size ${_fontSize}pt`,
                  style: 'margin-top:4px' })}

    <div class="pn-preview" aria-hidden="true">
      ${_previewHTML()}
    </div>
  `;

  _bindEvents();
}

function _previewHTML() {
  const ex1 = _formatNum(_startAt, _format);
  const ex2 = _formatNum(_startAt + 1, _format);
  const ex3 = _formatNum(_startAt + 2, _format);
  const sfx = n => _showTotal ? ` / ${_formatNum(_startAt + 10, _format)}` : '';
  return `<span class="pn-preview__label">Preview:</span>
    <span class="pn-preview__ex">${_skipFirst ? '—' : ex1 + sfx(1)}</span>
    <span class="pn-preview__ex">${ex2 + sfx(2)}</span>
    <span class="pn-preview__ex">${ex3 + sfx(3)}</span>
    <span class="pn-preview__dots">…</span>`;
}

// ── Events ─────────────────────────────────────────────────────

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
      _refreshPreview();
    }
    if (e.target.id === 'pnSkipFirst') {
      _skipFirst = e.target.checked;
      _refreshPreview();
    }
    if (e.target.id === 'pnShowTotal') {
      _showTotal = e.target.checked;
      _refreshPreview();
    }
  });

  id('pnStartMinus')?.addEventListener('click', () => {
    if (_startAt > 1) { _startAt--; _refreshPreview(); }
  });
  id('pnStartPlus')?.addEventListener('click', () => {
    if (_startAt < 999) { _startAt++; _refreshPreview(); }
  });

  id('pnFontSize')?.addEventListener('input', e => {
    _fontSize = parseInt(e.target.value);
    const val = id('pnFontSizeVal');
    if (val) val.textContent = e.target.value + 'pt';
  });
}

function _refreshPreview() {
  const el = id('pnStartVal');
  if (el) el.textContent = _formatNum(_startAt, _format);
  const prev = id('pageNumOptions')?.querySelector('.pn-preview');
  if (prev) prev.innerHTML = _previewHTML();
}

// ── Numeral formatters ─────────────────────────────────────────
// Implementations live in pageNumUtils.js (shared with tests).
// worker.js keeps its own copy (can't use ES modules via importScripts).
// Integration tests verify both produce identical output.

// Re-export for callers who import formatPageNumber from this module
export { formatPageNumber };

// Local alias used by _render and _previewHTML
function _formatNum(n, fmt) { return formatPageNumber(n, fmt); }

// ── Helpers ────────────────────────────────────────────────────


