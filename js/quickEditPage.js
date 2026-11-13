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
import { RADICAL_IDEOGRAPH } from './cjkRadicals.js';

// What a person types for what a PDF stores: NFC turns a CJK compatibility
// ideograph (更 U+F901) into the ordinary one; a Kangxi radical (⽂ U+2F42 for
// 文) only NFKC maps, applied to it alone so full-width punctuation (，) stays;
// a CJK Radicals Supplement character (⻚ for 页) no normalization maps — the
// table from Noto SC's glyphs does (Chrome-printed Chinese, 2026-11-13).
const plain = value => value.normalize('NFC')
  .replace(/[\u2F00-\u2FDF]/g, c => c.normalize('NFKC'))
  .replace(/[\u2E80-\u2EFF]/g, c => RADICAL_IDEOGRAPH.get(c) ?? c);

// → { edits(): [{ line, text }], count(): number, destroy() }
export function createPageEditor(stage, original, { onChange } = {}) {
  const edits = new Map();              // "page:x:y" → { line, text }
  const total = original.pdf.numPages;
  let pageIndex = 0, version = 0, active = null;

  const root = document.createElement('div');
  root.className = 'qe-page-editor';
  root.innerHTML = `
    <form class="qe-find" data-find>
      <input type="text" data-find-text aria-label="${t('quickedit_find')}" placeholder="${t('quickedit_find')}" enterkeyhint="search">
      <input type="text" data-replace-text aria-label="${t('quickedit_replace_with')}" placeholder="${t('quickedit_replace_with')}">
      <button type="submit" class="qe-copies__button">${t('quickedit_find_btn')}</button>
      <button type="button" class="qe-copies__button" data-replace-all disabled>${t('quickedit_replace_all')}</button>
      <p class="qe-find__status" data-find-status role="status"></p>
    </form>
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
    const text = plain(span.textContent).replace(/\s+/g, ' ').trim();
    if (!text || text === plain(entry.line.text).replace(/\s+/g, ' ').trim()) {
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

  // One page's editable lines — the same for drawing it and for Find, so a
  // match is always a line the person could also tap
  async function readPage(index) {
    const page = await original.pdf.getPage(index + 1);
    const viewport = page.getViewport({ scale: 1 });
    const [{ items }, ops] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
    // A scan with an OCR layer: its text is drawn invisible (render mode 3)
    // under the page picture — an edit would change only hidden text, never
    // what a reader sees (Internet Archive books, 2026-11-12)
    const { OPS } = window.pdfjsLib;
    const modes = ops.fnArray.map((fn, i) => (fn === OPS.setTextRenderingMode ? ops.argsArray[i][0] : null)).filter(m => m !== null);
    const hiddenOnly = modes.length > 0 && modes.every(m => m === 3 || m === 7);
    // the font a pdf.js id stands for, its subset tag (ABCDEF+) dropped;
    // fonts are known once the operator list above has been read
    const fontKey = id => {
      try { return page.commonObjs.get(id)?.name?.replace(/^[A-Z]{6}\+/, '') || id; } catch { return id; }
    };
    const lines = hiddenOnly ? [] : originalLines(items, { splitFonts: true, fontKey });
    for (const line of lines) {
      const right = lines.find(other => other.y === line.y && other.x > line.right);
      line.page = index;
      // free space to the next piece on the line, else to the page margin
      line.maxRight = right ? Math.max(line.right, right.x - 12) : Math.max(line.right, viewport.width - 36);
    }
    return { page, viewport, lines, hiddenOnly };
  }
  const keyOf = line => `${line.page}:${line.x}:${line.y}`;

  async function render() {
    const mine = ++version;
    label.textContent = t('quickedit_page_of', { n: pageIndex + 1, total });
    prev.disabled = pageIndex === 0;
    next.disabled = pageIndex >= total - 1;
    const { page, viewport, lines, hiddenOnly } = await readPage(pageIndex);
    if (mine !== version || !root.isConnected) return;
    const scale = Math.min(2, (window.devicePixelRatio || 1) * Math.max(1, (view.clientWidth || viewport.width) / viewport.width));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width * scale);
    canvas.height = Math.ceil(viewport.height * scale);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: page.getViewport({ scale }) }).promise;
    if (mine !== version || !root.isConnected) return;
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
      const key = keyOf(line);
      const span = document.createElement('span');
      span.className = 'qe-original-line qe-page-line';
      // a removed line (Find, nothing to replace with) shows struck through
      span.textContent = edits.get(key)?.text || line.text;
      if (edits.has(key)) span.classList.add(edits.get(key).text ? 'qe-page-line--edited' : 'qe-page-line--removed');
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
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); span.textContent = edits.get(key)?.text || line.text; span.blur(); }
        } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); edit(span, entry); }
      });
      view.appendChild(span);
    }
  }

  // ── Find & replace on every page (like a word processor's Replace all) ──
  // A match lies inside one line: a phrase broken across two lines isn't
  // found, and the status says so when nothing is. Latin case is ignored,
  // as a word processor does by default.
  const findForm = root.querySelector('[data-find]');
  const findText = root.querySelector('[data-find-text]');
  const replaceText = root.querySelector('[data-replace-text]');
  const replaceAll = root.querySelector('[data-replace-all]');
  const findStatus = root.querySelector('[data-find-status]');
  let found = [], search = 0;

  // Compared after NFC + lower case, per character so a match maps back to
  // the line: Chinese PDFs often map a glyph to a CJK compatibility
  // ideograph (更 as U+F901 in a Noto subset, 2026-11-13) — it looks the same
  // as the 更 a person types (U+66F4) and NFC makes them equal, while
  // full-width punctuation (，) stays as it is.
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : null;
  const fold = value => plain(value).toLowerCase().replace(/\s+/g, ' ');
  function occurrences(text, query) {
    const parts = segmenter ? [...segmenter.segment(text)].map(({ segment, index }) => ({ segment, index }))
      : Array.from(text, (segment, i, all) => ({ segment, index: all.slice(0, i).join('').length }));
    let haystack = '';
    const from = [];   // haystack position → [start, end) in the line's own text
    for (const { segment, index } of parts) {
      // any space (a no-break space too) is one space; a run of them counts once
      const folded = /^\s+$/.test(segment) ? ' ' : fold(segment);
      if (folded === ' ' && haystack.endsWith(' ')) continue;
      for (let k = 0; k < folded.length; k++) from.push([index, index + segment.length]);
      haystack += folded;
    }
    const target = fold(query);
    const at = [];
    for (let i = haystack.indexOf(target); i >= 0 && target; i = haystack.indexOf(target, i + target.length)) {
      at.push([from[i][0], from[i + target.length - 1][1]]);
    }
    return at;
  }

  findForm.addEventListener('submit', async event => {
    event.preventDefault();
    const query = findText.value.replace(/\s+/g, ' ').trim();
    const mine = ++search;
    found = [];
    replaceAll.disabled = true;
    if (!query) { findStatus.textContent = ''; return; }
    let count = 0;
    const pages = new Set();
    for (let index = 0; index < total; index++) {
      if (mine !== search || !root.isConnected) return;
      findStatus.textContent = t('quickedit_searching', { n: index + 1, total });
      const { lines } = await readPage(index);
      for (const line of lines) {
        const at = occurrences(line.text, query);
        if (!at.length) continue;
        found.push({ line, at });
        count += at.length;
        pages.add(index);
      }
    }
    if (mine !== search) return;
    findStatus.textContent = count ? t('quickedit_found', { n: count, pages: pages.size }) : t('quickedit_found_none');
    replaceAll.disabled = !count;
  });

  replaceAll.addEventListener('click', () => {
    active?.blur();
    const replacement = replaceText.value;
    let lines = 0;
    for (const { line, at } of found) {
      let text = line.text;
      for (const [start, end] of [...at].reverse()) text = text.slice(0, start) + replacement + text.slice(end);
      // NFC: a compatibility ideograph left in the line is written as the
      // ordinary one, which the replacement font has
      text = plain(text).replace(/\s+/g, ' ').trim();
      if (text === plain(line.text).replace(/\s+/g, ' ').trim()) continue;
      edits.set(keyOf(line), { line, text });
      lines++;
    }
    found = [];
    replaceAll.disabled = true;
    findStatus.textContent = t('quickedit_replaced', { n: lines });
    onChange?.(edits.size);
    void render();
  });

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
