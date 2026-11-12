// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  quickEditUI.js — "Quick Edit PDF": fix a typo/small text change inside
//  a PDF entirely client-side, by round-tripping through this site's own
//  PDF->DOCX (pdf2word) and DOCX->PDF (docx2pdf) engines with an editing
//  step spliced in between.
//
//  See /Users/murodjon/.claude/plans/typed-plotting-wave.md for the full
//  design rationale — short version: docxToPdfCore.js's DOCX->PDF pipeline
//  already works by rendering a .docx into a real HTML DOM (docx-preview)
//  then WALKING that live DOM to build the output PDF, so editing the DOM
//  before the walk is sufficient to edit the final PDF. Full contenteditable
//  is unsafe (the walk parser depends on exact DOM shapes — direct-child
//  <span> runs, specific heading/list classes, :scope > td/p table
//  structure) — editing is constrained to per-run TEXT-ONLY edits via
//  _bindEditableSpans (Stage 3, below). Save/walk-to-PDF wiring is Stage 4.
//
//  Modal pattern mirrors js/formFieldsUI.js's proven .ff-modal subsystem
//  (full-viewport, inert/aria-hidden background while open, Escape/
//  backdrop-click close, focus trap) almost line-for-line — see that file
//  for the fuller rationale on each piece. The one structural difference:
//  the modal body holds the REAL container renderDocxToDom() rendered into
//  (moved via appendChild, not re-rendered), not a canvas.
// ============================================================

import { id, esc }                     from './utils.js';
import { setButtonDisabled }            from './ui.js';
import { loadPdfJs }                    from './pdf2jpgUI.js';
import { renderDocxToDom }              from './docxToPdfCore.js';
import { _buildPdf2WordDocxBlob }       from './processor.js';
import { bindQuickEditCopies } from './quickEditCopies.js';
import { openOriginalPdf, originalLines } from './quickEditOriginal.js';
import { createPageEditor } from './quickEditPage.js';
import { copyText } from './quickEditCopyText.js';
import { RECIPIENT_LIMIT } from './quickEditRecipients.js';
import { t }                            from './i18n.js';

// Focus-trap selector — same standard set formFieldsUI.js uses.
const FOCUSABLE_SEL = 'a[href], button:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// ── State ──────────────────────────────────────────────────────
export const quickEditExamples = new WeakMap();

let _loading    = false;
let _generation = 0;    // staleness guard, same pattern as formFieldsUI.js
let _container  = null; // the outer #quickEditOptions panel
let _fileLabel  = '';
let _sourceFile = null;
let _docContainer = null; // the live docx-preview render target — lives INSIDE the modal while open
// In-place editing (quickEditPage.js), tried first: the PDF itself, edited line
// by line; the rebuild editor above only when a file can't be edited in place
let _pageOriginal = null;
let _pageEditor   = null;
let _forceRebuild = false;   // the person chose the rebuild editor for this file
let _atlasEri   = null; // {eri, components, findings} from _buildPdf2WordDocxBlob — pre-edit gate
let _modal      = null;
let _clearCopyFields = null;
let _prevFocus  = null;
let _inerted    = [];

// ── Public API ────────────────────────────────────────────────

export const COPY_MODE = 'personalized-copies';
export const COPY_MODE_QUERY = `?mode=${COPY_MODE}`;

export function initQuickEditOptions(file) {
  const el = id('quickEditOptions');
  if (!el) return;
  el.style.display = '';
  if (!file) { el.innerHTML = ''; _closeModal({ silent: true }); return; }
  if (new URLSearchParams(location.search).get('mode') === COPY_MODE) {
    _generation++;
    _closeModal({ silent: true });
    _loading = false;
    _atlasEri = null;
    _sourceFile = file;
    _fileLabel = file.name;
    _container = el;
    _docContainer = null;
    el.innerHTML = _sourceOnlyButton();
    _bindTriggerEvents(el);
    void _openModal(null, true);
    return;
  }
  _forceRebuild = false;
  _prepareAndRender(file, el);
}

export function getQuickEditParams() {
  return {
    loading:        _loading,
    hasOpened:      !!_docContainer || !!_pageEditor,
    editedContainer: _docContainer,
    pageEdit:        _pageEditor ? { original: _pageOriginal, edits: _pageEditor.edits() } : null,
  };
}

