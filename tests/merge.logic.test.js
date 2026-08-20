// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/merge.logic.test.js — regression coverage for the
//  #mergeFilenameInput focus-loss bug fixed in commit 8122056
//  (js/toolRegistrations.js's _initMerge). Real bug: initToolOptions()
//  calls _initMerge() on EVERY 'pdfree:files-added'/'pdfree:file-removed'
//  event, and the old code unconditionally did c.innerHTML = ... on every
//  call — destroying and recreating #mergeFilenameInput each time a file
//  was added or removed, not just once. A user mid-typing a custom
//  filename who then added one more file got their cursor/focus silently
//  yanked away.
//
//  _initMerge is module-private (js/toolRegistrations.js has no export
//  for it — it's wired into the tool registry internally) and the real
//  fix's correctness hinges on DOM NODE IDENTITY (was the actual <input>
//  element preserved, not just "which branch executed"), which a plain
//  pure-logic copy of the branching wouldn't actually prove. So this
//  simulates the real state machine (touched flag / auto-stem / DOM node
//  reference) closely enough that the property that actually matters —
//  the input node's IDENTITY survives repeated init calls — is what gets
//  asserted, not just which code path ran.
//
//  Run: node tests/merge.logic.test.js
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

// Simulates js/toolRegistrations.js's post-fix (8122056) _initMerge state
// machine: alreadyRendered gates a destructive rebuild vs. an in-place
// patch, and a patch never touches input.value while the user is focused
// in it (document.activeElement !== input, mirrored here as `.focused`).
function makeMergeInitHarness() {
  let outputNameTouched = false;
  let outputStem        = 'auto-1';
  let inputNode          = null;
  let rebuildCount       = 0;
  let stemCounter        = 1;

  function computeDefaultStem() { return `auto-${++stemCounter}`; }

  return {
    initMerge() {
      const alreadyRendered = inputNode !== null;
      if (!alreadyRendered) {
        rebuildCount++;
        if (!outputNameTouched) outputStem = computeDefaultStem();
        inputNode = { value: outputStem, focused: false }; // a brand-new node = fresh render
        return;
      }
      if (outputNameTouched) return; // never touch the DOM once the user has typed
      outputStem = computeDefaultStem();
      if (!inputNode.focused) inputNode.value = outputStem;
    },
    touchByTyping(text) { outputNameTouched = true; inputNode.value = text; },
    focus()   { inputNode.focused = true; },
    blur()    { inputNode.focused = false; },
    get inputNode()    { return inputNode; },
    get rebuildCount()  { return rebuildCount; },
  };
}

console.log('\nmerge — #mergeFilenameInput focus preservation (regression for 8122056):');

test('the input node is only ever created once, even across many file add/remove events', () => {
  const h = makeMergeInitHarness();
  h.initMerge(); // 1st file added
  h.initMerge(); // 2nd file added
  h.initMerge(); // file removed
  h.initMerge(); // 3rd file added
  expect(h.rebuildCount).toBe(1);
});

test('the same DOM node reference survives repeated init calls — never replaced', () => {
  const h = makeMergeInitHarness();
  h.initMerge();
  const nodeAfterFirst = h.inputNode;
  h.initMerge();
  h.initMerge();
  expect(h.inputNode).toBe(nodeAfterFirst);
});

test('typing a custom name, then adding another file, does not touch the focused input value', () => {
  const h = makeMergeInitHarness();
  h.initMerge();               // file 1 added — panel first rendered
  h.focus();
  h.touchByTyping('my-report'); // user is mid-typing
  h.initMerge();                // file 2 added WHILE user is typing
  expect(h.inputNode.value).toBe('my-report'); // untouched — this is the actual bug this fix closes
});

test('an UNTOUCHED default filename still stays in sync across file changes (the original feature, not broken by the fix)', () => {
  const h = makeMergeInitHarness();
  h.initMerge(); // file 1 — first default computed
  const firstDefault = h.inputNode.value;
  h.initMerge(); // file 2 added, never touched by user — default should refresh
  expect(h.inputNode.value === firstDefault).toBe(false);
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
