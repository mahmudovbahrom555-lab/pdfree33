// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Scores PDF→Excel against tests/corpus/groundtruth/tables/ — invoices rendered
// from known cells (make_tables.mjs), so every cell's true text, place and value
// is exact. Runs the real tool page (file input, Convert, the downloaded .xlsx),
// or scores another converter's .xlsx files (--from-dir). Per document:
//   cells    share of the true table's non-empty cells found at their place in
//            the best-matching sheet (best row/column offset; a numeric cell
//            matches by value, so "1,450.00" stored as the number 1450 counts)
//   numbers  share of the true numeric cells stored as numbers with the right
//            value — what lets the user sum a column
//   order    the sheet's column order: "logical" (the table's first column, the
//            rightmost in RTL, is column A) or "visual" (left to right as drawn)
//   sheetRTL the sheet is set right-to-left (column A on the right)
//   looks    the sheet looks like the PDF when opened: logical order on a
//            right-to-left sheet, or visual order on a left-to-right one (for an
//            LTR table: logical, left-to-right). Anything else shows it mirrored.
//   words    share of the true words (all cells, title, note) anywhere in the file —
//            tokens with letters only: a number's text depends on how it is stored
//   pf       Arabic presentation forms left in the cells (see gtCommon.mjs)
//
// Usage: node scripts/corpus-diff/groundtruth-tables.mjs [base-url] [--json out.json]
//        node scripts/corpus-diff/groundtruth-tables.mjs --from-dir <dir> [--json out.json]
//   base-url defaults to http://localhost:8934 (python3 -m http.server 8934 --directory dist)

import { chromium } from 'playwright';
import JSZip from 'jszip';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRESENTATION_FORM, convertOnToolPage, tokens } from './gtCommon.mjs';

const args = process.argv.slice(2);
const base = (args.find(a => /^https?:/.test(a)) || 'http://localhost:8934').replace(/\/$/, '');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const fromDir = args.includes('--from-dir') ? args[args.indexOf('--from-dir') + 1] : null;
const DIR = new URL('../../tests/corpus/groundtruth/tables/', import.meta.url);
const PDF2EXCEL = { slug: 'pdf-to-excel', panel: '#pdf2excelOptions', ready: /page/, mime: /spreadsheetml/ };

