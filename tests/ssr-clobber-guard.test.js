// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/ssr-clobber-guard.test.js
//
//  app.js runs showTool() -> renderToolHeader() unconditionally on every
//  tool-page load (js/app.js's DOMContentLoaded handler), and initSearch()
//  unconditionally on every homepage load. Both overwrite already-correct,
//  server-rendered DOM (#toolTitle/#toolDesc/document.title on tool pages;
//  #heroDropLabel/#heroImgHint on homepages) with whatever the client JS's
//  own data source resolves to. Two real, shipped bugs came from this:
//
//    1. js/config.js's TOOLS[*].titles/descs/btns had fewer locales than
//       the actual built pages (19 of 23 tools, plus `compress-email`
//       which isn't tracked in data/tools-config.json at all) — English
//       silently overwrote correctly-localized SSR text on every load.
//    2. js/i18n.js's hero_drop/hero_img_hint and the hardcoded document.title
//       in goHome() had drifted out of sync with the actual homepage HTML —
//       not a missing translation, but a second, independently-maintained
//       copy of the same string that nobody kept in sync.
//
//  This test guards against both recurring, by scanning the actual
//  git-tracked HTML (not dist/, so it runs without a prior build step) for
//  every page that sets <body data-tool="X">, and asserting js/config.js
//  covers that locale for X — plus checking the homepage hero strings and
//  title still match js/i18n.js/js/locales/*.js exactly.
// ============================================================

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

const KNOWN_LOCALES = ['de', 'es', 'fr', 'pt', 'id', 'vi', 'ru', 'ja', 'it', 'ko', 'nl', 'pl', 'tr'];
// Non-content top-level directories — never contain a page with <body data-tool>.
const EXCLUDE_DIRS = new Set([
  '.git', '.claude', '.github', 'node_modules', 'dist',
  'css', 'data', 'fonts', 'icons', 'js', 'scripts', 'tests', 'docs', 'blog',
]);

let passed = 0, failed = 0;
function test(name, fn) {
  try   { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// ── 1. Scan every git-tracked index.html for <body data-tool="X"> ─────────
// and check js/config.js covers whatever locale that page is served in.

function findIndexHtmlFiles() {
  const found = [];
  // Depth 0: root/index.html, root/<slug>/index.html
  // Depth 1 (locale dirs only): <locale>/index.html, <locale>/<slug>/index.html
  function scanDir(dir, locale) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (dir === ROOT && EXCLUDE_DIRS.has(entry)) continue;
      const idx = path.join(full, 'index.html');
      if (existsSync(idx)) found.push({ file: idx, locale });
    }
  }
  const rootIdx = path.join(ROOT, 'index.html');
  if (existsSync(rootIdx)) found.push({ file: rootIdx, locale: 'en' });
  scanDir(ROOT, 'en');
  for (const loc of KNOWN_LOCALES) {
    const locDir = path.join(ROOT, loc);
    if (!existsSync(locDir) || !statSync(locDir).isDirectory()) continue;
    const locIdx = path.join(locDir, 'index.html');
    if (existsSync(locIdx)) found.push({ file: locIdx, locale: loc });
    scanDir(locDir, loc);
  }
  return found;
}

global.document = { documentElement: { lang: 'en' } };
const { TOOLS } = await import('../js/config.js');

console.log('\nSSR data-tool locale coverage (scanning git-tracked HTML):');

const pages = findIndexHtmlFiles();
console.log(`  scanned ${pages.length} index.html files`);

const failures = [];
for (const { file, locale } of pages) {
  if (locale === 'en') continue; // 'en' always resolves via top-level .title/.desc/.btn
  const html = readFileSync(file, 'utf-8');
  const m = html.match(/<body[^>]*\bdata-tool="([^"]+)"/);
  if (!m) continue;
  const toolKey = m[1];
  const tool = TOOLS[toolKey];
  if (!tool) continue; // _detectTool() requires TOOLS[bodyTool] to exist — if absent, showTool() never fires for it

  for (const field of ['titles', 'descs', 'btns']) {
    if (!(tool[field] && locale in tool[field])) {
      failures.push(`${path.relative(ROOT, file)} → data-tool="${toolKey}" → TOOLS.${toolKey}.${field} has no '${locale}' entry`);
    }
  }
}

test('every page with <body data-tool> has full js/config.js locale coverage for its own locale', () => {
  if (failures.length) {
    throw new Error(
      `${failures.length} SSR-clobber risk(s) found — renderToolHeader() will overwrite ` +
      `correct localized text with English on load:\n    ` + failures.join('\n    ')
    );
  }
});

// ── 2. Homepage hero text must match js/i18n.js / js/locales/*.js exactly ──
// (initSearch() runs unconditionally on every homepage load and overwrites
// these elements with t('hero_drop')/t('hero_img_hint')/t('home_title').)

console.log('\nHomepage hero text parity (SSR vs. i18n source):');

function extractValue(source, key) {
  const re = new RegExp(`^\\s*${key}:\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`, 'm');
  const m = source.match(re);
  return m ? m[2].replace(/\\(['"])/g, '$1') : null;
}

const i18nSource = readFileSync(path.join(ROOT, 'js/i18n.js'), 'utf-8');
const HERO_KEYS = ['hero_drop', 'hero_img_hint', 'home_title'];

const HOMEPAGE_LOCALES = ['en', 'de', 'es', 'fr', 'pt', 'id'];
for (const locale of HOMEPAGE_LOCALES) {
  const file = locale === 'en' ? path.join(ROOT, 'index.html') : path.join(ROOT, locale, 'index.html');
  if (!existsSync(file)) continue;
  const html = readFileSync(file, 'utf-8');

  const localeSource = locale === 'en' ? null : readFileSync(path.join(ROOT, `js/locales/${locale}.js`), 'utf-8');
  function resolve(key) {
    if (localeSource) {
      const v = extractValue(localeSource, key);
      if (v !== null) return v;
    }
    return extractValue(i18nSource, key);
  }

  const ssrDrop  = html.match(/id="heroDropLabel">([^<]*)</)?.[1];
  const ssrHint  = html.match(/id="heroImgHint">([^<]*)</)?.[1];
  const ssrTitle = html.match(/<title>([^<]*)<\/title>/)?.[1];

  test(`${locale}: heroDropLabel matches t('hero_drop')`, () => {
    const expected = resolve('hero_drop');
    if (ssrDrop !== expected) {
      throw new Error(`SSR="${ssrDrop}" but i18n source resolves to "${expected}" — initSearch() will overwrite the SSR text with a different phrase on load`);
    }
  });
  test(`${locale}: heroImgHint matches t('hero_img_hint')`, () => {
    const expected = resolve('hero_img_hint');
    if (ssrHint !== expected) {
      throw new Error(`SSR="${ssrHint}" but i18n source resolves to "${expected}"`);
    }
  });
  test(`${locale}: <title> matches t('home_title') (what goHome() sets)`, () => {
    const expected = resolve('home_title');
    if (ssrTitle !== expected) {
      throw new Error(`SSR <title>="${ssrTitle}" but i18n source resolves to "${expected}" — goHome() will set a different document.title`);
    }
  });
}

// ── Summary ────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
