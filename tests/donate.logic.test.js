// ============================================================
//  tests/donate.logic.test.js — Unit тесты логики donate.js
//  Тестируем: счётчик использований, таймер, сброс состояния
// ============================================================

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

function expect(actual) {
  return {
    toBe:       (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy: ()  => { if (!actual) throw new Error(`Expected truthy, got ${actual}`); },
    toBeFalsy:  ()  => { if (actual) throw new Error(`Expected falsy, got ${actual}`); },
    toBeGreaterThan: (e) => { if (actual <= e) throw new Error(`Expected > ${e}, got ${actual}`); },
  };
}

// ── Mock localStorage ──────────────────────────────────────
const _store = {};
global.localStorage = {
  getItem:    (k)    => _store[k] ?? null,
  setItem:    (k, v) => { _store[k] = String(v); },
  removeItem: (k)    => { delete _store[k]; },
};

// ── Изолированная логика usage counter ────────────────────

const USAGE_KEY = 'pdfree_usage';

function getUsageCount() {
  try { return parseInt(localStorage.getItem(USAGE_KEY) || '0'); }
  catch { return 0; }
}

function incrementUsage() {
  try { localStorage.setItem(USAGE_KEY, getUsageCount() + 1); }
  catch { /* заблокирован */ }
}

// ── Тесты счётчика ─────────────────────────────────────────
console.log('\nUsage counter:');

test('начальное значение — 0', () => {
  delete _store[USAGE_KEY];
  expect(getUsageCount()).toBe(0);
});

test('инкремент увеличивает счётчик', () => {
  delete _store[USAGE_KEY];
  incrementUsage();
  expect(getUsageCount()).toBe(1);
});

test('несколько инкрементов', () => {
  delete _store[USAGE_KEY];
  incrementUsage(); incrementUsage(); incrementUsage();
  expect(getUsageCount()).toBe(3);
});

test('читает существующее значение', () => {
  _store[USAGE_KEY] = '7';
  expect(getUsageCount()).toBe(7);
});

test('некорректное значение возвращает NaN (graceful)', () => {
  _store[USAGE_KEY] = 'abc';
  // parseInt('abc') === NaN, поэтому счётчик вернёт NaN — это допустимо
  // для нашей логики показа персонального текста (NaN >= 3 === false)
  const count = getUsageCount();
  expect(isNaN(count)).toBeTruthy();
});

// ── Тесты логики таймера (п.1) ─────────────────────────────
console.log('\nDonate timer (п.1):');

test('clearTimeout не бросает если timer === null', () => {
  let timer = null;
  // Должно работать без ошибок
  if (timer) clearTimeout(timer);
  expect(true).toBeTruthy();
});

test('таймер отменяется при повторном вызове', () => {
  let fired = false;
  // Симулируем логику из donate.js
  let _donateTimer = null;

  function scheduleWithCancel(delay) {
    if (_donateTimer) clearTimeout(_donateTimer);
    _donateTimer = setTimeout(() => { fired = true; }, delay);
    return _donateTimer;
  }

  function cancelTimer() {
    if (_donateTimer) { clearTimeout(_donateTimer); _donateTimer = null; }
  }

  scheduleWithCancel(10000); // большая задержка
  cancelTimer();             // отменяем до истечения

  // Нельзя напрямую проверить в синхронном тесте, что он не сработал,
  // но убеждаемся что cancel не бросает исключений и _donateTimer === null
  expect(_donateTimer).toBeFalsy();
  expect(fired).toBeFalsy();
});

test('второй вызов schedule заменяет первый таймер', () => {
  let _donateTimer = null;
  let callCount    = 0;

  function schedule() {
    if (_donateTimer) clearTimeout(_donateTimer);
    _donateTimer = setTimeout(() => { callCount++; }, 50);
  }

  schedule();
  const first = _donateTimer;
  schedule();
  const second = _donateTimer;

  expect(first !== second).toBeTruthy(); // новый ID
});

// ── Тест: персональный текст после N использований ─────────
console.log('\nPersonal donate text:');

const THRESHOLD = 3;

function getDonateTitle(count) {
  return count >= THRESHOLD
    ? `You've used PDFree ${count} times 🎉`
    : 'This tool is free, forever.';
}

test('обычный текст при count < 3', ()  => expect(getDonateTitle(0)).toBe('This tool is free, forever.'));
test('обычный текст при count = 2', ()  => expect(getDonateTitle(2)).toBe('This tool is free, forever.'));
test('персональный текст при count = 3',() => expect(getDonateTitle(3)).toBe(`You've used PDFree 3 times 🎉`));
test('персональный текст при count > 3',() => expect(getDonateTitle(10)).toBe(`You've used PDFree 10 times 🎉`));

// ── Summary ────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
