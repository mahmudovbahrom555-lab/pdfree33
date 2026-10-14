// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  scripts/corpus-cloud/robust.mjs — the nightly robustness run (2026-10-14,
//  the owner's main idea: a large corpus, converted, measured, fixed —
//  pains first).
//
//  Every document goes through every tool, in a real Chromium, the way a
//  user does it (add the file, wait for the page to be ready, one click).
//  No ground truth is needed for this layer: what it finds is what makes a
//  user leave — the tool fails, hangs, crashes the page, or hands back a
//  file that doesn't open. One line per (document, tool) in results.jsonl:
//    ok        — a result came out and it opens (PDF: pdf.js reads it; a
//                ZIP/DOCX/XLSX: a real ZIP; Markdown/JPG: not empty)
//    broken    — a result came out but doesn't open
//    error     — the site's own error (its pdfree:error type and message)
//    refused   — stopped with a message, no error (password, not a PDF…)
//    timeout   — nothing within RUN_TIMEOUT_MS
//    crash     — the page itself died
//    harness   — the run itself failed (page didn't load…): not the tool's fault
//  scripts/corpus-cloud/report.py clusters them.
//
//  node scripts/corpus-cloud/robust.mjs --docs <dir> --sample <sample.json>
//       [--tools compress,merge,…] [--base http://localhost:8934]
//       [--out <dir>] [--jobs 2]
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { TOOLS, EXT } from '../corpus-diff/tools.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
const DOCS   = path.resolve(arg('docs', 'corpus-cloud-docs'));
const SAMPLE = arg('sample', null);
const BASE   = arg('base', 'http://localhost:8934');
const OUT    = path.resolve(arg('out', 'corpus-cloud-out'));
const JOBS   = Math.max(1, Number(arg('jobs', 2)));
const TOOL_LIST = arg('tools', 'compress,merge,split,pdf2jpg,pdf2word,pdf2excel,resize,nup').split(',');
const RUN_TIMEOUT_MS = 120_000;

for (const t of TOOL_LIST) if (!TOOLS[t]) { console.error(`unknown tool: ${t}`); process.exit(2); }

const strata = {};
if (SAMPLE) for (const s of JSON.parse(fs.readFileSync(SAMPLE, 'utf8')).sample) strata[s.file] = s;
const docs = fs.readdirSync(DOCS).filter(f => f.toLowerCase().endsWith('.pdf')).sort();

// One (document, tool) run → { outcome, reason, … , ms, pageErrors }.
async function runOne(browser, tool, file) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message.slice(0, 200)));
  let crashed = false;
  page.on('crash', () => { crashed = true; });
  const started = Date.now();
  try {
    return { ...(await drive(page, tool, file, () => crashed)), ms: Date.now() - started, pageErrors };
  } catch (e) {
    return { outcome: crashed ? 'crash' : 'harness', reason: e.message.slice(0, 200), ms: Date.now() - started, pageErrors };
  } finally {
    await context.close().catch(() => {});
  }
}

