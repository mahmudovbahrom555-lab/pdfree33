// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// OCR on a slow or stalling connection (2026-10-29). "OCR engine load timed
// out" — CN Safari, HK Edge, PS Safari, 2026-10-24..28: one 120 s limit
// covered downloading the 3.9 MB core and the models, so a slow line still
// receiving was cut off. js/ocrEngine.js now downloads them itself, watching
// for silence (30 s) instead of total time, and starts a stalled download
// again.
//
// dist/ is served here by a server that sends the core slowly (~150 s) or
// stops halfway through its first request. Both must end with a searchable
// PDF — and the core must cross the wire once, not twice (the engine takes it
// from the browser's cache). The old build fails both at 120 s.
//
// Minutes, not in the CI gate. Run: node tests/e2e/ocr-slow-download.e2e.mjs
// (DIST=<dir> to serve another build; default dist/).

import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(process.env.DIST || path.join(__dirname, '..', '..', 'dist'));
const SCAN = path.join(__dirname, '..', 'fixtures', 'ocr_scan_ar_en.pdf');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// mode: 'slow' — the core at ~26 KB/s; 'stall' — the core's first request
// stops after 1 MB and never ends
function serve(mode) {
  const core = { requests: 0, finished: 0 };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(DIST, p);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    const body = fs.readFileSync(file);
    const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' };
    // as production's _headers: /js/vendor/ is cacheable for an hour
    if (p.startsWith('/js/vendor/')) headers['Cache-Control'] = 'public, max-age=3600';
    if (!/tesseract-core-.*\.wasm\.js$/.test(p)) { res.writeHead(200, headers); res.end(body); return; }
    const n = ++core.requests;
    res.writeHead(200, headers);
    const chunk = 13 * 1024;
    let off = 0;
    const tick = () => {
      if (res.destroyed) return;
      if (mode === 'stall' && n === 1 && off >= 1 << 20) return;    // silence, never ends
      res.write(body.subarray(off, off + chunk));
      off += chunk;
      if (off >= body.length) { core.finished++; res.end(); return; }
      setTimeout(tick, mode === 'slow' ? 500 : 5);
    };
    tick();
  });
  return new Promise(r => server.listen(0, () => r({ server, core, url: `http://localhost:${server.address().port}` })));
}

const browser = await chromium.launch();
for (const mode of ['slow', 'stall']) {
  await test(`OCR with the core sent ${mode === 'slow' ? 'slowly (~150 s)' : 'with a stall halfway'}: a searchable PDF, the core downloaded once`, async () => {
    const { server, core, url } = await serve(mode);
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const page = await ctx.newPage();
      await page.addInitScript(() => {
        const o = URL.createObjectURL.bind(URL);
        URL.createObjectURL = x => { if (x instanceof Blob && x.type === 'application/pdf') window.__pdf = x; return o(x); };
      });
      await page.goto(`${url}/ocr-pdf/`, { waitUntil: 'load' });
      await page.setInputFiles('#fileInput', SCAN);
      await page.waitForSelector('#ocrLangSelect', { timeout: 60000 });
      await page.selectOption('#ocrLangSelect', 'ara+eng');
      await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 60000 });
      await page.click('#mergeBtn');
      const done = await page.waitForFunction(() => window.__pdf || /error|timed out/i.test(document.querySelector('#toast.show')?.innerText || ''), null, { timeout: 420000 })
        .then(() => page.evaluate(() => (window.__pdf ? 'pdf' : document.querySelector('#toast')?.innerText)), () => 'nothing in 7 min');
      if (done !== 'pdf') throw new Error(`${done} (core: ${core.requests} requests, ${core.finished} finished)`);
      if (core.finished !== 1) throw new Error(`the core was downloaded ${core.finished} times in full (${core.requests} requests)`);
    } finally {
      await ctx.close();
      server.closeAllConnections();
      server.close();
    }
  });
}
await browser.close();
console.log(`\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
process.exit(failed ? 1 : 0);
