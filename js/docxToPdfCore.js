// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Word (.docx) -> PDF, entirely client-side: docx-preview renders the
// .docx into real DOM+CSS in THIS page (the user's own browser IS the
// layout engine — no headless-browser automation needed here, unlike the
// prototype this was built from, which used Playwright purely because it
// ran in Node during development), then this file walks that rendered
// DOM to build a pdfmake document definition -> real vector PDF (the
// text stays selectable/searchable, not a rasterized image).
//
// v1, disclosed limitations (see CLAUDE.md "Adding a feature" + the real
// testing this was built against):
//  - Multi-column sections: block-level greedy-optimal balancing by real
//    measured height, not true CSS line-by-line auto-flow — a single
//    paragraph much taller than the rest of a section can still look
//    lopsided (mathematical ceiling of not splitting text mid-paragraph).
//  - Table borders: reads only the FIRST cell's border and applies it to
//    the whole table — real per-edge variation isn't preserved.
//  - Header/footer: one recurring header/footer for the WHOLE document
//    (pdfmake has no per-DOCX-section header/footer concept); dynamic
//    fields (PAGE/NUMPAGES) render empty — docx-preview itself doesn't
//    resolve them statically.
//  - Footnotes: real text is collected into one "Footnotes" section at
//    the end of the document, not pinned to the bottom of the specific
//    page the reference appears on (pdfmake has no per-page footnote
//    region).
//  - Images: only a full-paragraph image (its own line) is placed — an
//    image inline mid-sentence with surrounding text is skipped.
//  - Numbering: real per-numId/per-level restart and Word's actual
//    start-value ARE both handled correctly (read straight from
//    docx-preview's own generated CSS, not guessed) — this is a genuine
//    strength of this specific pipeline, not a gap.

import { loadDocxPreview, loadPdfMake } from './lazyLibs.js';

const HEADING_STYLE = {
  docx_title:    { fontSize: 22, bold: true },
  docx_heading1: { fontSize: 16, bold: true, color: '#2E74B5' },
  docx_heading2: { fontSize: 13, bold: true, color: '#2E74B5' },
  docx_heading3: { fontSize: 12, bold: true, color: '#1F4D78' },
  docx_heading4: { fontSize: 11, bold: true, italics: true, color: '#2E74B5' },
  docx_heading5: { fontSize: 11, bold: true, color: '#2E74B5' },
  docx_heading6: { fontSize: 11, bold: true, color: '#1F4D78' },
};

function _parseRun(span) {
  const style = span.getAttribute('style') || '';
  const text = span.textContent;
  if (!text) return null;
  const run = { text };
  if (/font-weight:\s*bold/.test(style)) run.bold = true;
  if (/font-style:\s*italic/.test(style)) run.italics = true;
  if (/text-decoration:\s*underline/.test(style)) run.decoration = 'underline';
  if (span.classList.contains('docx_footnotereference')) run.sup = true;
  return run;
}

function _toAlpha(n, upper) {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
  return upper ? s.toUpperCase() : s;
}
function _toRoman(n, upper) {
  const table = [[1000,'m'],[900,'cm'],[500,'d'],[400,'cd'],[100,'c'],[90,'xc'],[50,'l'],[40,'xl'],[10,'x'],[9,'ix'],[5,'v'],[4,'iv'],[1,'i']];
  let s = '';
  for (const [v, sym] of table) { while (n >= v) { s += sym; n -= v; } }
  return upper ? s.toUpperCase() : s;
}
function _formatCounter(n, style) {
  switch (style) {
    case 'lower-alpha': case 'lower-latin': return _toAlpha(n, false);
    case 'upper-alpha': case 'upper-latin': return _toAlpha(n, true);
    case 'lower-roman': return _toRoman(n, false);
    case 'upper-roman': return _toRoman(n, true);
    default: return String(n);
  }
}

async function _imgToDataUrl(img) {
  const resp = await fetch(img.src);
  const blob = await resp.blob();
  return await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

function _rgbToHex(rgb) {
  const m = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return rgb;
  return '#' + m.slice(1, 4).map(n => parseInt(n, 10).toString(16).padStart(2, '0')).join('');
}

// Contiguous "split ordered array into K groups minimizing the largest
// group sum" — solved exactly via binary search on the answer, so
// document reading order is preserved exactly (sorting by height first,
// the usual greedy fix, was rejected during testing: it scrambles the
// order a reader actually encounters paragraphs in).
function _splitBalanced(heights, k) {
  const n = heights.length;
  let lo = Math.max(...heights, 0);
  let hi = heights.reduce((a, b) => a + b, 0);
  const feasible = (cap) => {
    let groups = 1, cur = 0;
    for (const h of heights) {
      if (cur + h > cap) { groups++; cur = h; if (groups > k) return false; }
      else cur += h;
    }
    return true;
  };
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (feasible(mid)) hi = mid; else lo = mid + 1;
  }
  const cap = lo;
  const groups = [];
  let cur = [], curSum = 0;
  for (let i = 0; i < n; i++) {
    if (curSum + heights[i] > cap && cur.length > 0) { groups.push(cur); cur = []; curSum = 0; }
    cur.push(i);
    curSum += heights[i];
  }
  if (cur.length) groups.push(cur);
  while (groups.length < k) groups.push([]);
  return groups;
}

