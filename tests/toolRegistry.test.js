// ============================================================
//  tests/toolRegistry.test.js — Unit tests for js/toolRegistry.js
//  Запуск: node tests/toolRegistry.test.js
//
//  Тестирует реальный модуль (не реимплементацию):
//  registerTool, getToolDescriptor, hideAllToolOptions,
//  initToolOptions, collectToolParams, getRunner, getWorkerTool.
// ============================================================

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

function expect(actual) {
  return {
    toBe:       (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toEqual:    (e) => { if (JSON.stringify(actual) !== JSON.stringify(e)) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy: ()  => { if (!actual) throw new Error(`Expected truthy, got ${actual}`); },
    toBeFalsy:  ()  => { if (actual)  throw new Error(`Expected falsy, got ${actual}`); },
    toBeUndefined: () => { if (actual !== undefined) throw new Error(`Expected undefined, got ${JSON.stringify(actual)}`); },
  };
}

const {
  registerTool, getToolDescriptor, hideAllToolOptions,
  initToolOptions, collectToolParams, getRunner, getWorkerTool,
  notifyToolSuccess,
} = await import('../js/toolRegistry.js');

// ── registerTool / getToolDescriptor (CRUD) ────────────────
console.log('\nregisterTool / getToolDescriptor:');

test('хранит и возвращает дескриптор', () => {
  const desc = { runner: 'merge' };
  registerTool('t_crud', desc);
  expect(getToolDescriptor('t_crud')).toBe(desc);
});

test('перезапись ключа заменяет дескриптор', () => {
  registerTool('t_overwrite', { runner: 'a' });
  registerTool('t_overwrite', { runner: 'b' });
  expect(getToolDescriptor('t_overwrite').runner).toBe('b');
});

test('неизвестный ключ → undefined', () => {
  expect(getToolDescriptor('t_does_not_exist')).toBeUndefined();
});

// ── hideAllToolOptions ─────────────────────────────────────
console.log('\nhideAllToolOptions:');

test('вызывает hide() на всех зарегистрированных инструментах', () => {
  let hideA = 0, hideB = 0;
  registerTool('t_hideA', { runner: 'x', hide: () => { hideA++; } });
  registerTool('t_hideB', { runner: 'x', hide: () => { hideB++; } });
  hideAllToolOptions();
  expect(hideA).toBe(1);
  expect(hideB).toBe(1);
});

test('инструмент без hide() пропускается без ошибки', () => {
  registerTool('t_nohide', { runner: 'x' }); // нет hide
  // не должно бросить исключение
  hideAllToolOptions();
  expect(true).toBeTruthy();
});

// ── initToolOptions ────────────────────────────────────────
console.log('\ninitToolOptions:');

test('single-file: передаёт files[0]', () => {
  let received = null;
  registerTool('t_single', { runner: 'x', init: (f) => { received = f; } });
  initToolOptions('t_single', ['FILE0', 'FILE1']);
  expect(received).toBe('FILE0');
});

test('multiFile: передаёт копию массива', () => {
  let received = null;
  registerTool('t_multi', { runner: 'x', multiFile: true, init: (arr) => { received = arr; } });
  const files = ['a', 'b'];
  initToolOptions('t_multi', files);
  expect(received).toEqual(['a', 'b']);
  // должна быть копия, не та же ссылка
  expect(received === files).toBeFalsy();
});

test('minFiles не достигнут → init не вызывается', () => {
  let called = false;
  registerTool('t_minfiles', { runner: 'x', multiFile: true, minFiles: 2, init: () => { called = true; } });
  initToolOptions('t_minfiles', ['only-one']);
  expect(called).toBeFalsy();
});

test('minFiles достигнут → init вызывается', () => {
  let called = false;
  registerTool('t_minfiles2', { runner: 'x', multiFile: true, minFiles: 2, init: () => { called = true; } });
  initToolOptions('t_minfiles2', ['one', 'two']);
  expect(called).toBeTruthy();
});

test('default minFiles=1: пустой массив → init не вызывается', () => {
  let called = false;
  registerTool('t_empty', { runner: 'x', init: () => { called = true; } });
  initToolOptions('t_empty', []);
  expect(called).toBeFalsy();
});

test('инструмент без init() — ничего не делает', () => {
  registerTool('t_noinit', { runner: 'x' });
  initToolOptions('t_noinit', ['a']); // не должно бросить
  expect(true).toBeTruthy();
});

test('неизвестный ключ — ничего не делает', () => {
  initToolOptions('t_unknown_init', ['a']); // не должно бросить
  expect(true).toBeTruthy();
});

// ── collectToolParams ──────────────────────────────────────
console.log('\ncollectToolParams:');

test('без getParams → { params:{}, error:null }', () => {
  registerTool('t_noparams', { runner: 'x' });
  expect(collectToolParams('t_noparams')).toEqual({ params: {}, error: null });
});

test('getParams без validate → { params, error:null }', () => {
  registerTool('t_params', { runner: 'x', getParams: () => ({ a: 1 }) });
  expect(collectToolParams('t_params')).toEqual({ params: { a: 1 }, error: null });
});

test('validate возвращает ошибку → error пробрасывается', () => {
  registerTool('t_invalid', {
    runner: 'x',
    getParams: () => ({ pages: '' }),
    validate: (p) => p.pages ? null : 'no pages',
  });
  const { params, error } = collectToolParams('t_invalid');
  expect(params).toEqual({ pages: '' });
  expect(error).toBe('no pages');
});

test('validate возвращает null для валидных params', () => {
  registerTool('t_valid', {
    runner: 'x',
    getParams: () => ({ pages: '1-3' }),
    validate: (p) => p.pages ? null : 'no pages',
  });
  expect(collectToolParams('t_valid').error).toBe(null);
});

// ── getRunner ──────────────────────────────────────────────
console.log('\ngetRunner:');

test('возвращает runner из дескриптора', () => {
  registerTool('t_runner', { runner: 'compress' });
  expect(getRunner('t_runner')).toBe('compress');
});

test('неизвестный ключ → "stub"', () => {
  expect(getRunner('t_unknown_runner')).toBe('stub');
});

// ── getWorkerTool ──────────────────────────────────────────
console.log('\ngetWorkerTool:');

test('runner="worker" → возвращает workerTool', () => {
  registerTool('t_worker', { runner: 'worker', workerTool: 'rotatePdf' });
  expect(getWorkerTool('t_worker')).toBe('rotatePdf');
});

test('runner не worker без workerTool → undefined', () => {
  registerTool('t_nonworker', { runner: 'merge' });
  expect(getWorkerTool('t_nonworker')).toBeUndefined();
});

test('неизвестный ключ → undefined', () => {
  expect(getWorkerTool('t_unknown_worker')).toBeUndefined();
});

// ── notifyToolSuccess ──────────────────────────────────────
console.log('\nnotifyToolSuccess:');

test('вызывает onSuccess с detail', () => {
  let got = null;
  registerTool('t_success', { runner: 'x', onSuccess: (d) => { got = d; } });
  notifyToolSuccess('t_success', { ok: true });
  expect(got).toEqual({ ok: true });
});

test('инструмент без onSuccess — ничего не делает', () => {
  registerTool('t_nosuccess', { runner: 'x' });
  notifyToolSuccess('t_nosuccess', {}); // не должно бросить
  expect(true).toBeTruthy();
});

// ── Summary ────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed + ' failed' : '0 failed'}`);
if (failed > 0) process.exit(1);
