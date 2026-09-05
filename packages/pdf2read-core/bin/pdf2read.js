#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

import { writeFile } from 'node:fs/promises';
import { pdfToReadingBlocks } from '../src/index.js';

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: pdf2read-core <input.pdf> [--out <output.txt>] [--json]

Reflows a PDF into structured reading blocks (headings, paragraphs, lists,
tables) using the same engine behind pdfree.io's Read PDF tool. Nothing is
uploaded — this runs entirely on your machine.

  --out <file>   Write output to a file instead of stdout.
  --json         Print the raw { pages, pageCount } structure instead of
                 the default plain-text reflow.

Examples:
  pdf2read-core report.pdf > report.txt
  pdf2read-core report.pdf --json > report.json
  pdf2read-core report.pdf --out report.txt`);
  process.exit(args.length === 0 ? 1 : 0);
}

const inputPath = args[0];
const outIdx     = args.indexOf('--out');
const outPath    = outIdx !== -1 ? args[outIdx + 1] : null;
const wantsJson  = args.includes('--json');

if (outIdx !== -1 && !outPath) {
  console.error('Error: --out requires a file path argument.');
  process.exit(1);
}

// Plain-text default output — a simple, human-readable reflow, not a
// faithful re-render of every formatting detail. Numbered list items already
// carry their own marker text ("1.", "2.5.1." — see js/pdf2readCore.js's own
// comment on why), so only bullet/lettered items get a synthesized "- "
// prefix here.
function _renderPlainText({ pages }) {
  const lines = [];
  for (const page of pages) {
    if (page.scanned) { lines.push('[scanned page — no extractable text]', ''); continue; }
    for (const block of page.blocks) {
      switch (block.type) {
        case 'heading':
          lines.push(block.text.toUpperCase(), '');
          break;
        case 'paragraph':
          lines.push(block.text, '');
          break;
        case 'list-item':
          lines.push((block.ordinal === 'number' ? '' : '- ') + block.text);
          break;
        case 'table':
          for (const row of block.rows) lines.push(row.map(c => c.text).join(' | '));
          lines.push('');
          break;
        case 'image':
          lines.push('[image]', '');
          break;
      }
    }
  }
  return lines.join('\n');
}

try {
  const result = await pdfToReadingBlocks(inputPath);
  const output = wantsJson ? JSON.stringify(result, null, 2) : _renderPlainText(result);
  if (outPath) {
    await writeFile(outPath, output, 'utf8');
    console.error(`Wrote ${outPath} (${output.length} bytes)`);
  } else {
    process.stdout.write(output + (wantsJson ? '\n' : ''));
  }
} catch (err) {
  console.error(`Error converting ${inputPath}: ${err.message}`);
  process.exit(1);
}
