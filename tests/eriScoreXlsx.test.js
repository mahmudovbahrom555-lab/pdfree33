// tests/eriScoreXlsx.test.js — regression tests for js/eriScoreXlsx.js
//
// Unlike eriScore.test.js (which pins values against Atlas_DR's Python
// implementation), eriScoreXlsx.js is original PDFree code with no external
// reference — there is nothing else to cross-check against. These fixtures
// are synthetic minimal .xlsx files built in-process (via buildXlsx() below)
// so each test isolates exactly one structural signal, and the expected
// values are pinned against this file's own reviewed-correct output — the
// goal is catching silent drift (e.g. a weight/threshold change that quietly
// stops flagging a real defect), not validating the design itself.
//
// Run: node tests/eriScoreXlsx.test.js

import JSZip from 'jszip';
import { DOMParser as XmldomParser } from '@xmldom/xmldom';

global.window = { JSZip };
global.DOMParser = XmldomParser;

const { evaluateXlsxStructural } = await import('../js/eriScoreXlsx.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Builds a minimal .xlsx ArrayBuffer from a plain description — only the
// parts js/eriScoreXlsx.js's dissectXlsx() actually reads (no styles.xml,
// no [Content_Types].xml — this is a unit fixture, not a real Excel file).
//
// sheets: [{ name, rows: [ [ {text, shared?} | string, ... ], ... ] }]
//   A plain string cell is numeric (t absent). { text, shared: true } is a
//   shared-string cell (t="s") — use this for anything that should render
//   as text even if it looks like a number, and for all prose content.
async function buildXlsx(sheets) {
  const zip = new JSZip();
  const sst = [];
  const sstIndex = new Map();
  const sstIdx = text => {
    if (sstIndex.has(text)) return sstIndex.get(text);
    const idx = sst.length;
    sst.push(text);
    sstIndex.set(text, idx);
    return idx;
  };

  sheets.forEach((sheet, si) => {
    const rowsXml = sheet.rows.map((row, ri) => {
      const cellsXml = row.map((cell, ci) => {
        const col = String.fromCharCode(65 + ci);
        const ref = `${col}${ri + 1}`;
        if (typeof cell === 'object' && cell.shared) {
          return `<c r="${ref}" t="s"><v>${sstIdx(cell.text)}</v></c>`;
        }
        const text = typeof cell === 'object' ? cell.text : cell;
        return `<c r="${ref}"><v>${esc(text)}</v></c>`;
      }).join('');
      return `<row r="${ri + 1}">${cellsXml}</row>`;
    }).join('');
    zip.file(`xl/worksheets/sheet${si + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetData>${rowsXml}</sheetData></worksheet>`);
  });

  const sheetEntries = sheets.map((s, i) =>
    `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  zip.file('xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${sheetEntries}</sheets></workbook>`);

  const relEntries = sheets.map((s, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  ).join('');
  zip.file('xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relEntries}</Relationships>`);

  zip.file('xl/sharedStrings.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">` +
    sst.map(s => `<si><t>${esc(s)}</t></si>`).join('') + `</sst>`);

  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const S = text => ({ text, shared: true });

console.log('eriScoreXlsx.js — mechanism checks (one signal per fixture)');

await testAsync('real table (headers + numeric data) scores 100, no findings', async () => {
  const buf = await buildXlsx([{
    name: 'Table 1',
    rows: [
      [S('Department'), S('Q1 Budget'), S('Q1 Actual')],
      [S('Engineering'), '150000', '148200'],
      [S('Marketing'), '80000', '91500'],
      [S('Operations'), '60000', '58750'],
    ],
  }]);
  const r = await evaluateXlsxStructural(buf);
  const sheet = r.sheets[0];
  if (sheet.eri !== 100) throw new Error(`expected eri 100, got ${sheet.eri}`);
  for (const key of ['columnConsistency', 'columnDominance', 'numericFidelity', 'proseVsData']) {
    if (sheet.components[key] !== 1) throw new Error(`expected ${key} === 1, got ${sheet.components[key]}`);
  }
});

await testAsync('two unrelated prose columns (Skills/Interests) trip proseVsData and fail the retry threshold', async () => {
  const buf = await buildXlsx([{
    name: 'Table 1',
    rows: [
      [S('Skills'), S('Interests')],
      [S('Python programming'), S('Hiking on weekends')],
      [S('Data analysis'), S('Chess tournaments')],
      [S('Team leadership'), S('Home gardening')],
      [S('Public speaking'), S('Amateur photography')],
    ],
  }]);
  const r = await evaluateXlsxStructural(buf);
  const sheet = r.sheets[0];
  // This is the exact regression this check exists for: the OTHER three
  // checks must stay clean (this really is a consistent, fully-used,
  // non-numeric grid) — only proseVsData should catch it.
  if (sheet.components.columnConsistency !== 1) throw new Error('expected columnConsistency === 1 (columns ARE consistent)');
  if (sheet.components.columnDominance !== 1) throw new Error('expected columnDominance === 1 (both columns ARE used)');
  if (sheet.components.numericFidelity !== 1) throw new Error('expected numericFidelity === 1 (no numbers to mis-type)');
  if (sheet.components.proseVsData >= 0.5) {
    throw new Error(`expected proseVsData to fire (< 0.5), got ${sheet.components.proseVsData}`);
  }
  if (!sheet.findings.proseVsData.some(f => f.includes('independent text lists'))) {
    throw new Error('expected a proseVsData finding, got: ' + JSON.stringify(sheet.findings.proseVsData));
  }
  // _P2E_ERI_THRESHOLD in processor.js is 70 — this is the actual production
  // gate this fixture must clear to prove the demotion really fires.
  if (sheet.eri >= 70) throw new Error(`expected eri < 70 (processor.js's demotion threshold), got ${sheet.eri}`);
});

await testAsync('numbers stored as text tank numericFidelity but nothing else', async () => {
  const buf = await buildXlsx([{
    name: 'Table 1',
    rows: [
      [S('Item'), S('Price')],
      [S('Widget'), S('19.99')],
      [S('Gadget'), S('29.99')],
      [S('Gizmo'), S('39.99')],
    ],
  }]);
  const r = await evaluateXlsxStructural(buf);
  const sheet = r.sheets[0];
  if (sheet.components.numericFidelity !== 0) {
    throw new Error(`expected numericFidelity === 0 (all 3 prices stored as text), got ${sheet.components.numericFidelity}`);
  }
  if (!sheet.findings.numericFidelity.some(f => f.includes("won't sum/sort/chart"))) {
    throw new Error('expected a numericFidelity finding, got: ' + JSON.stringify(sheet.findings.numericFidelity));
  }
  if (sheet.components.columnConsistency !== 1 || sheet.components.columnDominance !== 1) {
    throw new Error('expected the other structural checks to stay clean');
  }
});

await testAsync('ragged row lengths penalize columnConsistency', async () => {
  const buf = await buildXlsx([{
    name: 'Table 1',
    rows: [
      ['A', 'B', 'C'],
      ['1', '2', '3'],
      ['4', '5'],
      ['6', '7', '8', '9'],
    ],
  }]);
  const r = await evaluateXlsxStructural(buf);
  const sheet = r.sheets[0];
  if (sheet.components.columnConsistency >= 0.6) {
    throw new Error(`expected columnConsistency to drop (2 of 4 rows off-mode), got ${sheet.components.columnConsistency}`);
  }
  if (!sheet.findings.columnConsistency.some(f => f.includes('mis-clustered'))) {
    throw new Error('expected a columnConsistency finding, got: ' + JSON.stringify(sheet.findings.columnConsistency));
  }
});

await testAsync('a column that never has content trips columnDominance', async () => {
  const buf = await buildXlsx([{
    name: 'Table 1',
    rows: [
      [S('Header'), S('')],
      [S('Only A has data 1'), S('')],
      [S('Only A has data 2'), S('')],
      [S('Only A has data 3'), S('')],
    ],
  }]);
  const r = await evaluateXlsxStructural(buf);
  const sheet = r.sheets[0];
  if (sheet.components.columnDominance !== 0.3) {
    throw new Error(`expected columnDominance === 0.3 (col B never has content), got ${sheet.components.columnDominance}`);
  }
  if (!sheet.findings.columnDominance.some(f => f.includes('single-column text'))) {
    throw new Error('expected a columnDominance finding, got: ' + JSON.stringify(sheet.findings.columnDominance));
  }
});

await testAsync('a sheet named "Text" is skipped entirely, even if it would otherwise fail', async () => {
  const buf = await buildXlsx([
    {
      name: 'Table 1',
      rows: [
        [S('Department'), S('Q1 Budget')],
        [S('Engineering'), '150000'],
        [S('Marketing'), '80000'],
      ],
    },
    {
      name: 'Text',
      rows: [[S('some')], [S('unrelated')], [S('single-column')], [S('lines')]],
    },
  ]);
  const r = await evaluateXlsxStructural(buf);
  if (r.sheets.length !== 1 || r.sheets[0].name !== 'Table 1') {
    throw new Error(`expected only "Table 1" to be scored, got: ${JSON.stringify(r.sheets.map(s => s.name))}`);
  }
});

await testAsync('single-row sheets (no body rows) are trivially clean — nothing to compare against', async () => {
  const buf = await buildXlsx([{ name: 'Table 1', rows: [[S('Prepared by'), S('Date'), S('Page')]] }]);
  const r = await evaluateXlsxStructural(buf);
  if (r.sheets[0].eri !== 100) throw new Error(`expected eri 100 for a single row, got ${r.sheets[0].eri}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
