// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/protect.logic.test.js — regression coverage for the
//  #protUserPwd/#protOwnerPwd silent-empty bug found + fixed during the
//  2026-08-21 Phase 3 audit (js/protectUI.js's initProtectOptions).
//
//  protect is multi:true/batch:true (config.js) — dropping a 2nd file
//  into the batch queue re-fires 'pdfree:files-added', which calls
//  initProtectOptions() again while the panel is already open. The old
//  code unconditionally called _render(), rebuilding both password
//  <input>s from a template with NO `value` attribute (passwords are
//  deliberately never baked into the HTML — see getProtectParams'
//  header comment: "never caches passwords across async gaps"). Since
//  getProtectParams() reads the password straight from the live DOM at
//  submit time, a password typed before the 2nd file landed would
//  silently revert to empty — a real, more severe variant of the
//  merge/jpg2pdf focus-loss bug class: not just lost focus, but a file
//  that could ship with NO open password while the user believed
//  they'd set one. Confirmed live via Playwright (typed a password,
//  dropped a 2nd file, field went from "hunter2secret" to "") before
//  fixing, and confirmed fixed the same way after.
//
//  initProtectOptions/_render are module-private with heavy real-DOM/
//  i18n/uiComponents dependencies (importing the real module in plain
//  Node isn't practical — same reasoning as merge.logic.test.js), so
//  this simulates the fixed state machine: an id-existence guard skips
//  the ENTIRE render (not a partial patch like merge's — protect's
//  panel has zero file-specific content, so "already rendered" means
//  "nothing to do at all").
//
//  Run: node tests/protect.logic.test.js
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

// Mirrors js/protectUI.js's post-fix initProtectOptions: a render only
// ever happens once; the password inputs are never touched again by any
// later init call, regardless of how many files get added to the batch.
function makeProtectInitHarness() {
  let userPwdNode  = null;
  let ownerPwdNode = null;
  let renderCount  = 0;

  return {
    initProtectOptions() {
      if (userPwdNode) return; // the actual fix — skip entirely if already rendered
      renderCount++;
      userPwdNode  = { value: '' }; // template has no `value` attribute — always starts empty
      ownerPwdNode = { value: '' };
    },
    typeUserPwd(text)  { userPwdNode.value  = text; },
    typeOwnerPwd(text) { ownerPwdNode.value = text; },
    get userPwdNode()  { return userPwdNode; },
    get ownerPwdNode() { return ownerPwdNode; },
    get renderCount()  { return renderCount; },
  };
}

console.log('\nprotect — password field survives batch file additions (regression):');

test('the panel is only ever rendered once, no matter how many files are queued', () => {
  const h = makeProtectInitHarness();
  h.initProtectOptions(); // file 1
  h.initProtectOptions(); // file 2 added to batch
  h.initProtectOptions(); // file 3 added to batch
  expect(h.renderCount).toBe(1);
});

test('a password typed before a 2nd file is added survives — the real bug this fix closes', () => {
  const h = makeProtectInitHarness();
  h.initProtectOptions();          // file 1 — panel renders
  h.typeUserPwd('hunter2secret');  // user types the open password
  h.initProtectOptions();          // file 2 dropped into the batch queue
  expect(h.userPwdNode.value).toBe('hunter2secret');
});

test('the owner password survives the same scenario', () => {
  const h = makeProtectInitHarness();
  h.initProtectOptions();
  h.typeOwnerPwd('owner-pass-1');
  h.initProtectOptions();
  h.initProtectOptions();
  expect(h.ownerPwdNode.value).toBe('owner-pass-1');
});

test('the same DOM node references survive repeated init calls — never replaced', () => {
  const h = makeProtectInitHarness();
  h.initProtectOptions();
  const userRef  = h.userPwdNode;
  const ownerRef = h.ownerPwdNode;
  h.initProtectOptions();
  h.initProtectOptions();
  expect(h.userPwdNode).toBe(userRef);
  expect(h.ownerPwdNode).toBe(ownerRef);
});

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
