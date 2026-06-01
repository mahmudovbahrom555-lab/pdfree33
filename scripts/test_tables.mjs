#!/usr/bin/env node
// ── scripts/test_tables.mjs ────────────────────────────────────────────────
// CLI test harness for the table detector.
// Runs _detectTables() on one or more real PDFs and prints results.
//
// Usage:
//   node scripts/test_tables.mjs file.pdf
//   node scripts/test_tables.mjs *.pdf
//   node scripts/test_tables.mjs --dir /path/to/pdfs/
//
// Output: per-page table summary + ASCII grid + confidence scores.
// Use this to tune MIN_ROWS, ALIGN_THRESHOLD, CONF_THRESHOLD in
// pdf2wordTables.js before integrating into the Word generator.
// ──────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync } from 'fs';
import { resolve, extname, basename, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── Re-implement detectTables inline so this script is self-contained ────────
// (Avoids ES-module/CommonJS headaches with pdf.js in Node.)
// Keep in sync with js/pdf2wordTables.js.

const MIN_ROWS        = 3;
const MIN_COLS        = 2;
const COL_TOLERANCE   = 25;
const ALIGN_THRESHOLD = 0.80;
const CONF_THRESHOLD  = 0.72;

function clusterColumns(items, tol) {
  const clusters = [];
  for (const item of [...items].sort((a, b) => a.x - b.x)) {
    let best = null, bestDist = Infinity;
    for (const c of clusters) {
      const d = Math.abs(c.center - item.x);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    if (best && bestDist <= tol) {
      best.sum += item.x; best.count++;
      best.center = best.sum / best.count;
    } else {
      clusters.push({ center: item.x, sum: item.x, count: 1 });
    }
  }
  return clusters.map(c => c.center).sort((a, b) => a - b);
}

function columnAlignScore(base, line, tol) {
  if (!line.length) return 0;
  let matched = 0;
  for (const lc of line) {
    if (base.some(bc => Math.abs(bc - lc) <= tol)) matched++;
  }
  return matched / Math.max(base.length, line.length);
}

function detectColumnBoundaries(lines, tol) {
  const allX = lines.flatMap(ln => ln.items.map(i => i.x));
  const centers = clusterColumns(allX.map(x => ({ x })), tol).sort((a, b) => a - b);
  return centers.map((center, idx) => ({
    center,
    left:  idx === 0                 ? -Infinity : (center + centers[idx - 1]) / 2,
    right: idx === centers.length - 1 ? Infinity  : (center + centers[idx + 1]) / 2,
  }));
}

function assignToCells(items, colBounds) {
  const cells = colBounds.map(() => []);
  for (const item of items) {
    let bestCol = 0, bestDist = Infinity;
    for (let c = 0; c < colBounds.length; c++) {
      const d = Math.abs(item.x - colBounds[c].center);
      if (d < bestDist) { bestDist = d; bestCol = c; }
    }
    cells[bestCol].push(item.str);
  }
  return cells.map(parts => parts.join(' ').trim());
}

function computeScores(rows, expectedCols) {
  if (!rows.length || !expectedCols) return { alignScore: 0, fillScore: 0, confidence: 0 };
  const minFilled = Math.ceil(expectedCols * 0.6);
  let alignedRows = 0, totalFill = 0;
  for (const row of rows) {
    const nonEmpty = row.filter(c => c.trim()).length;
    if (nonEmpty >= minFilled) alignedRows++;
    totalFill += nonEmpty / expectedCols;
  }
  const alignScore = alignedRows / rows.length;
  const fillScore  = totalFill  / rows.length;
  const rowBonus   = Math.min(rows.length / 10, 1) * 0.15;
  return { alignScore, fillScore, confidence: Math.min(alignScore * 0.55 + fillScore * 0.30 + rowBonus, 1) };
}

function detectTables(lines) {
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.items || line.items.length < MIN_COLS) { i++; continue; }
    const baseCols = clusterColumns(line.items, COL_TOLERANCE);
    if (baseCols.length < MIN_COLS) { i++; continue; }
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      if (!next.items || next.items.length === 0) break;
      const nextCols   = clusterColumns(next.items, COL_TOLERANCE);
      const alignScore = columnAlignScore(baseCols, nextCols, COL_TOLERANCE);
      if (alignScore >= ALIGN_THRESHOLD) j++;
      else break;
    }
    const rowCount = j - i;
    if (rowCount >= MIN_ROWS) {
      const tableLines = lines.slice(i, j);
      const colBounds  = detectColumnBoundaries(tableLines, COL_TOLERANCE);
      const rows       = tableLines.map(ln => assignToCells(ln.items, colBounds));
      const scores     = computeScores(rows, colBounds.length);
      if (scores.confidence >= CONF_THRESHOLD) {
        tables.push({ startIdx: i, endIdx: j - 1, rows, colCount: colBounds.length, ...scores });
      }
      i = j;
    } else {
      i++;
    }
  }
  return tables;
}

// ── PDF.js text extraction (Node.js compatible) ───────────────────────────────

