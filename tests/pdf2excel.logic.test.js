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

const { _p2eCellValue, _p2eDecimalMark, _p2eTableMark, _p2eExtractPage, _p2eStitchTables } = await import('../js/processor.js');
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
      const doc = { numPages: 0 };
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
    expect({ whileRetrying, successes, destroyed: [...destroyed].sort() }).toEqual({
      whileRetrying: { originalReleased: true, locked: true, results: [] },
      successes: ['second.xlsx'],
      destroyed: [1, 2],
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

// ── Summary ────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
