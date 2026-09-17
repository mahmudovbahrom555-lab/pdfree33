// ============================================================
//  tests/worker-scope-collision.test.js
//
//  js/worker.js (off-limits per CLAUDE.md) is a classic (non-module) Web
//  Worker that importScripts() TWO hand-maintained sibling files into its
//  own shared global scope: js/pdfEncrypt.js and js/watermarkImage.js —
//  confirmed the ONLY such pairing in the codebase (every other worker's
//  importScripts() targets are pre-built vendor bundles, not touched by
//  this project's own minifier). scripts/build.py's minifier runs PER
//  FILE, with no knowledge that its output will later share a global
//  namespace with the other file — so a top-level (module-scope-escaping)
//  declaration in either file can silently collide with one in the other
//  after independent minification, even when their SOURCE names look
//  nothing alike.
//
//  Real incident this guards against (2026-09-16/17): watermarkImage.js
//  gained a top-level `function _safeSize(page)`, which terser minified
//  to a bare `function t(t){...}` — the exact same global name
//  pdfEncrypt.js's own top-level `_rc4` function independently minified
//  to. watermarkImage.js loads after pdfEncrypt.js via importScripts(),
//  so it silently overwrote RC4 encryption for EVERY Protect operation.
//  Caught only by a real-browser E2E test (tests/e2e/protect.e2e.mjs) —
//  invisible to build/lint/unit-tests, none of which run real minified
//  code in a shared global scope. Fixed (commit 6ddff0c6) by scoping the
//  helper inside its only caller instead of top-level. See memory
//  watermark_worker_minified_name_collision_2026_09 for the full story.
//
//  This test is a permanent regression guard for the underlying class of
//  bug, not just the one incident: it extracts every TOP-LEVEL
//  (brace-depth-0) function/const/let/var binding name from each file's
//  REAL MINIFIED dist/ output (source-level uniqueness doesn't prove
//  minified-level uniqueness — the whole point of the incident) and
//  fails if the two sets intersect.
//
//  Depth-tracking name extraction, not a full parser — acceptable here
//  because these are our own build outputs (never adversarial input),
//  and the check only needs to answer one narrow question: does
//  `function <name>(`/`const <name>`/`let <name>`/`var <name>` appear at
//  brace/paren depth 0 in this specific minified file.
//
//  Run: node tests/worker-scope-collision.test.js
// ============================================================

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dir, '..', 'dist', 'js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function expect(actual) {
  return {
    toEqual: (e) => { if (JSON.stringify(actual) !== JSON.stringify(e)) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
  };
}

// Strips the license-header comment lines this project's minifier leaves
// intact at the top of every dist/ JS file, so they don't skew depth
// tracking (comments contain no braces here, but skip them for clarity).
function stripLeadingComments(src) {
  return src.replace(/^(\/\/[^\n]*\n)+/, '');
}

// Depth-0 (brace AND paren) top-level binding names — a function body's
// own params/locals sit at depth > 0 by construction, so this only ever
// picks up names that actually leak into the shared global scope of a
// classic (non-module) script.
function topLevelNames(minifiedSrc) {
  const src = stripLeadingComments(minifiedSrc);
  const names = new Set();
  let depth = 0;
  const funcRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/y;
  const declRe  = /\b(const|let|var)\s+([A-Za-z_$][\w$]*)/y;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{' || ch === '(') { depth++; continue; }
    if (ch === '}' || ch === ')') { depth--; continue; }
    if (depth !== 0) continue;
    funcRe.lastIndex = i;
    const fm = funcRe.exec(src);
    if (fm && fm.index === i) { names.add(fm[1]); continue; }
    declRe.lastIndex = i;
    const dm = declRe.exec(src);
    if (dm && dm.index === i) names.add(dm[2]);
  }
  return names;
}

if (!existsSync(DIST)) {
  if (process.env.CI || process.env.GITHUB_ACTIONS) {
    console.error('dist/js/ missing in CI — the build step itself must have failed.');
    process.exit(1);
  }
  console.log('worker-scope-collision: dist/ not built — run `python3 scripts/build.py` first. Skipping (not in CI).');
  process.exit(0);
}

console.log('\n🔒 worker.js shared-scope collision guard (pdfEncrypt.js / watermarkImage.js):');

// Sanity check on the extractor itself, before trusting it against the
// real files below — same discipline as this session's other new tests
// (prove the check can actually detect the thing it claims to detect).
test('sanity: the extractor finds depth-0 names and ignores nested ones', () => {
  const sample = 'function a(x){function b(y){const c=1}return b}const d=2;';
  const names = [...topLevelNames(sample)].sort();
  expect(names).toEqual(['a', 'd']);
});

test('pdfEncrypt.js and watermarkImage.js share no top-level minified names', () => {
  const pdfEncrypt = readFileSync(join(DIST, 'pdfEncrypt.js'), 'utf8');
  const watermarkImage = readFileSync(join(DIST, 'watermarkImage.js'), 'utf8');
  const a = topLevelNames(pdfEncrypt);
  const b = topLevelNames(watermarkImage);
  const overlap = [...a].filter(n => b.has(n));
  if (overlap.length > 0) {
    throw new Error(
      `pdfEncrypt.js and watermarkImage.js both declare top-level minified name(s) ` +
      `[${overlap.join(', ')}] — these share js/worker.js's importScripts() global ` +
      `scope, so whichever loads last silently overwrites the other's binding. ` +
      `Scope the colliding declaration inside its only caller instead of top-level ` +
      `(see this file's header comment for the real incident this once caused).`
    );
  }
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`worker-scope-collision tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
