// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  eriScoreXlsx.js — structural editability checks for .xlsx (pure, no DOM UI)
//
//  Atlas's Word-side ERI (eriScore.js/eriChecks.js/eriAnatomy.js) is a port of
//  Atlas_DR's Python engine and reads word/document.xml — it cannot read a
//  spreadsheet at all (completely different OOXML schema: xl/worksheets/*.xml
//  + xl/sharedStrings.xml, no <w:tbl>/<w:p>). This is an ORIGINAL PDFree
//  module, not a port, built for the same reason and with the same
//  ground-truth-free philosophy as the Word ERI: a converter's own detector
//  can be confident and still be wrong (a resume's two-column layout can
//  look like a well-aligned table without being one) — so pdf2excel's
//  output is checked against its OWN produced .xlsx bytes, independently of
//  the detector's self-reported confidence (see pdf2wordTables.js's
//  tbl.confidence, which is a separate, earlier gate in processor.js).
//
//  Four checks, each scoped to what's actually verifiable without a
//  human-labeled corpus (mirrors why Word's port only carries 3 of Atlas's
//  5 channels — see eriChecks.js's header):
//    columnConsistency — real tables have a stable column count row to row;
//                         a mis-clustered "table" is often ragged.
//    columnDominance    — a "table" where only one column ever has content
//                         wasn't a table — it was single-column text
//                         mis-detected as a grid.
//    numericFidelity     — a cell whose text plainly looks like a number
//                         (e.g. "1,234.56") but was written as a string
//                         instead of a real numeric cell loses the one
//                         thing a spreadsheet is for: sums, sorting, charts.
//    proseVsData         — two unrelated prose lists placed side by side
//                         (e.g. a resume's Skills/Interests columns) can
//                         pass all three checks above and still not be a
//                         table — see checkProseVsData() below for the
//                         structural proxy this uses instead of language
//                         understanding.
//
//  Usage:
//    import { evaluateXlsxStructural } from './eriScoreXlsx.js';
//    const result = await evaluateXlsxStructural(arrayBuffer);
//    result.eri              // 0-100, averaged across scored sheets
//    result.sheets           // [{ name, eri, components, findings }, ...]
// ============================================================

import { loadJSZip } from './lazyLibs.js';

const NUMERIC_LOOKING = /^-?[$€£¥]?\s?\d{1,3}(,\d{3})*(\.\d+)?%?$/;

function round(v, decimals) {
  const m = 10 ** decimals;
  return Math.round(v * m) / m;
}

