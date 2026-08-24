// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/build-skip-dirs.test.js — regression guard: non-site directories
//  never leak into dist/
//
//  scripts/build.py's SKIP_DIRS (an explicit allowlist, not pattern-based —
//  checked directly: `_should_skip(name, is_dir)` for a directory is just
//  `name in SKIP_DIRS`, no glob/wildcard) determines what gets copied into
//  dist/ as a static asset. An unrecognized new top-level directory is
//  copied by DEFAULT unless its exact name is added to SKIP_DIRS — found
//  the hard way while building packages/pdf2md-core/ (a standalone npm
//  package, not part of the site): SKIP_DIRS did not already skip it,
//  confirmed via direct testing before the fix landed (see the pdf2md
//  structural-gap plan/memory).
//
//  This guards specifically against a re-add of packages/pdf2md-core/ (or
//  any future packages/<name>/) accidentally ending up in dist/ if
//  SKIP_DIRS is ever refactored/reordered and 'packages' silently drops
//  out — a real, non-hypothetical risk class for this exact allowlist
//  shape (see the CI shallow-clone lesson in sitemap-lastmod.test.js for
//  another "silent regression in a config nobody was watching" precedent).
// ============================================================

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.join(__dirname, '..');
const DIST       = path.join(ROOT, 'dist');
const DIST_PKGS  = path.join(DIST, 'packages');
const SRC_PKGS   = path.join(ROOT, 'packages');

let passed = 0, failed = 0;
function test(name, fn) {
  try   { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const inCI = !!(process.env.CI || process.env.GITHUB_ACTIONS);
if (!existsSync(DIST) && !inCI) {
  console.log('  – skipped: build-skip-dirs check (dist/ not built — run scripts/build.py first; mandatory in CI)');
} else {
  test('dist/ exists', () => {
    if (!existsSync(DIST)) {
      throw new Error('dist/ does not exist in CI — the build step must have failed or been skipped before tests ran');
    }
  });

  if (existsSync(DIST)) {
    test('packages/ (standalone npm packages, e.g. pdf2md-core) is never copied into dist/', () => {
      if (existsSync(SRC_PKGS) && existsSync(DIST_PKGS)) {
        throw new Error(
          "dist/packages/ exists — scripts/build.py's SKIP_DIRS no longer skips 'packages'. " +
          'This would publish a standalone npm package (source, node_modules if present, etc.) ' +
          'as a static site asset. Re-add \'packages\' to SKIP_DIRS in scripts/build.py.'
        );
      }
    });
  }
}

console.log(`\n${'─'.repeat(40)}\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
