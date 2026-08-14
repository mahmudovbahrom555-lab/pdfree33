// ============================================================
//  tests/heicDecode.integration.test.js
//
//  Integration test for js/heicDecode.js's actual WASM decode path,
//  against a real HEIC fixture (tests/fixtures/heic/sample.heic —
//  see SOURCE.md there for provenance: self-generated via macOS `sips`,
//  not third-party).
//
//  Standalone, not wired into `npm test` (matches the precedent set by
//  tests/fillOrderWorker.integration.test.js / resizeWorker.integration.
//  test.js — see those files' header comments) — this one is slower
//  (loads a 1.46MB WASM module) and needs a real binary fixture.
//  Run: node tests/heicDecode.integration.test.js
//
//  Scope: verifies the vendored libheif WASM build (js/vendor/
//  libheif-bundle.mjs) actually decodes real HEIC bytes to correct
//  pixel data — this is the real risk surface (wrong npm package,
//  wrong build variant, API mismatch, etc.). The final canvas
//  putImageData()/toBlob() step in js/heicDecode.js's _decode() is
//  standard browser Canvas API, the same primitives jpg2pdfUI.js's
//  own thumbnail rendering already uses elsewhere with no dedicated
//  test coverage — not re-tested here since it isn't HEIC-specific
//  and Node has no canvas implementation.
// ============================================================

const { readFileSync } = await import('fs');
const { join, dirname } = await import('path');
const { fileURLToPath } = await import('url');
const __dir = dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;

async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); failed++; }
}

function expect(actual) {
  return {
    toBe: (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
  };
}

console.log('\nheicDecode WASM integration:');

await test('vendored libheif-bundle.mjs decodes a real HEIC file to correct RGBA pixel data', async () => {
  const mod = await import('../js/vendor/libheif-bundle.mjs');
  const libheif = await mod.default();

  const buf = readFileSync(join(__dir, 'fixtures/heic/sample.heic'));
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(buf);

  expect(images.length).toBe(1);

  const image  = images[0];
  const width  = image.get_width();
  const height = image.get_height();
  expect(width).toBe(400);
  expect(height).toBe(300);

  const imgData = { data: new Uint8ClampedArray(width * height * 4), width, height };
  await new Promise((resolve, reject) => {
    image.display(imgData, (displayData) => {
      if (!displayData) { reject(new Error('HEIC decode failed')); return; }
      resolve();
    });
  });

  expect(imgData.data.length).toBe(width * height * 4);
  // Alpha channel should be fully opaque for a plain RGB source image —
  // a wrong decode (garbage/zeroed buffer) would show as alpha=0 throughout.
  expect(imgData.data[3]).toBe(255);
  expect(imgData.data[imgData.data.length - 1]).toBe(255);
});

// ── Summary ────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed + ' failed' : '0 failed'}`);
if (failed > 0) process.exit(1);
