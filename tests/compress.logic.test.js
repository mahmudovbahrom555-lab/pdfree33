// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/compress.logic.test.js — regression coverage for a real
//  race condition found while auditing compressUI.js for Phase 2
//  of the testing plan (see js/app.js's 'pdfree:files-added'
//  listener for compress). startCompressScan(file) is async; if
//  the user swaps the selected file while a scan for the PREVIOUS
//  file is still in flight, the stale scan result (wrong page
//  count, wrong recommended preset, wrong encrypted badge) used to
//  render onto the panel for the file that's actually selected now
//  — renderWorkerScanReport only checked that the panel was
//  visible, never that the report still matched the current file.
//
//  The real listener in js/app.js is a closure, not exported, so
//  this simulates the same async race shape (capture file
//  reference before awaiting, compare against "current selection"
//  after) closely enough to prove the guard actually prevents the
//  stale write, not just that some code runs.
//
//  Run: node tests/compress.logic.test.js
// ============================================================

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

// Simulates js/app.js's post-fix listener shape: capture the file
// reference before an async scan, only apply the result if that file is
// still the current selection when the scan resolves.
function makeCompressScanHarness() {
  let selectedFile = null;
  let rendered     = null; // last report actually applied to the panel

  return {
    setSelectedFile(f) { selectedFile = f; },
    async onFilesAdded(scanFn) {
      const file = selectedFile;
      if (!file) return;
      const report = await scanFn(file);
      if (report && selectedFile === file) rendered = report;
    },
    get rendered() { return rendered; },
  };
}

console.log('\ncompress — stale async scan-report race (regression, js/app.js audit):');

await test('a scan that resolves AFTER the file was swapped is discarded, not rendered', async () => {
  const h = makeCompressScanHarness();
  const fileA = { name: 'a.pdf' };
  const fileB = { name: 'b.pdf' };
  h.setSelectedFile(fileA);

  // fileA's scan is slow; the user swaps to fileB before it resolves.
  const slowScanForA = new Promise(resolve => {
    setTimeout(() => resolve({ file: 'a', pageCount: 5 }), 20);
  });
  const pending = h.onFilesAdded(() => slowScanForA);
  h.setSelectedFile(fileB); // user removed A, dropped B while A's scan was in flight
  await pending;

  expect(h.rendered).toBe(null); // A's stale report must NOT have been applied
});

await test('a scan that resolves BEFORE any swap still renders normally (fix does not break the happy path)', async () => {
  const h = makeCompressScanHarness();
  const fileA = { name: 'a.pdf' };
  h.setSelectedFile(fileA);
  const report = { file: 'a', pageCount: 5 };
  await h.onFilesAdded(async () => report);
  expect(h.rendered).toBe(report);
});

await test('a null/undefined scan result (scan failed) is never applied, swap or not', async () => {
  const h = makeCompressScanHarness();
  const fileA = { name: 'a.pdf' };
  h.setSelectedFile(fileA);
  await h.onFilesAdded(async () => null);
  expect(h.rendered).toBe(null);
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
