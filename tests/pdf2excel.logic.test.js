// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/pdf2excel.logic.test.js — Unit тесты логики pdf2excel
//  Тестируем: _p2eCellValue (типизация ячеек), _p2eConfidence
//  (расчёт confidence score) и detectTables (общий с pdf2word
//  детектор таблиц по X-координатам колонок).
// ============================================================

// processor.js touches Worker/document at module load time (it's built for
// the browser), so stub the minimum needed to import it under plain Node —
// same approach integration.test.js uses for config.js.
global.document = {
  documentElement: { lang: 'en' },
  getElementById:  () => null,
  querySelector:   () => null,
  addEventListener: () => {},
  createElement:   () => ({ style: {}, setAttribute() {}, appendChild() {} }),
};
global.window    = globalThis;
global.Worker    = class { postMessage() {} terminate() {} addEventListener() {} };

const { _p2eCellValue, _p2eConfidence } = await import('../js/processor.js');
const { detectTables, groupItemsIntoLines } = await import('../js/pdf2wordTables.js');

let passed = 0, failed = 0;

function test(name, fn) {
  try   { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

function expect(actual) {
  return {
    toBe:    (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toEqual: (e) => { if (JSON.stringify(actual) !== JSON.stringify(e)) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
};
}

// ── _p2eCellValue: числа ──────────────────────────────────
console.log('\n_p2eCellValue — числа:');

test('простое целое становится Number', () => {
  expect(_p2eCellValue('42')).toEqual({ value: 42 });
});

test('десятичное число с точкой становится Number', () => {
  expect(_p2eCellValue('1234.56')).toEqual({ value: 1234.56 });
});

test('число с разделителями тысяч парсится корректно', () => {
  expect(_p2eCellValue('1,234.56')).toEqual({ value: 1234.56 });
});

test('число с символом валюты парсится корректно', () => {
  expect(_p2eCellValue('$1,234.56')).toEqual({ value: 1234.56 });
});

test('отрицательное число парсится корректно', () => {
  expect(_p2eCellValue('-42')).toEqual({ value: -42 });
});

// ── _p2eCellValue: проценты ────────────────────────────────
console.log('\n_p2eCellValue — проценты:');

test('простой процент конвертируется в долю с форматом', () => {
  expect(_p2eCellValue('12.5%')).toEqual({ value: 0.125, numFmt: '0.00%' });
});

test('процент с разделителем тысяч конвертируется корректно', () => {
  expect(_p2eCellValue('1,234%')).toEqual({ value: 12.34, numFmt: '0.00%' });
});

// ── _p2eCellValue: даты ────────────────────────────────────
console.log('\n_p2eCellValue — даты:');

test('ISO-дата (YYYY-MM-DD) распознаётся как дата', () => {
  const result = _p2eCellValue('2026-01-15');
  expect(result.numFmt).toBe('yyyy-mm-dd');
  expect(result.value instanceof Date).toBe(true);
});

test('дата в формате DD/MM/YYYY НЕ парсится как дата (неоднозначна)', () => {
  // Намеренное поведение: слэш-даты неоднозначны (DD/MM vs MM/DD), поэтому
  // остаются текстом, чтобы не подменить день и месяц молча.
  expect(_p2eCellValue('01/02/2026')).toEqual({ value: '01/02/2026' });
});

test('дата в формате DD.MM.YYYY НЕ парсится как дата', () => {
  expect(_p2eCellValue('15.01.2026')).toEqual({ value: '15.01.2026' });
});

// ── _p2eCellValue: текст и края ─────────────────────────────
console.log('\n_p2eCellValue — текст и граничные случаи:');

test('обычный текст остаётся текстом', () => {
  expect(_p2eCellValue('Invoice #4471')).toEqual({ value: 'Invoice #4471' });
});

test('пустая строка возвращается как есть', () => {
  expect(_p2eCellValue('')).toEqual({ value: '' });
});

test('null/undefined не бросает исключение', () => {
  expect(_p2eCellValue(null)).toEqual({ value: null });
  expect(_p2eCellValue(undefined)).toEqual({ value: undefined });
});

test('строка с пробелами по краям обрезается при проверке, но число распознаётся', () => {
  expect(_p2eCellValue('  42  ')).toEqual({ value: 42 });
});

test('текст, похожий на число с буквой, остаётся текстом', () => {
  expect(_p2eCellValue('42kg')).toEqual({ value: '42kg' });
});

// ── _p2eConfidence ──────────────────────────────────────────
console.log('\n_p2eConfidence:');

test('без таблиц — score 0, level none', () => {
  const result = _p2eConfidence({ tables: [], totalPages: 3, pagesWithNoText: 0 });
  expect(result).toEqual({ score: 0, level: 'none', tableCount: 0, pagesWithNoText: 0, totalPages: 3 });
});

test('высокая уверенность и полное покрытие страниц дают level high', () => {
  const result = _p2eConfidence({
    tables: [{ confidence: 0.9 }, { confidence: 0.95 }],
    totalPages: 2,
    pagesWithNoText: 0,
  });
  expect(result.level).toBe('high');
  expect(result.tableCount).toBe(2);
});

test('низкая уверенность даёт level low', () => {
  const result = _p2eConfidence({
    tables: [{ confidence: 0.3 }],
    totalPages: 2,
    pagesWithNoText: 0,
  });
  expect(result.level).toBe('low');
});

test('много страниц без текста снижает score через pageCoverage', () => {
  const withCoverage = _p2eConfidence({
    tables: [{ confidence: 0.9 }],
    totalPages: 10,
    pagesWithNoText: 0,
  });
  const withoutCoverage = _p2eConfidence({
    tables: [{ confidence: 0.9 }],
    totalPages: 10,
    pagesWithNoText: 8,
  });
  if (!(withoutCoverage.score < withCoverage.score)) {
    throw new Error(`Expected lower score with more no-text pages: ${withoutCoverage.score} < ${withCoverage.score}`);
  }
});

test('pageCoverage не опускается ниже 0.5 (минимальный пол)', () => {
  const result = _p2eConfidence({
    tables: [{ confidence: 1 }],
    totalPages: 10,
    pagesWithNoText: 10, // 100% страниц без текста
  });
  expect(result.score).toBe(50); // 1 * 100 * 0.5
});

// ── groupItemsIntoLines (общая для preview-скана и реальной конвертации) ────
console.log('\ngroupItemsIntoLines:');

test('items на одной Y-высоте группируются в одну строку, отсортированную по X', () => {
  const items = [
    { str: 'B', x: 50, y: 700 },
    { str: 'A', x: 10, y: 700 },
  ];
  const lines = groupItemsIntoLines(items);
  expect(lines.length).toBe(1);
  expect(lines[0].items.map(i => i.str)).toEqual(['A', 'B']);
});

test('items за пределами допуска YTOL попадают в разные строки', () => {
  const items = [
    { str: 'Top',    x: 0, y: 700 },
    { str: 'Bottom', x: 0, y: 680 }, // разница 20px >> YTOL=6
  ];
  const lines = groupItemsIntoLines(items);
  expect(lines.length).toBe(2);
});

test('items в пределах допуска YTOL сливаются в одну строку', () => {
  const items = [
    { str: 'Base',    x: 0, y: 700 },
    { str: 'Baseline', x: 10, y: 704 }, // разница 4px < YTOL=6
  ];
  const lines = groupItemsIntoLines(items);
  expect(lines.length).toBe(1);
});

test('строки идут в порядке убывания Y (сверху вниз по странице)', () => {
  const items = [
    { str: 'Bottom', x: 0, y: 100 },
    { str: 'Top',    x: 0, y: 700 },
  ];
  const lines = groupItemsIntoLines(items);
  expect(lines.map(l => l.items[0].str)).toEqual(['Top', 'Bottom']);
});

// ── detectTables (используется и pdf2word, и pdf2excel) ─────
console.log('\ndetectTables:');

// Строим фейковые "строки" в формате, который ожидает detectTables:
// { y, items: [{ str, x, width }] }
function makeLine(y, cells) {
  let x = 0;
  const items = cells.map((str) => {
    const item = { str, x, width: str.length * 6 };
    x += item.width + 20; // зазор между колонками
    return item;
  });
  return { y, items };
}

test('явная таблица (3+ строки, 2+ выровненных колонки) детектируется', () => {
  const lines = [
    makeLine(700, ['Name', 'Amount']),
    makeLine(680, ['Alice', '100']),
    makeLine(660, ['Bob', '200']),
    makeLine(640, ['Carol', '300']),
  ];
  const tables = detectTables(lines);
  expect(tables.length > 0).toBe(true);
});

test('обычный текстовый абзац (без выровненных колонок) не детектируется как таблица', () => {
  const lines = [
    { y: 700, items: [{ str: 'This is a long paragraph of', x: 0, width: 200 }] },
    { y: 680, items: [{ str: 'regular prose text that should', x: 0, width: 210 }] },
    { y: 660, items: [{ str: 'not be mistaken for a table.', x: 0, width: 190 }] },
  ];
  const tables = detectTables(lines);
  expect(tables.length).toBe(0);
});

test('менее MIN_ROWS строк не формирует таблицу', () => {
  const lines = [
    makeLine(700, ['Name', 'Amount']),
    makeLine(680, ['Alice', '100']),
  ];
  const tables = detectTables(lines);
  expect(tables.length).toBe(0);
});

// ── Summary ────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
