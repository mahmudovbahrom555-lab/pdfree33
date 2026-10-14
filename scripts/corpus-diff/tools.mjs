// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  scripts/corpus-diff/tools.mjs — how a corpus run drives each tool page:
//  its path, which files one run adds, and when the page is ready for the
//  click. Shared by scripts/corpus-diff/run.mjs (old-vs-new gate) and
//  scripts/corpus-cloud/robust.mjs (nightly robustness run).
// ============================================================

import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REF_PDF = path.join(ROOT, 'tests', 'fixtures', 'normal-1page.pdf');

// merge appends a fixed 1-page reference — check.py rebuilds the same
// concatenation as the expected original; split pre-selects every page only
// once its page list has loaded.
export const TOOLS = {
  compress: { path: '/compress-pdf/', files: f => [f] },
  merge:    { path: '/merge-pdf/',    files: f => [f, REF_PDF] },
  split:    { path: '/split-pdf/',    files: f => [f],
              ready: () => { const c = document.querySelector('#splitOptions');
                             return !!c && c.children.length > 0 &&
                               !(c.children.length === 1 && c.firstElementChild.classList.contains('split-loading')); } },
  // Same readiness signal scripts/pdf2md_benchmark.mjs uses (the pre-scan
  // must finish or validation refuses with "analysing")
  pdf2md:   { path: '/pdf-to-markdown/', files: f => [f],
              ready: () => { const el = document.getElementById('pdf2mdOptions');
                             return !!el && el.style.display !== 'none' && !el.textContent.toLowerCase().includes('analysing'); } },
  pdf2word:  { path: '/pdf-to-word/',  files: f => [f] },
  pdf2excel: { path: '/pdf-to-excel/', files: f => [f] },
  pdf2jpg:   { path: '/pdf2jpg/',      files: f => [f],
               ready: () => !!document.querySelector('label[data-fmt="jpg"]') },
  resize:    { path: '/resize-pdf-for-printing/', files: f => [f] },
  nup:       { path: '/pages-per-sheet/', files: f => [f],
               ready: () => !!document.querySelector('#nupPreview svg') },
};

export const EXT = {
  'application/pdf': 'pdf', 'application/zip': 'zip', 'text/markdown': 'md',
  'image/jpeg': 'jpg', 'image/png': 'png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};
