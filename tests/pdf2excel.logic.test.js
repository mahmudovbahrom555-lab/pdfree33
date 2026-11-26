// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/pdf2excel.logic.test.js — Unit тесты логики pdf2excel
//  Cell types, table extraction, cancellation, and result messaging.
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

const { _p2eHasUnrepresentedImage, _p2eCellValue, _p2eDecimalMark, _p2eTableMark, _p2eExtractPage, _p2eStitchTables, _p2eJoinColumnBands, _p2eSmallPrintScale } = await import('../js/processor.js');
const { detectTables, groupItemsIntoLines } = await import('../js/pdf2wordTables.js');

const { initPdf2ExcelOptions, hidePdf2ExcelOptions, renderP2eConfidence } = await import('../js/pdf2excelUI.js');

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

test('арабско-индийские цифры с ٬ и ٫ становятся тем же Number', () => {
  expect(_p2eCellValue('١٬٤٥٠٫٠٠')).toEqual({ value: 1450 });
  expect(_p2eCellValue('١٢')).toEqual({ value: 12 });
});

test('персидские цифры становятся Number', () => {
  expect(_p2eCellValue('۱۸٫۵۰')).toEqual({ value: 18.5 });
});

test('текст с арабскими цифрами остаётся исходным текстом', () => {
  expect(_p2eCellValue('فاتورة رقم ١٠٤٢')).toEqual({ value: 'فاتورة رقم ١٠٤٢' });
  expect(_p2eCellValue('٢٠٢٦/٠٩/١٤')).toEqual({ value: '٢٠٢٦/٠٩/١٤' });
});

// ── _p2eCellValue: проценты ────────────────────────────────
console.log('\n_p2eCellValue — проценты:');

test('простой процент конвертируется в долю с форматом', () => {
  expect(_p2eCellValue('12.5%')).toEqual({ value: 0.125, numFmt: '0.00%' });
});