// ── Anatomy: parse xl/* parts into { sheets: [{ name, rows }] } ────────────
async function dissectXlsx(arrayBuffer) {
  await loadJSZip();
  const zip = await window.JSZip.loadAsync(arrayBuffer);
  const parser = new DOMParser();
  const readXml = async path => {
    const entry = zip.file(path);
    if (!entry) return null;
    return parser.parseFromString(await entry.async('string'), 'application/xml');
  };

  // Shared strings: each <si> may hold a single <t> or multiple <r><t> runs
  // (rich text) — concatenate all <t> descendants either way.
  const sharedStrings = [];
  const sstDoc = await readXml('xl/sharedStrings.xml');
  if (sstDoc) {
    for (const si of sstDoc.getElementsByTagName('si')) {
      let text = '';
      for (const t of si.getElementsByTagName('t')) text += t.textContent;
      sharedStrings.push(text);
    }
  }

  const wbDoc = await readXml('xl/workbook.xml');
  const relsDoc = await readXml('xl/_rels/workbook.xml.rels');
  if (!wbDoc || !relsDoc) return { sheets: [] };

  const ridToTarget = new Map();
  for (const rel of relsDoc.getElementsByTagName('Relationship')) {
    ridToTarget.set(rel.getAttribute('Id'), rel.getAttribute('Target'));
  }

  const sheetMetas = [];
  for (const sheetEl of wbDoc.getElementsByTagName('sheet')) {
    const name = sheetEl.getAttribute('name');
    const rid  = sheetEl.getAttribute('r:id');
    const target = ridToTarget.get(rid);
    if (target) sheetMetas.push({ name, path: `xl/${target.replace(/^\/?xl\//, '')}` });
  }

  const colLetterOf = ref => (ref.match(/^[A-Z]+/) || [''])[0];

  const sheets = [];
  for (const meta of sheetMetas) {
    const sheetDoc = await readXml(meta.path);
    if (!sheetDoc) { sheets.push({ name: meta.name, rows: [] }); continue; }

    const rows = [];
    for (const rowEl of sheetDoc.getElementsByTagName('row')) {
      const cells = [];
      for (const c of rowEl.getElementsByTagName('c')) {
        const ref  = c.getAttribute('r') || '';
        const type = c.getAttribute('t'); // null/undefined → numeric
        let text = '';
        if (type === 's') {
          const vEl = c.getElementsByTagName('v')[0];
          const idx = vEl ? parseInt(vEl.textContent, 10) : NaN;
          text = Number.isInteger(idx) ? (sharedStrings[idx] ?? '') : '';
        } else if (type === 'inlineStr') {
          const isEl = c.getElementsByTagName('is')[0];
          text = isEl ? isEl.textContent : '';
        } else {
          const vEl = c.getElementsByTagName('v')[0];
          text = vEl ? vEl.textContent : '';
        }
        if (text === '' && type !== 's' && type !== 'inlineStr' && type !== 'str') continue; // empty numeric cell
        cells.push({
          col: colLetterOf(ref),
          isTextType: type === 's' || type === 'inlineStr' || type === 'str',
          text,
        });
      }
      if (cells.length) rows.push({ cells });
    }
    sheets.push({ name: meta.name, rows });
  }

  return { sheets };
}

// ── Checks (operate on one sheet's rows) ───────────────────────────────────

function checkColumnConsistency(rows) {
  if (rows.length < 2) return { score: 1.0, findings: [] };
  const counts = rows.map(r => r.cells.length);
  const freq = new Map();
  for (const n of counts) freq.set(n, (freq.get(n) || 0) + 1);
  const mode = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const offCount = counts.filter(n => n !== mode).length;
  const ratio = offCount / rows.length;
  const score = Math.max(0, 1 - ratio * 1.2);
  const findings = ratio > 0.15
    ? [`${offCount} of ${rows.length} row(s) have a different cell count than the rest (mode=${mode}) — likely mis-clustered, not a real table`]
    : [];
  return { score, findings };
}

function checkColumnDominance(rows) {
  if (rows.length < 2) return { score: 1.0, findings: [] };
  const colsWithContent = new Set();
  let maxCols = 0;
  for (const r of rows) {
    maxCols = Math.max(maxCols, r.cells.length);
    for (const c of r.cells) if (c.text.trim()) colsWithContent.add(c.col);
  }
  if (maxCols <= 1) return { score: 1.0, findings: [] };
  if (colsWithContent.size <= 1) {
    return {
      score: 0.3,
      findings: [`only 1 of up to ${maxCols} columns ever has content — this looks like single-column text mis-detected as a table`],
    };
  }
  return { score: 1.0, findings: [] };
}

function checkNumericFidelity(rows) {
  let numericCells = 0;
  let numericLookingAsText = 0;
  for (const r of rows) {
    for (const c of r.cells) {
      const looksNumeric = NUMERIC_LOOKING.test(c.text.trim());
      if (!looksNumeric) continue;
      if (c.isTextType) numericLookingAsText++;
      else numericCells++;
    }
  }
  const total = numericCells + numericLookingAsText;
  if (total === 0) return { score: 1.0, findings: [] };
  const score = numericCells / total;
  const findings = numericLookingAsText > 0
    ? [`${numericLookingAsText} of ${total} number-looking cell(s) stored as text, not a real number — won't sum/sort/chart in Excel`]
    : [];
  return { score, findings };
}

