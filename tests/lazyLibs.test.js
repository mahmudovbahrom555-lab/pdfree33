// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/lazyLibs.test.js — Lazy-Load Guard tests for
//  js/lazyLibs.js. Real bug found + fixed during the 2026-08-20/21
//  testing pass: _load() (the shared helper behind loadPdfLib/
//  loadJSZip) cached a REJECTED promise forever — one transient
//  CDN failure permanently broke that loader for the rest of the
//  page session, since every later call just replayed the same
//  cached rejection instead of trying again. loadDocx/loadExcelJs/
//  loadPptxGenJs already had the correct "clear cache on failure"
//  pattern; _load() didn't.
//
//  Real imports (not pure-copied) — lazyLibs.js has no heavy DOM
//  dependency beyond document.createElement('script')/head.appendChild,
//  which this file stubs to control onload/onerror manually and
//  simulate real network failure/recovery without a real network.
//
//  Run: node tests/lazyLibs.test.js
// ============================================================

// Minimal document stub: createElement('script') returns a controllable
// fake element; appendChild just records it so a test can fire its
// onload/onerror by hand, simulating a real CDN <script> tag's lifecycle.
const _createdScripts = [];
global.document = {
  createElement: (tag) => {
    const el = { tag, src: '', onload: null, onerror: null };
    return el;
  },
  head: {
    appendChild: (el) => { _createdScripts.push(el); },
  },
};
global.window = {};

const { loadJSZip, loadPdfLib } = await import('../js/lazyLibs.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe:       (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy: ()  => { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
  };
}

function lastScript() { return _createdScripts[_createdScripts.length - 1]; }

console.log('\nlazyLibs — Lazy-Load Guards (CDN failure/retry, see 2026-08-20/21 fix):');

await test('a failed load can be retried — the SAME loader tries again, not a cached rejection', async () => {
  delete global.window.JSZip;
  _createdScripts.length = 0;

  const first = loadJSZip();
  lastScript().onerror(); // simulate the CDN request failing
  let firstRejected = false;
  try { await first; } catch { firstRejected = true; }
  expect(firstRejected).toBeTruthy();

  // A second call after the failure must attempt a REAL new load (a new
  // <script> tag), not just replay the same rejected promise.
  const scriptCountBefore = _createdScripts.length;
  const second = loadJSZip();
  expect(_createdScripts.length > scriptCountBefore).toBeTruthy(); // a new script element was created
  global.window.JSZip = {}; // simulate the retry succeeding this time
  lastScript().onload();
  await second; // must resolve, not throw
});

await test('if the library global already exists, no script is loaded at all', async () => {
  global.window.JSZip = {};
  _createdScripts.length = 0;
  await loadJSZip();
  expect(_createdScripts.length).toBe(0);
});

await test('loadPdfLib has the same retry-after-failure guarantee (shares the fixed _load() helper)', async () => {
  delete global.window.PDFLib;
  _createdScripts.length = 0;

  const first = loadPdfLib();
  lastScript().onerror();
  let firstRejected = false;
  try { await first; } catch { firstRejected = true; }
  expect(firstRejected).toBeTruthy();

  const scriptCountBefore = _createdScripts.length;
  const second = loadPdfLib();
  expect(_createdScripts.length > scriptCountBefore).toBeTruthy();
  global.window.PDFLib = {};
  lastScript().onload();
  await second;
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
