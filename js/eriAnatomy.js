// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  eriAnatomy.js — DOCX structural dissection (pure, no DOM UI)
//
//  JavaScript port of Atlas_DR's eri_core/anatomy.py `dissect()`,
//  synced through Atlas_DR v0.2.2 (NFC text normalization + gridSpan-aware
//  Tbl.regular — see ownParagraphText()/_rowEffectiveWidth() below). Not
//  ported: has_numpr/effective_number (v0.2.1's native-list-renumbering
//  machinery) — only feeds check_lists(), a profile/ground-truth-only
//  check that doesn't apply to an arbitrary user's document; see
//  eriChecks.js's header for why only 3 of Atlas's channels are ported.
//  Reads word/document.xml directly (JSZip + DOMParser) rather than
//  a docx-parsing library, because python-docx-style libraries don't
//  see text boxes either — and text boxes are exactly what matters
//  most here (a converter that traps body text in a fixed-position
//  frame instead of a normal paragraph).
//
//  This module, eriChecks.js, and eriScore.js are checked for parity
//  against Atlas_DR's Python implementation via corpus fixtures in
//  tests/eriScore.test.js — see that file before changing any of the
//  three. This is the current production implementation for browser
//  integration; if maintaining parallel Python/JS implementations
//  becomes costly as Atlas grows, consolidating on one shared core
//  (e.g. via WebAssembly) is the direction to evaluate then.
//
//  Gotcha #1 (matches anatomy.py): mc:Fallback duplicates mc:Choice's
//  content (LibreOffice writes every text box twice) — skip anything
//  with an mc:Fallback ancestor.
//  Gotcha #2 (matches anatomy.py): w:framePr — a paragraph pinned to
//  fixed coordinates (a favorite trick of Word's built-in importers) —
//  treated as just as "trapped" as a text box.
// ============================================================

import { loadJSZip } from './lazyLibs.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

function isEl(node) {
  return node && node.nodeType === 1;
}

function isTag(node, ns, localName) {
  return isEl(node) && node.namespaceURI === ns && node.localName === localName;
}

function hasAncestor(el, ns, localName) {
  let p = el.parentNode;
  while (p) {
    if (isTag(p, ns, localName)) return true;
    p = p.parentNode;
  }
  return false;
}

function nearestParagraphAncestor(el) {
  let p = el.parentNode;
  while (p) {
    if (isTag(p, W_NS, 'p')) return p;
    p = p.parentNode;
  }
  return null;
}

function directChild(el, ns, localName) {
  for (const child of el.childNodes) {
    if (isTag(child, ns, localName)) return child;
  }
  return null;
}

function directChildren(el, ns, localName) {
  const out = [];
  for (const child of el.childNodes) {
    if (isTag(child, ns, localName)) out.push(child);
  }
  return out;
}

function ownParagraphText(p) {
  // Only this paragraph's own <w:t> descendants: a nested paragraph
  // (a text box's internal <w:p>, itself reachable as a descendant of
  // an anchoring paragraph) must not have its text double-counted here.
  let text = '';
  for (const t of p.getElementsByTagNameNS(W_NS, 't')) {
    if (nearestParagraphAncestor(t) === p) text += t.textContent || '';
  }
  // NFC normalize (matches anatomy.py v0.2.2): a converter reading a
  // decomposed-Unicode source PDF (combining marks — common for Vietnamese
  // and other diacritic-heavy scripts) can pass NFD straight through into
  // <w:t> — confirmed directly on pdf2docx. Normalizing once here, at the
  // single point all downstream text flows through, keeps char counts
  // (bodyChars/tblChars/textboxChars) and any future marker-matching
  // consistent regardless of which form the source used.
  return text.normalize('NFC');
}

