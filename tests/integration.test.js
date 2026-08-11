// SPDX-License-Identifier: AGPL-3.0-only
// Integration test: verifies consistency across config.js, toolRegistrations.js,
// and processor.js WITHOUT importing DOM-dependent UI modules.
//
// What this catches:
//   • Tool added to TOOLS but registerTool() never called → silent 'stub' runner
//   • registerTool() call without matching TOOLS entry → orphan registration
//   • runner: 'typo' that doesn't exist in processor.js runnerMap → silent fallback
//   • New runner type added to registrations but missing from processor.js
//
// Approach: read source files as text + parse with regex, then import config.js
// (which has no DOM dependency). This avoids importing UI modules (which use
// document.getElementById) and keeps the test runnable in Node.js.

import { readFileSync } from 'fs';
import { strict as assert } from 'assert';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

// Known runner keys in processor.js runnerMap.
// If you add a new runner there, add it here too.
const KNOWN_RUNNERS = new Set(['merge', 'split', 'compress', 'jpg2pdf', 'pdf2jpg', 'pdf2word', 'pdf2excel', 'pdf2ppt', 'pdf2md', 'unlock', 'worker', 'organize', 'resize', 'fillOrder']);

// ── Parse sources ─────────────────────────────────────────────────

global.document = { documentElement: { lang: 'en' } };
const { TOOLS } = await import('../js/config.js');
const configKeys = Object.keys(TOOLS);

const regsSource  = readFileSync(path.join(ROOT, 'js/toolRegistrations.js'), 'utf-8');
const procSource  = readFileSync(path.join(ROOT, 'js/processor.js'), 'utf-8');

// All registerTool('key') calls
const registeredKeys = [...regsSource.matchAll(/registerTool\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]);

// All runner: 'value' declarations inside registerTool blocks
const declaredRunners = [...regsSource.matchAll(/\brunner\s*:\s*['"]([^'"]+)['"]/g)].map(m => m[1]);

// runnerMap keys from processor.js (e.g. merge:, split:, ...)
const runnerMapBlock   = procSource.match(/const runnerMap\s*=\s*\{([\s\S]*?)\};/)?.[1] ?? '';
const processorRunners = [...runnerMapBlock.matchAll(/^\s+(\w[\w\d]+)\s*:/gm)].map(m => m[1]);

// ── Test runner ───────────────────────────────────────────────────

let passed = 0, failed = 0;
function test(name, fn) {
  try   { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

// ── 1. TOOLS ↔ toolRegistrations.js ──────────────────────────────

console.log('\nIntegration: TOOLS ↔ toolRegistrations.js');

test('every TOOLS key has a registerTool() call', () => {
  for (const key of configKeys) {
    assert.ok(
      registeredKeys.includes(key),
      `TOOLS['${key}'] is not registered — add registerTool('${key}', ...) to toolRegistrations.js`
    );
  }
});

test('no orphan registrations (registerTool without TOOLS entry)', () => {
  for (const key of registeredKeys) {
    assert.ok(
      configKeys.includes(key),
      `registerTool('${key}') has no entry in TOOLS — add it to config.js or remove the registration`
    );
  }
});

test('registration count matches TOOLS count', () =>
  assert.equal(
    registeredKeys.length, configKeys.length,
    `${registeredKeys.length} registered ≠ ${configKeys.length} in TOOLS`
  ));

// ── 2. Runner values are valid ────────────────────────────────────

console.log('\nIntegration: runner values');

test('all declared runner values are known', () => {
  const valid = new Set([...KNOWN_RUNNERS, 'stub']);
  for (const runner of declaredRunners) {
    assert.ok(
      valid.has(runner),
      `Unknown runner '${runner}' in toolRegistrations.js — add it to KNOWN_RUNNERS or processor.js runnerMap`
    );
  }
});

test('all non-worker runners have a handler in processor.js runnerMap', () => {
  for (const runner of new Set(declaredRunners)) {
    if (runner === 'worker') continue;
    assert.ok(
      processorRunners.includes(runner),
      `Runner '${runner}' declared in toolRegistrations.js but missing from processor.js runnerMap`
    );
  }
});

// ── 3. processor.js runnerMap is self-consistent ──────────────────

console.log('\nIntegration: processor.js runnerMap');

test('runnerMap keys were parsed successfully (sanity)', () =>
  assert.ok(processorRunners.length > 0, 'runnerMap regex matched 0 keys — check the regex'));

test('all runnerMap keys are in KNOWN_RUNNERS', () => {
  for (const runner of processorRunners) {
    assert.ok(
      KNOWN_RUNNERS.has(runner),
      `Unexpected key '${runner}' in processor.js runnerMap — add to KNOWN_RUNNERS in this test`
    );
  }
});

// ── Summary ───────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${total} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
