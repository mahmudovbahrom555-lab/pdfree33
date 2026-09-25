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

// Roboto (pdfmake's default and only bundled font) covers Latin, Latin
// Extended, Cyrillic, and Greek — NOT CJK, Arabic, Hebrew, Thai, or most
// emoji. Rendering any of those with no fallback font registered maps them
// to .notdef glyphs: visible tofu boxes in the PDF, and literal NUL bytes
// on any later text-extraction of the output (confirmed via document-
// skeleton/stress testing, 2026-09-24) — the tool still reports success
// regardless, a silent, total loss of that content CLAUDE.md's own UX
// rules explicitly warn against ("never fail silently"). A real fix needs
// a bundled Unicode-coverage fallback font — a genuine bundle-size/
// engineering tradeoff deliberately left for deliberate daylight review,
// not decided unattended overnight. In the meantime, detect and warn
// instead of silently corrupting the output — see hasUnsupportedScript on
// walkDomToPdfContent()'s return value and _runDocx2Pdf's toast.
const _UNSUPPORTED_SCRIPT_RE =
  /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯؀-ۿݐ-ݿﭐ-﷿ﹰ-\uFEFF֐-׿฀-๿\u{1F000}-\u{1FAFF}☀-➿]/u;

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

// Real bug found via a live test conversion (not disclosed as a known
// limitation — a genuine regression to fix): Word's default bullet-list
// styles set the `::before` bullet glyph using a Private-Use-Area
// codepoint from the "Symbol" or "Wingdings" font (confirmed live via
// docx-preview's own computed style: U+F0B7 with font-family "Symbol" for
// a plain default bullet list) — a codepoint that only means anything
// inside THAT specific font's private mapping. docxToPdfCore.js emitted
// it as plain text with no font override, and pdfmake's default font has
// no glyph for a Symbol-font PUA codepoint at all, rendering a visible
// "missing glyph" tofu box instead of a bullet in every bulleted list.
// Map the handful of codepoints Word's built-in list styles actually use
// in practice to their real Unicode equivalents; anything else in the
// Private Use Area (any codepoint Word/a dingbat font could plausibly
// emit that isn't in this table) falls back to a plain bullet rather than
// a tofu box — always closer to correct than leaving it untranslated.
const SYMBOL_BULLET_MAP = {
  0xf0b7: '•', // Symbol "l" — the default Word bullet (•)
  0xf0a7: '▪', // Wingdings solid square (▪)
  0xf0d8: '▸', // Wingdings small right arrow (▸)
  0xf075: '○', // Wingdings open circle (○)
  0xf0fc: '✓', // Wingdings check mark (✓)
};
function _normalizeBulletPrefix(str) {
  return Array.from(str).map(ch => {
    const cp = ch.codePointAt(0);
    if (SYMBOL_BULLET_MAP[cp]) return SYMBOL_BULLET_MAP[cp];
    if (cp >= 0xe000 && cp <= 0xf8ff) return '•'; // any other PUA codepoint — safe fallback
    return ch;
  }).join('');
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
  if (!resp.ok) throw new Error(`Image fetch returned ${resp.status}`);
  const blob = await resp.blob();
  if (!blob.type || !blob.type.startsWith('image/')) {
    throw new Error(`Fetched resource is not an image (${blob.type || 'unknown type'})`);
  }
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

// A real password-protected .docx (Office's own "Encrypt with Password")
// and a legacy binary .doc file simply renamed to .docx are BOTH, at the
// byte level, an OLE2/CFBF compound file — not a zip at all (an ordinary
// .docx IS a zip). Office wraps the ENTIRE zip container in CFBF to
// encrypt it, and the old binary Office formats (.doc/.xls/.ppt) were
// always CFBF to begin with. Without this check, docx-preview's own
// JSZip.loadAsync() chokes on it with a raw, JSZip-internal error ("Can't
// find end of central directory : is this a zip file? ...") that links out
// to JSZip's own GitHub Pages docs — confusing for a user with a perfectly
// ordinary old .doc file ("is this a zip file?" means nothing to them),
// and actively misleading: the generic error toast's "tap to report"
// affordance implies a pdfree.io bug, when the file is just an unsupported
// format. Sniff the magic bytes up front (D0 CF 11 E0 A1 B1 1A E1, stable
// across every real CFBF file) and give one specific, correct diagnosis
// instead — found via a corpus-based fuzz sweep, not a specific user
// report (see docx2pdf.e2e.mjs for the regression coverage).
const OLE_CFBF_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
async function _rejectIfOleCfbf(file) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (OLE_CFBF_MAGIC.every((b, i) => head[i] === b)) {
    throw new Error('DOCX_LEGACY_OR_ENCRYPTED');
  }
}

