// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

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
      showToast('This PDF has no pages');
      container.innerHTML = '';
      container.style.display = 'none';
      return;
    }

    if (_pageCount > 500) {
      showToast(`⚠️ Large PDF (${_pageCount} pages) — processing may take a while`, 5000);
    }

    // По умолчанию выбраны все страницы
    _selectedPages = Array.from({ length: _pageCount }, (_, i) => i + 1);
    _mode = 'separate';

    _render();
  } catch (err) {
    showToast('Could not read PDF pages: ' + err.message);
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
      <span class="split-info__pages">${_pageCount} page${_pageCount > 1 ? 's' : ''}</span>
    </div>

    <div class="split-mode">
      <label class="split-mode__opt ${_mode === 'separate' ? 'active' : ''}" data-mode="separate">
        <input type="radio" name="splitMode" value="separate" ${_mode === 'separate' ? 'checked' : ''}>
        <span>✂️ Separate files</span>
        <small>Each page → individual PDF</small>
      </label>
      <label class="split-mode__opt ${_mode === 'single' ? 'active' : ''}" data-mode="single">
        <input type="radio" name="splitMode" value="single" ${_mode === 'single' ? 'checked' : ''}>
        <span>📄 Single file</span>
        <small>Selected pages → one PDF</small>
      </label>
    </div>

    <div class="split-pages">
      <div class="split-pages__header">
        <span class="split-pages__label">Pages to extract</span>
        <div class="split-pages__actions">
          <button type="button" class="split-action-btn" id="splitSelectAll">Select all</button>
          <button type="button" class="split-action-btn" id="splitDeselectAll">Deselect all</button>
        </div>
      </div>

      ${useRange ? _renderRangeInput() : _renderCheckboxes()}

      <div class="split-pages__count" id="splitPageCount">
        ${_selectedPages.length} of ${_pageCount} pages selected
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
        showToast('Invalid range — no valid pages found');
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
  if (el) el.textContent = `${_selectedPages.length} of ${_pageCount} pages selected`;
}

function _updateBtn() {
  const btn = id('mergeBtn');
  if (!btn) return;
  const ok = _selectedPages.length > 0;
  btn.disabled = !ok;
  const label = _mode === 'separate'
    ? `✂️ Split into ${_selectedPages.length} file${_selectedPages.length > 1 ? 's' : ''}`
    : `📄 Extract ${_selectedPages.length} page${_selectedPages.length > 1 ? 's' : ''}`;
  btn.textContent = ok ? label : '✂️ Select pages to split';
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