/**
 * Renders a .docx File into DOM (off-screen, in this page) and walks it
 * into a pdfmake document-definition `content` array + header/footer text.
 * @param {File|Blob} file
 * @param {{ isCancelled?: () => boolean }} [opts]
 */
async function _docxToPdfmakeContent(file, { isCancelled } = {}) {
  await loadDocxPreview();

  // Off-screen, not display:none — display:none elements don't get real
  // layout at all, which would make every getBoundingClientRect() used
  // for column-balancing below return zero height.
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute; top:-99999px; left:-99999px; width:800px;';
  document.body.appendChild(container);

  try {
    await window.docx.renderAsync(file, container, null, { inWrapper: true });
    if (isCancelled?.()) throw new Error('cancelled');

    const listCounters = {};
    const wrapperEl = container.querySelector('.docx-wrapper');
    const counterResetStr = wrapperEl ? getComputedStyle(wrapperEl).counterReset : '';
    if (counterResetStr) {
      const parts = counterResetStr.trim().split(/\s+/);
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const val = parseInt(parts[i + 1], 10);
        if (!Number.isNaN(val) && val !== 0) listCounters[parts[i]] = val;
      }
    }

    async function parseParagraph(p) {
      const img = p.querySelector('img');
      if (img) {
        const dataUrl = await _imgToDataUrl(img);
        const wrapper = img.closest('div');
        const wStyle = wrapper?.getAttribute('style') || '';
        const wMatch = wStyle.match(/width:\s*([\d.]+)pt/);
        const width = wMatch ? parseFloat(wMatch[1]) : 200;
        return { image: dataUrl, width, margin: [0, 0, 0, 8] };
      }

      const spans = Array.from(p.children).filter(c => c.tagName === 'SPAN');
      const runs = spans.map(_parseRun).filter(Boolean);
      const headingClass = Array.from(p.classList).find(c => HEADING_STYLE[c]);
      const listClass = Array.from(p.classList).find(c => /^docx-num-/.test(c));
      let listPrefix = '';
      if (listClass) {
        const beforeContent = getComputedStyle(p, '::before').content || '';
        if (/counter\(/.test(beforeContent)) {
          const m = listClass.match(/^docx-num-(.+)-(\d+)$/);
          if (m) {
            const [, numId, levelStr] = m;
            const level = parseInt(levelStr, 10);
            Object.keys(listCounters).forEach((key) => {
              const km = key.match(/^docx-num-(.+)-(\d+)$/);
              if (km && km[1] === numId && parseInt(km[2], 10) > level) delete listCounters[key];
            });
          }
          listCounters[listClass] = (listCounters[listClass] || 0) + 1;
          const styleMatch = beforeContent.match(/counter\([^,)]+,\s*([a-z-]+)\)/);
          listPrefix = `${_formatCounter(listCounters[listClass], styleMatch?.[1])}.  `;
        } else {
          const cleaned = beforeContent.replace(/^"|"$/g, '').replace(/\\9\s*/g, '').trim();
          listPrefix = cleaned ? `${cleaned}  ` : '';
        }
      }
      if (runs.length === 0) {
        return { text: ' ', fontSize: 8, margin: [0, 0, 0, 6] };
      }
      const textRuns = runs.map(r => ({ text: r.text, bold: !!r.bold, italics: !!r.italics, decoration: r.decoration, sup: !!r.sup }));
      if (listPrefix) textRuns.unshift({ text: listPrefix });
      const node = {
        text: textRuns,
        margin: listClass ? [18 * (1 + (parseInt(listClass.split('-').pop(), 10) || 0)), 0, 0, 4] : [0, 0, 0, 8],
      };
      if (headingClass) {
        Object.assign(node, HEADING_STYLE[headingClass]);
        node.margin = [0, 4, 0, 8];
      }
      return node;
    }

    async function parseCell(td) {
      const paras = Array.from(td.querySelectorAll(':scope > p'));
      const stack = await Promise.all(paras.map(parseParagraph));
      return { stack: stack.length ? stack : [{ text: ' ' }] };
    }

    async function parseTable(table) {
      const rows = Array.from(table.querySelectorAll(':scope > tr'));
      const body = await Promise.all(
        rows.map(tr => Promise.all(Array.from(tr.querySelectorAll(':scope > td')).map(parseCell)))
      );
      const colCount = body[0]?.length || 1;

      const firstTd = table.querySelector('td');
      const tdStyle = firstTd?.getAttribute('style') || '';
      const widthMatch = tdStyle.match(/border-width:\s*([\d.]+)pt/);
      const colorMatch = tdStyle.match(/border-color:\s*([^;]+)/);
      const hasBorder = /border-style:\s*solid/.test(tdStyle);
      const lineWidth = widthMatch ? parseFloat(widthMatch[1]) : 0.5;
      const lineColor = colorMatch ? _rgbToHex(colorMatch[1].trim()) : '#000000';

      return {
        table: { widths: Array(colCount).fill('*'), body },
        // Real function references, no serialization boundary to cross
        // (this whole pipeline runs in one JS context, unlike the
        // Node+Playwright prototype it's adapted from).
        layout: hasBorder ? {
          hLineWidth: () => lineWidth,
          vLineWidth: () => lineWidth,
          hLineColor: () => lineColor,
          vLineColor: () => lineColor,
        } : 'noBorders',
        margin: [0, 6, 0, 6],
      };
    }

    function extractHeaderFooterText(section, tag) {
      const el = section.querySelector(`:scope > ${tag}`);
      if (!el) return null;
      const text = Array.from(el.querySelectorAll('p')).map(p => p.textContent).join(' ').trim();
      return text || null;
    }
    const firstSection = container.querySelector('.docx-wrapper > section.docx');
    const headerText = firstSection ? extractHeaderFooterText(firstSection, 'header') : null;
    const footerText = firstSection ? extractHeaderFooterText(firstSection, 'footer') : null;

    const sections = Array.from(container.querySelectorAll('.docx-wrapper > section.docx'));
    const out = [];
    for (const [sIdx, section] of sections.entries()) {
      if (isCancelled?.()) throw new Error('cancelled');
      const article = section.querySelector('article');
      if (!article) continue;
      const children = Array.from(article.children);
      const nodes = [];
      const nodeHeights = [];
      for (const el of children) {
        let node;
        if (el.tagName === 'P') node = await parseParagraph(el);
        else if (el.tagName === 'TABLE') node = await parseTable(el);
        else continue;
        nodes.push(node);
        nodeHeights.push(el.getBoundingClientRect().height);
      }
      if (nodes.length === 0) continue;

      const articleStyle = article.getAttribute('style') || '';
      const colMatch = articleStyle.match(/column-count:\s*(\d+)/);
      let sectionNode;
      if (colMatch) {
        const colCount = parseInt(colMatch[1], 10);
        const groups = _splitBalanced(nodeHeights, colCount);
        const cols = groups.map(idxs => ({ stack: idxs.map(i => nodes[i]), width: '*' }));
        sectionNode = { columns: cols, columnGap: 12 };
      } else {
        sectionNode = { stack: nodes };
      }
      if (sIdx > 0) sectionNode.pageBreak = 'before';
      out.push(sectionNode);
    }

    const footnoteEls = Array.from(container.querySelectorAll('.docx-wrapper > section.docx > ol > li'));
    if (footnoteEls.length > 0) {
      out.push({ text: 'Footnotes', fontSize: 12, bold: true, margin: [0, 16, 0, 6] });
      footnoteEls.forEach((li, i) => {
        const text = li.textContent.trim();
        out.push({ text: `${i + 1}. ${text}`, fontSize: 9, margin: [0, 0, 0, 4] });
      });
    }

    return { content: out, headerText, footerText };
  } finally {
    container.remove();
  }
}

