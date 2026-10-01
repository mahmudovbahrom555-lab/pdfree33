// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Edge routing check — which requests reach the Worker, and what every class of
// URL is served with. Workers Free counts each Worker invocation against
// 100,000/day; with run_worker_first = true every file of every page view
// counted (~100–175 per load), and the account hit 88% on 2026-09-30. Static
// files are now served by Cloudflare directly (wrangler.toml), and this script
// is the proof that stays true:
//   1. redirect matrix — every Worker redirect (src/index.js REDIRECTS) and
//      every dist/_redirects rule answers 301 to its expected destination;
//   2. header matrix — status, a single Cache-Control, whether the Worker
//      served it (X-Pdfree-Worker), X-Frame-Options, MIME, nosniff, per URL class;
//   3. --browser — real Chromium page loads, with and without the Service
//      Worker: every request that reaches the Worker must be /api/*.
//
// Usage: node scripts/check_edge_routing.mjs <base-url> [--browser] [--redirect-sample N]
//   CI runs it against the uploaded preview version before traffic moves, and
//   `npm run check:prod:edge` against https://pdfree.io after a deploy. Local:
//   `npx wrangler dev` (python's http.server has no _headers/Worker routing).
//   --redirect-sample N checks every Nth Worker redirect — each one is a real
//   Worker invocation, so production checks don't spend ~1,900 of the limit.

import { readFileSync } from 'node:fs';
import { REDIRECTS } from '../src/index.js';

const args = process.argv.slice(2);
const base = (args.find(a => !a.startsWith('--') && !/^\d+$/.test(a)) || '').replace(/\/$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('usage: node scripts/check_edge_routing.mjs <base-url> [--browser] [--redirect-sample N]');
  process.exit(2);
}
const sampleIdx = args.indexOf('--redirect-sample');
const sampleEvery = sampleIdx > -1 ? Number(args[sampleIdx + 1]) : 1;
const failures = [];
const fail = msg => { failures.push(msg); console.log(`  ✗ ${msg}`); };

async function get(path, init = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(base + path, { redirect: 'manual', ...init, signal: AbortSignal.timeout(20000) });
    } catch (e) {
      if (attempt === 3) throw new Error(`${path}: ${e.message}`);
    }
  }
}

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

// ── 1. Redirect matrix ────────────────────────────────────────────────────
const staticRedirects = readFileSync(new URL('../dist/_redirects', import.meta.url), 'utf8')
  .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  .map(l => l.split(/\s+/)).map(([from, to, code = '301']) => ({ from, to, code: Number(code), kind: '_redirects' }));
const workerRedirects = Object.entries(REDIRECTS)
  .filter((_, i) => i % sampleEvery === 0)
  .map(([from, to]) => ({ from, to, code: 301, kind: 'Worker' }));

console.log(`Redirects: ${workerRedirects.length} Worker${sampleEvery > 1 ? ` (every ${sampleEvery}th)` : ''} + ${staticRedirects.length} _redirects`);
await pool([...workerRedirects, ...staticRedirects], 8, async ({ from, to, code, kind }) => {
  const res = await get(from);
  const loc = res.headers.get('location');
  const want = new URL(to, base + '/').pathname;
  if (res.status !== code || !loc || new URL(loc, base + '/').pathname !== want) {
    fail(`${kind} redirect ${from} → expected ${code} ${want}, got ${res.status} ${loc || '(no Location)'}`);
  }
});

// ── 2. Header matrix ──────────────────────────────────────────────────────
const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const versioned = (re, what) => {
  const m = html.match(re);
  if (!m) throw new Error(`dist/index.html has no ${what} — update this check`);
  return '/' + m[1];
};
const appJs = versioned(/src="\/?(js\/app\.js\?v=[\w]+)"/, 'versioned js/app.js');
const css = versioned(/href="\/?(css\/[\w.-]+\.css\?v=[\w]+)"/, 'versioned stylesheet');
const font = versioned(/href="\/?(fonts\/[^"?]+)"/, 'font preload');