export function hideQuickEditOptions() {
  const el = id('quickEditOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  _closeModal({ silent: true });
  _dropPageEditor();
  _forceRebuild = false;
  _loading = false;
  _fileLabel = '';
  _sourceFile = null;
  _docContainer = null;
  _atlasEri = null;
  _generation++;
  _container = null;
}

// ── Atlas ERI pre-edit gate ──────────────────────────────────────
// Reuses the SAME verdict thresholds pdf2wordUI.js's own (unexported)
// _atlasVerdict uses (READY>=95/MINOR>=80/NOTABLE>=60/HEAVY<60) — same
// bar, not invented separately. Can't reuse that function directly (not
// exported) or the shared #atlasCheck div (it lives INSIDE #successCard,
// display:none until a real success fires — semantically scoped to
// POST-conversion results, not a pre-edit gate a user needs to see before
// ever clicking anything). Renders the same .atlas-check__* classes
// (css/components.css, already theme-aware) inline in this tool's own
// options panel instead.
function _atlasVerdict(eri) {
  if (eri >= 95) return { key: 'ready',   label: t('quickedit_verdict_ready') };
  if (eri >= 80) return { key: 'minor',   label: t('quickedit_verdict_minor') };
  if (eri >= 60) return { key: 'notable', label: t('quickedit_verdict_notable') };
  return { key: 'heavy', label: t('quickedit_verdict_heavy') };
}

// Below HEAVY, block entirely rather than let the user into an editor with
// no power to fix what's already wrong. Deliberately DIFFERENT from
// pdf2word's own leniency (pdf2word ships a full .docx the user can fix by
// hand in Word; Quick Edit's only recovery power is "retype text inside a
// run" — it can't repair a mis-split paragraph or a lost table row, so
// shipping a PDF built from an already-HEAVY conversion would silently
// bake in corruption the constrained editor can't fix and the user never
// even sees).
const _ATLAS_BLOCK_THRESHOLD = 60;

function _atlasSummaryHTML(atlasEri) {
  if (!atlasEri || atlasEri.error) return '';
  const v = _atlasVerdict(atlasEri.eri);
  return `
    <div class="atlas-check" style="border-top:none;padding:0 0 12px;text-align:left;">
      <div class="atlas-check__header">
        <span class="atlas-check__title">${esc(t('quickedit_structural_check'))}</span>
        <span class="atlas-check__badge atlas-check__badge--${v.key}">${Math.round(atlasEri.eri)}% ${esc(v.label)}</span>
      </div>
    </div>`;
}

// ── Trigger / spinner / error views (outer panel, behind the modal) ──

function _spinnerHTML(msg) {
  return `<div style="padding:24px 16px;text-align:center;color:var(--text3);font-size:14px;">
    <div style="font-size:24px;margin-bottom:8px;">⏳</div><span data-qe-progress>${esc(msg)}</span>${_sourceOnlyButton()}</div>`;
}

function _errorHTML(msg) {
  return `<div style="padding:16px;border:1px solid #fca5a5;border-radius:10px;background:#fff1f2;color:#dc2626;font-size:13px;">
    ${esc(msg)}
  </div>`;
}

function _sourceOnlyButton() {
  return `<button type="button" class="qe-copies__button" id="qeOpenOriginal">${copyText('Open original for personalized copies', '打开原始 PDF 并生成个性化副本')}</button>`;
}

// Shown when the source PDF's structure survived the PDF->DOCX step too
// poorly to safely enter the constrained editor at all — see
// _ATLAS_BLOCK_THRESHOLD's own comment for why this is stricter than
// pdf2word's own no-blocking policy.
function _blockedHTML(atlasEri) {
  const v = _atlasVerdict(atlasEri.eri);
  return `
    <div style="padding:16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);">
      <div class="atlas-check" style="border-top:none;padding:0 0 10px;">
        <div class="atlas-check__header">
          <span class="atlas-check__title">${esc(t('quickedit_structural_check'))}</span>
          <span class="atlas-check__badge atlas-check__badge--${v.key}">${Math.round(atlasEri.eri)}% ${esc(v.label)}</span>
        </div>
      </div>
      <p style="margin:0;font-size:13px;color:var(--text3);line-height:1.5;">
        ${esc(t('quickedit_blocked_body'))}<a href="/pdf-to-word/" style="color:var(--green-text);">${esc(t('quickedit_blocked_link'))}</a>${esc(t('quickedit_blocked_suffix'))}
      </p>
      ${_sourceOnlyButton()}
    </div>`;
}

// Shown in the outer options panel — behind the modal while it's briefly
// building, and again if the user closes the modal without processing.
function _triggerHTML() {
  return `
    <div style="padding:16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);text-align:center;">
      ${_atlasSummaryHTML(_atlasEri)}
      <p style="margin:0 0 10px;font-size:13px;color:var(--text3);word-break:break-word;">
        ${esc(_fileLabel)}
      </p>
      <button type="button" id="qeReopenBtn" class="split-action-btn">${esc(t('quickedit_continue_editing'))}</button>
    </div>`;
}

function _bindTriggerEvents(container) {
  container.querySelector('#qeReopenBtn')?.addEventListener('click', () => _openModal());
  container.querySelector('#qeOpenOriginal')?.addEventListener('click', () => {
    _generation++;
    _loading = false;
    _openModal(null, true);
    setButtonDisabled();
  });
}

// ── Build: PDF -> DOCX blob (reusing pdf2word's own engine, text mode
// only — image mode has no text runs to click-edit) -> render for preview ──

function _dropPageEditor() {
  _pageEditor?.destroy();
  _pageEditor = null;
  void _pageOriginal?.pdf.destroy().catch(() => {});
  _pageOriginal = null;
}

// In place when the file has a text layer on its first pages and isn't a form
// or signed (openOriginalPdf refuses those): nothing else in the file changes.
// Arabic, Persian and Hebrew can't be written in place yet (no shaping), so a
// mostly right-to-left file keeps the previous editor and its script warning
// rather than failing only after the edit
async function _openInPlace(file, container, myGen) {
  let original;
  try { original = await openOriginalPdf(file); } catch { return false; }
  try {
    let letters = 0, rtl = 0;
    for (let i = 1; i <= Math.min(3, original.pdf.numPages); i++) {
      for (const line of originalLines((await (await original.pdf.getPage(i)).getTextContent()).items)) {
        letters += (line.text.match(/\p{L}/gu) || []).length;
        rtl += (line.text.match(/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/gu) || []).length;
      }
    }
    if (!letters || rtl > letters * 0.3 || myGen !== _generation) { await original.pdf.destroy(); return myGen !== _generation; }
  } catch { await original.pdf.destroy().catch(() => {}); return false; }
  _pageOriginal = original;
  _loading = false;
  container.innerHTML = _triggerHTML();
  _bindTriggerEvents(container);
  await _openModal();
  return true;
}

// From the in-place editor to the rebuild one, for a file the page editor
// can't change: the same file, rebuilt once (until another file is chosen)
async function _switchToRebuild() {
  const file = _sourceFile, container = _container;
  _closeModal({ silent: true });
  _dropPageEditor();
  _forceRebuild = true;
  await _prepareAndRender(file, container);
}

async function _prepareAndRender(file, container) {
  _loading = true;
  _atlasEri = null;
  const myGen = ++_generation;
  _closeModal({ silent: true }); // a new file replaces any editor already open for a previous one
  _dropPageEditor();
  _sourceFile = file;
  _fileLabel = file.name;
  _container = container;
  _docContainer = null;
  container.innerHTML = _spinnerHTML('Converting to an editable form…');
  _bindTriggerEvents(container);
  const progress = container.querySelector('[data-qe-progress]');

  try {
    // _buildPdf2WordDocxBlob expects window.pdfjsLib to already be loaded
    // by its caller (same contract pdf2wordUI.js's own initPdf2WordOptions
    // follows) — it only checks for it, doesn't load it itself.
    await loadPdfJs();
    if (myGen !== _generation) return;
    if (!_forceRebuild && await _openInPlace(file, container, myGen)) return;

    // Reuses pdf2word's own conversion engine — text mode only, since
    // image mode produces no text runs to click-edit at all (Atlas ERI
    // scoring is also mode==='text'-only, matching processor.js's own
    // gate). This whole build+render step can genuinely exceed 1-2s on a
    // real document (Doherty Threshold, CLAUDE.md's UX checklist item 6)
    // — real progress text, not a static spinner message.
    const { blob, atlasEri } = await _buildPdf2WordDocxBlob(file, {
      mode: 'text',
      preserveNumericFields: true,
      onProgress:  (pct, label) => {
        if (myGen === _generation) progress.textContent = label || 'Converting to an editable form…';
      },
      isCancelled: () => myGen !== _generation,
    });
    if (myGen !== _generation) return;
    _atlasEri = atlasEri;

    // Atlas gate: block entirely below the HEAVY threshold — see
    // _ATLAS_BLOCK_THRESHOLD's own comment for why this is stricter than
    // pdf2word's own leniency. Never blocks on a scoring FAILURE (atlasEri
    // null/errored) — best-effort scoring, same posture processor.js's own
    // Atlas call already takes; only an ACTUAL low score blocks.
    if (atlasEri && !atlasEri.error && atlasEri.eri < _ATLAS_BLOCK_THRESHOLD) {
      _loading = false;
      container.innerHTML = _blockedHTML(atlasEri);
      _bindTriggerEvents(container);
      setButtonDisabled();
      return;
    }

    progress.textContent = 'Rendering preview…';

    // Off-screen render target, moved into the modal's stage once built —
    // same "caller owns the container" contract renderDocxToDom documents.
    // MUST be attached to document.body (off-screen, not display:none)
    // before renderAsync runs: docx-preview needs real layout to compute
    // column/measurement CSS — same reasoning docxToPdfCore.js's own
    // off-screen container comment documents, confirmed the hard way here
    // (renderAsync hangs indefinitely against a detached node instead of
    // erroring, so a timeout would have looked like a mystery hang without
    // this fix, not a clean failure).
    const docContainer = document.createElement('div');
    docContainer.className = 'docx-preview-target';
    docContainer.style.cssText = 'position:absolute; top:-99999px; left:-99999px; width:800px;';
    document.body.appendChild(docContainer);
    await renderDocxToDom(blob, docContainer, { isCancelled: () => myGen !== _generation });
    if (myGen !== _generation) { docContainer.remove(); return; }
    // Un-off-screen it now that render is done — the modal's own stage
    // gives it real, on-screen layout from here on.
    docContainer.style.cssText = '';

    _loading    = false;
    _fileLabel  = file.name;
    _sourceFile = file;
    _container  = container;

    container.innerHTML = _triggerHTML();
    _bindTriggerEvents(container);
    await _openModal(docContainer);
  } catch (err) {
    if (myGen !== _generation) return;
    _loading = false;
    container.innerHTML = _errorHTML(err.message) + _sourceOnlyButton();
    _bindTriggerEvents(container);
    setButtonDisabled();
  }
}

// ── Full-viewport modal (mirrors js/formFieldsUI.js's _openModal almost
// line-for-line — see that file for the fuller rationale on each piece) ──

async function _openModal(docContainer, originalOnly = false) {
  if (_modal) return;
  const pageMode = !!_pageOriginal && !originalOnly;
  const active = document.activeElement;
  _prevFocus = active && typeof active.focus === 'function' ? active : null;
  _modal = document.createElement('div');
  _modal.className = 'qe-modal';
  _modal.innerHTML = `
    <div class="qe-modal__card" role="dialog" aria-modal="true" aria-label="${esc(_fileLabel)}">
      <div class="qe-modal__header">
        <p class="qe-modal__title">${esc(_fileLabel)}</p>
        <button type="button" class="qe-modal-close" id="qeModalClose" aria-label="${esc(t('quickedit_close_aria'))}">✕</button>
      </div>
      <p class="qe-modal__hint">${esc(t('quickedit_modal_hint'))}</p>
      <div class="qe-workspace">
        <div class="qe-modal__stage" id="qeModalStage"></div>
        <section id="qeCopies" class="qe-copies" aria-labelledby="qeCopiesTitle" hidden>
          <h2 id="qeCopiesTitle">${copyText('Personalized copies', '个性化 PDF 副本')}</h2>
          <p class="qe-copies__intro">${copyText('Create one PDF for each recipient from this document.', '为每位收件人生成一份独立的 PDF。')}</p>

          <div class="qe-copies__step">
            <label><input type="checkbox" data-preserve-layout> ${copyText('Preserve original layout', '保留原始版式')} <small>${copyText('(experimental)', '（实验功能）')}</small></label>
            <p data-layout-hint>${copyText('Quick Edit rebuilds the PDF. Check the sample for changes to page breaks or layout.', '快速编辑会重新生成 PDF。请查看样本，确认分页和版式。')}</p>
            <div data-original-options hidden>
              <label for="qeOriginalPage">${copyText('Original page', '原始 PDF 页码')}</label>
              <select id="qeOriginalPage"></select>
              <label><input type="checkbox" data-smaller-text> ${copyText('Allow slightly smaller text when a name does not fit', '姓名放不下时允许适当缩小字号')}</label>
              <p>${copyText('Selected lines use an available replacement font. Changing modes clears selected fields.', '选中的文本会使用可用的替代字体。切换模式会清除已选字段。')}</p>
              <details data-name-style>
                <summary>${copyText('Name appearance', '姓名样式')}</summary>
                <label><input type="checkbox" data-style-enable> ${copyText('Customize inserted names', '自定义插入的姓名样式')}</label>
                <fieldset data-style-options disabled>
                  <label>${copyText('Font family', '字体')}
                    <select data-style-font><option value="">${copyText('Match source family', '匹配原字体类别')}</option><option value="Sans">${copyText('Sans', '无衬线')}</option><option value="Serif">${copyText('Serif', '衬线')}</option><option value="Mono">${copyText('Mono', '等宽')}</option></select>
                  </label>
                  <label>${copyText('Size (pt)', '字号（磅）')} <input data-style-size type="number" min="6" max="48" placeholder="${copyText('Auto', '自动')}"></label>
                  <label>${copyText('Color', '颜色')} <input data-style-color type="color" value="#000000"></label>
                  <label><input data-style-bold type="checkbox"> ${copyText('Bold', '粗体')}</label>
                  <label><input data-style-italic type="checkbox"> ${copyText('Italic', '斜体')}</label>
                </fieldset>
              </details>
              <label data-wrap-option hidden><input type="checkbox" data-wrap-name> ${copyText('Allow long names to wrap in this blank area (two lines)', '允许长姓名在此空白区域内换行（最多两行）')}</label>
              <button type="button" class="qe-copies__button" data-place aria-pressed="false" hidden>${copyText('Add name on scan', '在扫描页添加姓名')}</button>
              <p>${copyText('Original PDF engine', '原始 PDF 处理引擎')}
                <a href="/js/vendor/mupdf-1.28.1/LICENSE" target="_blank" rel="noopener">${copyText('MuPDF license', 'MuPDF 许可证')}</a>
                · <a href="https://github.com/ArtifexSoftware/mupdf/tree/1.28.1" target="_blank" rel="noopener">${copyText('Source and build files', '源代码和构建文件')}</a>
              </p>
            </div>
          </div>

          <div class="qe-copies__step">
            <label for="qeCopyNames">${copyText('1. Add recipients', '1. 添加收件人')}</label>
            <p id="qeCopyNamesHint">${copyText(`Paste one full name per line or import a table. Up to ${RECIPIENT_LIMIT} recipients.`, `每行粘贴一个姓名，或导入表格。最多支持 ${RECIPIENT_LIMIT} 位收件人。`)}</p>
            <textarea id="qeCopyNames" rows="4" aria-describedby="qeCopyNamesHint"
              placeholder="${copyText('Anna Example&#10;Boris Example', '张小明&#10;李晓华')}" spellcheck="false"></textarea>
            <p data-recipient-count>${copyText('0 recipients', '0 位收件人')}</p>
            <label for="qeRecipientFile">${copyText('Import Excel or CSV', '导入 Excel 或 CSV')}</label>
            <input type="file" id="qeRecipientFile" data-recipient-file accept=".xlsx,.csv,.tsv">
            <div data-import-options hidden>
              <label for="qeRecipientSheet">${copyText('Sheet', '工作表')}</label>
              <select id="qeRecipientSheet" data-import-sheet></select>
              <label for="qeRecipientStart">${copyText('First row with a name', '姓名起始行')}</label>
              <input id="qeRecipientStart" data-import-start type="number" min="1" value="2">
              <label for="qeRecipientColumn">${copyText('Full name column', '姓名所在列')}</label>
              <select id="qeRecipientColumn" data-import-column></select>
              <p data-import-preview></p>
              <button type="button" class="qe-copies__button" data-import-apply disabled>${copyText('Use this column', '使用此列')}</button>
            </div>
          </div>

          <div class="qe-copies__step">
            <h3>${copyText('2. Mark the name fields', '2. 标记姓名字段')}</h3>
            <p>${copyText('Select a name or placeholder in the document, then add it as a field. Repeat for each place to replace.', '在文档中选中姓名或占位文字，再添加为字段。需要替换多处时，请逐一添加。')}</p>
            <div class="qe-copies__actions">
              <button type="button" class="qe-copies__button" data-bind>${copyText('Use selected text', '使用选中的文字')}</button>
              <button type="button" class="qe-copies__button" data-reset disabled>${copyText('Clear fields', '清除字段')}</button>
            </div>
              <details data-name-suggestions hidden>
                <summary>${copyText('Suggested name fields on this page', '当前页建议的姓名字段')}</summary>
                <div class="qe-copies__actions" data-suggestion-list></div>
              </details>
            <p data-field-count>${copyText('0 fields selected', '已选 0 个字段')}</p>
          </div>

          <div class="qe-copies__step" data-copy-watermark>
            <label><input type="checkbox" id="qeCopyWm" data-wm-enable> ${copyText('Also add a watermark to each copy', '同时为每份副本添加水印')}</label>
            <fieldset data-wm-options disabled hidden>
              <label for="qeCopyWmText">${copyText('Watermark text — {name} becomes the recipient', '水印文字 — {name} 会替换为收件人姓名')}</label>
              <input id="qeCopyWmText" data-wm-text type="text" maxlength="200" value="${esc(copyText('Copy for {name}', '{name} 专用副本'))}">
              <label for="qeCopyWmPosition">${copyText('Position', '位置')}</label>
              <select id="qeCopyWmPosition" data-wm-position>
                <option value="center">${copyText('Diagonal, page centre', '页面中央（斜向）')}</option>
                <option value="tile">${copyText('Tiled across the page', '平铺整页')}</option>
                <option value="top">${copyText('Top of the page', '页面顶部')}</option>
                <option value="bottom">${copyText('Bottom of the page', '页面底部')}</option>
              </select>
            </fieldset>
          </div>

          <div class="qe-copies__step">
            <h3>${copyText('3. Check and download', '3. 检查并下载')}</h3>
            <p>${copyText('Preview a recipient and check that the names fit before downloading.', '下载前可预览收件人的副本，并检查姓名是否放得下。')}</p>
            <label for="qeCopyRecipient">${copyText('Sample recipient', '样本收件人')}</label>
            <select id="qeCopyRecipient" disabled><option>${copyText('Add names first', '请先添加姓名')}</option></select>
            <div class="qe-copies__actions">
              <button type="button" class="qe-copies__button" data-view-sample hidden disabled>${copyText('Preview on page', '在当前页预览')}</button>
              <button type="button" class="qe-copies__button" data-check-copies hidden disabled>${copyText('Check all names', '检查所有姓名')}</button>
              <button type="button" class="qe-copies__button" data-preview disabled>${copyText('Download sample PDF', '下载样本 PDF')}</button>
              <button type="button" class="qe-copies__button qe-copies__button--primary" data-download disabled>${copyText('Download ZIP', '下载 ZIP')}</button>
              <button type="button" class="qe-copies__button" data-stop hidden>${copyText('Stop export', '停止导出')}</button>
            </div>
          </div>
          <p class="qe-copies__status" role="status"></p>
        </section>
      </div>
      <div class="qe-modal__footer">
        <button type="button" class="qe-copies__button" data-copies-toggle aria-expanded="false" aria-controls="qeCopies">${copyText('Create personalized copies', '生成个性化副本')}</button>
        <button type="button" class="merge-btn" id="qeModalSaveBtn" style="position:static;margin-top:0;">${esc(t('quickedit_save_btn'))}</button>
      </div>
    </div>`;
  document.body.appendChild(_modal);
  _setBackgroundInert(true);
  requestAnimationFrame(() => _modal?.classList.add('qe-modal--open'));

  id('qeModalClose').addEventListener('click', () => _closeModal());
  document.addEventListener('keydown', _onModalKeydown);
  _modal.addEventListener('click', e => { if (e.target === _modal) _closeModal(); });
  // Forwards to the REAL #mergeBtn rather than duplicating its processing
  // wiring — closes the modal first so the shared progress bar/success
  // card (which live in the main page, invisible while the modal covers
  // it) are visible the instant processing starts. Exact same pattern
  // formFieldsUI.js's own #ffModalSaveBtn uses. If an edit is still
  // in-progress (span focused, not yet blurred), commit it first — the
  // walk needs the FINAL text, not whatever was mid-edit.
  id('qeModalSaveBtn').addEventListener('click', () => {
    if (_activeEditSpan) _commitEdit(_activeEditSpan);
    _closeModal({ silent: true });
    id('mergeBtn')?.click();
  });

  // On first open (called from _prepareAndRender), docContainer is the
  // freshly-rendered target. On reopen (the "Continue editing" trigger),
  // it's called with no argument — fall back to the one already built and
  // saved in module state, so reopening resumes the SAME live DOM (and any
  // edits already made to it, once Stage 3 lands) rather than re-rendering
  // from scratch.
  // In place: the page editor (kept between openings, its edits too). Personalized
  // copies open on the original layout (the same engine); the rebuild editor
  // stays one press away for a file the page editor can't change
  if (pageMode) {
    const toggle = _modal.querySelector('[data-copies-toggle]');
    toggle?.addEventListener('click', () => { _closeModal({ silent: true }); void _openModal(null, true); });
    const rebuild = document.createElement('button');
    rebuild.type = 'button';
    rebuild.id = 'qeUseRebuild';
    rebuild.className = 'qe-copies__button';
    rebuild.textContent = t('quickedit_use_rebuild');
    rebuild.title = t('quickedit_use_rebuild_title');
    rebuild.addEventListener('click', () => void _switchToRebuild());
    toggle?.before(rebuild);
    const stage = id('qeModalStage');
    if (_pageEditor) stage.appendChild(_pageEditor.root);
    else _pageEditor = createPageEditor(stage, _pageOriginal);
    id('qeModalClose')?.focus();
    return;
  }

  const target = originalOnly ? document.createElement('div') : docContainer || _docContainer;
  if (target) {
    id('qeModalStage').appendChild(target);
    // Real bug, found via empirical click-testing (Stage 3): while
    // renderDocxToDom() built `target` off-screen, it was a direct child
    // of document.body (see _prepareAndRender's own comment on why —
    // docx-preview needs real layout). _setBackgroundInert(true) below
    // walks document.body.children and marks everything except the modal
    // itself inert, for the WHOLE background-dimming duration this modal
    // is open — including `target`, since at that exact moment it still
    // looked like ordinary background content, not modal content.
    // Reparenting into qeModalStage (the line above) does NOT clear an
    // already-set `inert` attribute — it just carries the tainted node
    // into a live, interactive subtree, where every descendant span
    // silently stops receiving click/focus events at all (confirmed via
    // document.elementsFromPoint: hit-testing skipped straight past the
    // whole rendered document to the stage div itself). Clear it here,
    // now that `target` genuinely IS inside the modal.
    target.removeAttribute('inert');
    target.removeAttribute('aria-hidden');
    if (!originalOnly) _docContainer = target;
    _fitDocContainerToStage(target);
    // Only bind once per container — reopening (docContainer===undefined,
    // falls back to _docContainer) must NOT re-run this, since the
    // delegated listener + editable-run classes already applied the first
    // time are still intact on the same, never-torn-down DOM node.
    if (docContainer) _bindEditableSpans(target);
    _clearCopyFields = bindQuickEditCopies(id('qeCopies'), target, _sourceFile, _fitDocContainerToStage, originalOnly);
    const exampleNames = quickEditExamples.get(_sourceFile);
    if (exampleNames) {
      const names = id('qeCopyNames');
      names.value = exampleNames;
      names.dispatchEvent(new Event('input'));
    }
  }

  id('qeModalClose')?.focus();
}

// ── Stage 3: constrained per-run click-to-edit ──────────────────
//
// THE core design constraint (see this file's header + the plan doc): only
// a run's TEXT may change, never its class/style/element identity — every
// selector docxToPdfCore.js's walk depends on (direct-child <span> of <p>,
// bold/italic style regex, heading/list classes) must survive untouched.
// contenteditable="plaintext-only" is the browser's own native guarantee
// of exactly that (Chrome/Edge): the node can be typed into, but can never
// gain a child ELEMENT. Firefox/Safari don't support it yet, so those get
// a manual fallback that enforces the same invariant by hand.
const _PLAINTEXT_ONLY_SUPPORTED = (() => {
  try {
    const probe = document.createElement('span');
    probe.contentEditable = 'plaintext-only';
    return probe.contentEditable === 'plaintext-only';
  } catch { return false; }
})();

function _isEditableSpan(span) {
  return span?.tagName === 'SPAN'
    && span.parentElement?.tagName === 'P'
    // Footnote MARKER text (the small superscript reference number) — see
    // docxToPdfCore.js's `docx_footnotereference` class, `_parseRun`'s own
    // `sup` flag. Editing a marker's own text has no sensible meaning
    // (it's not the footnote's content, just its in-line number).
    && !span.classList.contains('docx_footnotereference');
}

// Adds the discoverable-affordance class to every currently-eligible span.
// Called once per fresh render (not on every click) — matches _isEditableSpan
// exactly, so "looks clickable" and "is clickable" never drift apart.
function _markEditableSpans(container) {
  for (const span of container.querySelectorAll('p > span')) {
    if (_isEditableSpan(span)) span.classList.add('qe-editable-run');
  }
}

let _activeEditSpan = null; // the one span currently in edit mode, or null

function _bindEditableSpans(container) {
  _markEditableSpans(container);
  container.addEventListener('click', e => {
    if (id('qeCopies')?.hidden === false) return;
    const span = e.target.closest('span');
    if (!_isEditableSpan(span)) return;
    if (span === _activeEditSpan) return; // already editing this one
    _enterEditMode(span);
  });
}

function _enterEditMode(span) {
  if (_activeEditSpan && _activeEditSpan !== span) _commitEdit(_activeEditSpan);

  _activeEditSpan = span;
  span.dataset.qeOriginalText = span.textContent;
  span.classList.add('qe-editable-run--active');

  if (_PLAINTEXT_ONLY_SUPPORTED) {
    span.contentEditable = 'plaintext-only';
  } else {
    // Fallback: plain contenteditable="true" plus explicit enforcement —
    // see this section's header comment for why each layer exists.
    span.contentEditable = 'true';
    span.addEventListener('beforeinput', _onFallbackBeforeInput);
    span.addEventListener('paste', _onFallbackPaste);
    // Last-resort safety net: if any non-text-node child ever appears
    // despite the above (an edge case the explicit handlers didn't
    // anticipate — unusual IME composition, a stray drag-drop), collapse
    // back to plain text immediately rather than let it reach the walk.
    span._qeObserver = new MutationObserver(() => {
      // nodeType 3 === TEXT_NODE (raw literal matches this codebase's own
      // existing convention, see js/eriAnatomy.js's nodeType===1 check).
      if (Array.from(span.childNodes).some(n => n.nodeType !== 3)) {
        // Re-flattening via textContent collapses all child nodes into one
        // plain text node, discarding whatever stray element the mutation
        // observer just caught.
        const flat = span.textContent;
        span.textContent = flat;
      }
    });
    span._qeObserver.observe(span, { childList: true });
  }

  span.addEventListener('keydown', _onEditKeydown);
  span.addEventListener('blur', _onEditBlur);

  span.focus();
  // Place the caret at the click point rather than selecting/resetting to
  // start — matches native text-field click behavior a user expects.
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) { /* leave an active click-drag selection alone */ }
}

