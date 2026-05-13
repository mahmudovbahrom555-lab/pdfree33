// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  files.js — File management: add, remove, render, reorder
// ============================================================

import { esc, fmtSize, id, show, hide, isFileAccepted } from './utils.js';
import { showToast } from './ui.js';
import { ACCEPTED_MIME } from './config.js';

// ── PDF encryption preflight ──────────────────────────────────
//
// Detects AES-encrypted PDFs immediately on file add — BEFORE pdf-lib
// touches the file. Reads only the last 8 KB (xref/trailer area) via
// slice(), so it's instant even for 100 MB files.
//
// WHY ONLY AES (not RC4):
//   pdf-lib with ignoreEncryption:true successfully loads and processes
//   RC4-encrypted PDFs — split, compress, rotate all work. AES-encrypted
//   PDFs fail with "Expected instance of PDFDict" because ignoreEncryption
//   only skips the header check, not actual AES decryption of object streams.
//   Flagging RC4 PDFs would be a false warning — they work fine.
//
// WHY NOT "trailer keyword only":
//   PDF 1.5+ (iText, modern Acrobat) use cross-reference streams instead
//   of the traditional "trailer" keyword. Searching for "trailer" would
//   miss most AES-encrypted PDFs from real-world tools. Tail-8KB search
//   covers both traditional trailers and xref streams reliably.
//
// FALSE POSITIVE SAFETY (tested):
//   - Page content with "/Filter /Standard" text → not detected (content
//     streams are compressed, pattern can't appear as plaintext in tail)
//   - PDFs with "encrypt" in metadata/title → not detected
//   - RC4-encrypted PDFs → correctly not flagged (they work fine)
//   - AES-encrypted PDFs → correctly detected
//
// Returns { isEncrypted, hasAES, restrictions[] } or null for non-PDFs.
// Result stored in file._pdfMeta so UI can read without re-scanning.

async function _preflightPDF(file) {
  if (!file.name.toLowerCase().endsWith('.pdf')) return null;
  try {
    // Read last 8 KB — covers xref table / xref stream / Encrypt dict.
    // 8 KB (vs 4 KB) adds margin for large Encrypt dicts with long O/U keys.
    const TAIL = 8192;
    const tailBuf = await file.slice(Math.max(0, file.size - TAIL)).arrayBuffer();
    const tail    = new TextDecoder('latin1').decode(tailBuf);

    // Triple-AND detection — all three must match in the tail area:
    //   /Encrypt N N R  — reference to encryption dict (xref/trailer)
    //   /Filter /Standard — Standard Security Handler (PDF spec §3.5)
    //   /AESV2 or /AESV3 — AES-128 or AES-256 algorithm marker
    //
    // Requiring all three virtually eliminates false positives:
    //   - embedded files or metadata containing "AESV2" as a string
    //     won't also have /Encrypt N N R in the xref area
    //   - /Filter /Standard in compressed page streams is unreadable
    //     as plaintext in the tail, so it can't match by accident
    //   - only RC4 PDFs missing AESV2/V3 are correctly NOT flagged
    //     (tested: pdf-lib handles RC4 fine with ignoreEncryption:true)
    const hasEncryptRef = /\/Encrypt\s+\d+\s+\d+\s+R/.test(tail);
    const hasStandard   = /\/Filter\s*\/Standard/.test(tail);
    const hasAES        = /\/AESV[23]/.test(tail);

    // Only flag as problematic if all three match.
    if (!hasEncryptRef || !hasStandard || !hasAES) return { isEncrypted: false };

    // Distinguish AES-128 (AESV2) from AES-256 (AESV3) for the UX message.
    const aesVersion = /\/AESV3/.test(tail) ? 'AES-256' : 'AES-128';

    // Parse /P permission flags for the "Why?" explanation
    const restrictions = [];
    const pMatch = tail.match(/\/P\s*(-?\d+)/);
    if (pMatch) {
      const P = parseInt(pMatch[1], 10);
      if (!(P & 0x04)) restrictions.push('print');
      if (!(P & 0x08)) restrictions.push('modify');
      if (!(P & 0x10)) restrictions.push('copy');
    }

    return { isEncrypted: true, hasAES: true, aesVersion, restrictions };
  } catch {
    return null;  // any error → treat as normal file, let pdf-lib handle it
  }
}

/** @type {File[]} Выбранные пользователем файлы */
export let selectedFiles = [];