async function drive(page, tool, file, isCrashed) {
  await page.addInitScript(() => {
    // the result: the first file made after the click (previews and
    // thumbnails made before it don't count)
    window.__armed = false; window.__blob = null; window.__err = null;
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => {
      if (window.__armed && !window.__blob && b instanceof Blob && b.size > 0) window.__blob = b;
      return orig(b);
    };
    document.addEventListener('pdfree:error', e => { window.__err = e.detail; });
  });
  await page.goto(`${BASE}${TOOLS[tool].path}`, { waitUntil: 'load', timeout: 45_000 });
  await page.setInputFiles('#fileInput', TOOLS[tool].files(file));
  await page.waitForTimeout(2500);
  if (TOOLS[tool].ready) await page.waitForFunction(TOOLS[tool].ready, null, { timeout: 30_000 }).catch(() => {});
  const disabled = await page.evaluate(() => !!document.querySelector('#mergeBtn')?.disabled);
  if (disabled) {
    const toast = await page.evaluate(() => (document.querySelector('#toast')?.innerText || '').trim().slice(0, 200));
    return { outcome: 'refused', reason: toast || 'button stayed disabled' };
  }
  let clickedAt = Date.now();
  await page.evaluate(() => { window.__armed = true; });
  await page.click('#mergeBtn');
  let retriedStandard = false;
  for (;;) {
    if (isCrashed()) return { outcome: 'crash', reason: 'page crashed' };
    const s = await page.evaluate(() => ({
      done: !!window.__blob, err: window.__err,
      busy: !!document.querySelector('#mergeBtn')?.classList.contains('merge-btn--processing'),
      toast: (document.querySelector('#toast')?.innerText || '').trim().slice(0, 200),
    }));
    if (s.done) break;
    if (s.err) return { outcome: 'error', type: s.err.errorType, reason: (s.err.message || '').slice(0, 200) };
    // Compress's Light preset found nothing ("…Try Standard"): what a user
    // does next — same as scripts/corpus-diff/run.mjs
    if (!s.busy && !retriedStandard && /Try Standard/i.test(s.toast)) {
      retriedStandard = true;
      await page.evaluate(() => {
        const i = document.querySelector('input[name="compressPreset"][value="medium"]');
        if (i) { i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); }
      });
      await page.click('#mergeBtn');
      clickedAt = Date.now();
      continue;
    }
    if (!s.busy && Date.now() - clickedAt > 4000) return { outcome: 'refused', reason: s.toast || 'no result' };
    if (Date.now() - clickedAt > RUN_TIMEOUT_MS) return { outcome: 'timeout', reason: `no result in ${RUN_TIMEOUT_MS / 1000}s` };
    await page.waitForTimeout(300);
  }
  // does the result open?
  const check = await page.evaluate(async () => {
    const b = window.__blob;
    const bytes = new Uint8Array(await b.arrayBuffer());
    const size = bytes.length;   // read now: pdf.js takes the buffer over (detached → 0)
    const head = String.fromCharCode(...bytes.subarray(0, 5));
    if (b.type === 'application/pdf') {
      try {
        await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
        const doc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
        await doc.getPage(1);
        return { type: b.type, size, ok: doc.numPages > 0, pages: doc.numPages };
      } catch (e) { return { type: b.type, size, ok: false, why: String(e.message || e).slice(0, 150) }; }
    }
    if (/zip|officedocument|comicbook/.test(b.type)) return { type: b.type, size, ok: head.startsWith('PK'), why: head.startsWith('PK') ? '' : 'not a ZIP' };
    return { type: b.type, size, ok: size > 0 };
  });
  return { outcome: check.ok ? 'ok' : 'broken', reason: check.why, out: { type: EXT[check.type] || check.type, size: check.size, pages: check.pages } };
}

fs.mkdirSync(OUT, { recursive: true });
const outFile = path.join(OUT, 'results.jsonl');
fs.writeFileSync(outFile, '');
const browser = await chromium.launch();
const jobs = docs.flatMap(d => TOOL_LIST.map(t => ({ doc: d, tool: t })));
let next = 0, done = 0;
async function worker() {
  while (next < jobs.length) {
    const { doc, tool } = jobs[next++];
    const res = await runOne(browser, tool, path.join(DOCS, doc));
    const line = { doc, tool, stratum: strata[doc]?.stratum ?? '', lang: strata[doc]?.lang ?? '',
      pages: strata[doc]?.pages ?? null, ...res };
    fs.appendFileSync(outFile, JSON.stringify(line) + '\n');
    console.log(`[${++done}/${jobs.length}] ${doc} ${tool}: ${res.outcome}${res.reason ? ' — ' + res.reason.slice(0, 80) : ''}`);
  }
}
await Promise.all(Array.from({ length: JOBS }, worker));
await browser.close();
console.log(`\n${jobs.length} runs → ${outFile}`);
