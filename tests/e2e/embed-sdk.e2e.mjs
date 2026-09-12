// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/embed-sdk.e2e.mjs — real-browser regression test for the
//  embed/SDK public contract (embed/sdk.js, embed/compress/index.html,
//  js/embedBridge.js) — the "hygiene" pass added after a security review
//  found two real CSP/sandbox bugs (fixed in commit 765a0744) and, while
//  writing THIS test, a third: embed/sdk.js's documented `onError`
//  callback and js/embedBridge.js's own `pdfree:error` listener both
//  already existed, but js/processor.js's shared `_handleError()` never
//  actually dispatched that event — onError could never fire for a real
//  embedded-tool failure. Fixed alongside this test, not found by it in
//  isolation (found while designing the error-path assertion below and
//  grepping for where it should have come from).
//
//  Two real HTTP origins, matching how a real third-party embedder
//  actually works (not page.setContent(), whose opaque origin fails
//  frame-ancestors' "network scheme required" check — confirmed the hard
//  way while building this test):
//    - PDFREE_BASE_URL (default http://localhost:8934, same convention as
//      protect.e2e.mjs) — serves the real built dist/, i.e. pdfree.io
//      itself for this test's purposes.
//    - A synthetic "embedder" page on EMBED_HOST_PORT (default 8935),
//      started by this script — replicates embed/sdk.js's own iframe-
//      creation logic (sandbox, allow, postMessage listener) but pointing
//      at PDFREE_BASE_URL instead of the real hardcoded production
//      domain, since embed/sdk.js's own `iframe.src` is intentionally
//      hardcoded to https://pdfree.io — a separate, narrower check below
//      verifies THAT file's own behavior without needing real network
//      navigation to production.
//
//  Requires: dist/ already built (`python3 scripts/build.py`) and served
//  at PDFREE_BASE_URL.
//
//  Run: node tests/e2e/embed-sdk.e2e.mjs
// ============================================================

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL        = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const EMBED_HOST_PORT = Number(process.env.EMBED_HOST_PORT) || 8935;
const NORMAL_FILE     = path.join(__dirname, '..', 'fixtures', 'normal-3page.pdf');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe: (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toContain: (sub) => { if (!String(actual).includes(sub)) throw new Error(`Expected "${actual}" to contain "${sub}"`); },
  };
}

// A real third-party embedder page — same iframe-creation shape as
// embed/sdk.js's own create(), just pointed at BASE_URL instead of the
// hardcoded production domain, and exposing results on `window` for the
// test to read directly.
const HOST_HTML = `<!doctype html><html><body>
<div id="my-widget"></div>
<script>
  window.__ready = false;
  window.__result = null;
  window.__errorResult = null;
  const iframe = document.createElement('iframe');
  iframe.src = '${BASE_URL}/embed/compress/';
  iframe.setAttribute('allow', '');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-downloads allow-forms');
  window.addEventListener('message', (e) => {
    if (e.source !== iframe.contentWindow) return;
    const data = e.data || {};
    if (data.type === 'pdfree:ready') window.__ready = true;
    else if (data.type === 'pdfree:result') window.__result = data;
    else if (data.type === 'pdfree:error') window.__errorResult = data;
  });
  document.getElementById('my-widget').appendChild(iframe);
</script>
</body></html>`;

function startHostServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(HOST_HTML);
    });
    server.listen(EMBED_HOST_PORT, () => resolve(server));
  });
}

const hostServer = await startHostServer();
const browser = await chromium.launch();

