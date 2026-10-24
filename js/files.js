// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  files.js — File management: add, remove, render, reorder
// ============================================================

import { esc, fmtSize, id, hide, isFileAccepted } from './utils.js';
import { showToast } from './ui.js';
import { ACCEPTED_MIME, TOOLS } from './config.js';
import { t, tp } from './i18n.js';
import { decryptOwnerOnly } from './decryptPdf.js';
import { bindDragReorder } from './dragReorder.js';
import { getWmRemove } from './watermarkRemoveUI.js';
import { getMergeOrder } from './mergeOrderUI.js';

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
    // Verify the PDF header (%PDF-) before any further processing.
    // Extension check alone is insufficient — a renamed .exe or .html passes it.
    // Searched in the first 1024 bytes, not only at byte 0: readers (Acrobat,
    // pdf.js, pdf-lib — all our engines) accept a header anywhere there, and
    // real files carry leading bytes — a mail/HTTP header or a few NULs left by
    // the program that saved them. Rejecting those turned a file every viewer
    // opens into "not a valid PDF" here (found 2026-10-14 testing damaged files).
    const head  = new TextDecoder('latin1').decode(await file.slice(0, 1024).arrayBuffer());
    if (!head.includes('%PDF-')) return { notPDF: true };

    // Read last 8 KB — covers xref table / xref stream / Encrypt dict.
    // 64 KB: a trailer's /Encrypt is not always in the last few KB — a real
    // 332-page Persian book had it 4.9 KB from the end (cloud corpus,
    // 2026-10-14); same window as decryptPdf.js's _looksEncrypted.
    const TAIL = 65536;
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
    // Either a reference (Acrobat, qpdf) or a DIRECT dictionary in the trailer
    // (MuPDF / PyMuPDF / mutool write `/Encrypt<</Filter/Standard …>>`) — both
    // valid. Matching only the reference form missed the latter entirely: such
    // files were treated as unencrypted, tools processed the ciphertext into a
    // corrupt output, and Unlock claimed no password was needed (2026-09-30).
    const hasEncryptRef = /\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/.test(tail);
    const hasStandard   = /\/Filter\s*\/Standard/.test(tail);
    const hasAES        = /\/AESV[23]/.test(tail);

    // `isEncrypted` below stays AES-specific (see WHY ONLY AES above) — every
    // other tool's warning banner depends on that meaning and must not start
    // firing for RC4 files that actually work fine with ignoreEncryption:true.
    //
    // `mayBeEncrypted` is broader on purpose: just "/Encrypt N N R" present,
    // regardless of algorithm — same signal _looksEncrypted() in decryptPdf.js
    // already uses. unlockUI.js needs this wider flag specifically, because an
    // RC4-encrypted PDF can still require a real user password to open (only
    // AES-vs-RC4 determines whether OTHER tools can process it without one).
    if (!hasEncryptRef || !hasStandard || !hasAES) {
      return { isEncrypted: false, mayBeEncrypted: hasEncryptRef };
    }

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

    return { isEncrypted: true, hasAES: true, aesVersion, restrictions, mayBeEncrypted: true };
  } catch (err) {
    // Any error here (e.g. a cloud-sync placeholder file — OneDrive/Google Drive
    // "Files On-Demand" — that hasn't actually downloaded yet, so file.slice()
    // rejects) used to be swallowed with zero trace, making a stuck file look
    // like "nothing happened" with no way to diagnose from a bug report alone.
    console.warn('[PDFree] preflight read failed for', file.name, '—', err?.name, err?.message);
    return null;  // treat as normal file, let pdf-lib handle it (or fail loudly later)
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

/** @returns {boolean} true while a tool is actively processing */
export function isFilesLocked() {
  return _locked;
}

// ── Add / Remove ───────────────────────────────────────────

/**
 * Добавляет файлы с проверкой типа и дублей.
 * Защита от drag-and-drop неподходящих файлов (п.5).
 * @param {File[]} files
 */
export function addFiles(files) {
  if (_locked) return; // (п.2) игнорируем добавление во время обработки

  // Captured before the push loop below — NOT the same as "selectedFiles.
  // length === 1 after adding", which misses a multi-select first pick
  // (e.g. a user's very first "Choose files" tap selecting 3 files at once
  // jumps straight from 0 to 3, never passing through exactly 1). Consumers
  // that care about "was this genuinely the first add" (e.g. app.js's
  // scroll-into-view fix for #fileList rendering under the sticky
  // #mergeBtn) need the real before/after transition, not a length snapshot.
  const _wasEmpty = selectedFiles.length === 0;

  // Tools with multi:false (config.js) accept exactly one file — a second
  // "Choose file" pick must replace-or-block, not silently append to a list
  // the tool's UI never re-reads past files[0]. split keeps its own wording;
  // every other single-file tool (pdf2jpg, redact, extract, meta, fill, ocr,
  // unlock, pdf2pdfa) shares a generic message.
  if (TOOLS[_currentTool]?.multi === false && selectedFiles.length >= 1) {
    showToast(_currentTool === 'split' ? t('split_one_only') : t('single_file_only'));
    return;
  }

  let invalid = 0;
  let dupes   = 0;
  const added = [];

  // Fingerprint includes lastModified so re-saved files with same name+size are admitted.
  const _fp = f => `${f.name}|${f.size}|${f.lastModified}`;
  const existingFPs = new Set(selectedFiles.map(_fp));

  files.forEach(f => {
    // п.5: валидация MIME / расширения
    if (!isFileAccepted(f, _currentAccept, ACCEPTED_MIME)) {
      invalid++;
      return;
    }
    if (existingFPs.has(_fp(f))) {
      dupes++;
      return;
    }
    existingFPs.add(_fp(f));
    delete f._batchStatus; // defensive: clear any stale batch queue status from a prior tool/run
    selectedFiles.push(f);
    added.push(f);
  });

  if (invalid > 0) {
    const msg = _currentAccept.startsWith('.pdf')
      ? t('invalid_pdf')
      : t('invalid_img');
    showToast(msg, 5000);
  }
  if (dupes > 0) showToast(tp(dupes, 'dupe_skip_one', 'dupe_skip_many'));

  if (selectedFiles.length > 0) {
    document.dispatchEvent(new CustomEvent('pdfree:files-added', { detail: { wasEmpty: _wasEmpty } }));
  }

  renderList();

  for (const f of added) _keepCopy(f);

  // Run preflight on newly added PDFs — async, non-blocking.
  // Annotates file._pdfMeta. For AES- or RC4-encrypted files, tries QPDF
  // silent decryption (owner-only / empty user password) before showing badge.
  for (const f of added) {
    // Kept on the file so the process button can wait for it (see
    // app.js's password guard) — a click right after adding must not race it.
    f._encryptionCheck = _preflightPDF(f).then(async meta => {
      if (!meta) return;
      if (meta.notPDF) {
        // File has .pdf extension but missing %PDF- magic bytes — reject it.
        import('./ui.js').then(({ showToast }) =>
          showToast(t('not_valid_pdf', { name: f.name }), 5000)
        );
        removeFile(selectedFiles.indexOf(f));
        return;
      }
      f._pdfMeta = meta;
      if (meta.isEncrypted || meta.mayBeEncrypted) {
        // Try silent decryption — owner-only PDFs (empty user password) open fine.
        // Runs for RC4 too (meta.mayBeEncrypted), not just AES (meta.isEncrypted):
        // qpdf handles both, and an RC4 file can be owner-only just like an AES one
        // — without this, Unlock would show a password field for RC4 files that
        // actually need none, since mayBeEncrypted alone can't tell owner-only
        // apart from a real user password.
        // QPDF WASM loads lazily here; only fires on first encrypted PDF.
        try {
          const bytes = new Uint8Array(await f.arrayBuffer());
          const decrypted = await decryptOwnerOnly(bytes);
          if (decrypted) {
            f._decryptedBuffer = decrypted.buffer;  // cache for processor.js
            f._pdfMeta.isEncrypted    = false;       // suppress lock badge
            f._pdfMeta.mayBeEncrypted = false;       // suppress Unlock's password field
          } else {
            // qpdf ran and couldn't open it without a real user password (a
            // WASM init failure throws instead, below — never flagged here).
            f._needsPassword = true;
          }
        } catch { /* WASM init failure — keep flags as detected */ }
        // Re-init tool options either way — the first init ran before this
        // resolved and saw no _pdfMeta at all. Owner-only success clears the
        // lock (tools can now process the file); a real password staying
        // required also needs a re-render (e.g. Unlock's password field
        // must appear, not default to "no password needed").
        document.dispatchEvent(new CustomEvent('pdfree:file-decrypted'));
        renderList();
      }
    });
  }
}

// A private copy of each added file, read once when it is added. A browser
// File is only a reference to a file on disk: saved again in another app,
// moved, deleted, a cloud-drive file swapped by its sync, an Android pick
// whose permission lapsed while the tab sat in the background — and reading it
// again when the user presses the button fails ("Couldn't read …", ORGANIZE-
// 1455, 2026-10-16: a merged PDF opened in Organize, pages arranged, then
// unreadable). Every read of the file — arrayBuffer, slice, stream, text, by
// any tool, at any time — is served from the copy once it is made. Copies
// share a budget (big merges must not double the tab's memory); a file past
// it stays a reference, as before. A file that can't be read even now is
// taken off the list at once, with what to do — not after minutes of work.
// (read when a file is added, not at import: the Node test runner has no navigator)
const _copyBudget = () => (navigator.deviceMemory ?? 8) < 4 || /Android|iPhone|iPad/i.test(navigator.userAgent)
  ? 150 * 1048576 : 600 * 1048576;
// Why a file has no copy, kept on it (`_copyState`) and sent with a
// "couldn't read" error — the only causes left since the copy (SPLIT-DFCC,
// 2026-10-23: a file over 50 MB unreadable 12 s after it was added — past the
// budget, still being copied, or changed while copied; nothing told which).
// Only what the code knows: no state at all is reported as 'unknown'.
async function _keepCopy(f) {
  if (typeof navigator === 'undefined' || typeof f.stream !== 'function' && typeof f.arrayBuffer !== 'function') return;
  const copied = selectedFiles.reduce((sum, x) => sum + (x !== f && x._copy ? x.size : 0), 0);
  if (copied + f.size > _copyBudget()) { f._copyState = 'over_budget'; return; }
  f._copyState = 'copying';
  let copy;
  try {
    // streamed: the copy is the browser's (paged to disk for big files), not a JS buffer
    copy = f.stream ? await new Response(f.stream()).blob() : new Blob([await f.arrayBuffer()]);
  } catch (err) {
    f._copyState = `copy_failed:${err?.name || 'unknown'}`;
    if (err?.name !== 'NotReadableError' && err?.name !== 'NotFoundError') return;
    const i = selectedFiles.indexOf(f);
    if (i === -1) return;
    selectedFiles.splice(i, 1);
    renderList();
    if (selectedFiles.length > 0) document.dispatchEvent(new CustomEvent('pdfree:file-removed'));
    showToast(t('err_file_unreadable_added', { name: f.name }), 9000);
    return;
  }
  if (copy.size !== f.size) { f._copyState = 'size_changed'; return; }
  if (!selectedFiles.includes(f)) { f._copyState = 'removed'; return; }
  f._copy = copy;
  f._copyState = 'copied';
  for (const m of ['arrayBuffer', 'slice', 'stream', 'text']) {
    Object.defineProperty(f, m, { value: copy[m].bind(copy), configurable: true });
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
  // Re-init the active tool so it picks up the new files[0] (single-source-of-truth).
  // Without this, tools like OCR keep a stale _file reference to the removed file.
  if (selectedFiles.length > 0) {
    document.dispatchEvent(new CustomEvent('pdfree:file-removed'));
  }
}

/** Очищает весь список файлов */
export function clearFiles() {
  selectedFiles = [];
  renderList();
}

// ── Render ─────────────────────────────────────────────────

/** Перерисовывает список файлов и обновляет счётчик / кнопку */
export function renderList(keepSuccess = false) {
  const list = id('fileList');
  list.innerHTML = '';

  // jpg2pdf renders its own reorderable thumbnail grid (jpg2pdfUI.js) —
  // the numbered row list would just duplicate the same files a second
  // time on screen. Meta line / success-card / body-class side effects
  // below still need to run, so this isn't a full early return.
  //
  // scanDocument reuses that exact same thumbnail-grid UI (js/scanDocumentUI.js's
  // _previewsHtml, deliberately copied from jpg2pdfUI.js's own — see that
  // file's header) but was missing from this check, a real gap found via
  // real Playwright testing: #fileList rendered a second, fully redundant
  // "1. receipt_shadow.jpg  400 KB  ×" / "2. contract_brightcorner.jpg ..."
  // row list directly ABOVE the tool's own thumbnail grid showing the exact
  // same 2 files, on every real scan (confirmed live, not just in theory) —
  // wasted vertical space and visibly confusing on a small phone screen,
  // worse in Telegram Mini App's already-constrained WebView viewport.
  if (_currentTool === 'jpg2pdf' || _currentTool === 'scanDocument') {
    _updateMeta();
    if (!keepSuccess) id('successCard').style.display = 'none';
    document.body.classList.toggle('has-files', selectedFiles.length > 0);
    return;
  }

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

    const isDraggable = _currentTool === 'merge' && !_locked;
    const isDuplicate = _currentTool === 'merge' &&
      selectedFiles.some((g, j) => j !== i && g.name === f.name);

    const pages = f._mergePageCount > 0 ? ` · ${f._mergePageCount}p` : '';
    el.innerHTML = `
      ${isDraggable ? '<span class="file-item-drag" aria-hidden="true">⠿</span>' : ''}
      <span style="font-size:16px;flex-shrink:0">${locked ? '🔒' : '📄'}</span>
      <span class="file-item-num">${i + 1}</span>
      <div class="file-item-info">
        <span class="file-item-name" title="${esc(f.name)}">${esc(f.name)}</span>
        ${isDuplicate ? '<span class="file-item-dup">⚠ Duplicate</span>' : ''}
        ${locked ? `<span class="file-item-enc-warn" title="${esc(lockTip)}">
          🔒 ${meta.aesVersion || 'AES'}-encrypted — editing blocked.
          <a class="file-item-enc-help" href="#" data-enc-help="${i}" tabindex="0">How to fix ↗</a>
        </span>` : ''}
      </div>
      <span class="file-item-size">${fmtSize(f.size)}${pages}</span>
      ${_batchStatusBadge(f._batchStatus)}
      <button class="file-item-del" data-i="${i}" aria-label="Remove ${esc(f.name)}" ${_locked ? 'disabled aria-disabled="true"' : ''}>×</button>
    `;

    list.appendChild(el);
  });

  if (_currentTool === 'merge' && !_locked) {
    bindDragReorder({
      container:  list,
      itemSelector: '.file-item',
      arrays:     [selectedFiles],
      onReorder:  () => renderList(true),
      isLocked:   () => _locked,
      mode:       'list',
    });
  }

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
      showToast(t('aes_help', { ver, restricted }), 12000);
    }
  };

  _updateMeta();
  if (!keepSuccess) id('successCard').style.display = 'none';
  document.body.classList.toggle('has-files', selectedFiles.length > 0);
}

