// tests/dom.contract.test.js
// Verifies DOM contracts between app.js and all homepage HTML files.
//
// What this catches:
//   • Hero file-input IDs missing from a locale page → hero upload broken
//   • Tool options divs missing from a locale page → inline tool open silently fails
//   • fill/draw-pdf canvas elements present where they should not be (would
//     signal that NAVIGATE_ONLY logic is being bypassed)
//   • tools with inline:false gaining required divs by mistake
//
// Run: node tests/dom.contract.test.js

import { readFileSync } from 'fs';
import { strict as assert } from 'assert';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// ── Helpers ───────────────────────────────────────────────────────

function readPage(relPath) {
  return readFileSync(path.join(ROOT, relPath), 'utf8');
}

function hasId(html, id) {
  return html.includes(`id="${id}"`);
}

// ── Pages under test ─────────────────────────────────────────────

const PAGES = {
  en: readPage('index.html'),
  de: readPage('de/index.html'),
  es: readPage('es/index.html'),
  fr: readPage('fr/index.html'),
  pt: readPage('pt/index.html'),
  id: readPage('id/index.html'),
};

// ── 1. Hero file-input contract ───────────────────────────────────
// These IDs must exist on every homepage for hero upload to work.
// Bug risk: adding a new locale homepage without copying hero structure.

const HERO_REQUIRED = [
  'heroFileInput',    // <input type="file"> — change event drives _setHeroFiles
  'heroDropZone',     // initSearch() guard: early-return if missing
  'heroDropChooseBtn',
  'heroDropIdle',
  'heroDropReady',
  'heroFileName',
  'heroClearFile',
  'heroDetected',
  'heroBanner',
  'heroChipsLabel',
  'searchHero',       // initSearch() guard: early-return if missing
  'srFileInput',      // search-card file input — same-file reset fix relies on this
];

console.log('\nHero file-input contract (all homepages):');
for (const [lang, html] of Object.entries(PAGES)) {
  const missing = HERO_REQUIRED.filter(id => !hasId(html, id));
  test(`${lang}: all ${HERO_REQUIRED.length} hero IDs present`, () =>
    assert.deepEqual(missing, [], `Missing: ${missing.join(', ')}`)
  );
}

// ── 2. Inline tool options divs ───────────────────────────────────
// These empty container divs must exist on every homepage so that
// the hero-intercept can open inline tools (Fix 2) without crashing.
// Tools with inline:false are excluded — they navigate, not inline.

const INLINE_OPTIONS_DIVS = [
  'mergeOptions',
  'splitOptions',
  'compressOptions',
  'jpg2pdfOptions',
  'pdf2jpgOptions',
  'watermarkOptions',
  'pageNumOptions',
  'metaOptions',
  'protectOptions',
  'redactOptions',
  'rotateOptions',
  'ocrOptions',
  'pdf2wordOptions',
  'pdf2excelOptions',
  'pdf2pptOptions',
  'pdf2mdOptions',
  'unlockOptions',
  'compareOptions',
  // splitOptions doubles as extractOptions container
];

console.log('\nInline tool options divs (all homepages):');
for (const [lang, html] of Object.entries(PAGES)) {
  const missing = INLINE_OPTIONS_DIVS.filter(id => !hasId(html, id));
  test(`${lang}: all ${INLINE_OPTIONS_DIVS.length} inline options divs present`, () =>
    assert.deepEqual(missing, [], `Missing: ${missing.join(', ')}`)
  );
}

// ── 3. NAVIGATE_ONLY tools must NOT have their dedicated HTML ─────
// fill needs fillOptions; draw-pdf needs canvas elements.
// If these appear in index.html it means someone added them by mistake
// and the inline:false guard in app.js would be the only protection.

const NAVIGATE_ONLY_FORBIDDEN = {
  fillOptions: 'fillOptions div must not exist in index.html (fill needs /fill/ page)',
  pdfCanvas:   'pdfCanvas must not exist in index.html (draw-pdf needs /draw-on-pdf/ page)',
  drawCanvas:  'drawCanvas must not exist in index.html (draw-pdf needs /draw-on-pdf/ page)',
};

console.log('\nNAVIGATE_ONLY: dedicated-page elements absent from homepages:');
for (const [lang, html] of Object.entries(PAGES)) {
  for (const [id, msg] of Object.entries(NAVIGATE_ONLY_FORBIDDEN)) {
    test(`${lang}: ${id} absent`, () =>
      assert.ok(!hasId(html, id), msg)
    );
  }
}

// ── 4. config.js inline flag consistency ─────────────────────────
// Verify that every tool has a defined inline capability: either
// inline:false (navigate-only) or no flag (defaults to inline-capable).
// Catches: new tool added to config without considering inline support.

console.log('\nconfig.js inline flag coverage:');

global.document = { documentElement: { lang: 'en' } };
const { TOOLS } = await import('../js/config.js');

const navigateOnly = Object.entries(TOOLS)
  .filter(([, t]) => t.inline === false)
  .map(([k]) => k);

test('fill has inline:false', () =>
  assert.equal(TOOLS['fill']?.inline, false)
);
test('draw-pdf has inline:false', () =>
  assert.equal(TOOLS['draw-pdf']?.inline, false)
);
test('all other implemented tools do NOT have inline:false', () => {
  const wrongly_blocked = Object.entries(TOOLS)
    .filter(([k, t]) => t.implemented && t.inline === false && k !== 'fill' && k !== 'draw-pdf')
    .map(([k]) => k);
  assert.deepEqual(wrongly_blocked, [],
    `Unexpected inline:false on: ${wrongly_blocked.join(', ')}`);
});
test('navigate-only tools are fill and draw-pdf (update test if you add more)', () =>
  assert.deepEqual(navigateOnly.sort(), ['draw-pdf', 'fill'])
);

// ── Summary ───────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${total} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