async function extractLines(pdfPath) {
  let pdfjsLib;
  try {
    // pdfjs-dist v4+ is ESM-only — dynamic import required
    const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdfjsLib = mod;
  } catch {
    try {
      const mod = await import('pdfjs-dist/build/pdf.mjs');
      pdfjsLib = mod;
    } catch {
      console.error('pdf.js not found. Run: npm install --no-save pdfjs-dist');
      process.exit(1);
    }
  }

  // Point to the worker file so pdf.js can load it in Node.js
  const __dir = dirname(fileURLToPath(import.meta.url));
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    resolve(__dir, '../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs');

  const data     = readFileSync(pdfPath);
  const loadTask = pdfjsLib.getDocument({ data: new Uint8Array(data), verbosity: 0, disableWorker: true });
  const doc      = await loadTask.promise;
  const pageLines = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page    = await doc.getPage(p);
    const content = await page.getTextContent({ normalizeWhitespace: false });

    const items   = content.items
      .filter(item => 'str' in item && item.str.trim())
      .map(item => ({
        str:      item.str,
        x:        item.transform[4],
        y:        item.transform[5],
        fontSize: (item.height > 0 ? item.height : Math.abs(item.transform[3])) || 10,
      }));

    // Group into lines (same algorithm as pdf2wordUI.js)
    const YTOL  = 4;
    const lines = [];
    for (const item of [...items].sort((a, b) => b.y - a.y)) {
      let merged = false;
      for (const ln of lines) {
        if (Math.abs(ln.y - item.y) <= YTOL) { ln.items.push(item); merged = true; break; }
      }
      if (!merged) lines.push({ y: item.y, items: [item] });
    }
    lines.forEach(ln => ln.items.sort((a, b) => a.x - b.x));

    pageLines.push({ page: p, totalPages: doc.numPages, lines });
  }

  return pageLines;
}

// ── ASCII table renderer ──────────────────────────────────────────────────────

function renderASCII(table) {
  const CELL_MAX = 20;
  const widths = Array.from({ length: table.colCount }, (_, c) =>
    Math.min(Math.max(...table.rows.map(r => (r[c] || '').length), 4), CELL_MAX)
  );
  const divider = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
  const lines   = [divider];
  for (const row of table.rows) {
    const cells = row.map((cell, c) => {
      const s = (cell || '').slice(0, widths[c]);
      return ' ' + s.padEnd(widths[c]) + ' ';
    });
    lines.push('|' + cells.join('|') + '|');
  }
  lines.push(divider);
  return lines.join('\n');
}

// ── Summary stats ─────────────────────────────────────────────────────────────

function printSummary(results) {
  const pct = v => (v * 100).toFixed(0) + '%';
  console.log('\n' + '═'.repeat(72));
  console.log('SUMMARY');
  console.log('═'.repeat(72));

  let totalTables = 0, totalPages = 0;
  for (const { file, pages } of results) {
    const tablesInFile = pages.reduce((s, p) => s + p.tables.length, 0);
    const pagesWithTables = pages.filter(p => p.tables.length > 0).length;
    totalTables += tablesInFile;
    totalPages  += pages.length;
    console.log(
      `${basename(file).padEnd(35)}` +
      `${pages.length} pages  ` +
      `${pagesWithTables} pages with tables  ` +
      `${tablesInFile} tables`
    );
  }
  console.log('─'.repeat(72));
  console.log(
    `TOTAL: ${results.length} files  ${totalPages} pages  ${totalTables} tables detected`
  );
  console.log(
    `Thresholds: MIN_ROWS=${MIN_ROWS} MIN_COLS=${MIN_COLS} COL_TOL=${COL_TOLERANCE}px ` +
    `ALIGN≥${pct(ALIGN_THRESHOLD)} CONF≥${pct(CONF_THRESHOLD)}`
  );
  console.log('');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args  = process.argv.slice(2);
  const files = [];

  if (!args.length) {
    console.error('Usage: node scripts/test_tables.mjs file.pdf [file2.pdf ...] [--dir path/]');
    process.exit(1);
  }

  // Collect PDF paths
  let i = 0;
  while (i < args.length) {
    if (args[i] === '--dir' && args[i + 1]) {
      const dir = resolve(args[i + 1]);
      readdirSync(dir)
        .filter(f => extname(f).toLowerCase() === '.pdf')
        .forEach(f => files.push(resolve(dir, f)));
      i += 2;
    } else {
      files.push(resolve(args[i]));
      i++;
    }
  }

  if (!files.length) { console.error('No PDF files found.'); process.exit(1); }

  const results = [];

  for (const file of files) {
    console.log('\n' + '─'.repeat(72));
    console.log(`FILE: ${file}`);

    let pageLines;
    try {
      pageLines = await extractLines(file);
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      results.push({ file, pages: [] });
      continue;
    }

    const fileResult = { file, pages: [] };

    for (const { page, totalPages, lines } of pageLines) {
      const tables = detectTables(lines);
      fileResult.pages.push({ page, tables });

      if (!tables.length) {
        if (totalPages <= 5) {
          console.log(`  Page ${page}/${totalPages}: no tables`);
        }
        continue;
      }

      const pct = v => (v * 100).toFixed(0) + '%';
      console.log(`\n  Page ${page}/${totalPages}: ${tables.length} table(s)`);

      for (const [idx, t] of tables.entries()) {
        console.log(
          `    Table ${idx + 1}: lines ${t.startIdx}–${t.endIdx} | ` +
          `${t.rows.length} rows × ${t.colCount} cols | ` +
          `align=${pct(t.alignScore)} fill=${pct(t.fillScore)} conf=${pct(t.confidence)}`
        );
        // Print first 6 rows of ASCII grid (avoids huge output for large tables)
        const preview = { ...t, rows: t.rows.slice(0, 6) };
        const ascii   = renderASCII(preview)
          .split('\n').map(l => '      ' + l).join('\n');
        console.log(ascii);
        if (t.rows.length > 6) {
          console.log(`      … ${t.rows.length - 6} more rows`);
        }
      }
    }

    results.push(fileResult);
  }

  printSummary(results);
}

main().catch(err => { console.error(err); process.exit(1); });