/** Имя текущего активного инструмента */
let _currentTool   = 'merge';
/** Строка accept текущего инструмента (нужна для валидации) */
let _currentAccept = '.pdf';
/** Флаг блокировки интерактивности во время обработки */
let _locked        = false;

export function setCurrentTool(tool, accept) {
  _currentTool   = tool;
  _currentAccept = accept;
}

// ── Lock / Unlock (п.2 и п.6: блокировка во время обработки) ──

/**
 * Блокирует/разблокирует файловые элементы управления.
 * Вызывается из processor.js в начале и конце doProcess.
 * @param {boolean} locked
 */
export function setFilesLocked(locked) {
  // aria-busy сообщает скринридерам об активной обработке
  const toolArea = document.getElementById('toolArea');
  if (toolArea) toolArea.setAttribute('aria-busy', locked ? 'true' : 'false');
  _locked = locked;
  const dz = id('dropZone');
  dz.style.opacity       = locked ? '0.5' : '';
  dz.style.pointerEvents = locked ? 'none' : '';
  const chooseBtn = id('chooseFilesBtn');
  chooseBtn.disabled = locked;
  // aria-disabled дублирует disabled для скринридеров которые не всегда
  // читают disabled на кастомных компонентах
  chooseBtn.setAttribute('aria-disabled', locked ? 'true' : 'false');
}

// ── Add / Remove ───────────────────────────────────────────

/**
 * Добавляет файлы с проверкой типа и дублей.
 * Защита от drag-and-drop неподходящих файлов (п.5).
 * @param {File[]} files
 */
export function addFiles(files) {
  if (_locked) return; // (п.2) игнорируем добавление во время обработки

  // Split работает только с одним файлом
  if (_currentTool === 'split' && selectedFiles.length >= 1) {
    showToast('Split works with one PDF only. Remove the current file first.');
    return;
  }

  let dupes   = 0;
  let invalid = 0;
  const added = [];

  files.forEach(f => {
    // п.5: валидация MIME / расширения
    if (!isFileAccepted(f, _currentAccept, ACCEPTED_MIME)) {
      invalid++;
      return;
    }
    const isDupe = selectedFiles.some(x => x.name === f.name && x.size === f.size);
    if (!isDupe) { selectedFiles.push(f); added.push(f); }
    else dupes++;
  });

  if (invalid > 0) showToast(`${invalid} file${invalid > 1 ? 's' : ''} skipped — wrong format`);
  if (dupes   > 0) showToast(`${dupes} duplicate${dupes > 1 ? 's' : ''} skipped`);

  if (selectedFiles.length > 0) {
    document.dispatchEvent(new CustomEvent('pdfree:files-added'));
  }

  renderList();

  // Run preflight on newly added PDFs — async, non-blocking.
  // Annotates file._pdfMeta, then re-renders to show warning badge.
  for (const f of added) {
    _preflightPDF(f).then(meta => {
      if (!meta) return;
      f._pdfMeta = meta;
      if (meta.isEncrypted) renderList();  // show the warning badge
    });
  }
}

/**
 * Удаляет файл по индексу
 * @param {number} index
 */
export function removeFile(index) {
  if (_locked) return; // (п.2) блокируем удаление во время обработки
  selectedFiles.splice(index, 1);
  renderList();
}

/** Очищает весь список файлов */
export function clearFiles() {
  selectedFiles = [];
  renderList();
}

// ── Render ─────────────────────────────────────────────────