/**
 * Renders a .docx File into a live DOM inside `container` (docx-preview).
 * Caller owns `container`'s creation/position/visibility/removal — this
 * function only populates it. Split out of what used to be one monolithic
 * "render+walk" function (see git history) specifically so an interactive
 * caller (Quick Edit PDF) can render into an ON-SCREEN container, let the
 * user edit the live DOM, and only THEN call walkDomToPdfContent() below —
 * docxToPdf()'s own off-screen container is just the non-interactive case
 * of the same contract.
 * @param {File|Blob} file
 * @param {HTMLElement} container
 * @param {{ isCancelled?: () => boolean }} [opts]
 */
export async function renderDocxToDom(file, container, { isCancelled } = {}) {
  await _rejectIfOleCfbf(file);
  await loadDocxPreview();

  try {
    // window.__pdfreeDocxPreview, not window.docx — see lazyLibs.js's
    // loadDocxPreview() header comment: docx@8.5.0 (the OTHER "docx"
    // library, used by pdf2word) and docx-preview@0.4.0 both export
    // themselves under the exact same window.docx name, and Quick Edit
    // PDF is the first caller to ever need both loaded in one session.
    await window.__pdfreeDocxPreview.renderAsync(file, container, null, { inWrapper: true });
  } catch {
    // Any renderAsync failure — corrupt/truncated zip, a missing
    // required part (e.g. word/document.xml absent from an otherwise
    // valid zip), or any other malformed-OOXML shape docx-preview's own
    // zip/XML walk doesn't expect — surfaces here as whatever raw
    // internal string that specific corruption happened to produce (a
    // real one found via fuzzing: "Cannot read properties of undefined
    // (reading 'body')", a bare property-access TypeError meaning
    // nothing to an actual user). Normalize ALL of these to one honest,
    // specific sentinel instead of leaking internals.
    throw new Error('DOCX_PARSE_FAILED');
  }
  if (isCancelled?.()) throw new Error('cancelled');
}

/**
 * Walks an already-rendered docx-preview DOM (see renderDocxToDom above)
 * into a pdfmake document-definition `content` array + header/footer text.
 * Does NOT touch `container`'s lifecycle (create/remove) — same
 * caller-owns-the-container contract as renderDocxToDom. Split out
 * specifically so Quick Edit PDF can run this against a user-EDITED DOM,
 * not just a pristine renderAsync() output — every selector below is
 * exactly what an editing UI must not disturb (see js/quickEditUI.js).
 * @param {HTMLElement} container
 * @param {{ isCancelled?: () => boolean }} [opts]
 */