function _onEditKeydown(e) {
  if (e.key === 'Enter') {
    // Under plaintext-only, Enter is a no-op by the browser's own contract
    // (can't insert a paragraph break) — still explicitly blur to commit,
    // for a consistent "Enter commits" UX under BOTH code paths.
    e.preventDefault();
    e.stopPropagation(); // see the Escape branch's comment below — same bug class
    e.target.blur();
  } else if (e.key === 'Escape') {
    // Real bug, found via empirical testing: Escape here is meant to
    // cancel just THIS edit — but this listener is bound on the span
    // itself, and keydown BUBBLES. _onModalKeydown (bound on `document`,
    // for the modal's own Escape-to-close shortcut) was ALSO firing for
    // the exact same keypress, closing the entire modal out from under an
    // in-progress edit (confirmed: the whole #qeModalStage vanished
    // immediately after pressing Escape while editing). preventDefault()
    // alone only blocks the browser's own default action, not propagation
    // to other listeners — stopPropagation() is the piece that was missing.
    e.preventDefault();
    e.stopPropagation();
    const span = e.target;
    span.textContent = span.dataset.qeOriginalText ?? span.textContent;
    span.blur();
  }
}

function _onFallbackBeforeInput(e) {
  if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
    e.preventDefault();
  }
}

