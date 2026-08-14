// ============================================================
//  tests/heicDecode.test.js — Unit tests for js/heicDecode.js
//  Запуск: node tests/heicDecode.test.js
//
//  Тестирует только isHeicFile() — чистая функция, не трогает DOM/WASM.
//  Реальное WASM-декодирование (libheif) проверяется отдельно в
//  tests/heicDecode.integration.test.js (standalone, не в npm test —
//  требует настоящий .heic fixture и дольше выполняется).
// ============================================================

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

function expect(actual) {
  return {
    toBe: (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
  };
}

const { isHeicFile } = await import('../js/heicDecode.js');

function mockFile(name, type) {
  return { name, type, size: 1000, arrayBuffer: async () => new ArrayBuffer(0) };
}

console.log('\nisHeicFile:');

test('.heic extension, empty MIME (common on non-Apple platforms) → true', () => {
  expect(isHeicFile(mockFile('IMG_0001.heic', ''))).toBe(true);
});

test('.heic extension, uppercase → true', () => {
  expect(isHeicFile(mockFile('IMG_0001.HEIC', ''))).toBe(true);
});

test('.heif extension → true', () => {
  expect(isHeicFile(mockFile('photo.heif', ''))).toBe(true);
});

test('image/heic MIME, no matching extension → true', () => {
  expect(isHeicFile(mockFile('photo', 'image/heic'))).toBe(true);
});

test('image/heif MIME → true', () => {
  expect(isHeicFile(mockFile('photo', 'image/heif'))).toBe(true);
});

test('MIME case-insensitive → true', () => {
  expect(isHeicFile(mockFile('photo.jpg', 'IMAGE/HEIC'))).toBe(true);
});

test('regular JPEG → false', () => {
  expect(isHeicFile(mockFile('photo.jpg', 'image/jpeg'))).toBe(false);
});

test('regular PNG → false', () => {
  expect(isHeicFile(mockFile('photo.png', 'image/png'))).toBe(false);
});

test('WebP → false', () => {
  expect(isHeicFile(mockFile('photo.webp', 'image/webp'))).toBe(false);
});

test('no extension, no MIME → false', () => {
  expect(isHeicFile(mockFile('photo', ''))).toBe(false);
});

test('filename containing "heic" as a substring but wrong extension → false', () => {
  expect(isHeicFile(mockFile('heic-not-really.jpg', 'image/jpeg'))).toBe(false);
});

// ── Summary ────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed + ' failed' : '0 failed'}`);
if (failed > 0) process.exit(1);