/** Перерисовывает список файлов и обновляет счётчик / кнопку */
export function renderList() {
  const list = id('fileList');
  list.innerHTML = '';

  selectedFiles.forEach((f, i) => {
    const el = document.createElement('div');
    el.className = 'file-item';
    // п.6: drag разрешён только когда не идёт обработка
    el.draggable  = _currentTool === 'merge' && !_locked;
    el.dataset.i  = i;

    const meta  = f._pdfMeta;
    const locked = meta?.isEncrypted;
    const lockTip = locked
      ? (meta.hasAES
          ? `AES-encrypted · cannot modify (restrictions: ${meta.restrictions.join(', ') || 'unknown'})`
          : 'Password-protected · cannot modify without owner password')
      : '';

    el.innerHTML = `
      <span style="font-size:16px;flex-shrink:0">${locked ? '🔒' : '📄'}</span>
      <span class="file-item-num">${i + 1}</span>
      <div class="file-item-info">
        <span class="file-item-name" title="${esc(f.name)}">${esc(f.name)}</span>
        ${locked ? `<span class="file-item-enc-warn" title="${esc(lockTip)}">
          🔒 ${meta.aesVersion || 'AES'}-encrypted — editing blocked.
          <a class="file-item-enc-help" href="#" data-enc-help="${i}" tabindex="0">How to fix ↗</a>
        </span>` : ''}
      </div>
      <span class="file-item-size">${fmtSize(f.size)}</span>
      <button class="file-item-del" data-i="${i}" aria-label="Remove ${esc(f.name)}" ${_locked ? 'disabled aria-disabled="true"' : ''}>×</button>
    `;

    // п.6: drag-обработчики добавляем только когда не заблокировано
    if (_currentTool === 'merge' && !_locked) {
      el.addEventListener('dragstart', _onDragStart);
      el.addEventListener('dragover',  _onDragOver);
      el.addEventListener('drop',      _onDrop);
      el.addEventListener('dragend',   _onDragEnd);
    }

    list.appendChild(el);
  });

  // Delegation: delete button + encryption help link
  list.onclick = e => {
    if (_locked) return;
    const btn = e.target.closest('.file-item-del');
    if (btn) { removeFile(+btn.dataset.i); return; }

    const help = e.target.closest('[data-enc-help]');
    if (help) {
      e.preventDefault();
      const idx  = parseInt(help.dataset.encHelp, 10);
      const meta = selectedFiles[idx]?._pdfMeta;
      const restricted = meta?.restrictions?.length > 0
        ? `Restrictions detected: ${meta.restrictions.join(', ')}.`
        : '';
      const ver = meta?.aesVersion || 'AES';
      showToast(
        `🔒 ${ver}-encrypted PDF — cannot be processed without the owner password. ${restricted} ` +
        `To fix: 1) Open in Adobe Acrobat. 2) File → Properties → Security. ` +
        `3) Set Security Method: No Security → Save. Then re-upload here.`,
        12000
      );
    }
  };

  _updateMeta();
  id('successCard').style.display = 'none';
}

/** Обновляет счётчик файлов, подсказку перетаскивания и состояние кнопки */
function _updateMeta() {
  const count = selectedFiles.length;
  const total = selectedFiles.reduce((s, f) => s + f.size, 0);
  const btn   = id('mergeBtn');

  if (count > 0) {
    const countEl = id('fileCount');
    countEl.style.display = 'block';
    countEl.textContent   = `${count} file${count > 1 ? 's' : ''} · ${fmtSize(total)}`;

    const hint = id('reorderHint');
    hint.style.display = count > 1 && _currentTool === 'merge' && !_locked ? 'block' : 'none';

    // Не снимаем disabled если идёт обработка
    if (!_locked) {
      btn.disabled = count < (_currentTool === 'merge' ? 2 : 1);
    }
  } else {
    hide('fileCount');
    hide('reorderHint');
    if (!_locked) btn.disabled = true;
  }
}

// ── Drag-to-reorder ────────────────────────────────────────

let _dragFrom = null;

function _onDragStart() {
  if (_locked) return; // (п.6) двойная защита
  _dragFrom = +this.dataset.i;
  this.classList.add('dragging');
}

function _onDragOver(e) {
  if (_locked) return;
  e.preventDefault();
  this.classList.add('drag-target');
}

function _onDrop(e) {
  if (_locked) return;
  e.preventDefault();
  this.classList.remove('drag-target');
  const to = +this.dataset.i;
  if (_dragFrom === to) return;

  const [moved] = selectedFiles.splice(_dragFrom, 1);
  selectedFiles.splice(to, 0, moved);
  renderList();
}

function _onDragEnd() {
  document.querySelectorAll('.file-item').forEach(el => {
    el.classList.remove('dragging', 'drag-target');
  });
}

// ── Setup input listeners ──────────────────────────────────

/**
 * Инициализирует слушатели для fileInput и drop zone.
 * Вызывается один раз из app.js.
 */
export function initFileListeners() {
  const fileInput = id('fileInput');
  const dropZone  = id('dropZone');

  fileInput.addEventListener('change', function (e) {
    if (_locked) return;
    addFiles(Array.from(e.target.files));
    this.value = '';
  });

  dropZone.addEventListener('dragover',  e => { e.preventDefault(); if (!_locked) dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (!_locked) addFiles(Array.from(e.dataTransfer.files));
  });
}
