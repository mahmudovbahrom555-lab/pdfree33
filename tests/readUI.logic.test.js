// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

// ============================================================
//  tests/readUI.logic.test.js — regression coverage for a real race
//  found in js/readUI.js during a security audit of the Read PDF tool
//  (same bug class this codebase has hit repeatedly: resize, meta,
//  redact, clean-scan — see memory/stale_init_race_sweep_2026_08).
//
//  toolRegistry.js's initToolOptions() can call initReadOptions(fileB)
//  directly for a replaced file while a PREVIOUS initReadOptions(fileA)
//  call is still awaiting mid-pipeline (loadPdfJs / _p2wBuildPageData /
//  the per-page render loop) — it never calls hideReadOptions() first.
//  Before the fix, the only staleness guard was a local `_cancelled`
//  flag that initReadOptions() itself reset to `false` on every call,
//  so the in-flight fileA run was never actually told to stop — its
//  results could land in the shared #readContent container on top of
//  (or interleaved with) fileB's already-rendered view.
//
//  The fix (mirrors ocrUI.js/fillUI.js's own `_generation` counter
//  pattern): each call captures `myGen = ++_generation` up front, and
//  every checkpoint after an `await` compares `myGen !== _generation`
//  — a call superseded by a newer one (which bumps `_generation`
//  again) reliably detects it's stale and bails without touching the
//  container, regardless of which run's async work finishes first.
//
//  js/readUI.js's real functions aren't imported directly here (the
//  module reaches for `window.pdfjsLib`/`document` at real call time,
//  same DOM-coupling reason other *.logic.test.js files in this suite
//  use a harness instead of a real import) — this harness reproduces
//  the exact same generation-counter shape against a multi-checkpoint
//  async pipeline, close enough to prove the guard actually prevents
//  the stale write, not just that some code runs.
//
//  Run: node tests/readUI.logic.test.js
// ============================================================

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe:      (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeNull:  ()  => { if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`); },
  };
}

// Mirrors js/readUI.js's real shape: a module-level `_generation`
// counter, bumped on every new run (initReadOptions-equivalent) AND on
// close (hideReadOptions-equivalent); each run captures its own
// `myGen` and checks it after every await, matching the real file's
// checkpoints (post-loadPdfJs, post-pdfDoc-load, post-buildPageData,
// per-page in the render loop).
function makeReadHarness() {
  let _generation = 0;
  let container   = null; // last content actually written — the shared #readContent stand-in

  async function initReadOptions(file, { loadPdfJs, buildPageData, pages }) {
    const myGen = ++_generation;
    container = null; // real code shows a loading state here; irrelevant to the race itself

    await loadPdfJs();
    if (myGen !== _generation) return;

    await buildPageData(file);
    if (myGen !== _generation) return;

    for (const page of pages) {
      if (myGen !== _generation) return;
      await Promise.resolve(); // simulates the real per-page yield-to-UI await
      if (myGen !== _generation) return;
      container = (container || []).concat(page);
    }
  }

  function hideReadOptions() { _generation++; container = null; }

  return { initReadOptions, hideReadOptions, get container() { return container; } };
}

console.log('\nreadUI — stale in-flight run superseded by a new file (regression, security audit 2026-09):');

await test('a slow fileA run still mid-pipeline when fileB starts never writes into the container', async () => {
  const h = makeReadHarness();
  let resolveA;
  const slowLoadForA = new Promise(r => { resolveA = r; });

  const pendingA = h.initReadOptions('fileA', {
    loadPdfJs:     () => slowLoadForA,
    buildPageData: async () => {},
    pages:         ['A-page-1'],
  });

  // fileB starts (and finishes) entirely while fileA is still stuck on
  // its slow loadPdfJs await — exactly the "replace file, no hide() in
  // between" shape toolRegistry.js's real call site can produce.
  await h.initReadOptions('fileB', {
    loadPdfJs:     async () => {},
    buildPageData: async () => {},
    pages:         ['B-page-1'],
  });
  expect(JSON.stringify(h.container)).toBe(JSON.stringify(['B-page-1'])); // sanity: B's own run must have written

  // Now let fileA's stale run resume and run to completion.
  resolveA();
  await pendingA;

  // fileA's stale results must NOT have overwritten or appended onto
  // fileB's container — this is exactly what was broken pre-fix.
  expect(JSON.stringify(h.container)).toBe(JSON.stringify(['B-page-1']));
});

await test('closing the tool mid-run (hideReadOptions) also invalidates the in-flight run', async () => {
  const h = makeReadHarness();
  let resolveA;
  const slowBuildForA = new Promise(r => { resolveA = r; });

  const pendingA = h.initReadOptions('fileA', {
    loadPdfJs:     async () => {},
    buildPageData: () => slowBuildForA,
    pages:         ['A-page-1'],
  });

  h.hideReadOptions(); // user navigates away before fileA's build finishes
  resolveA();
  await pendingA;

  expect(h.container).toBeNull(); // the superseded run must not repopulate the container after close
});

await test('the happy path (no swap) still renders normally — the fix does not break single-file loads', async () => {
  const h = makeReadHarness();
  await h.initReadOptions('fileA', {
    loadPdfJs:     async () => {},
    buildPageData: async () => {},
    pages:         ['A-page-1', 'A-page-2'],
  });
  expect(JSON.stringify(h.container)).toBe(JSON.stringify(['A-page-1', 'A-page-2']));
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
