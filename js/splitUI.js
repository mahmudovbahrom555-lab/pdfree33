// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  splitUI.js — UI логика для инструмента Split PDF
//  Отвечает за:
//  - Отображение информации о файле (страниц)
//  - Панель выбора страниц (чекбоксы до 30, диапазон > 30)
//  - Переключатель режима (постранично / одним файлом)
//  - Экспорт selectedPages и splitMode для processor.js
// ============================================================

import { id, esc } from './utils.js';
import { showToast } from './ui.js';
import { t, tp } from './i18n.js';
import { trackToolError } from './analytics.js';
import { parseRange as _parseRangeUtil, pagesToRangeString,
         renderCheckboxes as _renderCheckboxesUtil,
         renderRangeInput as _renderRangeInputUtil } from './pageSelectorUtils.js';

// ── State ──────────────────────────────────────────────────────
let _pageCount    = 0;
let _selectedPages = [];   // массив номеров 1-indexed
let _mode         = 'separate'; // 'separate' | 'single'

export function getSelectedPages() { return [..._selectedPages]; }
export function getSplitMode()     { return _mode; }

// ── Public API ────────────────────────────────────────────────

/**
 * Инициализирует панель выбора страниц для загруженного файла.
 * Читает количество страниц из файла через pdf-lib (импорт через CDN).
 * @param {File} file
 */
export async function initSplitOptions(file) {
  const container = id('splitOptions');
  if (!container) return;

  container.innerHTML = '<div class="split-loading">Reading PDF…</div>';
  container.style.display = 'block';

  try {
    // pdf-lib доступен как глобальная переменная через CDN скрипт в index.html
    const { PDFDocument } = window.PDFLib;
    const buf  = await file.arrayBuffer();
    const doc  = await PDFDocument.load(buf, { ignoreEncryption: true });
    _pageCount = doc.getPageCount();

    if (_pageCount === 0) {
      showToast(t('no_pages_pdf'));
      container.innerHTML = '';
      container.style.display = 'none';
      return;
    }

    if (_pageCount > 500) {
      showToast(t('warn_large_pdf', { n: _pageCount }), 5000);
    }

    // По умолчанию выбраны все страницы
    _selectedPages = Array.from({ length: _pageCount }, (_, i) => i + 1);
    _mode = 'separate';

    _render();
  } catch (err) {
    trackToolError('split', 'pdf_read_failed');
    showToast(t('err_read_pages', { msg: err.message }));
    container.style.display = 'none';
  }
}

/** Скрывает и очищает панель */
export function hideSplitOptions() {
  const container = id('splitOptions');
  if (!container) return;
  container.style.display = 'none';
  container.innerHTML = '';
  _pageCount     = 0;
  _selectedPages = [];
  _mode          = 'separate';
}

// ── Render ────────────────────────────────────────────────────

function _render() {
  const container = id('splitOptions');
  if (!container) return;

  const useRange = _pageCount > 30;

  container.innerHTML = `
    <div class="split-info">
      <span class="split-info__pages">${tp(_pageCount, 'split_info_page', 'split_info_pages')}</span>
    </div>

    <div class="split-mode">
      <label class="split-mode__opt ${_mode === 'separate' ? 'active' : ''}" data-mode="separate">
        <input type="radio" name="splitMode" value="separate" ${_mode === 'separate' ? 'checked' : ''}>
        <span>✂️ ${t('split_mode_separate')}</span>
        <small>${t('split_mode_separate_desc')}</small>
      </label>
      <label class="split-mode__opt ${_mode === 'single' ? 'active' : ''}" data-mode="single">
        <input type="radio" name="splitMode" value="single" ${_mode === 'single' ? 'checked' : ''}>
        <span>📄 ${t('split_mode_single')}</span>
        <small>${t('split_mode_single_desc')}</small>
      </label>
    </div>

    <div class="split-pages">
      <div class="split-pages__header">
        <span class="split-pages__label">${t('split_pages_label')}</span>
        <div class="split-pages__actions">
          <button type="button" class="split-action-btn" id="splitSelectAll">${t('select_all')}</button>
          <button type="button" class="split-action-btn" id="splitDeselectAll">${t('deselect_all')}</button>
        </div>
      </div>

      ${useRange ? _renderRangeInput() : _renderCheckboxes()}

      <div class="split-pages__count" id="splitPageCount">
        ${t('pages_selected', { n: _selectedPages.length, total: _pageCount })}
      </div>
    </div>
  `;

  _bindEvents(useRange);
}

