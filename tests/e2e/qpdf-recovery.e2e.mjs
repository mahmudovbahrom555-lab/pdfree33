// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/qpdf-recovery.e2e.mjs — one qpdf abort must not break decryption
//  for the rest of the tab, and only a wrong password is called one (C33,
//  2026-11-06; acceptance pre-registered in tests/corpus/ERROR_CLASSES.md).
//
//  The site's js/qpdfWorker.js is served with a test probe in front of it
//  (Playwright route): the probe importScripts the real file, then — told
//  over a BroadcastChannel — breaks the qpdf instance (every call on it
//  throws, as an aborted Emscripten runtime does) or makes every call abort
//  "Aborted(OOM)". The real worker and decryptPdf.js do the rest; nothing in
//  the site is changed for the test, so it runs against pdfree.io too.
//
//  Run: node tests/e2e/qpdf-recovery.e2e.mjs   (dist/ served on :8934)
//       PDFREE_BASE_URL=https://pdfree.io node tests/e2e/qpdf-recovery.e2e.mjs
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const FIX = path.join(__dirname, '..', 'fixtures');
const LOCKED = path.join(FIX, 'unlock', 'qpdf-r4-ascii.pdf');   // open password secret-42
const RIGHT = 'secret-42';
const RESTRICTED = path.join(FIX, 'qpdf-recovery', 'restricted-no-open-password.pdf');

// Worker-side probe. It names nothing inside qpdfWorker.js (dist/ is minified):
// it catches the factory qpdf.js defines as the global `Module` and wraps every
// instance that factory makes.
const PROBE = `
let mode = 'off', realFactory = null, latest = null;
function wrap(inst) {
  const real = inst.callMain.bind(inst);
  let broken = false;
  inst.callMain = (args) => {
    if (mode === 'oom') throw new Error('Aborted(OOM)');
    if (broken) throw new WebAssembly.RuntimeError('memory access out of bounds');
    if (mode === 'break-once') { mode = 'off'; broken = true; throw new WebAssembly.RuntimeError('memory access out of bounds'); }
    return real(args);
  };
  latest = inst;
  return inst;
}
const wrapped = async (o) => wrap(await realFactory(o));
Object.defineProperty(self, 'Module', { configurable: true, get: () => (realFactory ? wrapped : undefined), set: v => { realFactory = v; } });
importScripts(${JSON.stringify('/js/qpdfWorker.js?real=1')});
const bc = new BroadcastChannel('qpdf-probe');
bc.onmessage = (e) => {
  const c = e.data || {};
  if (c.cmd === 'mode') { mode = c.mode; bc.postMessage({ ack: c.n }); }
  if (c.cmd === 'stats') {
    let files = [], streams = null;
    try { files = latest.FS.readdir('/').filter(n => !['.', '..', 'tmp', 'home', 'dev', 'proc'].includes(n)); } catch {}
    try { streams = latest.FS.streams.filter(Boolean).length; } catch {}
    bc.postMessage({ ack: c.n, files, streams });
  }
};
`;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ serviceWorkers: 'block' });
await ctx.route(/\/js\/qpdfWorker\.js(\?.*)?$/, (route) => {
  if (route.request().url().includes('real=1')) return route.continue();
  return route.fulfill({ status: 200, contentType: 'text/javascript', body: PROBE });
});
const page = await ctx.newPage();
const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
await page.goto(BASE_URL + '/unlock-pdf/', { waitUntil: 'load' });

const b64 = p => fs.readFileSync(p).toString('base64');
await page.evaluate(([locked, restricted]) => {
  const bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  window.__fx = { locked: bytes(locked), restricted: bytes(restricted) };
  const bc = new BroadcastChannel('qpdf-probe'); let n = 0; const wait = new Map();
  bc.onmessage = e => { const r = wait.get(e.data.ack); if (r) { wait.delete(e.data.ack); r(e.data); } };
  window.__probe = (msg) => new Promise(r => { const k = ++n; wait.set(k, r); bc.postMessage({ ...msg, n: k }); setTimeout(() => r(null), 5000); });
}, [b64(LOCKED), b64(RESTRICTED)]);

// One call through decryptPdf.js → 'ok' | 'null' | the thrown message.
const call = (fn, pw) => page.evaluate(async ([fn, pw]) => {
  const m = await import('/js/decryptPdf.js');
  try {
    const out = fn === 'owner' ? await m.decryptOwnerOnly(window.__fx.restricted.slice()) : await m.decryptWithPassword(window.__fx.locked.slice(), pw);
    return out ? (out.length > 100 && String.fromCharCode(...out.subarray(0, 5)) === '%PDF-' ? 'ok' : 'bad-bytes') : 'null';
  } catch (e) { return 'throw:' + e.message; }
}, [fn, pw]);
const mode = m => page.evaluate(m => window.__probe({ cmd: 'mode', mode: m }), m);
const stats = () => page.evaluate(() => window.__probe({ cmd: 'stats' }));

