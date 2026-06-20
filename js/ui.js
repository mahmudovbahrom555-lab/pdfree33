// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  ui.js — UI utilities: toast, progress, page transitions
//  Всё что связано с отображением, но не с бизнес-логикой
// ============================================================

import { id, show, hide, setText } from './utils.js';
import { t } from './i18n.js';

// ── Toast ──────────────────────────────────────────────────

let _toastTimer = null;

/**
 * Показывает уведомление внизу экрана (не блокирует UI)
 * @param {string} message
 * @param {number} [duration=3000]
 */
export function showToast(message, duration = 3000) {
  const el = id('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ── Progress bar ───────────────────────────────────────────

/**
 * Показывает прогресс-бар и устанавливает значение
 * @param {number} percent  0–100
 * @param {string} [label]
 */
export function setProgress(percent, label = '') {
  const bar  = id('progressBar');
  const fill = id('progressFill');
  const lbl  = id('progressLabel');
  if (!bar || !fill || !lbl) return;

  bar.style.display = 'block';
  lbl.style.display = 'block';
  fill.style.width  = percent + '%';
  if (label) lbl.textContent = label;
}

/** Скрывает прогресс-бар */
export function hideProgress() {
  hide('progressBar');
  hide('progressLabel');
  id('progressFill').style.width = '0%';
}

// ── Page sections visibility ───────────────────────────────

/** Показывает главную страницу (hero + grid) */
export function showHomePage() {
  show('hero');
  show('trustAlert');
  show('noLimitBar');
  show('toolsGrid');
  show('privacyBar');
  hide('toolArea');
}

/** Показывает страницу конкретного инструмента */
export function showToolPage() {
  hide('hero');
  hide('trustAlert');
  hide('noLimitBar');
  hide('toolsGrid');
  hide('privacyBar');
  show('toolArea');
}

// ── Tool header ────────────────────────────────────────────

/**
 * Обновляет заголовок инструмента
 * @param {{ icon: string, title: string, desc: string }} tool
 */
export function renderToolHeader(tool) {
  setText('toolIcon',  tool.icon);
  setText('toolTitle', tool.title);
  setText('toolDesc',  tool.desc);
  document.title = tool.title + ' — PDFree';
}

// ── Process button ─────────────────────────────────────────

/**
 * Переводит кнопку в состояние "обработка"
 */
export function setButtonProcessing() {
  const btn = id('mergeBtn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = t('btn_processing');
}

/**
 * Сбрасывает кнопку в нормальное состояние
 * @param {string} label
 */
export function setButtonReady(label) {
  const btn = id('mergeBtn');
  btn.disabled = false;
  btn.textContent = label;
}

/**
 * Блокирует кнопку (нет файлов)
 */
export function setButtonDisabled() {
  id('mergeBtn').disabled = true;
}

// ── Cancel button ──────────────────────────────────────────
// Единственное место управления видимостью кнопки отмены.
// Раньше логика дублировалась в processor.js и app.js —
// теперь оба модуля импортируют эти функции из ui.js.

/** Показывает кнопку отмены */
export function showCancelBtn() {
  const btn = id('cancelBtn');
  if (btn) btn.style.display = 'block';
}

/** Скрывает кнопку отмены */
export function hideCancelBtn() {
  const btn = id('cancelBtn');
  if (btn) btn.style.display = 'none';
}

/** Обновляет мобильную подсказку в dropzone при смене инструмента */
export function setDropHint(accept) {
  const zone = id('dropZone');
  if (!zone) return;
  let hint = zone.querySelector('.drop-mobile-hint');
  if (accept === '.pdf') {
    if (!hint) {
      hint = document.createElement('p');
      hint.className = 'drop-mobile-hint';
      zone.appendChild(hint);
    }
    hint.textContent = t('drop_mobile_hint');
  } else {
    if (hint) hint.remove();
  }
}
