// SPDX-License-Identifier: AGPL-3.0-only
//
// Copies the pure, browser-independent extraction core from the main
// pdfree33 repo (../../../js/) into src/core/ before every `npm publish`.
// These files are gitignored HERE — the canonical source lives in the
// parent repo's js/ directory, not duplicated in git. Run manually via
// `npm run sync` during development, or automatically via prepublishOnly.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here    = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const jsRoot  = join(pkgRoot, '..', '..', 'js');
const destDir = join(pkgRoot, 'src', 'core');

const FILES = [
  'pdf2mdCore.js',
  'pdf2wordTables.js',
  'pdf2wordColumns.js',
  'textLayoutUtils.js',
];

mkdirSync(destDir, { recursive: true });

for (const name of FILES) {
  const src  = join(jsRoot, name);
  const dest = join(destDir, name);
  const content = readFileSync(src, 'utf8');
  writeFileSync(dest, content);
  console.log(`copied ${name} (${content.length} bytes)`);
}

console.log(`\nsynced ${FILES.length} files from ../../js/ -> src/core/`);
