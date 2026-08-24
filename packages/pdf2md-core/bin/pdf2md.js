#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

import { writeFile } from 'node:fs/promises';
import { pdfToMarkdown } from '../src/index.js';

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: pdf2md-core <input.pdf> [--out <output.md>]

Converts a PDF to Markdown using the same extraction engine behind
pdfree.io's PDF-to-Markdown tool. Nothing is uploaded — this runs
entirely on your machine.

  --out <file>   Write Markdown to a file instead of stdout.

Examples:
  pdf2md-core report.pdf > report.md
  pdf2md-core report.pdf --out report.md`);
  process.exit(args.length === 0 ? 1 : 0);
}

const inputPath = args[0];
const outIdx    = args.indexOf('--out');
const outPath   = outIdx !== -1 ? args[outIdx + 1] : null;

if (outIdx !== -1 && !outPath) {
  console.error('Error: --out requires a file path argument.');
  process.exit(1);
}

try {
  const md = await pdfToMarkdown(inputPath);
  if (outPath) {
    await writeFile(outPath, md, 'utf8');
    console.error(`Wrote ${outPath} (${md.length} bytes)`);
  } else {
    process.stdout.write(md);
  }
} catch (err) {
  console.error(`Error converting ${inputPath}: ${err.message}`);
  process.exit(1);
}
