// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

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
 * Truncates a long filename in the middle, preserving the start and the
 * extension — "Screenshot 2026-08-12 at 19.19.09.pdf" (38 chars) becomes
 * "Screenshot 2026-08-….pdf" at maxLen=24. Used where a long OS-generated
 * filename (screenshots, camera exports) would otherwise wrap the success
 * card's download confirmation onto 3+ lines.
 * @param {string} name
 * @param {number} [maxLen=24]
 * @returns {string}
 */
export function truncateMiddle(name, maxLen = 24) {
  if (!name || name.length <= maxLen) return name;
  const dotIdx = name.lastIndexOf('.');
  const ext  = dotIdx > 0 ? name.slice(dotIdx) : '';
  const base = dotIdx > 0 ? name.slice(0, dotIdx) : name;
  const keep = Math.max(4, maxLen - ext.length - 1);
  return base.slice(0, keep) + '…' + ext;
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
  const el = id(elementId); if (el) el.style.display = '';
}

/**
 * Скрывает элемент
 * @param {string} elementId
 */
export function hide(elementId) {
  const el = id(elementId); if (el) el.style.display = 'none';
}

/**
 * Устанавливает textContent элемента
 * @param {string} elementId
 * @param {string} value
 */
export function setText(elementId, value) {
  const el = id(elementId); if (el) el.textContent = value;
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

// AbortSignal.throwIfAborted() and signal.reason are Chrome 100 / 98, Safari
// 15.4: on an older browser Compress stopped with "throwIfAborted is not a
// function" on 10–50 MB files (Analytics, 2026-11-17). The same, everywhere.
export function abortReason(signal) {
  return signal.reason ?? Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}
export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

// A photo or picture Merge takes alongside PDFs, each made one page by
// Images → PDF's own conversion (2026-11-18: 4 people a day brought a .jpg to
// Merge and were turned away). TIFF stays Images → PDF's own: it has a
// decoding path of its own there.
export function isMergeImage(file) {
  return /^image\/(?:jpeg|png|webp|heic|heif)$/i.test(file.type || '') || /\.(?:jpe?g|png|webp|heic|heif)$/i.test(file.name || '');
}
