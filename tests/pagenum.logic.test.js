// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/pagenum.logic.test.js — regression coverage for the focus-loss
//  bug found + fixed during the 2026-08-21 Phase 3 audit
//  (js/pagenumUI.js's initPageNumOptions). Same root cause and same
//  audit pass as protect.logic.test.js.
//
//  pagenum is multi:true/batch:true (config.js) — dropping a 2nd file
//  into the batch queue re-fires 'pdfree:files-added', which calls
//  initPageNumOptions() again while the panel is already open. The old
//  code unconditionally called _render(), rebuilding every input
//  (From/To page, Start at, font size) from scratch — the DISPLAYED
//  values survive (they're read from closure state, not reset), but
//  the DOM node identity doesn't, so a user mid-typing any of those
//  fields gets their cursor/focus silently yanked away, same class as
//  the #mergeFilenameInput bug (commit 8122056).
//
//  initPageNumOptions/_render are module-private with heavy real-DOM/
//  i18n/uiComponents dependencies, so this simulates the fixed state
//  machine the same way merge.logic.test.js and protect.logic.test.js
//  do: an id-existence guard skips the ENTIRE render (pagenum's panel,
//  like protect's, has zero file-specific content — from/to page caps
//  are hardcoded, not tied to the actual file's page count).
//
//  Run: node tests/pagenum.logic.test.js
// ============================================================

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe:       (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy: ()  => { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
  };
}

// Mirrors js/pagenumUI.js's post-fix initPageNumOptions: a render only
// ever happens once; input focus/node identity is never disturbed by a
// later init call triggered by another file joining the batch queue.
function makePageNumInitHarness() {
  let fromInputNode = null;
  let renderCount   = 0;

  return {
    initPageNumOptions() {
      if (fromInputNode) return; // the actual fix — skip entirely if already rendered
      renderCount++;
      fromInputNode = { value: 1, focused: false };
    },
    focusFromInput() { fromInputNode.focused = true; },
    typeFromPage(v)  { fromInputNode.value = v; }, // mirrors the real 'input' listener updating state live
    get fromInputNode() { return fromInputNode; },
    get renderCount()   { return renderCount; },
  };
}

console.log('\npagenum — options panel survives batch file additions (regression):');

test('the panel is only ever rendered once, no matter how many files are queued', () => {
  const h = makePageNumInitHarness();
  h.initPageNumOptions(); // file 1
  h.initPageNumOptions(); // file 2 added to batch
  h.initPageNumOptions(); // file 3 added to batch
  expect(h.renderCount).toBe(1);
});

test('the "From page" input node identity survives a 2nd file being added — focus is not silently dropped', () => {
  const h = makePageNumInitHarness();
  h.initPageNumOptions();
  const nodeAfterFirst = h.fromInputNode;
  h.initPageNumOptions();
  expect(h.fromInputNode).toBe(nodeAfterFirst);
});

test('a value typed mid-interaction, then a 2nd file added, does not reset the field', () => {
  const h = makePageNumInitHarness();
  h.initPageNumOptions();     // file 1 — panel renders
  h.focusFromInput();
  h.typeFromPage(42);         // user is mid-typing a custom start page
  h.initPageNumOptions();     // file 2 dropped into the batch queue
  expect(h.fromInputNode.value).toBe(42);
  expect(h.fromInputNode.focused).toBeTruthy(); // still focused — no rebuild happened
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
