// ============================================================
//  tests/processor.logic.test.js — Unit тесты логики processor
//  Тестируем: guard от двойного запуска, обработку stub,
//  snapshot защиту, флаг isProcessing
// ============================================================

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

function expect(actual) {
  return {
    toBe:       (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy: ()  => { if (!actual) throw new Error(`Expected truthy`); },
    toBeFalsy:  ()  => { if (actual) throw new Error(`Expected falsy`); },
    toEqual:    (e) => { if (JSON.stringify(actual) !== JSON.stringify(e)) throw new Error(`Expected ${JSON.stringify(e)}`); },
  };
}

// ── Снимок файлов (п.2) ────────────────────────────────────
console.log('\nFile snapshot (п.2):');

function makeFile(name, size = 100) { return { name, size }; }

test('snapshot изолирован от изменений оригинала', () => {
  const files = [makeFile('a.pdf'), makeFile('b.pdf')];
  const snapshot = [...files]; // как в processor.js

  // Мутируем оригинал
  files.push(makeFile('c.pdf'));
  files[0] = makeFile('CHANGED.pdf');

  // Снимок не изменился
  expect(snapshot.length).toBe(2);
  expect(snapshot[0].name).toBe('a.pdf');
});

test('snapshot содержит те же объекты (shallow copy)', () => {
  const files    = [makeFile('a.pdf')];
  const snapshot = [...files];
  expect(snapshot[0]).toBe(files[0]); // та же ссылка
});

// ── Guard от двойного запуска ──────────────────────────────
console.log('\nDouble-run guard:');

test('второй doProcess игнорируется если isProcessing=true', () => {
  let callCount  = 0;
  let _isProcessing = false;

  function doProcess() {
    if (_isProcessing) return 'ignored';
    _isProcessing = true;
    callCount++;
    return 'started';
  }

  expect(doProcess()).toBe('started');
  expect(doProcess()).toBe('ignored'); // второй вызов проигнорирован
  expect(callCount).toBe(1);
});

// ── Stub guard: проверка isProcessing после await (п.4) ────
console.log('\nStub cancel guard (п.4):');

test('stub не меняет состояние если уже отменён', async () => {
  let isProcessing = true;
  let sideEffectCalled = false;

  async function _runStub() {
    await new Promise(r => setTimeout(r, 10));
    if (!isProcessing) return; // п.4 FIX
    sideEffectCalled = true;
  }

  const p = _runStub();
  isProcessing = false; // отмена во время задержки
  await p;

  expect(sideEffectCalled).toBeFalsy();
});

test('stub выполняется нормально если не отменён', async () => {
  let isProcessing = true;
  let sideEffectCalled = false;

  async function _runStub() {
    await new Promise(r => setTimeout(r, 10));
    if (!isProcessing) return;
    sideEffectCalled = true;
    isProcessing = false;
  }

  await _runStub();
  expect(sideEffectCalled).toBeTruthy();
  expect(isProcessing).toBeFalsy();
});

// ── Cancel logic ───────────────────────────────────────────
console.log('\nCancel logic:');

test('cancel сбрасывает isProcessing в false', () => {
  let isProcessing = true;
  let workerTerminated = false;

  const fakeWorker = { terminate: () => { workerTerminated = true; } };

  function cancelProcess() {
    if (!isProcessing) return;
    fakeWorker.terminate();
    isProcessing = false;
  }

  cancelProcess();
  expect(isProcessing).toBeFalsy();
  expect(workerTerminated).toBeTruthy();
});

test('повторный cancel не вызывает terminate снова', () => {
  let isProcessing = false;
  let terminateCount = 0;

  const fakeWorker = { terminate: () => { terminateCount++; } };

  function cancelProcess() {
    if (!isProcessing) return;
    fakeWorker.terminate();
    isProcessing = false;
  }

  cancelProcess(); // isProcessing уже false — выходим сразу
  expect(terminateCount).toBe(0);
});

// ── Summary ────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