test('процент с разделителем тысяч конвертируется корректно', () => {
  expect(_p2eCellValue('1,234.0%')).toEqual({ value: 12.34, numFmt: '0.00%' });
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

// DD.MM.YYYY was left as text here (6455bd2e recorded the behaviour, with no
// reason given). Changed 2026-11-25: a dotted date is day first in every
// locale that writes it, unlike DD/MM — see the dotted-date tests below.
test('дата в формате DD.MM.YYYY — дата (день первым), как напечатано', () => {
  expect(_p2eCellValue('15.01.2026').value.toISOString()).toBe('2026-01-15T00:00:00.000Z');
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

test('локальные суммы записываются числами без изменения значения', () => {
  for (const [source, value] of [
    ['12,50', 12.5], ['€1.234,56', 1234.56], ['−1 234,56', -1234.56],
    ['1.234.567', 1234567], ['1 234 567.89', 1234567.89],
    ['١٢٫٣٤٥', 12.345], ['١٢٬٣٤٥', 12345],
  ]) expect(_p2eCellValue(source)).toEqual({ value });
});

test('идентификаторы, неоднозначное и неточное число остаются текстом', () => {
  for (const source of [
    '00123', '۰۰۱۲۳', '12345678901234567', '1234567890123456',
    '1,23,456', '1,234 567.89', '123456789.1234567',
  ]) expect(_p2eCellValue(source)).toEqual({ value: source });
  for (const source of ['1.234', '12,345', '1,234%']) expect(_p2eCellValue(source, null)).toEqual({ value: source });
  expect(_p2eCellValue('0.123')).toEqual({ value: 0.123 });
});

test('одиночный разделитель читается по знаку дроби таблицы', () => {
  // по умолчанию — как инструмент читал всегда: запятая разделяет тысячи
  expect(_p2eCellValue('12,345')).toEqual({ value: 12345 });
  expect(_p2eCellValue('1.234')).toEqual({ value: 1.234 });
  expect(_p2eCellValue('1,234%')).toEqual({ value: 12.34, numFmt: '0.00%' });
  expect(_p2eCellValue('12,345', ',')).toEqual({ value: 12.345 });
  expect(_p2eCellValue('12.345', ',')).toEqual({ value: 12345 });
  // однозначные числа знак таблицы не меняет
  expect(_p2eCellValue('1,234.5', ',')).toEqual({ value: 1234.5 });
  expect(_p2eCellValue('12,5', '.')).toEqual({ value: 12.5 });
});

test('знак дроби таблицы — по её однозначным числам', () => {
  expect(_p2eDecimalMark([['Сумма'], ['1.234,56'], ['12,345']])).toBe(',');
  expect(_p2eDecimalMark([['Amount'], ['1,234.56'], ['12,345']])).toBe('.');
  expect(_p2eDecimalMark([['Amount'], ['12,345'], ['7']])).toBe(null);
  // заголовок не голосует
  expect(_p2eDecimalMark([['0,5'], ['12,345']])).toBe(null);
});

test('локальные проценты сохраняют значение и видимые знаки после запятой', () => {
  expect(_p2eCellValue('12,5%')).toEqual({ value: 0.125, numFmt: '0.00%' });
  expect(_p2eCellValue('12,3456%')).toEqual({ value: 0.123456, numFmt: '0.0000%' });
});

test('проверка календаря сохраняет невозможные даты как текст', () => {
  for (const source of ['2026-02-31', '2025-02-29', '1900-02-29', '1899-12-31']) {
    expect(_p2eCellValue(source)).toEqual({ value: source });
  }
  expect(_p2eCellValue('2024-02-29').value.toISOString()).toBe('2024-02-29T00:00:00.000Z');
});

// Day.month.year (2026-11-25): 94 % of dd.mm.yyyy cells of 60 printed
// spreadsheets stayed text, so they couldn't be sorted or filtered by date.
// A dotted date is day first wherever it is written (de, ru, pl, tr, …);
// a slashed one is ambiguous (01/02/2024) and stays text.
test('a dotted date (dd.mm.yyyy) is a date, shown as it was printed', () => {
  const v = _p2eCellValue('30.12.2024');
  expect(v.value.toISOString()).toBe('2024-12-30T00:00:00.000Z');
  expect(v.numFmt).toBe('dd.mm.yyyy');
  expect(_p2eCellValue('1.2.2024').value.toISOString()).toBe('2024-02-01T00:00:00.000Z');
  expect(_p2eCellValue('29.02.2024').value.toISOString()).toBe('2024-02-29T00:00:00.000Z');
});
test('impossible or ambiguous day-month dates stay text', () => {
  for (const source of ['31.02.2024', '29.02.2025', '13.13.2024', '01/02/2024', '30.12.24', '1.2.3.2024']) {
    expect(_p2eCellValue(source)).toEqual({ value: source });
  }
});

// Accounting negatives (2026-11-25): "(2,945.15)" is −2,945.15 — every such
// cell (48 % of an accounting-format column) stayed text in 60 printed
// spreadsheets. Only an amount: decimals, a thousands group or a currency
// sign inside; "(500)", "(2021)" stay text (a note number, a year).
test('an amount in brackets is negative: (2,945.15), ($1,200), $(1,200.50), (1.234,56)', () => {
  expect(_p2eCellValue('(2,945.15)')).toEqual({ value: -2945.15 });
  expect(_p2eCellValue('($1,200)')).toEqual({ value: -1200 });
  expect(_p2eCellValue('$(1,200.50)')).toEqual({ value: -1200.5 });
  expect(_p2eCellValue('(1.234,56)', ',')).toEqual({ value: -1234.56 });
  expect(_p2eCellValue('( 75.00 )')).toEqual({ value: -75 });
});
test('brackets around a bare number, a year or text stay text', () => {
  for (const source of ['(500)', '(2021)', '(see note 3)', '-(5.00)', '((5.00))', '(5.00']) {
    expect(_p2eCellValue(source)).toEqual({ value: source });
  }
});
test('bracket negatives vote for the decimal mark like any amount', () => {
  expect(_p2eDecimalMark([['Amount'], ['(1.234,56)'], ['(12,50)']])).toBe(',');
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

// Precise X control (makeLine's auto-increment is fragile to hand-verify for
// these) — same {y, items:[{str,x,width}]} shape detectTables expects.
function makeLineAt(y, cellsWithX) {
  return { y, items: cellsWithX.map(([str, x]) => ({ str, x, width: str.length * 6 })) };
}

// Real, confirmed case (Atlas_DR's md_corpus/003-multipage-ledger, a real
// debit/credit financial ledger): every data row is missing one of two
// mutually-exclusive numeric columns by design (a transaction is either a
// debit or a credit, never both), and the very first data row (an opening
// balance) has neither. The OLD _columnAlignScore
// (matched / Math.max(baseCols.length, lineCols.length)) scored the
// opening-balance row 3/5=0.6 -- below ALIGN_THRESHOLD -- collapsing the
// whole candidate to 1 row before it ever reached rows that WOULD have
// matched, so this real 16-row table went completely undetected in
// production. See _columnAlignScore's own comment for the fix.
test('a debit/credit-ledger shape (mutually exclusive sparse columns, one row missing both) is still detected as one table', () => {
  const lines = [
    makeLineAt(700, [['Date', 0], ['Description', 60], ['Debit', 200], ['Credit', 280], ['Balance', 360]]),
    makeLineAt(680, [['01', 0], ['Opening Balance', 60], ['1000.00', 360]]),               // neither debit nor credit
    makeLineAt(660, [['02', 0], ['Payment', 60], ['50.00', 200], ['950.00', 360]]),         // debit only
    makeLineAt(640, [['03', 0], ['Deposit', 60], ['200.00', 280], ['1150.00', 360]]),       // credit only
    makeLineAt(620, [['04', 0], ['Payment', 60], ['30.00', 200], ['1120.00', 360]]),        // debit only
  ];
  const tables = detectTables(lines);
  expect(tables.length).toBe(1);
  expect(tables[0].rows.length).toBe(5);
});

test('a genuinely unrelated line (matching only 1 of 4 base columns) is excluded, not absorbed — coverage floor still protects', () => {
  const lines = [
    makeLineAt(700, [['Name', 0], ['Role', 44], ['Score', 88], ['Year', 138]]),
    makeLineAt(680, [['Alice', 0], ['Eng', 44], ['92', 88], ['2024', 138]]),
    makeLineAt(660, [['Bob', 0], ['PM', 44], ['87', 88], ['2023', 138]]),
    makeLineAt(640, [['Carol', 0], ['QA', 44], ['81', 88], ['2022', 138]]),
    makeLineAt(620, [['Score', 88], ['Unrelated', 500]]), // only 1/4 base columns match (coverage 0.25) -- must end the table, not extend into it
  ];
  const tables = detectTables(lines);
  expect(tables.length).toBe(1);
  expect(tables[0].rows.length).toBe(4); // header + 3 real data rows only
});

// ── _p2eExtractPage: ruled grids first ────────────────────
// Real case: a 41-page ruled attestation list where text-alignment column
// guessing got 574/842 records exact (spurious 9th column, wrapped names
// glued onto the previous record). With the drawn rules as cell
// boundaries: 842/842.
console.log('\n_p2eExtractPage — ruled grid:');

const GRID = { x: 0, y: 0, w: 300, h: 90, colXs: [0, 100, 200, 300], rowYs: [90, 60, 30, 0] };

test('a cell wrapped over two lines stays ONE cell in its own row, and an empty cell stays empty', () => {
  const lines = [
    makeLineAt(120, [['Report title', 0]]),                                // above the grid
    makeLineAt(75, [['No', 5], ['Name', 105], ['Group', 205]]),
    makeLineAt(50, [['1', 5], ['Long name', 105], ['89', 205]]),
    makeLineAt(40, [['continued', 105]]),                                  // wrap of row 1's Name
    makeLineAt(15, [['2', 5], ['90', 205]]),                               // Name cell empty
  ];
  const { tables, textRows } = _p2eExtractPage(lines, [GRID], 1);
  expect(tables.length).toBe(1);
  expect(tables[0].rows).toEqual([['No', 'Name', 'Group'], ['1', 'Long name\ncontinued', '89'], ['2', '', '90']]);
  expect(textRows.map(r => r.text)).toEqual(['Report title']);
});

test('two grids own only their cells and preserve notes at the same heights', () => {
  const left = { colXs: [40, 140, 240], rowYs: [90, 60, 30, 0] };
  const right = { colXs: [320, 420, 520], rowYs: [90, 60, 30, 0] };
  const lines = [
    makeLineAt(75, [['Item', 45], ['Qty', 145], ['Code', 325], ['Rate', 425]]),
    makeLineAt(50, [['Paper', 45], ['Memo', 245], ['A', 325], ['7', 425]]),
    makeLineAt(40, [['ream', 45], ['outside the right grid', 530]]),
    makeLineAt(15, [['Ink', 45], ['3', 145], ['B', 325], ['8', 425]]),
  ];
  const { tables, textRows } = _p2eExtractPage(lines, [left, right], 1);
  expect(tables.map(t => t.rows)).toEqual([
    [['Item', 'Qty'], ['Paper\nream', ''], ['Ink', '3']],
    [['Code', 'Rate'], ['A', '7'], ['B', '8']],
  ]);
  expect(textRows.map(row => row.text)).toEqual(['Memo', 'outside the right grid']);
});

test('a partial divider merges only the relevant row and preserves its left anchor', () => {
  const grid = { ...GRID, colDividers: [
    { x: 100, spans: [[0, 60]] }, { x: 200, spans: [[0, 90]] },
  ] };
  const lines = [
    makeLineAt(75, [['Item details', 105], ['Cost', 205]]),
    makeLineAt(45, [['Paper', 5], ['3', 105], ['12.5', 205]]),
    makeLineAt(15, [['Ink', 5], ['4', 105], ['8', 205]]),
  ];
  const [table] = _p2eExtractPage(lines, [grid], 1).tables;
  expect(table.rows[0]).toEqual(['Item details', '', 'Cost']);
  expect(table.merges).toEqual([{ row: 0, from: 0, to: 1 }]);
});

test('vertical cells move wrapped text to the top anchor and preserve blank rows', () => {
  const grid = { ...GRID, rowDividers: [
    { y: 60, spans: [[0, 300]] }, { y: 30, spans: [[100, 300]] },
  ] };
  const lines = [
    makeLineAt(75, [['Name', 5], ['Qty', 105], ['Cost', 205]]),
    makeLineAt(45, [['Long', 5], ['3', 105], ['12', 205]]),
    makeLineAt(15, [['name', 5], ['4', 105], ['8', 205]]),
  ];
  const table = _p2eExtractPage(lines, [grid], 1).tables[0];
  expect(table.rows).toEqual([['Name', 'Qty', 'Cost'], ['Long\nname', '3', '12'], ['', '4', '8']]);
  expect(table.merges).toEqual([{ row: 1, from: 0, to: 0, rowSpan: 2 }]);
  const blank = _p2eExtractPage(lines.slice(0, 2), [grid], 1).tables[0];
  expect(blank.rows.length).toBe(3);
  expect(blank.merges).toEqual(table.merges);
});

test('drawn separators preserve independent blank cells', () => {
  const grid = { ...GRID, rowDividers: [
    { y: 60, spans: [[0, 300]] }, { y: 30, spans: [[0, 300]] },
  ] };
  const lines = [
    makeLineAt(75, [['Name', 5], ['Qty', 105], ['Cost', 205]]),
    makeLineAt(45, [['Paper', 5], ['3', 105]]),
    makeLineAt(15, [['4', 105]]),
  ];
  const table = _p2eExtractPage(lines, [grid], 1).tables[0];
  expect(table.rows).toEqual([['Name', 'Qty', 'Cost'], ['Paper', '3', ''], ['', '4', '']]);
  expect(table.merges).toEqual([]);
});

test('a rectangular merge preserves text placed in its lower row', () => {
  const grid = { ...GRID,
    colDividers: [{ x: 100, spans: [[0, 30]] }, { x: 200, spans: [[0, 90]] }],
    rowDividers: [{ y: 60, spans: [[200, 300]] }, { y: 30, spans: [[0, 300]] }],
  };
  const lines = [
    makeLineAt(75, [['Cost', 205]]),
    makeLineAt(45, [['Combined', 105], ['12', 205]]),
    makeLineAt(15, [['Paper', 5], ['4', 105], ['8', 205]]),
  ];
  const table = _p2eExtractPage(lines, [grid], 1).tables[0];
  expect(table.rows).toEqual([['Combined', '', 'Cost'], ['', '', '12'], ['Paper', '4', '8']]);
  expect(table.merges).toEqual([{ row: 0, from: 0, to: 1, rowSpan: 2 }]);
});

test('a partial horizontal stroke prevents an ambiguous vertical merge', () => {
  const grid = { ...GRID, rowDividers: [
    { y: 60, spans: [[0, 300]] }, { y: 30, spans: [[20, 300]] },
  ] };
  const lines = [
    makeLineAt(75, [['Name', 5], ['Qty', 105]]),
    makeLineAt(45, [['Paper', 5], ['3', 105]]),
    makeLineAt(15, [['4', 105]]),
  ];
  expect(_p2eExtractPage(lines, [grid], 1).tables[0].merges).toEqual([]);
});

test('a lone ruled box with one line of text is not a table — its text goes to the Text sheet', () => {
  const box = { x: 0, y: 0, w: 300, h: 30, colXs: [0, 300], rowYs: [30, 0] };
  const { tables, textRows } = _p2eExtractPage([makeLineAt(15, [['Signature:', 5]])], [box], 1);
  expect(tables.length).toBe(0);
  expect(textRows.map(r => r.text)).toEqual(['Signature:']);
});

test('lines outside every grid still go through the text-alignment detector', () => {
  const lines = [
    makeLineAt(700, [['Name', 0], ['Role', 44], ['Score', 88]]),
    makeLineAt(680, [['Alice', 0], ['Eng', 44], ['92', 88]]),
    makeLineAt(660, [['Bob', 0], ['PM', 44], ['87', 88]]),
  ];
  const { tables } = _p2eExtractPage(lines, [GRID], 1);
  expect(tables.length).toBe(1);
  expect(tables[0].rows.length).toBe(3);
  expect(tables[0].colXs).toBe(undefined);
});

test('justified prose set word by word is not a table, though its words line up (Korean Wikipedia, 2026-10-06)', () => {
  const words = ['포스트스크립트는', '원래', '인쇄', '작업을', '출력', '장치로', '단방향', '선형', '전송하는', '매우',
    '다른', '유스', '케이스를', '위해', '설계되었으며'];
  const lines = [700, 685, 670, 655].map((y, r) => makeLineAt(y, words.slice(r, r + 10).map((w, k) => [w, k * 50])));
  const { tables, textRows } = _p2eExtractPage(lines, [], 1);
  expect(tables.length).toBe(0);
  expect(textRows.length).toBe(4);
});

test('a wrapped row\'s bold total is still bold: bold rows follow the rows, not the line count', () => {
  const B = (y, cells) => ({ y, items: cells.map(([str, x]) => ({ str, x, width: str.length * 6, fontSize: 11, bold: true })) });
  const lines = [
    makeLineAt(700, [['Paper', 0], ['12', 100], ['222.00', 150]]),
    makeLineAt(680, [['Ink', 0], ['10', 100], ['1,450.00', 150]]),
    { y: 663, items: [{ str: 'Large envelopes', x: 0, width: 90, fontSize: 11 }] },
    makeLineAt(656, [['100', 100], ['85.00', 150]]),
    { y: 649, items: [{ str: 'with a strip', x: 0, width: 70, fontSize: 11 }] },
    B(628, [['Total', 0], ['1,757.00', 150]]),
  ];
  const { tables } = _p2eExtractPage(lines, [], 1);
  expect(tables.length).toBe(1);
  expect(tables[0].rows.length).toBe(4);
  expect([...tables[0].boldRows]).toEqual([3]);
});

test('sparse right-aligned ledger preserves all columns and opening balance', () => {
  const lines = [{"y": 325.02734, "items": [{"str": "Date", "x": 33, "y": 325.02734, "width": 15.663719999999994, "fontSize": 8, "bold": false}, {"str": "Description", "x": 77, "y": 325.02734, "width": 39.27160000000001, "fontSize": 8, "bold": false}, {"str": "Withdrawals ($)", "x": 316.8877, "y": 325.02734, "width": 54.16670999999999, "fontSize": 8, "bold": false}, {"str": "Deposits ($)", "x": 419.58301, "y": 325.02734, "width": 41.455789999999936, "fontSize": 8, "bold": false}, {"str": "Balance ($)", "x": 543.63184, "y": 325.02734, "width": 38.399290000000065, "fontSize": 8, "bold": false}]}, {"y": 311.02734, "items": [{"str": "Opening balance", "x": 77.00001, "y": 311.02734, "width": 64.41231999999998, "fontSize": 9, "bold": false}, {"str": "4,247.14", "x": 546.63968, "y": 311.02734, "width": 35.361000000000004, "fontSize": 9, "bold": false}]}, {"y": 297.02734, "items": [{"str": "15 Mar", "x": 32.99995999999999, "y": 297.02729999999997, "width": 26.936840000000014, "fontSize": 9, "bold": false}, {"str": "Transfer", "x": 77.00977, "y": 297.02734, "width": 30.770479999999985, "fontSize": 9, "bold": false}, {"str": "85.00", "x": 438.30175, "y": 297.02734, "width": 22.698, "fontSize": 9, "bold": false}]}, {"y": 283.02734, "items": [{"str": "Interest paid", "x": 77.00109, "y": 283.02734, "width": 48.256889999999984, "fontSize": 9, "bold": false}, {"str": ".15", "x": 448.38192, "y": 283.02734, "width": 12.618000000000002, "fontSize": 9, "bold": false}]}, {"y": 269.02734, "items": [{"str": "ATM withdrawal", "x": 77, "y": 269.02734, "width": 60.11037999999998, "fontSize": 9, "bold": false}, {"str": "100.00", "x": 343.26160000000004, "y": 269.02734, "width": 27.738000000000003, "fontSize": 9, "bold": false}]}, {"y": 255.02734, "items": [{"str": "Interac purchase -1361 - Nasr Foods Inc.", "x": 77.00109, "y": 255.02734, "width": 153.08728000000002, "fontSize": 9, "bold": false}, {"str": "47.82", "x": 348.30174999999997, "y": 255.02734, "width": 22.698, "fontSize": 9, "bold": false}, {"str": "4,184.47", "x": 546.63964, "y": 255.02734, "width": 35.361000000000004, "fontSize": 9, "bold": false}]}, {"y": 241.02734, "items": [{"str": "17 Mar", "x": 33.00882, "y": 241.02734, "width": 26.936770000000003, "fontSize": 9, "bold": false}, {"str": "Overdraft interest", "x": 77.01855, "y": 241.02734, "width": 67.20206, "fontSize": 9, "bold": false}, {"str": "0.93", "x": 353.34182, "y": 241.02734, "width": 17.658, "fontSize": 9, "bold": false}, {"str": "4,183.54", "x": 546.63964, "y": 241.02734, "width": 35.361000000000004, "fontSize": 9, "bold": false}]}, {"y": 227.02734, "items": [{"str": "18 Mar", "x": 33.00882, "y": 227.02734, "width": 26.936770000000003, "fontSize": 9, "bold": false}, {"str": "Cheque #30", "x": 76.99987, "y": 227.02734, "width": 46.22400000000001, "fontSize": 9, "bold": false}, {"str": "40.00", "x": 348.30188, "y": 227.02734, "width": 22.698, "fontSize": 9, "bold": false}]}, {"y": 213.02734, "items": [{"str": "Cheque #31", "x": 77.00001, "y": 213.02734, "width": 46.22400000000001, "fontSize": 9, "bold": false}, {"str": "148.11", "x": 343.26175, "y": 213.02734, "width": 27.738000000000003, "fontSize": 9, "bold": false}, {"str": "3,995.43", "x": 546.63964, "y": 213.02734, "width": 35.361000000000004, "fontSize": 9, "bold": false}]}, {"y": 199.02734, "items": [{"str": "19 Mar", "x": 33.00882, "y": 199.02734, "width": 26.936770000000003, "fontSize": 9, "bold": false}, {"str": "ATM withdrawal", "x": 77.01855, "y": 199.02734, "width": 60.110379999999985, "fontSize": 9, "bold": false}, {"str": "60.00", "x": 348.30179, "y": 199.02734, "width": 22.698, "fontSize": 9, "bold": false}, {"str": "3,935.43", "x": 546.63964, "y": 199.02734, "width": 35.361000000000004, "fontSize": 9, "bold": false}]}, {"y": 185.02734, "items": [{"str": "22 Mar", "x": 32.999919999999975, "y": 185.0273, "width": 26.936880000000023, "fontSize": 9, "bold": false}, {"str": "ATM withdrawal", "x": 77.00977, "y": 185.02734, "width": 60.10987999999999, "fontSize": 9, "bold": false}, {"str": "20.00", "x": 348.30277, "y": 185.02734, "width": 22.698, "fontSize": 9, "bold": false}]}, {"y": 171.02734, "items": [{"str": "Interac purchase - 1361 - The Bay", "x": 77.00109, "y": 171.02734, "width": 126.78973, "fontSize": 9, "bold": false}, {"str": "125.13", "x": 343.2627, "y": 171.02734, "width": 27.738000000000003, "fontSize": 9, "bold": false}]}, {"y": 157.02734, "items": [{"str": "Interac purchase - 1361 - Highland Farms", "x": 77.00109, "y": 157.02734, "width": 156.55251000000004, "fontSize": 9, "bold": false}, {"str": "6.94", "x": 353.34182, "y": 157.02734, "width": 17.658, "fontSize": 9, "bold": false}, {"str": "3,783.36", "x": 546.63964, "y": 157.02734, "width": 35.361000000000004, "fontSize": 9, "bold": false}]}];
  const { tables } = _p2eExtractPage(lines, [], 1);
  expect(tables.length).toBe(1);
  expect(tables[0].rows.length).toBe(13);
  expect(tables[0].rows[0]).toEqual(['Date', 'Description', 'Withdrawals ($)', 'Deposits ($)', 'Balance ($)']);
  expect(tables[0].rows[1]).toEqual(['', 'Opening balance', '', '', '4,247.14']);
  expect(tables[0].rows[3]).toEqual(['', 'Interest paid', '', '.15', '']);
  expect(tables[0].rows[12]).toEqual(['', 'Interac purchase - 1361 - Highland Farms', '6.94', '', '3,783.36']);
  // the workbook keeps tables at confidence >= 0.85 — a lower one went to the Text sheet
  expect(tables[0].confidence >= 0.85).toBe(true);
});

test('fractions without a leading zero remain usable numbers', () => {
  expect(_p2eCellValue('.15')).toEqual({ value: 0.15 });
  expect(_p2eCellValue('-,15')).toEqual({ value: -0.15 });
});

// ── A spreadsheet printed to PDF (2026-11-25) ─────────────────
// Real geometry (LibreOffice 26.2, A4, 6 columns of width 14): heading
// labels sit at each cell's LEFT edge, numbers at its RIGHT edge, so "Date"
// starts 2 pt after the ID numbers end. The heading went to the Text sheet
// on every page, and a reprinted heading or a "Sheet1" / "Page 2 of 7" line
// above the table blocked the page-break join: 7 sheets for one table.
console.log('\n_p2eExtractPage + _p2eStitchTables — a printed spreadsheet:');
const SHEET_VIEW = [0, 0, 595, 842];
const at = (y, cells) => ({ y, items: cells.map(([str, x, right]) => ({ str, x, width: right - x, fontSize: 10 })) });
const SHEET_HEAD = y => at(y, [['ID', 55, 66.6], ['Date', 132.7, 156.2], ['Category', 210.4, 255.3], ['Amount', 288.1, 328.5], ['Qty', 365.8, 383.3], ['Rate', 443.5, 466.5]]);
const SHEET_ROWS = (y0, n, first) => Array.from({ length: n }, (_, k) => at(y0 - 15 * k, [
  [String(first + k), 108.4, 130.6], [`2025-02-${String(10 + k).padStart(2, '0')}`, 157, 208.3], [k % 2 ? 'Food' : 'Software', 210.4, 250.4],
  [`${9000 + k}.98`, 327.5, 363.7], [String(400 + k), 424.7, 441.4], [`0.${600 + k}`, 494.1, 519.1]]));
test('the heading row of a printed spreadsheet is the table\'s first row, not a Text-sheet line', () => {
  const { tables, textRows } = _p2eExtractPage([SHEET_HEAD(769), ...SHEET_ROWS(754, 4, 1000)], [], 1, SHEET_VIEW);
  expect(tables.length).toBe(1);
  expect(tables[0].rows[0]).toEqual(['ID', 'Date', 'Category', 'Amount', 'Qty', 'Rate']);
  expect(tables[0].rows.length).toBe(5);
  expect(textRows.length).toBe(0);
});
test('a heading reprinted on every page: one table, the heading once', () => {
  const out = _p2eStitchTables([
    ..._p2eExtractPage([SHEET_HEAD(769), ...SHEET_ROWS(754, 48, 1000)], [], 1, SHEET_VIEW).tables,
    ..._p2eExtractPage([SHEET_HEAD(769), ...SHEET_ROWS(754, 10, 1048)], [], 2, SHEET_VIEW).tables,
  ]);
  expect(out.length).toBe(1);
  expect(out[0].rows.length).toBe(59);
  expect(out[0].rows[0][0]).toBe('ID');
  expect(out[0].rows[49][0]).toBe('1048');
});
test('a running header ("Sheet1") and footer ("Page N of 2") on every page don\'t split the table', () => {
  const page = (n, first, count) => _p2eExtractPage([at(805, [['Sheet1', 280, 310]]), ...(n === 1 ? [SHEET_HEAD(769)] : []),
    ...SHEET_ROWS(n === 1 ? 754 : 769, count, first), at(30, [[`Page ${n} of 2`, 270, 325]])], [], n, SHEET_VIEW).tables;
  const out = _p2eStitchTables([...page(1, 1000, 48), ...page(2, 1048, 10)]);
  expect(out.length).toBe(1);
  expect(out[0].rows.length).toBe(59);
});
test('a title line above a table is not taken for its heading', () => {
  const { tables, textRows } = _p2eExtractPage([at(790, [['Quarterly', 55, 100], ['report', 104, 135]]), ...SHEET_ROWS(754, 4, 1000)], [], 1, SHEET_VIEW);
  expect(tables[0].rows[0][0]).toBe('1000');
  expect(textRows.length).toBe(1);
});
test('a line that is only on the next page still keeps the tables apart', () => {
  const out = _p2eStitchTables([
    ..._p2eExtractPage([SHEET_HEAD(769), ...SHEET_ROWS(754, 48, 1000)], [], 1, SHEET_VIEW).tables,
    ..._p2eExtractPage([at(805, [['Expenses', 55, 100]]), SHEET_HEAD(769), ...SHEET_ROWS(754, 10, 1048)], [], 2, SHEET_VIEW).tables,
  ]);
  expect(out.length).toBe(2);
});

// ── A wide spreadsheet printed "down, then over" or "over, then down" ──
// (2026-11-25) Columns that don't fit the page width print on later pages, the
// same rows at the same heights. 14 columns came back as 4 sheets of 6, 6, 2.
console.log('\n_p2eJoinColumnBands — a wide printed spreadsheet:');
const band = (page, cols, first, n, head) => {
  const rows = [], rowBands = [];
  if (head) { rows.push(cols.map(c => `${c}`)); rowBands.push([780, 768]); }
  for (let k = 0; k < n; k++) { rows.push(cols.map(c => (c === 'ID' ? String(first + k) : `${c}${first + k}`))); rowBands.push([766 - 15 * k, 754 - 15 * k]); }
  const colXs = cols.map((_, i) => 50 + i * 80).concat(50 + cols.length * 80);
  return { page, rows, rowBands, colXs, confidence: 1, boldRows: new Set(head ? [0] : []), clearAbove: true, clearBelow: true, atTop: true, atBottom: n === 45 };
};
test('down, then over: pages 1–2 columns A–C, pages 3–4 columns D–E → one table of 5 columns', () => {
  const out = _p2eStitchTables(_p2eJoinColumnBands([
    band(1, ['ID', 'A', 'B'], 1000, 45, true), band(2, ['ID', 'A', 'B'], 1045, 10, false),
    band(3, ['D', 'E'], 1000, 45, true), band(4, ['D', 'E'], 1045, 10, false),
  ]));
  expect(out.length).toBe(1);
  expect(out[0].rows.length).toBe(56);
  expect(out[0].rows[0]).toEqual(['ID', 'A', 'B', 'D', 'E']);
  expect(out[0].rows[55]).toEqual(['1054', 'A1054', 'B1054', 'D1054', 'E1054']);
});
test('over, then down: the same table in the other page order → the same result', () => {
  const out = _p2eStitchTables(_p2eJoinColumnBands([
    band(1, ['ID', 'A', 'B'], 1000, 45, true), band(2, ['D', 'E'], 1000, 45, true),
    band(3, ['ID', 'A', 'B'], 1045, 10, false), band(4, ['D', 'E'], 1045, 10, false),
  ]));
  expect(out.length).toBe(1);
  expect(out[0].rows[0]).toEqual(['ID', 'A', 'B', 'D', 'E']);
  expect(out[0].rows[55][4]).toBe('E1054');
});
test('a repeated first column (print titles: ID on every page) is kept once', () => {
  const out = _p2eStitchTables(_p2eJoinColumnBands([
    band(1, ['ID', 'A'], 1000, 45, true), band(2, ['ID', 'D'], 1000, 45, true),
  ]));
  expect(out[0].rows[0]).toEqual(['ID', 'A', 'D']);
  expect(out[0].rows[45]).toEqual(['1044', 'A1044', 'D1044']);
});
test('two different tables on two pages that don\'t share their rows are left apart', () => {
  const a = band(1, ['ID', 'A', 'B'], 1000, 45, true), b = band(2, ['X', 'Y'], 1, 30, true);
  expect(_p2eJoinColumnBands([a, b]).length).toBe(2);
});
test('bands of different lengths are left apart', () => {
  const parts = [band(1, ['ID', 'A'], 1000, 45, true), band(2, ['ID', 'A'], 1045, 10, false), band(3, ['D'], 1000, 45, true)];
  expect(_p2eJoinColumnBands(parts).length).toBe(3);
});

// Right-aligned numbers of different lengths (2026-11-25): "649" starts 5.5 pt
// right of "5627" — the same right edge — and the column split in two by its
// left edges, shifting every value after it (LibreOffice print, a 14-column
// table's second band).
// A band of numbers only (LibreOffice, page 8 of a 14-column print): detectTables
// takes the heading in by left edges — "Q1" at the cell's left, its numbers at
// the right — so each label sat one column left of its numbers, a column held
// only the heading and another only numbers (2026-11-25).
const BAND2 = [at(768.8, [["Q1", 55.0, 69.1], ["Q2", 132.7, 146.8], ["Q3", 210.4, 224.5], ["Q4", 288.1, 302.2], ["Q5", 365.8, 379.9], ["Q6", 443.5, 457.6]]),
  at(754.2, [["7813", 108.4, 130.6], ["5627", 186.1, 208.3], ["6326", 263.8, 286.0], ["136", 347.0, 363.7], ["5847", 419.2, 441.4], ["1653", 496.9, 519.1]]),
  at(739.2, [["3358", 108.4, 130.6], ["9997", 186.1, 208.3], ["7756", 263.8, 286.0], ["4112", 341.5, 363.7], ["2578", 419.2, 441.4], ["9202", 496.9, 519.1]]),
  at(724.2, [["2770", 108.4, 130.6], ["649", 191.6, 208.3], ["2004", 263.8, 286.0], ["4207", 341.5, 363.7], ["7539", 419.2, 441.4], ["4158", 496.9, 519.1]]),
  at(709.2, [["2802", 108.4, 130.6], ["4460", 186.1, 208.3], ["1304", 263.8, 286.0], ["7358", 341.5, 363.7], ["8704", 419.2, 441.4], ["4541", 496.9, 519.1]]),
  at(694.2, [["6823", 108.4, 130.6], ["9342", 186.1, 208.3], ["649", 269.3, 286.0], ["2837", 341.5, 363.7], ["637", 424.7, 441.4], ["1322", 496.9, 519.1]]),
  at(679.2, [["6817", 108.4, 130.6], ["65", 197.2, 208.4], ["2986", 263.8, 286.0], ["1616", 341.5, 363.7], ["7000", 419.2, 441.4], ["3307", 496.9, 519.1]]),
  at(664.2, [["1264", 108.4, 130.6], ["6573", 186.1, 208.3], ["6410", 263.8, 286.0], ["1094", 341.5, 363.7], ["572", 424.7, 441.4], ["2672", 496.9, 519.1]]),
  at(649.2, [["8353", 108.4, 130.6], ["5942", 186.1, 208.3], ["7988", 263.8, 286.0], ["6291", 341.5, 363.7], ["7687", 419.2, 441.4], ["5938", 496.9, 519.1]]),
  at(634.2, [["8414", 108.4, 130.6], ["2783", 186.1, 208.3], ["120", 269.3, 286.0], ["9516", 341.5, 363.7], ["8774", 419.2, 441.4], ["4572", 496.9, 519.1]]),
  at(619.2, [["8285", 108.4, 130.6], ["294", 191.6, 208.3], ["6719", 263.8, 286.0], ["6332", 341.5, 363.7], ["4105", 419.2, 441.4], ["3241", 496.9, 519.1]]),
  at(604.2, [["6459", 108.4, 130.6], ["9674", 186.1, 208.3], ["2579", 263.8, 286.0], ["1033", 341.5, 363.7], ["177", 424.7, 441.4], ["2142", 496.9, 519.1]]),
  at(589.2, [["7264", 108.4, 130.6], ["5537", 186.1, 208.3], ["1533", 263.8, 286.0], ["8575", 341.5, 363.7], ["7222", 419.2, 441.4], ["2348", 496.9, 519.1]]),
  at(574.2, [["651", 114.0, 130.6], ["1814", 186.1, 208.3], ["4207", 263.8, 286.0], ["5106", 341.5, 363.7], ["4666", 419.2, 441.4], ["7205", 496.9, 519.1]])];
test('a numbers-only band: each label over its own numbers, no empty first column', () => {
  const { tables } = _p2eExtractPage(BAND2, [], 8, SHEET_VIEW);
  expect(tables.length).toBe(1);
  expect(tables[0].rows[0]).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6']);
  expect(tables[0].rows[3]).toEqual(['2770', '649', '2004', '4207', '7539', '4158']);
});

test('small print is read enlarged to 10 pt; ordinary text is left as it is', () => {
  const items = sizes => sizes.map(h => ({ height: h, transform: [h, 0, 0, h, 0, 0] }));
  expect(_p2eSmallPrintScale(items([3.2, 3.2, 3.2, 9]))).toBe(10 / 3.2);
  expect(_p2eSmallPrintScale(items([10, 10, 12]))).toBe(1);
  expect(_p2eSmallPrintScale(items([6, 6, 6]))).toBe(1);
  expect(_p2eSmallPrintScale([])).toBe(1);
});

// ── _p2eStitchTables: one table across pages → one worksheet ──
console.log('\n_p2eStitchTables:');

const T = (page, rows, colXs) => ({ page, rows, confidence: 1, boldRows: new Set(), colXs, clearBelow: true, clearAbove: true });

// Borderless tables (user report 2026-10-08: "put into multiple tabs Table1,
// Table 2"): pages run through _p2eExtractPage, then stitched.
const P = (page, lines) => _p2eExtractPage(lines, [], page).tables;
const HDR = y => makeLineAt(y, [['Item', 0], ['Qty', 100], ['Price', 150], ['Date', 220]]);
const ROWS = (y0, n, tag) => Array.from({ length: n }, (_, k) =>
  makeLineAt(y0 - 20 * k, [[`${tag}${k}`, 0], [String(k + 1), 100], [`${k}.50`, 150], ['2026-09-14', 220]]));

test('a borderless table continuing on the next page becomes one table — page number and reprinted header in between', () => {
  const out = _p2eStitchTables([
    ...P(1, [HDR(700), ...ROWS(680, 5, 'a'), makeLineAt(40, [['1', 150]])]),
    ...P(2, [HDR(780), ...ROWS(760, 4, 'b'), makeLineAt(40, [['Page 2 of 2', 120]])]),
  ]);
  expect(out.length).toBe(1);
  expect(out[0].rows.length).toBe(10); // header once + 5 + 4
  expect(out[0].rows.filter(r => r[0] === 'Item').length).toBe(1);
});

test('a heading over a same-column table on the next page keeps them apart ("Expenses")', () => {
  const out = _p2eStitchTables([
    ...P(1, [HDR(700), ...ROWS(680, 5, 'a')]),
    ...P(2, [makeLineAt(800, [['Expenses', 0]]), HDR(780), ...ROWS(760, 4, 'b')]),
  ]);
  expect(out.length).toBe(2);
});

test('a borderless table followed by text on its page, or with other columns on the next page, is not continued', () => {
  const textBelow = _p2eStitchTables([
    ...P(1, [HDR(700), ...ROWS(680, 5, 'a'), makeLineAt(500, [['These totals are subject to change and are provided for reference only.', 0]])]),
    ...P(2, [HDR(780), ...ROWS(760, 4, 'b')]),
  ]);
  expect(textBelow.length).toBe(2);
  const otherCols = _p2eStitchTables([
    ...P(1, [HDR(700), ...ROWS(680, 5, 'a')]),
    ...P(2, [makeLineAt(780, [['Category', 0], ['Amount', 300]]),
      ...Array.from({ length: 4 }, (_, k) => makeLineAt(760 - 20 * k, [[`c${k}`, 0], [`${k}00.00`, 300]]))]),
  ]);
  expect(otherCols.length).toBe(2);
});

test('a ruled table continuing on the next page becomes one table; a reprinted header is dropped', () => {
  const out = _p2eStitchTables([
    T(1, [['No', 'Name'], ['1', 'A']], [0, 100, 200]),
    { ...T(2, [['No', 'Name'], ['2', 'B']], [1, 101, 199]), atBottom: true },   // same columns within snap tolerance
    { ...T(3, [['3', 'C']], [0, 100, 200]), atTop: true },
  ]);
  expect(out.length).toBe(1);
  expect(out[0].rows).toEqual([['No', 'Name'], ['1', 'A'], ['2', 'B'], ['3', 'C']]);
});

test('repeated header is skipped and identical data rows keep their values and bold style', () => {
  const cols = [40, 140, 240];
  const head = ['Item', 'Qty'];
  const duplicate = ['Paper', '3'];
  const last = ['Ink', '8'];
  const out = _p2eStitchTables([
    T(1, [head, duplicate, ['Pens', '4']], cols),
    { ...T(2, [head, duplicate, last], cols), boldRows: new Set([1]) },
  ]);
  expect(out.map(table => table.rows)).toEqual([[head, duplicate, ['Pens', '4'], duplicate, last]]);
  expect([...out[0].boldRows]).toEqual([3]);
});

test('ruled tables with matching columns and a separate section title stay separate', () => {
  const grid = { colXs: [40, 140, 240], rowYs: [90, 60, 30, 0] };
  const rows = [
    makeLineAt(75, [['Item', 45], ['Qty', 145]]),
    makeLineAt(45, [['Paper', 45], ['3', 145]]),
    makeLineAt(15, [['Ink', 45], ['5', 145]]),
  ];
  const out = _p2eStitchTables([
    ..._p2eExtractPage(rows, [grid], 1).tables,
    ..._p2eExtractPage([makeLineAt(120, [['Expenses', 45]]), ...rows], [grid], 2).tables,
  ]);
  expect(out.length).toBe(2);
});

test('different headers keep tables with matching columns apart', () => {
  const cols = [40, 140, 240];
  const out = _p2eStitchTables([
    { ...T(1, [['Item', 'Qty'], ['Paper', '3']], cols), atBottom: true },
    { ...T(2, [['Code', 'Rate'], ['A', '7']], cols), atTop: true },
  ]);
  expect(out.length).toBe(2);
});

test('equal text rows without evidence of a header survive a continuation at the page break', () => {
  const cols = [40, 140, 240];
  const first = [['London', 'North'], ['Oslo', 'West']];
  const second = [['London', 'North'], ['Riga', 'East']];
  const out = _p2eStitchTables([
    { ...T(1, first, cols), atBottom: true },
    { ...T(2, second, cols), atTop: true },
  ]);
  expect(out.map(t => t.rows)).toEqual([[...first, ...second]]);
});

test('different columns, a skipped page, or a text-detected table are NOT stitched', () => {
  const out = _p2eStitchTables([
    T(1, [['a', 'b']], [0, 100, 200]),
    T(2, [['c', 'd', 'e']], [0, 60, 130, 200]),           // different column layout
    T(4, [['f', 'g', 'h']], [0, 60, 130, 200]),           // page 3 in between
    T(5, [['i', 'j', 'k']], undefined),                   // text-detected, no rules
  ]);
  expect(out.length).toBe(4);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function testCancelThenRetry(stage) {
  const { doProcess, cancelProcess } = await import('../js/processor.js');
  const { selectedFiles, isFilesLocked } = await import('../js/files.js');
  const { registerTool } = await import('../js/toolRegistry.js');
  const { clearLongOpHint } = await import('../js/ui.js');
  registerTool('pdf2excel', { runner: 'pdf2excel' });
  const element = { style: { setProperty() {} }, classList: { add() {}, remove() {} }, setAttribute() {} };
  const files = name => ({ name, size: 8, _decryptedBuffer: new ArrayBuffer(8) });
  const reachedOld = deferred();
  const reachedNew = deferred();
  const oldWork = deferred();
  const newWrite = deferred();
  const successes = [];
  const destroyed = [];
  let loads = 0;
  let writes = 0;
  let graphicsReads = 0;
  let oldRun;
  let newRun;

  document.getElementById = key => key === 'toast' ? null : element;
  document.dispatchEvent = event => { if (event.type === 'pdfree:success') successes.push(event.detail.filename); };
  const oldFetch = global.fetch;
  const OldCustomEvent = global.CustomEvent;
  global.CustomEvent = class {
    constructor(type, { detail } = {}) { this.type = type; this.detail = detail; }
  };
  global.fetch = async () => new Response(new ArrayBuffer(0));
  window.pdfjsLib = {
    getDocument() {
      const index = ++loads;
      const doc = {
        numPages: index === 2 ? 1 : 0,
        getPage: async () => ({
          getTextContent: async () => ({ items: [], styles: {} }),
          getOperatorList: async () => { graphicsReads++; return { fnArray: [], argsArray: [] }; },
        }),
      };
      if (index === 1 && stage === 'loading') reachedOld.resolve();
      return {
        promise: index === 1 && stage === 'loading' ? oldWork.promise.then(() => doc) : Promise.resolve(doc),
        destroy: async () => { destroyed.push(index); },
      };
    },
  };
  window.ExcelJS = {
    Workbook: class {
      addWorksheet() { return { addRow() {} }; }
      get xlsx() {
        return { writeBuffer: () => {
          writes++;
          if (stage === 'writing' && writes === 1) {
            reachedOld.resolve();
            return oldWork.promise;
          }
          reachedNew.resolve();
          return newWrite.promise;
        } };
      }
    },
  };

  try {
    selectedFiles.push(files('first.pdf'));
    oldRun = doProcess('pdf2excel');
    await Promise.race([reachedOld.promise, oldRun.then(() => { throw new Error('First run exited before the pause'); })]);
    cancelProcess('pdf2excel');
    selectedFiles.splice(0, 1, files('second.pdf'));
    newRun = doProcess('pdf2excel');
    await Promise.race([reachedNew.promise, newRun.then(() => { throw new Error('Retry exited before the pause'); })]);
    oldWork.resolve(new ArrayBuffer(8));
    // On the old loading path the cancelled run may also wait on newWrite.
    // Give it a turn to reach that point without blocking the retry.
    await new Promise(resolve => setImmediate(resolve));
    const whileRetrying = { originalReleased: destroyed.includes(1), locked: isFilesLocked(), results: [...successes] };
    newWrite.resolve(new ArrayBuffer(8));
    await Promise.all([oldRun, newRun]);
    expect({ whileRetrying, successes, destroyed: [...destroyed].sort(), graphicsReads }).toEqual({
      whileRetrying: { originalReleased: true, locked: true, results: [] },
      successes: ['second.xlsx'],
      destroyed: [1, 2],
      graphicsReads: 0,
    });
  } finally {
    oldWork.resolve(new ArrayBuffer(8));
    newWrite.resolve(new ArrayBuffer(8));
    await Promise.allSettled([oldRun, newRun]);
    clearLongOpHint();
    selectedFiles.length = 0;
    global.fetch = oldFetch;
    global.CustomEvent = OldCustomEvent;
    delete window.ExcelJS;
    delete window.pdfjsLib;
    delete document.dispatchEvent;
    document.getElementById = () => null;
  }
}

for (const stage of ['loading', 'writing']) {
  const name = `cancel while ${stage} releases the original PDF and keeps the retry isolated`;
  try {
    await testCancelThenRetry(stage);
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`);
    failed++;
  }
}

test('large image with only an outside heading needs a mixed-page warning', () => {
  expect(_p2eHasUnrepresentedImage(
    [{ x: 30, yTop: 700, width: 540, height: 600 }],
    [{ x: 40, y: 760, str: 'Payroll register', width: 100 }],
    [0, 0, 600, 800])).toBe(true);
});

test('logos, out-of-page images and searchable scans do not trigger the mixed-page warning', () => {
  const view = [0, 0, 600, 800];
  expect(_p2eHasUnrepresentedImage([{ x: 40, yTop: 760, width: 70, height: 50 }], [], view)).toBe(false);
  expect(_p2eHasUnrepresentedImage([{ x: 650, yTop: 700, width: 600, height: 700 }], [], view)).toBe(false);
  expect(_p2eHasUnrepresentedImage([{ x: 0, yTop: 800, width: 600, height: 800 }],
    [{ x: 50, y: 600, width: 150, str: 'Extractable table with values 123 456' }], view)).toBe(false);
  expect(_p2eHasUnrepresentedImage([], [], view)).toBe(false);
});

test('mixed-page warning stays visible without detected tables and links to OCR', () => {
  const root = { style: {}, children: [], replaceChildren() { this.children = []; },
    append(node) { this.children.push(node); } };
  const oldDocument = { ...document };
  const oldLocation = global.location;
  document.getElementById = id => id === 'p2eConfidence' ? root : null;
  document.createElement = () => ({ style: {}, children: [], append(...nodes) { this.children.push(...nodes); } });
  global.location = { pathname: '/pdf-to-excel/' };
  try {
    renderP2eConfidence({ tableCount: 0, imagePages: [171] });
    expect(root.style.display).toBe('');
    expect(root.children[0].children[0].textContent.includes('171')).toBe(true);
    expect(root.children[0].children[1].href).toBe('/ocr-pdf/');
    renderP2eConfidence({ tableCount: 0 });
    expect(root.children.length).toBe(0);
    expect(root.style.display).toBe('none');
  } finally {
    Object.assign(document, oldDocument);
    global.location = oldLocation;
  }
});

test('Excel result warns about skipped pages even when no table was found', () => {
  const root = { style: {}, innerHTML: '', children: [], replaceChildren() { this.children = []; },
    append(node) { this.children.push(node); } };
  const originalDocument = { ...document };
  const originalLocation = global.location;
  document.getElementById = id => id === 'p2eConfidence' ? root : null;
  document.createElement = () => ({ style: {}, children: [], append(...nodes) { this.children.push(...nodes); } });
  global.location = { pathname: '/ar/pdf-ila-excel/' };
  try {
    renderP2eConfidence({ tableCount: 0, skippedPages: [2, 3, 4, 7] });
    expect(root.style.display).toBe('');
    const [warning] = root.children;
    expect(warning.children[0].textContent.includes('2-4, 7')).toBe(true);
    expect(warning.children[1].href).toBe('/ar/taarruf-dawi-pdf/');
    renderP2eConfidence({ tableCount: 1, skippedPages: [], score: 100, level: 'high' });
    expect(root.children.length).toBe(1);
    expect(root.innerHTML.includes('100%')).toBe(false);
  } finally {
    Object.assign(document, originalDocument);
    global.location = originalLocation;
  }
});

const filenameFixture = '<b>NAME</b>.pdf';
try {
  const oldDocument = { ...document };
  const oldPdfJs = window.pdfjsLib;
  const nameNode = {};
  const panel = {
    style: {}, innerHTML: '',
    querySelector: selector => selector === '.compress-info__name' ? nameNode : null,
  };
  document.getElementById = key => key === 'pdf2excelOptions' ? panel : null;
  document.createElement = () => ({
    set textContent(text) { this.innerHTML = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  });
  window.pdfjsLib = { getDocument: () => ({ promise: Promise.resolve({ numPages: 0 }), destroy: async () => {} }) };
  try {
    await initPdf2ExcelOptions({ name: filenameFixture, _decryptedBuffer: new ArrayBuffer(8) });
    expect(panel.innerHTML.includes(filenameFixture)).toBe(false);
    expect(nameNode.textContent).toBe(filenameFixture);
    expect(nameNode.title).toBe(filenameFixture);
  } finally {
    hidePdf2ExcelOptions();
    Object.assign(document, oldDocument);
    window.pdfjsLib = oldPdfJs;
  }
  console.log('  ✓ Excel preview treats the filename as text');
  passed++;
} catch (error) {
  console.error(`  ✗ Excel preview treats the filename as text\n    ${error.message}`);
  failed++;
}

test('an explicit decimal separator only resolves ambiguous values', () => {
  const comma = _p2eTableMark([['Amount'], ['1,234']], 'comma');
  const dot = _p2eTableMark([['Amount'], ['1,234']], 'dot');
  expect(_p2eCellValue('1,234', comma)).toEqual({ value: 1.234 });
  expect(_p2eCellValue('1,234', dot)).toEqual({ value: 1234 });
  expect(_p2eCellValue('12,50', dot)).toEqual({ value: 12.5 });
  expect(_p2eCellValue('00123', comma)).toEqual({ value: '00123' });
});

test('Auto reads a table by its own numbers; a choice overrides them', () => {
  const european = [['Summe'], ['1.234,56'], ['1,234']];
  expect(_p2eTableMark(european, 'auto')).toBe(',');
  expect(_p2eTableMark(european, 'dot')).toBe('.');
  expect(_p2eTableMark([['Amount'], ['1,234']], 'auto')).toBe('.');
});

test('a stitched table reports each source page once', () => {
  const cols = [40, 140, 240];
  const tables = [
    T(1, [['Item', 'Qty'], ['A', '1']], cols),
    T(2, [['Item', 'Qty'], ['B', '2']], cols),
  ];
  expect(_p2eStitchTables(tables).map(table => table.sourcePages)).toEqual([[1, 2]]);
});

// Formatting must travel with values, including repeated-header removal.
test('ruled table retains physical row bands for formatting', () => {
  const lines = [90,70].map((y,r) => ({ y, items: [
    {str:r ? 'A' : 'Item', x:10,y,width:20,fontSize:12,bold:false},
    {str:r ? '2' : 'Qty', x:110,y,width:15,fontSize:12,bold:false},
  ] }));
  const result = _p2eExtractPage(lines,[{colXs:[0,100,150],rowYs:[100,80,60]}],1);
  expect(result.tables[0].rowBands).toEqual([[100,80],[80,60]]);
});
test('continuation styles follow rows after removing repeated heading', () => {
  const a = T(1, [['Item','Qty'],['A','1']], [0,100,150]);
  const b = T(2, [['Item','Qty'],['B','2']], [0,100,150]);
  a.cellStyles = [[{font:{size:12}}],[{font:{size:10}}]];
  b.cellStyles = [[{font:{size:12}}],[{font:{size:9}}]];
  a.rowHeights = [20,18]; b.rowHeights = [20,17];
  const table = _p2eStitchTables([a,b])[0];
  expect(table.cellStyles.length).toBe(3);
  expect(table.cellStyles[2][0].font.size).toBe(9);
  expect(table.rowHeights).toEqual([20,18,17]);
});

const { readExcelPaint, styleExcelTable, applyExcelStyles } = await import('../js/pdf2excelStyles.js');
const paintOps = (...pairs) => ({fnArray:pairs.map(p=>p[0]),argsArray:pairs.map(p=>p[1])});
const glyphs = text => [...text].map(unicode=>({unicode}));
test('text colours require exact complete stream correspondence', () => {
  const ops = paintOps([59,new Uint8ClampedArray([255,0,0])],[44,[glyphs('AB')]],[59,[0,0,255]],[44,[glyphs('CD')]]);
  expect(readExcelPaint(ops,[{str:'AB'},{str:'CD'}]).colors).toEqual(['FF0000','0000FF']);
  expect(readExcelPaint(ops,[{str:'ABC'},{str:'D'}]).colors).toEqual([null,'0000FF']);
  expect(readExcelPaint(ops,[{str:'AXCD'}]).colors).toEqual([]);
});
test('rectangle fills respect transforms and graphics-state restore', () => {
  const ops = paintOps([10,[]],[12,[2,0,0,2,10,20]],[59,[128,0,255]],
    [91,[[19],[0,0,50,20]]],[22,[]],[11,[]],[44,[glyphs('A')]]);
  const paint = readExcelPaint(ops,[{str:'A'}]);
  expect(paint.fills[0]).toEqual({bounds:[10,20,110,60],color:'8000FF'});
  expect(paint.colors).toEqual(['000000']);
});
test('clipping-only paths do not become backgrounds or borders', () => {
  const paint = readExcelPaint(paintOps([91,[[19],[0,0,20,20]]],[29,[]],[28,[]]),[]);
  expect(paint.fills).toEqual([]);expect(paint.rules).toEqual([]);
});
test('rectangular clipping intersects subsequent fills', () => {
  const paint = readExcelPaint(paintOps([91,[[19],[0,0,20,20]]],[29,[]],[28,[]],
    [91,[[19],[-10,-10,50,50]]],[22,[]]),[]);
  expect(paint.fills[0].bounds).toEqual([0,0,20,20]);
});
test('transparency and hidden text never acquire invented opaque colours', () => {
  const paint = readExcelPaint(paintOps([9,[[['ca',0.5]]]],[59,[255,0,0]],
    [44,[glyphs('A')]],[91,[[19],[0,0,20,20]]],[22,[]]),[{str:'A'}]);
  expect(paint.colors).toEqual([null]);expect(paint.fills[0].color).toBe(null);
  expect(readExcelPaint(paintOps([38,[3]],[44,[glyphs('A')]]),[{str:'A'}]).colors).toEqual([null]);
});
test('small logo rectangle does not colour a larger table cell', () => {
  const table={rows:[['A']],colXs:[0,100],rowBands:[[100,80]]};
  styleExcelTable(table,[{str:'A',x:10,y:85,fontSize:12,bold:false}],{fills:[{bounds:[0,80,20,100],color:'FF0000'}]});
  expect(table.cellStyles[0][0].fill).toBe(undefined);
});
test('font and fill metadata never changes values or numerical format', () => {
  const table={rows:[['42']],colXs:[0,100],rowBands:[[100,80]]};
  styleExcelTable(table,[{str:'42',x:10,y:85,fontSize:12,bold:true,italic:true,color:'FFFFFF'}],{fills:[{bounds:[0,80,100,100],color:'8000FF'}]});
  const cell={value:42,numFmt:'0.00'};
  const row={getCell:()=>cell};const column={};
  applyExcelStyles({getRow:()=>row,getColumn:()=>column},table);
  expect(cell.value).toBe(42);expect(cell.numFmt).toBe('0.00');expect(cell.font.size).toBe(12);
  expect(cell.font.color.argb).toBe('FFFFFFFF');expect(cell.fill.fgColor.argb).toBe('FF8000FF');
  expect(row.height).toBe(20);expect(table.rows).toEqual([['42']]);
});
test('white text without a recognised background stays readable', () => {
  const table={rows:[['A']],colXs:[0,100],rowBands:[[100,80]]};
  styleExcelTable(table,[{str:'A',x:10,y:85,fontSize:12,color:'FFFFFF'}],{fills:[]});
  expect(table.cellStyles[0][0].font.color).toBe(undefined);
});
test('stroked rectangles transfer real border colour', () => {
  const paint=readExcelPaint(paintOps([58,[0,0,255]],[91,[[19],[0,80,100,20]]],[20,[]]),[]);
  const table={rows:[['A']],colXs:[0,100],rowBands:[[100,80]]};
  styleExcelTable(table,[],paint);
  expect(Object.keys(table.cellStyles[0][0].border).length).toBe(4);
  expect(table.cellStyles[0][0].border.top.color.argb).toBe('FF0000FF');
});

test('borderless full-row stripe applies but a one-word highlight does not', () => {
  const make=()=>({rows:[['Item','Qty']],colCenters:[20,120],rowBands:[[100,80]]});
  const items=[{str:'Item',x:10,y:85,width:25,fontSize:12},{str:'Qty',x:110,y:85,width:20,fontSize:12}];
  const table=make();styleExcelTable(table,items,{fills:[{bounds:[0,80,140,100],color:'336699'}]});
  expect(table.cellStyles[0].map(s=>s.fill.fgColor.argb)).toEqual(['FF336699','FF336699']);
  const highlighted=make();styleExcelTable(highlighted,items,{fills:[{bounds:[0,80,40,100],color:'FFFF00'}]});
  expect(highlighted.cellStyles[0][0].fill).toBe(undefined);
});
test('form placement and quarter-turn rotation preserve rectangle bounds', () => {
  const ops=paintOps([74,[[1,0,0,1,10,20],[0,0,100,100]]],[59,[20,40,60]],
    [91,[[19],[0,0,30,40]]],[22,[]],[75,[]]);
  const paint=readExcelPaint(ops,[],[0,1,-1,0,200,0]);
  expect(paint.fills[0]).toEqual({bounds:[140,10,180,40],color:'14283C'});
});
test('optional formatting work is bounded without changing a large table', () => {
  const table={rows:Array.from({length:2000},()=>['42']),colXs:[0,100],rowBands:Array.from({length:2000},()=>[100,80])};
  styleExcelTable(table,Array.from({length:2000},()=>({str:'42',x:10,y:85})),{fills:[]});
  expect(table.cellStyles).toBe(undefined);expect(table.rows.length).toBe(2000);
});

test('a curve does not invent a straight border from its old start point', () => {
  const paint=readExcelPaint(paintOps([91,[[13,15,14],[0,80,0,80,100,80,100,100,0,100]]],[20,[]]),[]);
  expect(paint.rules).toEqual([]);
});

// ── Summary ────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