// Delegates to pageSelectorUtils — no duplication with pdf2jpgUI
function _renderCheckboxes() {
  return _renderCheckboxesUtil(_pageCount, _selectedPages);
}

function _renderRangeInput() {
  return _renderRangeInputUtil(_selectedPages, 'splitRangeInput', 'splitRangeApply');
}

// ── Events ────────────────────────────────────────────────────
// Примечание: _bindEvents добавляет слушатели на container каждый раз при вызове _render().
// Это безопасно, т.к. _render() полностью перезаписывает container.innerHTML,
// что уничтожает старые DOM-узлы вместе с их слушателями.

function _bindEvents(useRange) {
  // Mode switch
  id('splitOptions').addEventListener('change', e => {
    if (e.target.name === 'splitMode') {
      _mode = e.target.value;
      // Обновляем active класс
      document.querySelectorAll('.split-mode__opt').forEach(el => {
        el.classList.toggle('j2p-chip--active', el.dataset.mode === _mode);
      });
      _updateBtn();
    }
  });

  // Select all / Deselect all
  id('splitSelectAll')?.addEventListener('click', () => {
    _selectedPages = Array.from({ length: _pageCount }, (_, i) => i + 1);
    if (useRange) {
      id('splitRangeInput').value = `1-${_pageCount}`;
    } else {
      _syncCheckboxes();
    }
    _updateCount();
    _updateBtn();
  });

  id('splitDeselectAll')?.addEventListener('click', () => {
    _selectedPages = [];
    if (useRange) {
      id('splitRangeInput').value = '';
    } else {
      _syncCheckboxes();
    }
    _updateCount();
    _updateBtn();
  });

  if (useRange) {
    // Apply кнопка
    id('splitRangeApply')?.addEventListener('click', () => {
      const raw = id('splitRangeInput')?.value || '';
      const pages = _parseRange(raw, _pageCount);
      if (pages.length === 0 && raw.trim() !== '') {
        showToast(t('invalid_range'));
        return;
      }
      _selectedPages = pages;
      _updateCount();
      _updateBtn();
    });
    // Enter в поле
    id('splitRangeInput')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') id('splitRangeApply')?.click();
    });
  } else {
    // Чекбоксы
    id('splitOptions').addEventListener('change', e => {
      if (e.target.type === 'checkbox') {
        const page = parseInt(e.target.value);
        if (e.target.checked) {
          if (!_selectedPages.includes(page)) _selectedPages.push(page);
        } else {
          _selectedPages = _selectedPages.filter(p => p !== page);
        }
        _selectedPages.sort((a, b) => a - b);
        e.target.closest('label')?.classList.toggle('checked', e.target.checked);
        _updateCount();
        _updateBtn();
      }
    });
  }
}

function _syncCheckboxes() {
  document.querySelectorAll('#splitOptions input[type="checkbox"]').forEach(cb => {
    const page = parseInt(cb.value);
    cb.checked = _selectedPages.includes(page);
    cb.closest('label')?.classList.toggle('checked', cb.checked);
  });
}

function _updateCount() {
  const el = id('splitPageCount');
  if (el) el.textContent = t('pages_selected', { n: _selectedPages.length, total: _pageCount });
}

function _updateBtn() {
  const btn = id('mergeBtn');
  if (!btn) return;
  const ok = _selectedPages.length > 0;
  btn.disabled = !ok;
  const n = _selectedPages.length;
  const label = _mode === 'separate'
    ? tp(n, 'split_btn_separate', 'split_btn_separate_many')
    : tp(n, 'split_btn_single',   'split_btn_single_many');
  btn.textContent = ok ? label : t('split_btn_disabled');
}

// ── Utilities ─────────────────────────────────────────────────

/**
 * Парсит строку диапазонов в массив номеров страниц.
 * "1-3, 5, 7-9" → [1,2,3,5,7,8,9]
 */
// Public re-export — pdf2jpgUI and extractUI import parseRange from here
export function parseRange(str, maxPage) {
  return _parseRangeUtil(str, maxPage);
}

// Private delegates
function _parseRange(str, maxPage)  { return _parseRangeUtil(str, maxPage); }
function _pagesToRangeString(pages) { return pagesToRangeString(pages); }
