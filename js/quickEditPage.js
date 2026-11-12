// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  quickEditPage.js — Quick Edit's in-place editor: the original page,
//  its text lines clickable over it; an edited line is replaced in the PDF
//  itself (js/quickEditOriginal.js: MuPDF removes exactly its glyphs, the
//  new text is drawn in place, every changed page is read back) — nothing
//  else on the page or in the file is rebuilt.
//
//  Why (step 0 of the Quick Edit stage, 2026-11-12, 32 public PDFs + a
//  300-page Chinese book): the old path rebuilt the whole document — the
//  page count held on 3 of 20, untouched pages changed by 35 % of their
//  pixels, and no Chinese, Japanese, Korean, Arabic or Hebrew file could be
//  saved. In place, 23 of 31 saved with untouched pages unchanged (0.0 %).
//
//  One page is drawn at a time (a 300-page book on a phone keeps one
//  canvas). Edits are kept per line; the rest of the file is never touched.
// ============================================================

import { originalLines } from './quickEditOriginal.js';
import { t } from './i18n.js';

// → { edits(): [{ line, text }], count(): number, destroy() }
export function createPageEditor(stage, original, { onChange } = {}) {
  const edits = new Map();              // "page:x:y" → { line, text }
  const total = original.pdf.numPages;
  let pageIndex = 0, version = 0, active = null;

  const root = document.createElement('div');
  root.className = 'qe-page-editor';
  root.innerHTML = `
    <div class="qe-page-nav">
      <button type="button" class="qe-copies__button" data-prev aria-label="${t('quickedit_prev_page')}">‹</button>
      <span data-page-label role="status"></span>
      <button type="button" class="qe-copies__button" data-next aria-label="${t('quickedit_next_page')}">›</button>
      <button type="button" class="qe-copies__button" data-zoom aria-label="${t('quickedit_zoom')}">100%</button>
    </div>
    <p class="qe-page-hint">${t('quickedit_page_hint')}</p>
    <div class="qe-original-page" data-page></div>`;
  stage.appendChild(root);
  const view = root.querySelector('[data-page]');
  const label = root.querySelector('[data-page-label]');
  const prev = root.querySelector('[data-prev]');
  const next = root.querySelector('[data-next]');
  // Zoom: on a phone a line of text is ~10 px tall, too small to tap — larger
  // pages scroll sideways inside the editor, never the site
  const zoomBtn = root.querySelector('[data-zoom]');
  const ZOOMS = [1, 1.5, 2];
  let zoom = 0;
  zoomBtn.addEventListener('click', () => {
    zoom = (zoom + 1) % ZOOMS.length;
    zoomBtn.textContent = `${ZOOMS[zoom] * 100}%`;
    view.style.width = `${ZOOMS[zoom] * 100}%`;
    view.style.maxWidth = ZOOMS[zoom] === 1 ? view.dataset.maxWidth : 'none';
    view.style.marginInline = ZOOMS[zoom] === 1 ? 'auto' : '0';   // zoomed: scrolls from the left edge
  });

  function commit(span, entry) {
    if (active !== span) return;
    active = null;
    span.contentEditable = 'false';
    span.classList.remove('qe-page-line--active');
    const text = span.textContent.replace(/\s+/g, ' ').trim();
    if (!text || text === entry.line.text.replace(/\s+/g, ' ').trim()) {
      edits.delete(entry.key);
      span.textContent = entry.line.text;
      span.classList.remove('qe-page-line--edited');
    } else {
      edits.set(entry.key, { line: entry.line, text });
      span.textContent = text;
      span.classList.add('qe-page-line--edited');
    }
    onChange?.(edits.size);
  }

  function edit(span, entry) {
    if (active && active !== span) active.blur();
    active = span;
    span.contentEditable = 'plaintext-only';
    if (span.contentEditable !== 'plaintext-only') span.contentEditable = 'true';
    span.classList.add('qe-page-line--active');
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    range.collapse(false);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    span.addEventListener('blur', () => commit(span, entry), { once: true });
  }

  async function render() {
    const mine = ++version;
    label.textContent = t('quickedit_page_of', { n: pageIndex + 1, total });
    prev.disabled = pageIndex === 0;
    next.disabled = pageIndex >= total - 1;
    const page = await original.pdf.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2, (window.devicePixelRatio || 1) * Math.max(1, (view.clientWidth || viewport.width) / viewport.width));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width * scale);
    canvas.height = Math.ceil(viewport.height * scale);
    const [{ items }, ops] = await Promise.all([
      page.getTextContent(),
      page.getOperatorList(),
      page.render({ canvasContext: canvas.getContext('2d'), viewport: page.getViewport({ scale }) }).promise,
    ]);
    if (mine !== version || !root.isConnected) return;
    // A scan with an OCR layer: its text is drawn invisible (render mode 3)
    // under the page picture — an edit would change only hidden text, never
    // what a reader sees (Internet Archive books, 2026-11-12)
    const { OPS } = window.pdfjsLib;
    const modes = ops.fnArray.map((fn, i) => (fn === OPS.setTextRenderingMode ? ops.argsArray[i][0] : null)).filter(m => m !== null);
    const hiddenOnly = modes.length > 0 && modes.every(m => m === 3 || m === 7);
    const lines = hiddenOnly ? [] : originalLines(items, { splitFonts: true });
    view.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    view.dataset.maxWidth = `${viewport.width * 1.5}px`;
    if (ZOOMS[zoom] === 1) view.style.maxWidth = view.dataset.maxWidth;
    view.replaceChildren(canvas);
    if (!lines.length) {
      const note = document.createElement('p');
      note.className = 'qe-page-empty';
      note.textContent = hiddenOnly
        ? t('quickedit_page_scan_hidden')
        : t('quickedit_page_no_text');
      view.appendChild(note);
    }
    for (const line of lines) {
      const right = lines.find(other => other.y === line.y && other.x > line.right);
      line.page = pageIndex;
      // free space to the next piece on the line, else to the page margin
      line.maxRight = right ? Math.max(line.right, right.x - 12) : Math.max(line.right, viewport.width - 36);
      const key = `${pageIndex}:${line.x}:${line.y}`;
      const span = document.createElement('span');
      span.className = 'qe-original-line qe-page-line';
      span.textContent = edits.get(key)?.text ?? line.text;
      if (edits.has(key)) span.classList.add('qe-page-line--edited');
      span.style.left = `${line.x / viewport.width * 100}%`;
      span.style.top = `${(viewport.height - line.y - line.size) / viewport.height * 100}%`;
      span.style.minWidth = `${(line.right - line.x) / viewport.width * 100}%`;
      span.style.fontSize = `${line.size / viewport.width * 100}cqw`;
      span.tabIndex = 0;
      span.setAttribute('role', 'button');
      const entry = { key, line };
      span.addEventListener('click', () => { if (active !== span) edit(span, entry); });
      span.addEventListener('keydown', e => {
        if (active === span) {
          if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); span.textContent = edits.get(key)?.text ?? line.text; span.blur(); }
        } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); edit(span, entry); }
      });
      view.appendChild(span);
    }
  }

  prev.addEventListener('click', () => { if (pageIndex > 0) { active?.blur(); pageIndex--; void render(); } });
  next.addEventListener('click', () => { if (pageIndex < total - 1) { active?.blur(); pageIndex++; void render(); } });
  void render();

  return {
    root,
    edits: () => { active?.blur(); return [...edits.values()]; },
    count: () => edits.size,
    destroy: () => { version++; root.remove(); },
  };
}
