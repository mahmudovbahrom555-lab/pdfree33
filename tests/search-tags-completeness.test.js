// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/search-tags-completeness.test.js
//
//  A user reported the homepage search box returning "not found" for a
//  Russian query, even though the tool existed — js/search.js only ever
//  matched English tags (js/config.js TOOLS[*].tags), and 3 tools were
//  additionally missing translated titles for 9+ locales entirely. Fixed
//  by adding TOOLS[*].tags (English) + js/locales/<lc>.js's search_tags
//  (per-locale synonyms), merged at query time in buildIndex().
//
//  A follow-up manual audit of all ~1600 tags across 13 locales then
//  found a second class of bug this file exists to prevent from ever
//  shipping silently again: individual tags that are too short to ever
//  match (js/search.js ignores queries under a script-aware minimum
//  length), duplicated within a tool, or colliding with a DIFFERENT
//  tool's tag (so the wrong tool wins the exact-match tier).
//
//  This test re-runs that same audit — completeness AND correctness —
//  every `npm test`, so adding a new tool without search tags, or a new
//  tag that's too short or steps on another tool's vocabulary, fails
//  CI immediately instead of silently shipping a "not found" search.
// ============================================================

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe:       (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy: ()  => { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
  };
}

const { buildIndex, search } = await import('../js/search.js');
const { TOOLS } = await import('../js/config.js');

const implementedKeys = Object.entries(TOOLS).filter(([, t]) => t.implemented).map(([k]) => k);

// Same script-awareness as js/search.js's own minQueryLength — duplicated
// here deliberately (not imported) so this test still catches a regression
// if someone changes the threshold in search.js without updating tags.
const CJK_RE = /[぀-ヿ一-鿿가-힣]/;
const minLen = (s) => (CJK_RE.test(s) ? 2 : 3);

const LOCALES_DIR = path.join(ROOT, 'js/locales');
const locales = readdirSync(LOCALES_DIR).filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, ''));

function loadSearchTags(lc) {
  const source  = readFileSync(path.join(LOCALES_DIR, `${lc}.js`), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.window.PDFREE_LOCALE?.search_tags || {};
}

// ── 1. Every implemented tool has non-empty English tags ────────────
console.log('English tags — every implemented tool has at least one:');
for (const key of implementedKeys) {
  test(`${key}: TOOLS['${key}'].tags is non-empty`, () => {
    expect(Array.isArray(TOOLS[key].tags) && TOOLS[key].tags.length > 0).toBeTruthy();
  });
}

// ── 2. Every locale has search_tags for every implemented tool ──────
console.log('\nPer-locale search_tags — every implemented tool covered in every locale:');
const localeTagsByLc = {};
for (const lc of locales) {
  localeTagsByLc[lc] = loadSearchTags(lc);
  for (const key of implementedKeys) {
    test(`${lc}: search_tags['${key}'] is non-empty`, () => {
      const arr = localeTagsByLc[lc][key];
      expect(Array.isArray(arr) && arr.length > 0).toBeTruthy();
    });
  }
}

// ── 3. Full tag audit per locale: length, duplicates, self-resolution ─
console.log('\nTag quality audit (length, duplicates, cross-tool collisions, self-resolution):');
for (const lc of locales) {
  const localeTags = localeTagsByLc[lc];
  const index = buildIndex(TOOLS, lc, localeTags);
  const seenAcrossTools = new Map();

  for (const [toolKey, tags] of Object.entries(localeTags)) {
    if (!implementedKeys.includes(toolKey)) continue; // orphan key, not this test's concern
    const seenWithin = new Set();

    for (const tag of tags) {
      const norm = tag.toLowerCase().trim();
      const label = `${lc}/${toolKey}: '${tag}'`;

      test(`${label} — at least ${minLen(norm)} chars (script-aware minimum)`, () => {
        expect(norm.length >= minLen(norm)).toBeTruthy();
      });

      test(`${label} — not a duplicate within the same tool`, () => {
        expect(!seenWithin.has(norm)).toBeTruthy();
        seenWithin.add(norm);
      });

      if (seenAcrossTools.has(norm) && seenAcrossTools.get(norm) !== toolKey) {
        test(`${label} — not claimed by another tool ('${seenAcrossTools.get(norm)}' already has it)`, () => {
          throw new Error(`also used by ${seenAcrossTools.get(norm)}`);
        });
      } else {
        seenAcrossTools.set(norm, toolKey);
      }

      if (norm.length >= minLen(norm)) {
        test(`${label} — exact search resolves to its own tool`, () => {
          const top = search(tag, index)[0]?.key;
          expect(top).toBe(toolKey);
        });
      }
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
