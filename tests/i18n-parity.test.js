// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/i18n-parity.test.js — cross-locale key-parity check
//
//  js/i18n.js's EN object is the source of truth for every UI string
//  key. Each js/locales/<lang>.js sets window.PDFREE_LOCALE with a
//  translation for a subset of those keys — but nothing previously
//  verified that "subset" actually means "all of them, with no typos
//  and no orphan keys nobody reads". A key added to EN but forgotten
//  in one locale silently falls back to English for that locale's
//  users; a typo'd key name in a locale file silently does the same
//  (the typo'd key is never looked up, the real key falls back).
//
//  This test parses both sides as plain text (same technique already
//  used by tests/integration.test.js and tests/config.test.js) rather
//  than executing the locale files, since they're plain scripts that
//  assign to `window.PDFREE_LOCALE` as a side effect rather than ES
//  modules — running 13 of them in one process would clobber the same
//  global repeatedly.
// ============================================================

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

global.window = {};
const { EN } = await import('../js/i18n.js');
const enKeys  = new Set(Object.keys(EN));

const LOCALES_DIR = path.join(ROOT, 'js/locales');
const localeFiles  = readdirSync(LOCALES_DIR).filter(f => f.endsWith('.js')).sort();

// zh-CN is a deliberately scoped, partial locale — see its own file header.
// Unlike the other 13 (full sitewide UI translation, checked for full
// parity below), zh-CN currently backs exactly one dedicated tool page
// (/zh/merge-pdf/, no homepage) and intentionally translates only the keys
// that page's interactive flow renders, relying on i18n.js's EN fallback
// for the rest. Full parity is still enforced for every other locale.
const PARTIAL_LOCALES = new Set(['zh-CN']);

// Extracts top-level `  key:` names from a `window.PDFREE_LOCALE = { ... };`
// block. Restricted to the block itself (not the whole file) so a future
// nested object or comment mentioning "foo:" elsewhere can't leak in.
function extractLocaleKeys(source) {
  const start = source.indexOf('window.PDFREE_LOCALE');
  if (start === -1) return null;
  const braceStart = source.indexOf('{', start);
  const body = source.slice(braceStart);
  const keys = [...body.matchAll(/^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm)].map(m => m[1]);
  return new Set(keys);
}

let passed = 0, failed = 0;
function test(name, fn) {
  try   { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

console.log(`\nEN baseline: ${enKeys.size} keys, ${localeFiles.length} locale files`);

test('EN key set has no duplicate-looking near-misses (sanity)', () => {
  if (enKeys.size === 0) throw new Error('EN object parsed empty — regex or import broke');
});

for (const file of localeFiles) {
  const lang   = file.replace(/\.js$/, '');
  const source = readFileSync(path.join(LOCALES_DIR, file), 'utf-8');
  const localeKeys = extractLocaleKeys(source);

  test(`${lang}: window.PDFREE_LOCALE block found and non-empty`, () => {
    if (!localeKeys || localeKeys.size === 0) {
      throw new Error(`could not find/parse window.PDFREE_LOCALE in ${file}`);
    }
  });
  if (!localeKeys) continue;

  if (!PARTIAL_LOCALES.has(lang)) {
    test(`${lang}: no missing keys (present in EN, absent here)`, () => {
      const missing = [...enKeys].filter(k => !localeKeys.has(k));
      if (missing.length) {
        throw new Error(`missing ${missing.length} key(s): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', ...' : ''}`);
      }
    });
  }

  test(`${lang}: no orphan keys (present here, absent from EN — likely a typo)`, () => {
    const orphans = [...localeKeys].filter(k => !enKeys.has(k));
    if (orphans.length) {
      throw new Error(`orphan key(s) not in EN: ${orphans.join(', ')}`);
    }
  });

  if (!PARTIAL_LOCALES.has(lang)) {
    test(`${lang}: exact key count matches EN (${enKeys.size})`, () => {
      if (localeKeys.size !== enKeys.size) {
        throw new Error(`${localeKeys.size} keys, expected ${enKeys.size}`);
      }
    });
  } else {
    test(`${lang}: scoped locale has a non-trivial key set (not accidentally near-empty)`, () => {
      if (localeKeys.size < 10) {
        throw new Error(`only ${localeKeys.size} keys — looks broken, not just intentionally scoped`);
      }
    });
  }
}

// ── Summary ────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