// Two unrelated prose lists placed side by side (e.g. a resume's "Skills" /
// "Interests" columns) can be perfectly column-consistent, use every
// column, and contain no numbers — passing all three checks above even
// though the columns share no real relationship. This can't be proven
// without language understanding, but real tabular data (invoices, budgets,
// schedules, price lists — the vast majority of tables users actually
// convert) almost always has at least one short, numeric, or code-like
// column; free-running multi-word phrases in EVERY column, with no numeric
// anchor anywhere, is a structural proxy for "two lists", not a table.
function checkProseVsData(rows) {
  if (rows.length < 2) return { score: 1.0, findings: [] };
  // Skip the header row: headers are short in real AND fake tables alike
  // (e.g. "Skills" / "Interests" is 1 word each), so including it dilutes
  // the one place this signal is strong — the body rows.
  const body = rows.slice(1);
  if (!body.length) return { score: 1.0, findings: [] };
  let cellCount = 0;
  let wordCount = 0;
  let hasNumericAnchor = false;
  for (const r of body) {
    for (const c of r.cells) {
      const text = c.text.trim();
      if (!text) continue;
      cellCount++;
      wordCount += text.split(/\s+/).length;
      if (NUMERIC_LOOKING.test(text)) hasNumericAnchor = true;
    }
  }
  if (!cellCount) return { score: 1.0, findings: [] };
  const avgWords = wordCount / cellCount;
  if (!hasNumericAnchor && avgWords >= 2.0) {
    return {
      score: 0.1,
      findings: [`every column is multi-word prose (avg ${avgWords.toFixed(1)} words/cell) with no numeric or short-code column anywhere — looks like independent text lists placed side by side, not tabular data`],
    };
  }
  return { score: 1.0, findings: [] };
}

const CHECKS = [
  ['columnConsistency', checkColumnConsistency],
  ['columnDominance',   checkColumnDominance],
  ['numericFidelity',   checkNumericFidelity],
  ['proseVsData',       checkProseVsData],
];
// proseVsData carries the heaviest weight: when it fires it's a fairly
// confident, specific signal (see its own comment), and the other three
// checks are, by construction, near-perfect for exactly this failure mode
// (consistent columns, every column used, no numbers to mis-type) — so a
// lighter weight would let this exact false-positive class slip through
// the overall average even while proseVsData correctly flags it.
const DEFAULT_WEIGHTS = {
  columnConsistency: 0.25, columnDominance: 0.20, numericFidelity: 0.20, proseVsData: 0.35,
};

/**
 * evaluateXlsxStructural(arrayBuffer, { skipSheets, weights }?) -> {
 *   eri, sheets: [{ name, eri, components, findings }]
 * }
 *
 * skipSheets: sheet names to exclude from scoring (e.g. our own "Text"
 * fallback sheet, which is deliberately single-column and would otherwise
 * trip columnDominance for no reason).
 */
export async function evaluateXlsxStructural(arrayBuffer, { skipSheets = ['Text'], weights } = {}) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const { sheets } = await dissectXlsx(arrayBuffer);

  const scored = [];
  for (const sheet of sheets) {
    if (skipSheets.includes(sheet.name)) continue;
    const components = {};
    const findings = {};
    for (const [key, fn] of CHECKS) {
      const { score, findings: f } = fn(sheet.rows);
      components[key] = round(score, 3);
      findings[key] = f;
    }
    const eri = 100 * CHECKS.reduce((sum, [key]) => sum + w[key] * components[key], 0);
    scored.push({ name: sheet.name, eri: round(eri, 1), components, findings });
  }

  const eri = scored.length
    ? round(scored.reduce((sum, s) => sum + s.eri, 0) / scored.length, 1)
    : 100;

  return { eri, sheets: scored };
}
