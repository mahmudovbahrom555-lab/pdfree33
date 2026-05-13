// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  utils.js — Pure helper functions (no DOM, no side effects)
//  Можно тестировать изолированно (см. tests/)
// ============================================================

/**
 * XSS-safe escape строки для вставки в innerHTML
 * @param {string} str
 * @returns {string}
 */
export function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Форматирует байты в читаемый размер файла
 * @param {number} bytes
 * @returns {string}  e.g. "1.4 MB"
 */
export function fmtSize(bytes) {
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1_048_576)   return Math.round(bytes / 1024) + ' KB';
  return (bytes / 1_048_576).toFixed(1) + ' MB';
}

/**
 * Shorthand для document.getElementById
 * @param {string} elementId
 * @returns {HTMLElement}
 */
export function id(elementId) {
  return document.getElementById(elementId);
}

/**
 * Показывает элемент (убирает display:none)
 * @param {string} elementId
 */
export function show(elementId) {
  id(elementId).style.display = '';
}

/**
 * Скрывает элемент
 * @param {string} elementId
 */
export function hide(elementId) {
  id(elementId).style.display = 'none';
}

/**
 * Устанавливает textContent элемента
 * @param {string} elementId
 * @param {string} value
 */
export function setText(elementId, value) {
  id(elementId).textContent = value;
}

/**
 * Проверяет, соответствует ли файл допустимым MIME-типам.
 * Атрибут accept на <input> не защищает от drag-and-drop —
 * браузер применяет его только к диалогу выбора файлов.
 *
 * @param {File}     file          - файл для проверки
 * @param {string}   acceptString  - строка accept из config, e.g. ".pdf"
 * @param {Record<string, string[]>} mimeMap - карта ACCEPTED_MIME из config
 * @returns {boolean}
 */
export function isFileAccepted(file, acceptString, mimeMap) {
  const allowed = mimeMap[acceptString];
  if (!allowed) return true; // если карты нет — пропускаем (не блокируем)

  // Проверяем MIME-тип (надёжнее расширения, но может быть пустым на некоторых ОС)
  if (file.type && allowed.includes(file.type)) return true;

  // Запасная проверка по расширению (для случаев когда MIME пустой)
  const ext = file.name.split('.').pop()?.toLowerCase();
  return acceptString.split(',').some(a => a.trim() === '.' + ext);
}