function _onFallbackPaste(e) {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, text);
}

function _onEditBlur(e) {
  _commitEdit(e.target);
}

// Empty guard: _parseRun (docxToPdfCore.js) returns null for an empty span
// and parseParagraph silently filters nulls — an emptied run wouldn't
// crash anything, it would just silently VANISH from the output PDF. That
// is exactly the "silent no-op" CLAUDE.md's UX rule warns against — block
// it here (revert to the original text) rather than let it through quietly.
function _commitEdit(span) {
  if (!span) return;
  if (span.textContent.trim() === '') {
    span.textContent = span.dataset.qeOriginalText || '';
  }
  span.removeAttribute('contenteditable');
  span.classList.remove('qe-editable-run--active');
  span.removeEventListener('keydown', _onEditKeydown);
  span.removeEventListener('blur', _onEditBlur);
  span.removeEventListener('beforeinput', _onFallbackBeforeInput);
  span.removeEventListener('paste', _onFallbackPaste);
  if (span._qeObserver) { span._qeObserver.disconnect(); span._qeObserver = null; }
  delete span.dataset.qeOriginalText;
  if (_activeEditSpan === span) _activeEditSpan = null;
}

// docx-preview renders `.docx-wrapper > section.docx` at the page's own
// real width (e.g. ~595pt/~793px for A4) — a fixed size, not
// viewport-relative. On a real mobile viewport (confirmed empirically,
// not assumed: a 390px-wide screenshot showed the title/paragraphs
// truncated on both edges, requiring horizontal scroll to read a single
// line) that overflows the stage badly. Scale the whole rendered section
// down to fit the stage's available width — same "fit to width" idea
// `.qe-modal__stage`'s `overflow:auto` already allows scrolling past, just
// applied as a default so the common case doesn't NEED scrolling sideways
// to read a line of body text. Computed once per modal-open (not on
// resize) — a deliberately simple v1, not a full responsive re-layout.
function _fitDocContainerToStage(container) {
  const section = container.querySelector('.docx-wrapper > section.docx');
  const stage   = id('qeModalStage');
  if (!section || !stage) return;
  const sectionWidth = section.offsetWidth;
  const stageWidth   = stage.getBoundingClientRect().width - 32; // minus .qe-modal__stage's own padding
  if (sectionWidth <= 0 || stageWidth <= 0) return;
  const scale = Math.min(1, stageWidth / sectionWidth);
  const wrapper = container.querySelector('.docx-wrapper');
  if (!wrapper) return;
  wrapper.style.transform       = scale < 1 ? `scale(${scale})` : '';
  wrapper.style.transformOrigin = 'top center';
  wrapper.style.marginBottom = '';
  // Scaling via CSS transform doesn't shrink the element's own layout box
  // (the stage would still reserve/scroll the UNSCALED height) — compensate
  // so the visible content doesn't leave a tall dead-space gap below it.
  if (scale < 1) {
    const rect = wrapper.getBoundingClientRect();
    wrapper.style.marginBottom = `${-rect.height * (1 - scale)}px`;
  }
}