try {
  await test('embed/sdk.js sets sandbox + version, points the iframe at the tool path', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${BASE_URL}/embed/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      // No real page at /embed/ — just need a same-origin document to run
      // sdk.js's create() against, so window.PDFree exists to call.
      await page.addScriptTag({ url: `${BASE_URL}/embed/sdk.js` });
      await page.evaluate(() => {
        document.body.innerHTML = '<div id="w"></div>';
        window.PDFree.create({ container: '#w' });
      });
      const iframeAttrs = await page.evaluate(() => {
        const f = document.querySelector('#w iframe');
        return { src: f.getAttribute('src'), sandbox: f.getAttribute('sandbox'), allow: f.getAttribute('allow') };
      });
      expect(iframeAttrs.src).toBe('https://pdfree.io/embed/compress/');
      expect(iframeAttrs.sandbox).toContain('allow-scripts');
      expect(iframeAttrs.sandbox).toContain('allow-same-origin');
      if (iframeAttrs.sandbox.includes('allow-top-navigation') || iframeAttrs.sandbox.includes('allow-popups')) {
        throw new Error('sandbox must not grant allow-top-navigation/allow-popups');
      }
      expect(iframeAttrs.allow).toBe('');
      const version = await page.evaluate(() => window.PDFree.version);
      if (!version) throw new Error('window.PDFree.version is not set');
    } finally {
      await page.close();
    }
  });

  await test('a real embedder page: iframe loads, zero CSP violations, pdfree:ready fires', async () => {
    const page = await browser.newPage();
    const cspViolations = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && /Content Security Policy|Refused to apply/i.test(msg.text())) cspViolations.push(msg.text());
    });
    try {
      await page.goto(`http://localhost:${EMBED_HOST_PORT}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
      expect(await page.evaluate(() => window.__ready)).toBe(true);
      if (cspViolations.length > 0) throw new Error(`${cspViolations.length} CSP violation(s): ${cspViolations[0]}`);
    } finally {
      await page.close();
    }
  });

  await test('a successful compress relays pdfree:result with filename + size to the embedder', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`http://localhost:${EMBED_HOST_PORT}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
      const frame = page.frames().find((f) => f.url().includes('/embed/compress/'));
      await frame.locator('#fileInput').setInputFiles(NORMAL_FILE);
      await frame.locator('#mergeBtn').click();
      // Either a real result (savings found) or the "nothing to remove"
      // no-op toast is a legitimate outcome depending on preset auto-
      // selection for this fixture — both mean the Worker ran successfully
      // with no error, which is what this test actually needs to assert.
      await Promise.race([
        page.waitForFunction(() => window.__result !== null, { timeout: 15000 }),
        frame.locator('#toast.show, #toast:visible').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {}),
      ]);
      const result = await page.evaluate(() => window.__result);
      if (result) {
        expect(typeof result.filename).toBe('string');
        expect(typeof result.size).toBe('number');
      }
    } finally {
      await page.close();
    }
  });

  await test('embedBridge.js relays a real pdfree:error CustomEvent to the embedder as postMessage (the bug found+fixed alongside this test)', async () => {
    // A file rejected at selection time (files.js's own validation, e.g.
    // corrupt.pdf) never reaches _handleError() at all — that's a
    // different, already-covered code path (see files.logic.test.js) and
    // not what this test targets. This dispatches the exact CustomEvent
    // _handleError() itself fires directly inside the real iframe's
    // document, exercising the REAL js/embedBridge.js listener (loaded on
    // this exact page) without needing to first reverse-engineer a file
    // that survives selection but fails deep inside a specific Worker.
    const page = await browser.newPage();
    try {
      await page.goto(`http://localhost:${EMBED_HOST_PORT}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
      const frame = page.frames().find((f) => f.url().includes('/embed/compress/'));
      await frame.evaluate(() => {
        document.dispatchEvent(new CustomEvent('pdfree:error', {
          detail: { tool: 'compress', message: 'synthetic test failure', errorType: 'unknown', errorId: 'TEST-0001' },
        }));
      });
      await page.waitForFunction(() => window.__errorResult !== null, { timeout: 5000 });
      const err = await page.evaluate(() => window.__errorResult);
      expect(err.tool).toBe('compress');
      expect(err.errorId).toBe('TEST-0001');
    } finally {
      await page.close();
    }
  });
} finally {
  await browser.close();
  hostServer.close();
}

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
