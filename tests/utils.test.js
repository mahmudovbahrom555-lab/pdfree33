// ============================================================
//  tests/utils.test.js — Unit tests for utils.js
//  Запуск: node --experimental-vm-modules tests/utils.test.js
//  Или через Vitest/Jest (подключи как ES module)
// ============================================================

// Минимальный test runner (без зависимостей)
let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function expect(actual) {
  return {
    toBe:      (expected) => { if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); },
    toContain: (str)      => { if (!actual.includes(str)) throw new Error(`Expected "${actual}" to contain "${str}"`); },
    toBeTruthy:()         => { if (!actual) throw new Error(`Expected truthy, got ${actual}`); },
    toBeFalsy: ()         => { if (actual)  throw new Error(`Expected falsy, got ${actual}`); },
  };
}

// ── Mock DOM для fmtSize и esc ──
global.document = {
  createElement: (tag) => {
    let _text = '';
    return {
      get textContent() { return _text; },
      set textContent(v) { _text = v; },
      get innerHTML() {
        // Простая эмуляция HTML-эскейпинга
        return _text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }
    };
  }
};

// Импортируем тестируемые функции (CommonJS-совместимый вариант для node)
// В реальном проекте используй: import { fmtSize, esc, isFileAccepted } from '../js/utils.js'
const { fmtSize, esc, isFileAccepted } = await import('../js/utils.js');

// ── fmtSize ────────────────────────────────────────────────
console.log('\nfmtSize:');

test('форматирует байты', ()      => expect(fmtSize(500)).toBe('500 B'));
test('форматирует килобайты', ()  => expect(fmtSize(2048)).toBe('2 KB'));
test('форматирует мегабайты', ()  => expect(fmtSize(1_572_864)).toBe('1.5 MB'));
test('граница KB/MB', ()          => expect(fmtSize(1_048_576)).toBe('1.0 MB'));
test('0 байт', ()                 => expect(fmtSize(0)).toBe('0 B'));

// ── esc (XSS protection) ───────────────────────────────────
console.log('\nesc (XSS):');

test('экранирует <script>',  () => expect(esc('<script>')).toContain('&lt;'));
test('экранирует >',          () => expect(esc('a>b')).toContain('&gt;'));
test('экранирует &',          () => expect(esc('a&b')).toContain('&amp;'));
test('экранирует кавычки',    () => expect(esc('"test"')).toContain('&quot;'));
test('обычная строка без изменений', () => expect(esc('hello world')).toBe('hello world'));
test('пустая строка',         () => expect(esc('')).toBe(''));
test('XSS атака onload',      () => {
  const result = esc('<img onload="alert(1)">');
  expect(result).toContain('&lt;');
});

// ── isFileAccepted ─────────────────────────────────────────
console.log('\nisFileAccepted:');

const MIME_MAP = {
  '.pdf':           ['application/pdf'],
  '.jpg,.jpeg,.png':['image/jpeg', 'image/png'],
};

function makeFile(name, type) {
  return { name, type };
}

test('принимает PDF по MIME',              () => expect(isFileAccepted(makeFile('doc.pdf', 'application/pdf'), '.pdf', MIME_MAP)).toBeTruthy());
test('принимает PDF по расширению',        () => expect(isFileAccepted(makeFile('doc.pdf', ''), '.pdf', MIME_MAP)).toBeTruthy());
test('принимает JPG по MIME',              () => expect(isFileAccepted(makeFile('img.jpg', 'image/jpeg'), '.jpg,.jpeg,.png', MIME_MAP)).toBeTruthy());
test('отклоняет EXE как PDF',              () => expect(isFileAccepted(makeFile('virus.exe', 'application/x-msdownload'), '.pdf', MIME_MAP)).toBeFalsy());
test('отклоняет DOCX как PDF',             () => expect(isFileAccepted(makeFile('doc.docx', 'application/vnd.openxmlformats'), '.pdf', MIME_MAP)).toBeFalsy());
test('отклоняет PDF как image',            () => expect(isFileAccepted(makeFile('doc.pdf', 'application/pdf'), '.jpg,.jpeg,.png', MIME_MAP)).toBeFalsy());
test('пропускает если нет карты для accept',() => expect(isFileAccepted(makeFile('any.xyz', ''), '.xyz', MIME_MAP)).toBeTruthy());

// ── Summary ────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} passed | ${failed > 0 ? '✗ ' + failed + ' failed' : '0 failed'}`);
if (failed > 0) process.exit(1);