export async function walkDomToPdfContent(container, { isCancelled } = {}) {
  {
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
        // _imgToDataUrl's fetch(img.src) can genuinely fail — a real user
        // report showed a bare "Failed to fetch" aborting the WHOLE
        // conversion (never root-caused to a specific reproducing file,
        // but this is a real, verifiable gap regardless: docx-preview can
        // in principle render an <img> pointing at a linked/external image
        // reference rather than an embedded one, and any network hiccup —
        // CORS, offline, a dead external host — would hit this exact path).
        // One unreachable image shouldn't sink the entire document any
        // more than one unplaceable form field does elsewhere in this
        // codebase (formFieldsWorker.js's own per-field try/catch) —
        // skip just this image, matching parseCell's own "nothing to show"
        // fallback below.
        try {
          const dataUrl = await _imgToDataUrl(img);
          const wrapper = img.closest('div');
          const wStyle = wrapper?.getAttribute('style') || '';
          const wMatch = wStyle.match(/width:\s*([\d.]+)pt/);
          const width = wMatch ? parseFloat(wMatch[1]) : 200;
          return { image: dataUrl, width, margin: [0, 0, 0, 8] };
        } catch {
          return { text: ' ' };
        }
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
          const cleaned = _normalizeBulletPrefix(beforeContent.replace(/^"|"$/g, '').replace(/\\9\s*/g, '').trim());
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

    // Real bug found via a real user's file: a naive "one <td> per column,
    // every row has the same count" walk (the previous version of this
    // function) breaks the instant a table has a merged cell — docx-preview
    // renders Word's gridSpan/vMerge as genuine HTML colspan/rowspan
    // attributes (real DOM+CSS, not a flattened image), and a row covered
    // by an earlier row's rowSpan, or a row containing a colSpan cell,
    // simply has FEWER real <td> elements than the table's true column
    // count — pdfmake then throws "Malformed table row, a cell is
    // undefined" the moment it hits a row shorter than its own widths
    // array. Walks the table as a real grid instead: a column already
    // "occupied" by an active rowSpan from a previous row gets pdfmake's
    // own documented placeholder ({} — see pdfmake's table docs, a colSpan/
    // rowSpan continuation cell must still be present in the array, just
    // empty) rather than being skipped, and a cell with colSpan>1 gets that
    // many placeholder columns inserted after it in its OWN row too.
    async function parseTable(table) {
      const rows = Array.from(table.querySelectorAll(':scope > tr'));
      const rowSpanCarry = []; // rowSpanCarry[col] = how many more rows a previous row's rowSpan still covers at this column
      const body = [];
      let colCount = 0;

      for (const tr of rows) {
        const tds = Array.from(tr.querySelectorAll(':scope > td'));
        const rowArr = [];
        let col = 0, tdIdx = 0;

        while (tdIdx < tds.length || rowSpanCarry[col] > 0) {
          if (rowSpanCarry[col] > 0) {
            rowArr[col] = {};
            rowSpanCarry[col]--;
            col++;
            continue;
          }
          const td = tds[tdIdx++];
          // Real bug found via overnight stress testing: for a row COVERED
          // by an earlier row's rowSpan (a vMerge continuation), docx-preview
          // does NOT omit that grid position from the row's own <td> list —
          // it renders a real, empty `<td style="...;display:none">` there
          // (confirmed via direct DOM inspection, both for a combined
          // colSpan+rowSpan merge and a rowSpan-only one). Skip it outright:
          // the rowSpanCarry placeholder(s) set below already account for
          // every column this phantom cell would otherwise re-claim: without
          // this skip, tdIdx would still consume it as if it were the NEXT
          // real cell, double-counting that grid space and shifting every
          // real cell after it one position to the right for the rest of the
          // row — which desyncs colSpan boundaries across rows (this row's
          // real content no longer lines up with the header row's), and
          // inflates colCount table-wide, causing pdfmake's own table layout
          // to silently drop columns from the point of misalignment onward
          // for the WHOLE table, not just the affected rows.
          const tdStyle = td.getAttribute('style') || '';
          if (/display:\s*none/.test(tdStyle)) continue;
          const colSpan = Math.max(1, parseInt(td.getAttribute('colspan') || '1', 10) || 1);
          const rowSpan = Math.max(1, parseInt(td.getAttribute('rowspan') || '1', 10) || 1);
          const cell = await parseCell(td);
          if (colSpan > 1) cell.colSpan = colSpan;
          if (rowSpan > 1) cell.rowSpan = rowSpan;
          rowArr[col] = cell;
          for (let k = 1; k < colSpan; k++) rowArr[col + k] = {};
          // Carry must cover EVERY column this cell's colSpan occupies, not
          // just its starting column — a rowSpan>1 cell with colSpan>1 also
          // needs continuation rows to treat ALL of its columns as carried
          // (paired with the display:none skip above), or the fall-through
          // path re-consumes the phantom cell as new content one column
          // short of where it should.
          if (rowSpan > 1) {
            for (let k = 0; k < colSpan; k++) {
              rowSpanCarry[col + k] = (rowSpanCarry[col + k] || 0) + (rowSpan - 1);
            }
          }
          col += colSpan;
        }

        colCount = Math.max(colCount, col);
        body.push(rowArr);
      }

      // pdfmake requires every row to have EXACTLY colCount entries — pad
      // any row a malformed/inconsistent source table left short (should
      // be rare after the grid walk above, but a real-world .docx can still
      // have a genuinely irregular table; this is the same "don't fail the
      // whole document over one row" spirit as the sanitizers elsewhere in
      // this codebase, not a silently-swallowed bug). colCount||1 matches
      // this function's own pre-existing fallback for a degenerate
      // (empty/rowless) table.
      colCount = colCount || 1;
      for (const rowArr of body) {
        for (let c = 0; c < colCount; c++) if (!rowArr[c]) rowArr[c] = {};
        rowArr.length = colCount;
      }

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

    // Scanned once over the whole rendered document rather than per-run —
    // simpler, and independent of exactly how parseParagraph/parseCell
    // happen to slice text into runs.
    const hasUnsupportedScript = _UNSUPPORTED_SCRIPT_RE.test(container.textContent);

    return { content: out, headerText, footerText, hasUnsupportedScript };
  }
}

/**
 * Converts pdfmake `content` (see walkDomToPdfContent above) into a final
 * PDF Blob. Split out so Quick Edit PDF can call this same tail-end step
 * after its own edited-DOM walk, without duplicating the pdfmake wiring.
 * @param {{ content: object[], headerText: string|null, footerText: string|null }} parsed
 * @param {{ isCancelled?: () => boolean, onProgress?: (pct:number) => void }} [opts]
 * @returns {Promise<Blob>}
 */
export async function pdfContentToBlob({ content, headerText, footerText }, { isCancelled, onProgress } = {}) {
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

/**
 * Converts a .docx File into a PDF Blob, entirely client-side. Thin
 * composition of renderDocxToDom + walkDomToPdfContent + pdfContentToBlob
 * (all above) using an off-screen, non-interactive container — the
 * non-interactive special case of the same pipeline Quick Edit PDF drives
 * interactively. Owns the container's full lifecycle (create + remove),
 * unlike the three functions above which only operate on a container the
 * caller supplies.
 * @param {File} file
 * @param {{ isCancelled?: () => boolean, onProgress?: (pct:number) => void }} [opts]
 * @returns {Promise<{ blob: Blob, hasUnsupportedScript: boolean }>}
 */
export async function docxToPdf(file, { isCancelled, onProgress } = {}) {
  onProgress?.(10);

  // Off-screen, not display:none — display:none elements don't get real
  // layout at all, which would make every getBoundingClientRect() used
  // for column-balancing in walkDomToPdfContent() return zero height.
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute; top:-99999px; left:-99999px; width:800px;';
  document.body.appendChild(container);

  try {
    await renderDocxToDom(file, container, { isCancelled });
    const parsed = await walkDomToPdfContent(container, { isCancelled });
    if (isCancelled?.()) throw new Error('cancelled');
    onProgress?.(60);
    const blob = await pdfContentToBlob(parsed, { isCancelled, onProgress });
    return { blob, hasUnsupportedScript: parsed.hasUnsupportedScript };
  } finally {
    container.remove();
  }
}
