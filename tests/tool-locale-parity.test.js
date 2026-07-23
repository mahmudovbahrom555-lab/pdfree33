// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/tool-locale-parity.test.js — config.js vs tools-config.json
//
//  data/tools-config.json is the source of truth for which locales a
//  tool has a real, generated SEO page in (gated by its `slugs` entry).
//  js/config.js's TOOLS[*].titles/descs/btns is what the SPA runtime
//  actually renders into #toolTitle/#toolDesc/the process button via
//  getLocalizedTool() — and, critically, `app.js` calls this on EVERY
//  tool-page load (not just manual tool switches), overwriting the
//  correctly-localized server-rendered title/desc with whatever
//  getLocalizedTool() resolves to.
//
//  If a locale has a real page in tools-config.json but is missing
//  from config.js's titles/descs/btns, getLocalizedTool() silently
//  falls back to English — so a fully-localized SEO page gets its
//  title/description/button text overwritten with English the moment
//  JS runs. This exact regression shipped for 19 of 23 tools before
//  being caught by a manual audit; this test exists so it can never
//  ship silently again.
//
//  'en' is exempt: tool.titles?.en ?? tool.title always resolves to
//  the tool's own top-level EN string even if titles.en is absent, so
//  there's nothing to regress there.
// ============================================================

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

global.document = { documentElement: { lang: 'en' } };
const { TOOLS } = await import('../js/config.js');

const tc = JSON.parse(readFileSync(path.join(ROOT, 'data/tools-config.json'), 'utf-8'));

// tools-config.json entries key by `id`, but one tool (metadata/meta) uses a
// different `toolKey` to cross-reference js/config.js's TOOLS key — always
// prefer toolKey when present.
const tcByKey = {};
for (const t of tc.tools) {
  const key = t.toolKey || t.id;
  tcByKey[key] = t;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try   { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

console.log(`\n${Object.keys(TOOLS).length} tools in config.js, ${tc.tools.length} entries in tools-config.json`);

for (const [toolKey, tool] of Object.entries(TOOLS)) {
  const tcTool = tcByKey[toolKey];
  if (!tcTool) continue; // no SEO page for this tool at all (meta/compare/ocr/draw-pdf/...) — out of scope

  const tcLocales = Object.keys(tcTool.slugs || {}).filter(l => l !== 'en');
  if (!tcLocales.length) continue;

  for (const field of ['titles', 'descs', 'btns']) {
    test(`${toolKey}.${field}: covers every locale tools-config.json has a page for`, () => {
      const have    = tool[field] || {};
      const missing = tcLocales.filter(l => !(l in have));
      if (missing.length) {
        throw new Error(
          `js/config.js TOOLS.${toolKey}.${field} is missing ${missing.length} locale(s) ` +
          `that data/tools-config.json already has a real page for: ${missing.join(', ')}. ` +
          `getLocalizedTool() will silently show English for these — add the missing ` +
          `translations to js/config.js (reuse tools-config.json's cardNames/cardDescs).`
        );
      }
    });
  }
}

// ── Summary ────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