const xmlText = x => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
const colIndex = ref => [...ref.match(/^[A-Z]+/)[0]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

// .xlsx → sheets: { name, rtl, grid[r][c] = { text, num } }
async function xlsxSheets(buf) {
  const zip = await JSZip.loadAsync(buf);
  const read = async p => (zip.file(p) ? zip.file(p).async('string') : '');
  const shared = ((await read('xl/sharedStrings.xml')).match(/<si>[\s\S]*?<\/si>/g) || [])
    .map(si => (si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map(t => xmlText(t.replace(/<[^>]+>/g, ''))).join(''));
  const rels = await read('xl/_rels/workbook.xml.rels');
  const sheets = [];
  for (const [, name, rid] of (await read('xl/workbook.xml')).matchAll(/<sheet [^>]*?name="([^"]*)"[^>]*?r:id="([^"]+)"/g)) {
    const target = rels.match(new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`))?.[1]
      || rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${rid}"`))?.[1];
    const xml = await read(`xl/${target.replace(/^\/?xl\//, '')}`);
    const grid = [];
    for (const [, row] of xml.matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)) {
      for (const [, attrs, body] of row.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attrs.match(/r="([A-Z]+)(\d+)"/);
        if (!ref || !body) continue;
        const type = attrs.match(/t="(\w+)"/)?.[1] || 'n';
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const text = type === 's' ? shared[+v] : type === 'inlineStr'
          ? (body.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map(t => xmlText(t.replace(/<[^>]+>/g, ''))).join('')
          : xmlText(v ?? '');
        const r = +ref[2] - 1, c = colIndex(ref[1]);
        (grid[r] ||= [])[c] = { text, num: type === 'n' && v !== undefined ? Number(v) : null };
      }
    }
    sheets.push({ name: xmlText(name), rtl: /<sheetView [^>]*rightToLeft="(1|true)"/.test(xml), grid });
  }
  return sheets;
}

// Cell text compared after NFKC, any digit set → ASCII, ٬/٫ → ,/. , marks and
// tatweel dropped, whitespace collapsed.
const DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;
const norm = s => String(s ?? '').normalize('NFKC')
  .replace(DIGITS, d => String((d.charCodeAt(0) & 0xF) % 10)).replace(/\u066C/g, ',').replace(/\u066B/g, '.')
  .replace(/[\p{Mn}\u0640\u200C\u200E\u200F]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
const DATE_RE = /^\d{4}[/-]\d{2}[/-]\d{2}$/;
// Excel serial date → yyyy/mm/dd (a converter may store a date as a date)
const serialDate = n => new Date(Date.UTC(1899, 11, 30) + n * 864e5).toISOString().slice(0, 10).replace(/-/g, '/');

function cellMatches(truthText, value, out) {
  if (!out) return false;
  if (norm(out.text) === norm(truthText)) return true;
  if (value !== null && out.num !== null && Math.abs(out.num - value) < 0.005) return true;
  const t = norm(truthText).replace(/-/g, '/');
  return DATE_RE.test(t) && out.num !== null && out.num > 20000 && out.num < 80000 && serialDate(out.num) === t;
}

// Best placement of the true table in one sheet: column order × row/column offset.
function place(truth, sheet) {
  // Array.from: an empty row is a hole in the sparse grid, and a hole spread into Math.max is NaN
  const width = Math.max(0, ...Array.from(sheet.grid, r => (r ? r.length : 0)));
  let best = { hits: 0, numbers: 0, order: 'logical' };
  for (const order of ['logical', 'visual']) {
    // visual = the drawn left-to-right order; for RTL that is the logical order reversed
    const at = (r, c) => sheet.grid[r]?.[order === 'logical' ? c : width - 1 - c];
    for (let dr = 0; dr < sheet.grid.length; dr++) {
      for (let dc = 0; dc < Math.max(width, 1); dc++) {
        let hits = 0, numbers = 0;
        truth.rows.forEach((row, r) => row.forEach((text, c) => {
          if (!text) return;
          const out = at(r + dr, c + dc), value = truth.values[r][c];
          if (cellMatches(text, value, out)) hits++;
          if (value !== null && out?.num !== null && out?.num !== undefined && Math.abs(out.num - value) < 0.005) numbers++;
        }));
        if (hits > best.hits) best = { hits, numbers, order };
      }
    }
  }
  return best;
}

function score(truth, sheets) {
  const cells = truth.rows.flat().filter(Boolean).length;
  const numeric = truth.values.flat().filter(v => v !== null).length;
  let best = { hits: 0, numbers: 0, order: '-', sheet: null };
  for (const sheet of sheets) {
    const p = place(truth, sheet);
    if (p.hits > best.hits) best = { ...p, sheet };
  }
  const rtlDoc = truth.dir === 'rtl';
  const sheetRTL = !!best.sheet?.rtl;
  const looks = best.sheet ? (rtlDoc
    ? (best.order === 'logical') === sheetRTL
    : best.order === 'logical' && !sheetRTL) : false;
  const all = sheets.flatMap(s => s.grid.flatMap(r => (r || []).map(c => c?.text || ''))).join(' ');
  const bag = new Map();
  const words = text => tokens(norm(text)).filter(t => /\p{L}/u.test(t));
  for (const t of words(all)) bag.set(t, (bag.get(t) || 0) + 1);
  const truthToks = words([...truth.rows.flat(), truth.title, truth.note].join(' '));
  let hit = 0;
  for (const t of truthToks) if (bag.get(t) > 0) { hit++; bag.set(t, bag.get(t) - 1); }
  return {
    cells: best.hits / cells, numbers: best.numbers / numeric, order: best.order, sheetRTL, looks,
    words: hit / truthToks.length,
    pf: (all.match(PRESENTATION_FORM) || []).length / Math.max((all.match(/\p{L}/gu) || []).length, 1),
    sheets: sheets.length,
  };
}

const docs = readdirSync(DIR).filter(f => f.endsWith('.json')).sort()
  .map(f => ({ name: f.replace(/\.json$/, ''), truth: JSON.parse(readFileSync(new URL(f, DIR), 'utf8')) }));

const browser = fromDir ? null : await chromium.launch();
const rows = [];
let skipped = 0;
for (const { name, truth } of docs) {
  let buf;
  if (fromDir) {
    const file = `${fromDir.replace(/\/$/, '')}/${name}.xlsx`;
    if (!existsSync(file)) { skipped++; continue; }
    buf = readFileSync(file);
  } else {
    buf = Buffer.from(await convertOnToolPage(browser, base, PDF2EXCEL, fileURLToPath(new URL(`${name}.pdf`, DIR))), 'base64');
  }
  rows.push({ name, lang: truth.lang, layout: truth.layout, digits: truth.digits, ...score(truth, await xlsxSheets(buf)) });
}
await browser?.close();

const pct = v => (v * 100).toFixed(0).padStart(4);
console.log(`table ground truth — ${fromDir ? `xlsx files in ${fromDir}` : `pdf2excel on ${base}`}`);
console.log('document              cells numbers  order    sheetRTL looks  words    pf sheets');
for (const r of rows) {
  console.log(`${r.name.padEnd(20)} ${pct(r.cells)}% ${pct(r.numbers)}%   ${r.order.padEnd(8)} ${String(r.sheetRTL).padEnd(8)} ${(r.looks ? 'yes' : 'NO').padEnd(5)} ${pct(r.words)}% ${pct(r.pf)}% ${String(r.sheets).padStart(5)}`);
}
if (skipped) console.log(`\n${skipped} document(s) skipped — no .xlsx in ${fromDir}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