// ── Batch queue status badge ───────────────────────────────
//
// Set on individual File objects (f._batchStatus) only by processor.js's
// _runBatch(), for the compress/watermark/protect/pagenum/flatten multi-file
// queue flow.
// Absent on every other tool and on single-file selections — this renders
// nothing for those, so single-file row markup is unchanged.

const _BATCH_STATUS_ICON = { pending: '⏳', processing: '⚙️', done: '✓', error: '✗' };
const _BATCH_STATUS_KEY  = {
  pending:    'batch_status_pending',
  processing: 'batch_status_processing',
  done:       'batch_status_done',
  error:      'batch_status_error',
};

function _batchStatusBadge(status) {
  if (!status || !_BATCH_STATUS_ICON[status]) return '';
  const label = t(_BATCH_STATUS_KEY[status]);
  return `<span class="file-item-batch-status file-item-batch-status--${status}" title="${esc(label)}" aria-label="${esc(label)}">${_BATCH_STATUS_ICON[status]}</span>`;
}

/** Обновляет счётчик файлов, подсказку перетаскивания и состояние кнопки */
function _updateMeta() {
  const count = selectedFiles.length;
  const total = selectedFiles.reduce((s, f) => s + f.size, 0);
  const btn   = id('mergeBtn');

  if (count > 0) {
    const countEl = id('fileCount');
    countEl.style.display = 'block';
    let metaStr = `${count} file${count !== 1 ? 's' : ''}`;
    if (_currentTool === 'merge') {
      const scanned   = selectedFiles.filter(f => f._mergePageCount != null);
      const pageTotal = scanned.reduce((s, f) => s + (f._mergePageCount || 0), 0);
      if (scanned.length > 0) metaStr += ` · ${pageTotal} page${pageTotal !== 1 ? 's' : ''}`;
    }
    metaStr += ` · ${fmtSize(total)}`;
    countEl.textContent = metaStr;

    const showHint = count > 1 && _currentTool === 'merge' && !_locked;
    const hint = id('reorderHint');
    if (hint) hint.hidden = !showHint;

    // Не снимаем disabled если идёт обработка
    if (!_locked) {
      // Merge normally needs 2+ files, but a single file is a valid input when the
      // user just wants to strip watermarks (handleMerge in worker.js runs fine on
      // one file) — the watermark-removal toggle is visible and interactive at
      // count===1, so requiring 2 files unconditionally made that toggle a dead end.
      // Same for Alternate pages: one scan holding fronts then backs is alternated
      // by its own halves.
      const mergeMin = _currentTool === 'merge' && !getWmRemove() && getMergeOrder().order !== 'alternate' ? 2 : 1;
      btn.disabled = count < mergeMin;
    }
  } else {
    hide('fileCount');
    hide('reorderHint');
    if (!_locked) btn.disabled = true;
  }
}



// A tool panel that can't open a file asks this before showing an error of
// its own: a file that isn't a PDF at all is removed by _preflightPDF, which
// says so — a parser's raw "Failed to parse PDF document … No PDF header
// found" on top of that only confused (Resize, Pages per Sheet; found by the
// nightly robustness run, 2026-10-14).
export async function wasRejectedAsNotPdf(files) {
  await Promise.all(files.map(f => f._encryptionCheck).filter(Boolean));
  return files.some(f => !selectedFiles.includes(f));
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
