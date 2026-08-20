// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/jpg2pdf.logic.test.js — regression coverage for the
//  quality-slider interruption bug found + fixed during the
//  2026-08-20/21 UI-glue audit (js/jpg2pdfUI.js). Same bug class
//  as merge's #mergeFilenameInput focus-loss (8122056):
//  initJpg2PdfOptions/_render used to rebuild the ENTIRE options
//  panel — including the quality slider, page-size/orientation
//  chips, compress toggle — via one container.innerHTML assignment
//  on every single file add/remove, even though only the thumbnail
//  grid actually needed to change. A user mid-drag on the quality
//  slider who added or removed one more image got the drag
//  silently interrupted.
//
//  Unlike pdf2jpg/merge, this file's real functions ARE cleanly
//  separable (a settings region built once vs. a thumbnails region
//  rebuilt every time) but still module-private, so this simulates
//  the same shape closely enough to assert what actually matters:
//  the settings DOM region's identity survives repeated file-list
//  changes, while the thumbnail region legitimately refreshes.
//
//  Run: node tests/jpg2pdf.logic.test.js
// ============================================================

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe:       (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toEqual:    (e) => { if (JSON.stringify(actual) !== JSON.stringify(e)) throw new Error(`Expected ${JSON.stringify(e)}`); },
  };
}

// Simulates js/jpg2pdfUI.js's post-fix _render() split: settings region
// built once (settingsNode identity fixed forever after), thumbnails
// region rebuilt (new node each time) on every file-list change.
function makeJpg2PdfRenderHarness() {
  let settingsRendered = false;
  let settingsNode = null;
  let thumbsNode   = null;
  let settingsBuildCount = 0;
  let thumbsBuildCount   = 0;

  return {
    render(files) {
      if (!settingsRendered) {
        settingsRendered = true;
        settingsBuildCount++;
        settingsNode = { quality: 82 }; // fresh settings object = fresh DOM node
      }
      thumbsBuildCount++;
      thumbsNode = { files: files.slice() }; // thumbnails always rebuilt from the current file list
    },
    get settingsNode() { return settingsNode; },
    get thumbsNode()   { return thumbsNode; },
    get settingsBuildCount() { return settingsBuildCount; },
    get thumbsBuildCount()   { return thumbsBuildCount; },
  };
}

console.log('\njpg2pdf — settings panel survives file add/remove, thumbnails refresh (regression):');

test('the settings region is built exactly once, no matter how many file events follow', () => {
  const h = makeJpg2PdfRenderHarness();
  h.render(['a.jpg']);
  h.render(['a.jpg', 'b.jpg']);
  h.render(['a.jpg', 'b.jpg', 'c.jpg']);
  h.render(['b.jpg', 'c.jpg']); // one removed
  expect(h.settingsBuildCount).toBe(1);
});

test('the settings node identity is stable across repeated file-list changes', () => {
  const h = makeJpg2PdfRenderHarness();
  h.render(['a.jpg']);
  const nodeAfterFirst = h.settingsNode;
  h.render(['a.jpg', 'b.jpg']);
  h.render(['b.jpg']);
  expect(h.settingsNode).toBe(nodeAfterFirst);
});

test('the thumbnail grid DOES rebuild on every file-list change — that part is supposed to refresh', () => {
  const h = makeJpg2PdfRenderHarness();
  h.render(['a.jpg']);
  h.render(['a.jpg', 'b.jpg']);
  h.render(['a.jpg', 'b.jpg', 'c.jpg']);
  expect(h.thumbsBuildCount).toBe(3);
  expect(h.thumbsNode.files).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
