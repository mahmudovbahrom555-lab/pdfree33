// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  scripts/corpus-diff/run.mjs — run every corpus PDF through a tool on an
//  OLD build (default: production) and a NEW build (default: local dist/),
//  in a real Chromium, and save both outputs for check.py to judge against
//  the ORIGINAL. Old-vs-new over real files is what caught the 2026-09-30
//  compress corruption (charts vanishing, garbled scans) and a savings
//  regression in the fix itself — synthetic unit tests missed all of it.
//
//  Inputs: tests/corpus/real/*.pdf (committed, open licences — see
//  MANIFEST.json), tests/corpus/synthetic/*.pdf, and the run-time traps
//  from tests/corpus/traps.mjs.
//
//  Usage: node scripts/corpus-diff/run.mjs [--tool compress]
//           [--old https://pdfree.io] [--new http://localhost:8934] [--out dir]
//  Writes <out>/{inputs,old,new}/<name>.pdf and <out>/runs.json.
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { trapCases } from '../../tests/corpus/traps.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
const TOOL = arg('tool', 'compress');
const OLD  = arg('old', 'https://pdfree.io');
const NEW  = arg('new', 'http://localhost:8934');
const OUT  = path.resolve(arg('out', path.join(ROOT, 'corpus-diff-out')));

// Per-tool page + how a run is driven. Only compress so far; merge/split/
// converters get their own entry (see the plan in project memory).
const TOOLS = {
  compress: { path: '/compress-pdf/', mime: 'application/pdf' },
};
if (!TOOLS[TOOL]) { console.error(`unknown tool: ${TOOL}`); process.exit(2); }

const RUN_TIMEOUT_MS = 90_000;

async function runOnce(browser, base, file) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.addInitScript((mime) => {
      window.__blob = null;
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = b => { if (b instanceof Blob && b.type === mime) window.__blob = b; return orig(b); };
    }, TOOLS[TOOL].mime);
    await page.goto(`${base}${TOOLS[TOOL].path}`, { waitUntil: 'load', timeout: 45_000 });
    await page.setInputFiles('#fileInput', file);
    await page.waitForTimeout(2500); // background pre-scan + preset auto-pick, as a user would get
    await page.click('#mergeBtn');
    let started = Date.now();
    let retriedStandard = false;
    for (;;) {
      const state = await page.evaluate(() => ({
        done: !!window.__blob,
        busy: !!document.querySelector('#mergeBtn')?.classList.contains('merge-btn--processing'),
        toast: (document.querySelector('#toast')?.innerText || '').trim().slice(0, 200),
      }));
      if (state.done) break;
      // The scan auto-picked Light and it refused ("…Try Standard") — do what a
      // user does next, otherwise text-heavy documents never exercise compress.
      if (!state.busy && !retriedStandard && /Try Standard/i.test(state.toast)) {
        retriedStandard = true;
        await page.evaluate(() => {
          const i = document.querySelector('input[name="compressPreset"][value="medium"]');
          if (i) { i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); }
        });
        await page.click('#mergeBtn');
        started = Date.now();
        continue;
      }
      // Finished without a file: a validation block, a password prompt, an error toast
      if (!state.busy && Date.now() - started > 3000) return { status: 'no-output', reason: state.toast || 'no result' };
      if (Date.now() - started > RUN_TIMEOUT_MS) return { status: 'no-output', reason: 'timeout' };
      await page.waitForTimeout(250);
    }
    const b64 = await page.evaluate(async () => {
      const u = new Uint8Array(await window.__blob.arrayBuffer()); let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return btoa(s);
    });
    return { status: 'ok', bytes: Buffer.from(b64, 'base64') };
  } finally {
    await context.close();
  }
}

// One retry: a network blip against production must not read as a regression.
async function run(browser, base, file) {
  try { return await runOnce(browser, base, file); }
  catch { try { return await runOnce(browser, base, file); } catch (e) { return { status: 'error', reason: e.message.slice(0, 200) }; } }
}

for (const d of ['inputs', 'old', 'new']) fs.mkdirSync(path.join(OUT, d), { recursive: true });

const browser = await chromium.launch();
const inputs = [];
for (const dir of ['real', 'synthetic']) {
  const abs = path.join(ROOT, 'tests', 'corpus', dir);
  for (const f of fs.readdirSync(abs).filter(f => f.endsWith('.pdf')).sort()) {
    inputs.push({ name: `${dir}-${f.replace(/\.pdf$/, '')}`, file: path.join(abs, f), kind: dir });
  }
}
for (const trap of await trapCases(browser)) {
  const file = path.join(OUT, 'inputs', `trap-${trap.name}.pdf`);
  fs.writeFileSync(file, trap.bytes);
  inputs.push({ name: `trap-${trap.name}`, file, kind: 'trap', expect: trap.expect, why: trap.why });
}

const runs = [];
for (const [i, input] of inputs.entries()) {
  const [oldRes, newRes] = await Promise.all([run(browser, OLD, input.file), run(browser, NEW, input.file)]);
  const entry = { ...input, old: { status: oldRes.status, reason: oldRes.reason }, new: { status: newRes.status, reason: newRes.reason } };
  if (oldRes.bytes) fs.writeFileSync(path.join(OUT, 'old', `${input.name}.pdf`), oldRes.bytes);
  if (newRes.bytes) fs.writeFileSync(path.join(OUT, 'new', `${input.name}.pdf`), newRes.bytes);
  runs.push(entry);
  console.log(`[${i + 1}/${inputs.length}] ${input.name}: old=${oldRes.status} new=${newRes.status}`);
}
await browser.close();
fs.writeFileSync(path.join(OUT, 'runs.json'), JSON.stringify({ tool: TOOL, old: OLD, new: NEW, runs }, null, 1));
console.log(`\n${runs.length} inputs → ${OUT}`);