function _onModalKeydown(e) {
  if (e.key === 'Escape') { _closeModal(); return; }
  if (e.key !== 'Tab' || !_modal) return;
  const els = _focusables();
  if (!els.length) return;
  const first  = els[0];
  const last   = els[els.length - 1];
  const active = document.activeElement;
  if (!_modal.contains(active)) { e.preventDefault(); first.focus(); return; }
  if (e.shiftKey && active === first)  { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}

function _focusables() {
  if (!_modal) return [];
  return Array.from(_modal.querySelectorAll(FOCUSABLE_SEL))
    .filter(el => el.offsetParent !== null || el === document.activeElement);
}

function _setBackgroundInert(on) {
  if (on) {
    for (const el of Array.from(document.body.children)) {
      if (el === _modal) continue;
      if (el.hasAttribute('inert') || el.getAttribute('aria-hidden') === 'true') continue;
      el.setAttribute('inert', '');
      el.setAttribute('aria-hidden', 'true');
      _inerted.push(el);
    }
  } else {
    for (const el of _inerted) { el.removeAttribute('inert'); el.removeAttribute('aria-hidden'); }
    _inerted = [];
  }
}

function _closeModal({ silent = false } = {}) {
  const wasOpen = !!_modal;
  if (_modal) {
    _clearCopyFields?.();
    _clearCopyFields = null;
    document.removeEventListener('keydown', _onModalKeydown);
    _modal.remove();
    _modal = null;
  }
  _setBackgroundInert(false);
  if (!silent && _container) {
    _container.innerHTML = (_docContainer || _pageEditor) ? _triggerHTML()
      : _atlasEri && !_atlasEri.error && _atlasEri.eri < _ATLAS_BLOCK_THRESHOLD ? _blockedHTML(_atlasEri) : _sourceOnlyButton();
    _bindTriggerEvents(_container);
  }
  if (wasOpen) _restoreFocus(silent);
}

function _restoreFocus(silent) {
  let target = null;
  if (!silent && _container) target = _container.querySelector('#qeReopenBtn, #qeOpenOriginal');
  if (!target && _prevFocus && _prevFocus.isConnected) target = _prevFocus;
  _prevFocus = null;
  try { target?.focus(); } catch { /* element became unfocusable — nothing to restore to */ }
}