console.log('\nC33 — qpdf recovery and honest verdicts');

await test('1. 400 right passwords → 400 decrypted', async () => {
  const r = await page.evaluate(async (pw) => {
    const m = await import('/js/decryptPdf.js'); let ok = 0;
    for (let i = 0; i < 400; i++) if (await m.decryptWithPassword(window.__fx.locked.slice(), pw)) ok++;
    return ok;
  }, RIGHT);
  assert(r === 400, `${r}/400`);
});

await test('2. 800 runs, 2 in 3 wrong → right ones decrypt, wrong ones null, no abort; nothing left open', async () => {
  const before = await stats();
  const r = await page.evaluate(async (pw) => {
    const m = await import('/js/decryptPdf.js'); const bad = [];
    for (let i = 1; i <= 800; i++) {
      const right = i % 3 === 0;
      let v; try { v = await m.decryptWithPassword(window.__fx.locked.slice(), right ? pw : 'wrong-' + i); v = v ? 'ok' : 'null'; } catch (e) { v = 'throw:' + e.message; }
      if (v !== (right ? 'ok' : 'null')) { bad.push(i + ':' + v); if (bad.length > 3) break; }
    }
    return bad;
  }, RIGHT);
  assert(r.length === 0, 'wrong results: ' + r.join(' | '));
  const after = await stats();
  assert(after && after.files.length === 0, 'files left: ' + JSON.stringify(after));
  assert(after.streams <= (before?.streams ?? 3), `open streams ${before?.streams} → ${after.streams}`);
});

await test('3. a broken instance → the next right password decrypts', async () => {
  await mode('break-once');
  const v = await call('pw', RIGHT);
  assert(v === 'ok', v);
});

await test('4. out of memory on every try → QPDF_OUT_OF_MEMORY; then the next file decrypts', async () => {
  await mode('oom');
  const v = await call('pw', RIGHT);
  assert(v === 'throw:QPDF_OUT_OF_MEMORY', v);
  await mode('off');
  const v2 = await call('pw', RIGHT);
  assert(v2 === 'ok', 'after OOM: ' + v2);
});

await test('5. after recovery: wrong password → null, right → decrypted', async () => {
  await mode('break-once');
  const w = await call('pw', 'nope');
  const r = await call('pw', RIGHT);
  assert(w === 'null' && r === 'ok', `wrong ${w}, right ${r}`);
});

await test('6. restricted PDF without an open password → decrypted, not "needs password"', async () => {
  const v = await call('owner');
  assert(v === 'ok', v);
});

await test('7. five abort–recovery cycles, each with a wrong and a right password', async () => {
  const seen = [];
  for (let i = 0; i < 5; i++) {
    await mode('break-once');
    seen.push(await call('pw', 'nope-' + i), await call('pw', RIGHT));
  }
  assert(seen.join() === Array(5).fill('null,ok').join(), seen.join());
});

await test('8. after an abort, the restricted file still decrypts', async () => {
  await mode('break-once');
  const v = await call('owner');
  assert(v === 'ok', v);
});

await test('9. Unlock UI after an abort: right password → success, wrong → "incorrect"', async () => {
  const p2 = await ctx.newPage();
  await p2.goto(BASE_URL + '/unlock-pdf/', { waitUntil: 'load' });
  await p2.setInputFiles('#fileInput', LOCKED);
  await p2.waitForSelector('#fileList .file-item', { timeout: 30000 });
  await p2.waitForTimeout(1500);
  await p2.evaluate(() => new Promise(r => { const bc = new BroadcastChannel('qpdf-probe'); bc.onmessage = () => r(); bc.postMessage({ cmd: 'mode', mode: 'break-once', n: 1 }); setTimeout(r, 3000); }));
  const pwInput = p2.locator('#unlockPwd');
  await pwInput.fill('wrong-ui');
  await p2.click('#mergeBtn');
  await p2.waitForFunction(() => { const t = document.querySelector('#toast'); return t && /incorrect|wrong/i.test(t.textContent); }, null, { timeout: 30000 });
  await pwInput.fill(RIGHT);
  await p2.click('#mergeBtn');
  await p2.waitForFunction(() => { const c = document.querySelector('#successCard'); return c && !c.hidden && getComputedStyle(c).display !== 'none'; }, null, { timeout: 30000 });
  await p2.close();
});

if (pageErrors.length) console.log('  page errors:', pageErrors.slice(0, 3).join(' | '));
await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