const HTML = 'no-cache', HOUR = 'public, max-age=3600';
// worker: whether the response must come from the Worker (X-Pdfree-Worker)
const CASES = [
  { path: '/', status: 200, cc: HTML, worker: false, xfo: true, type: 'text/html' },
  { path: '/merge-pdf/', status: 200, cc: HTML, worker: false, xfo: true, type: 'text/html' },
  { path: '/merge-pdf/?utm_source=edge-check', status: 200, cc: HTML, worker: false, xfo: true },
  { path: '/ru/', status: 200, cc: HTML, worker: false, xfo: true, type: 'text/html' },
  { path: '/de/jpg-zu-pdf/', status: 200, cc: HTML, worker: false, xfo: true, type: 'text/html' },
  { path: appJs, status: 200, cc: HOUR, worker: false, xfo: true, type: 'javascript' },
  { path: '/js/mergeWorker.js', status: 200, cc: HOUR, worker: false, xfo: true, type: 'javascript' },
  { path: css, status: 200, cc: HOUR, worker: false, xfo: true, type: 'text/css' },
  { path: font, status: 200, cc: HOUR, worker: false, xfo: true },
  { path: '/js/vendor/qpdf/lib/qpdf.wasm', status: 200, cc: HOUR, worker: false, xfo: true, type: 'application/wasm' },
  { path: '/manifest.json', status: 200, cc: HOUR, worker: false, xfo: true },
  { path: '/robots.txt', status: 200, cc: HOUR, worker: false, xfo: true },
  { path: '/sitemap.xml', status: 200, cc: HOUR, worker: false, xfo: true, type: 'application/xml' },
  { path: '/version.json', status: 200, cc: HOUR, worker: false, xfo: true },
  { path: '/favicon.ico', status: 200, cc: HOUR, worker: false, xfo: true },
  { path: '/sw.js', status: 200, cc: HTML, worker: false, xfo: true, type: 'javascript' },
  { path: '/embed/compress/', status: 200, cc: HTML, worker: true, xfo: false, type: 'text/html' },
  { path: '/no-such-page-edge-check/', status: 404, cc: HTML, worker: true, xfo: true, type: 'text/html', body: 'Page Not Found' },
  { path: '/no-such-file-edge-check.js', status: 404, cc: HTML, worker: true, xfo: true, type: 'text/html' },
  { path: '/api/analytics', status: 405, worker: true },
];

console.log(`Header matrix: ${CASES.length} URLs`);
for (const c of CASES) {
  const res = await get(c.path);
  const h = res.headers;
  const problems = [];
  if (res.status !== c.status) problems.push(`status ${res.status} ≠ ${c.status}`);
  if (c.cc && h.get('cache-control') !== c.cc) problems.push(`Cache-Control "${h.get('cache-control')}" ≠ "${c.cc}"`);
  if (!!h.get('x-pdfree-worker') !== c.worker) problems.push(c.worker ? 'not served by the Worker' : 'reached the Worker');
  if (c.xfo !== undefined && !!h.get('x-frame-options') !== c.xfo) problems.push(c.xfo ? 'X-Frame-Options missing' : 'X-Frame-Options present (embed must be frameable)');
  if (c.type && !(h.get('content-type') || '').includes(c.type)) problems.push(`Content-Type "${h.get('content-type')}" lacks ${c.type}`);
  if (c.status < 400 && h.get('x-content-type-options') !== 'nosniff') problems.push('X-Content-Type-Options: nosniff missing');
  if (c.body && !(await res.text()).includes(c.body)) problems.push(`body lacks "${c.body}"`);
  if (problems.length) fail(`${c.path}: ${problems.join('; ')}`);
  else console.log(`  ✓ ${c.path}`);
}

// ── 3. Worker invocations per real page load ──────────────────────────────
if (args.includes('--browser')) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const origin = new URL(base).origin;
  console.log('Worker invocations per page load (clean profile):');
  for (const serviceWorkers of ['block', 'allow']) {
    for (const path of ['/', '/merge-pdf/', '/ru/', '/pdf-to-word/']) {
      const ctx = await browser.newContext({ serviceWorkers });
      let total = 0;
      const reached = [];
      ctx.on('response', r => {
        if (new URL(r.url()).origin !== origin) return;
        total++;
        if (r.headers()['x-pdfree-worker']) reached.push(`${r.request().method()} ${new URL(r.url()).pathname}`);
      });
      const page = await ctx.newPage();
      await page.goto(base + path, { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);
      await ctx.close();
      const unexpected = reached.filter(r => !r.split(' ')[1].startsWith('/api/'));
      const line = `${path} (SW ${serviceWorkers === 'allow' ? 'on' : 'off'}): ${total} requests, ${reached.length} reached the Worker`;
      if (unexpected.length) fail(`${line} — non-API: ${unexpected.join(', ')}`);
      else console.log(`  ✓ ${line}`);
    }
  }
  await browser.close();
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nAll edge routing checks passed');
process.exit(failures.length ? 1 : 0);