/**
 * Converts a .docx File into a PDF Blob, entirely client-side.
 * @param {File} file
 * @param {{ isCancelled?: () => boolean, onProgress?: (pct:number) => void }} [opts]
 * @returns {Promise<Blob>}
 */
export async function docxToPdf(file, { isCancelled, onProgress } = {}) {
  onProgress?.(10);
  const { content, headerText, footerText } = await _docxToPdfmakeContent(file, { isCancelled });
  if (isCancelled?.()) throw new Error('cancelled');
  onProgress?.(60);

  await loadPdfMake();
  if (isCancelled?.()) throw new Error('cancelled');
  onProgress?.(70);

  const docDefinition = {
    content,
    defaultStyle: { font: 'Roboto', fontSize: 11 },
    pageMargins: [72, headerText ? 50 : 72, 72, footerText ? 50 : 72],
    header: headerText ? { text: headerText, alignment: 'center', fontSize: 9, margin: [0, 20, 0, 0] } : undefined,
    footer: footerText ? { text: footerText, alignment: 'center', fontSize: 9, margin: [0, 0, 0, 20] } : undefined,
  };

  // pdfmake 0.3.x's BROWSER build: OutputDocumentBrowser#getBlob() is a
  // real `async` method returning Promise<Blob> directly — NOT the older
  // callback-style `getBlob(cb)` API shown in stale tutorials. Confirmed
  // by reading node_modules/pdfmake/js/browser-extensions/
  // OutputDocumentBrowser.js directly: the first attempt here passed a
  // callback (matching the Node-side OutputDocumentServer's different
  // API), which silently hung forever — getBlob() ignores an argument it
  // never declared, so the callback was just never called.
  const blob = await window.pdfMake.createPdf(docDefinition).getBlob();
  onProgress?.(95);
  return blob;
}
