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
//  Usage: node scripts/corpus-diff/run.mjs [--tool compress|merge|split|pdf2md]
//           [--old https://pdfree.io] [--new http://localhost:8934] [--out dir]
//           [--jobs 2]
//  Writes <out>/{inputs,old,new}/<name>.{pdf,zip,md} and <out>/runs.json
//  (pdf2md runs also record the page's own Atlas ERI structure score).
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

const REF_PDF = path.join(ROOT, 'tests', 'fixtures', 'normal-1page.pdf');

// Per tool: its page, which files one run adds (merge appends a fixed
// 1-page reference — check.py rebuilds the same concatenation as the
// expected original), and when the page is ready for the click (split
// pre-selects every page only once its page list has loaded).
const TOOLS = {
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
};
const EXT = { 'application/pdf': 'pdf', 'application/zip': 'zip', 'text/markdown': 'md' };
if (!TOOLS[TOOL]) { console.error(`unknown tool: ${TOOL}`); process.exit(2); }

const RUN_TIMEOUT_MS = 90_000;
const JOBS = Math.max(1, Number(arg('jobs', 2)));

async function runOnce(browser, base, file) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      window.__blob = null;
      window.__eri = null;
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = b => {
        if (b instanceof Blob && b.size > 0 && /^(application\/(pdf|zip)|text\/markdown)$/.test(b.type)) window.__blob = b;
        return orig(b);
      };
      // the page's own structure score for Markdown output (js/eriScoreMd.js)
      document.addEventListener('pdfree:success', e => { window.__eri = e.detail?.atlasEri ?? null; });
    });
    await page.goto(`${base}${TOOLS[TOOL].path}`, { waitUntil: 'load', timeout: 45_000 });
    await page.setInputFiles('#fileInput', TOOLS[TOOL].files(file));
    await page.waitForTimeout(2500); // background pre-scan / preset pick, as a user would get
    if (TOOLS[TOOL].ready) await page.waitForFunction(TOOLS[TOOL].ready, null, { timeout: 30_000 }).catch(() => {});
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
    await page.waitForTimeout(300); // pdfree:success fires right after the download
    const { b64, type, eri } = await page.evaluate(async () => {
      const u = new Uint8Array(await window.__blob.arrayBuffer()); let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return { b64: btoa(s), type: window.__blob.type, eri: window.__eri };
    });
    return { status: 'ok', bytes: Buffer.from(b64, 'base64'), ext: EXT[type], eri };
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

const save = (dir, name, res) => {
  if (!res.bytes) return undefined;
  const file = `${name}.${res.ext}`;
  fs.writeFileSync(path.join(OUT, dir, file), res.bytes);
  return file;
};
const runs = new Array(inputs.length);
let next = 0, done = 0;
async function worker() {
  while (next < inputs.length) {
    const i = next++;
    const input = inputs[i];
    const [oldRes, newRes] = await Promise.all([run(browser, OLD, input.file), run(browser, NEW, input.file)]);
    runs[i] = { ...input,
      old: { status: oldRes.status, reason: oldRes.reason, file: save('old', input.name, oldRes), eri: oldRes.eri },
      new: { status: newRes.status, reason: newRes.reason, file: save('new', input.name, newRes), eri: newRes.eri } };
    console.log(`[${++done}/${inputs.length}] ${input.name}: old=${oldRes.status} new=${newRes.status}`);
  }
}
await Promise.all(Array.from({ length: JOBS }, worker));
await browser.close();
fs.writeFileSync(path.join(OUT, 'runs.json'), JSON.stringify({ tool: TOOL, old: OLD, new: NEW, ref: REF_PDF, runs }, null, 1));
console.log(`\n${runs.length} inputs → ${OUT}`);