// gridSpan-aware effective row width, per anatomy.py's Tbl.regular: a table
// whose rows disagree once merged cells (gridSpan) are accounted for needs
// surgery, not a keystroke, to insert a plain row — a real editability cost
// checkTablesStruct penalizes that the raw <w:tc> count (nCols/nRows above,
// intentionally left untouched — see anatomy.py's comment on why gridSpan
// must never feed into the dimension-match numbers) can't see.
function _rowEffectiveWidth(tr) {
  let width = 0;
  for (const tc of directChildren(tr, W_NS, 'tc')) {
    const tcPr = directChild(tc, W_NS, 'tcPr');
    const gridSpan = tcPr && directChild(tcPr, W_NS, 'gridSpan');
    const span = gridSpan ? parseInt(gridSpan.getAttributeNS(W_NS, 'val'), 10) : 1;
    width += Number.isFinite(span) ? span : 1;
  }
  return width;
}

/**
 * dissect(arrayBuffer) -> Anatomy
 *
 * Anatomy shape: { paras: Para[], tables: Tbl[], fullText, bodyChars,
 *                  tblChars, textboxChars, parseError }
 * Para shape:    { text, inTextbox, inTable, hasNumPr, brCount }
 * Tbl shape:     { rows, cols, inTextbox, chars, regular }
 */
export async function dissect(arrayBuffer) {
  const a = {
    paras: [], tables: [], fullText: '',
    bodyChars: 0, tblChars: 0, textboxChars: 0, parseError: '',
  };
  let xmlText;
  try {
    await loadJSZip();
    const zip = await window.JSZip.loadAsync(arrayBuffer);
    const entry = zip.file('word/document.xml');
    if (!entry) throw new Error('word/document.xml not found in archive');
    xmlText = await entry.async('string');
  } catch (e) {
    a.parseError = `${e.name || 'Error'}: ${e.message}`;
    return a;
  }

  let root;
  try {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const parseErrorEl = doc.getElementsByTagName('parsererror')[0];
    if (parseErrorEl) throw new Error(parseErrorEl.textContent.slice(0, 200));
    root = doc.documentElement;
  } catch (e) {
    a.parseError = `${e.name || 'Error'}: ${e.message}`;
    return a;
  }

  const chunks = [];

  for (const p of root.getElementsByTagNameNS(W_NS, 'p')) {
    if (hasAncestor(p, MC_NS, 'Fallback')) continue;
    const inTb = hasAncestor(p, W_NS, 'txbxContent');
    const pPr = directChild(p, W_NS, 'pPr');
    const inFrame = !!(pPr && directChild(pPr, W_NS, 'framePr'));
    const inTbl = hasAncestor(p, W_NS, 'tc');
    const text = ownParagraphText(p);
    const hasNumPr = !!(pPr && directChild(pPr, W_NS, 'numPr'));
    const brCount = p.getElementsByTagNameNS(W_NS, 'br').length;
    a.paras.push({ text, inTextbox: inTb || inFrame, inTable: inTbl, hasNumPr, brCount });
    if (text) {
      chunks.push(text);
      if (inTb || inFrame) a.textboxChars += text.length;
      else if (inTbl) a.tblChars += text.length;
      else a.bodyChars += text.length;
    }
  }

  for (const tbl of root.getElementsByTagNameNS(W_NS, 'tbl')) {
    if (hasAncestor(tbl, MC_NS, 'Fallback')) continue;
    const trs = directChildren(tbl, W_NS, 'tr');
    const nRows = trs.length;
    const nCols = trs.length ? Math.max(...trs.map((tr) => directChildren(tr, W_NS, 'tc').length)) : 0;
    // regular: a SEPARATE signal from nCols above — never feed gridSpan into
    // the raw <w:tc> count, or dimension-matching against a profile's
    // expected cols/rows would silently drift (matches anatomy.py's comment).
    const rowWidths = trs.map(_rowEffectiveWidth);
    const regular = new Set(rowWidths).size <= 1;
    const inTb = hasAncestor(tbl, W_NS, 'txbxContent');
    let chars = 0;
    for (const t of tbl.getElementsByTagNameNS(W_NS, 't')) chars += (t.textContent || '').length;
    a.tables.push({ rows: nRows, cols: nCols, inTextbox: inTb, chars, regular });
  }

  a.fullText = chunks.join('\n');
  return a;
}
