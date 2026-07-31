// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/pdf2wordTables.test.js — regression tests for the two
//  "is this actually a table?" guards in js/pdf2wordTables.js:
//
//    looksLikeProseNotData()   — two unrelated prose columns
//                                 (existing, used by pdf2md; had no
//                                 dedicated test file before this one)
//    looksLikeEnumeratedList() — numbered legal clause lists
//                                 (new — see below)
//
// Both guards were added/wired into pdf2word after testing it against a
// real 19-page Uzbek investment-brokerage contract
// (iia_contract_21057.pdf). detectTables() found 4 false-positive
// "tables" in that document that were never gated before pdf2word's own
// call site (pdf2md already gated on looksLikeProseNotData; pdf2word did
// not gate on anything):
//   • 3 numbered legal clause lists — clause number in column 1
//     ("2.5.1.", "5.11.", "6.15." …), full clause prose in column 2 —
//     e.g. "5.11. | а) при биржевых торгах с эмиссионными ценными
//     бумагами - 0,01% от суммы сделки;"
//   • 1 coincidental X-alignment between a wrapped address paragraph and
//     an unrelated label/value signature block
// The exact row shapes below (rows_clause6, rows_clause9, rows_clause11)
// are copied verbatim from detectTables()'s real output on that PDF
// (pages 6, 9, 11 — dumped via a throwaway Playwright script driving the
// live pdf-to-word tool against the real file), not invented — this is
// the regression net for that specific finding.
//
// Run: node tests/pdf2wordTables.test.js

const { looksLikeProseNotData, looksLikeEnumeratedList } =
  await import('../js/pdf2wordTables.js');

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

// ── looksLikeEnumeratedList: real false positives from the contract ────────
console.log('\nlooksLikeEnumeratedList — real false positives (iia_contract_21057.pdf):');

// detectTables() output on page 6, verbatim.
const rows_clause6 = [
  ['2.4.15.', 'имеются санкционные, комплаенс- или иные правовые ограничения.'],
  ['2.5.', 'Инвестиционный посредник не имеет право:'],
  ['2.5.1.', 'Оказывать услуги Инвестиционного посредника на рынке ценных бумаг без соответствующей лицензии или'],
];

// detectTables() output on page 9, verbatim — note row 2's clause text
// contains an inline percentage ("0,01%"). This is exactly the shape that
// can defeat looksLikeProseNotData's numeric-anchor check if the anchor
// ever ends up isolated in its own cell (see the adversarial case below) —
// here it doesn't (the "0,01%" is embedded in a full sentence, not a bare
// cell), so both guards agree, but the fixture is kept close to the real
// data as the primary regression record.
const rows_clause9 = [
  ['5.11.', 'а) при биржевых торгах с эмиссионными ценными бумагами - 0,01% от суммы сделки;'],
  ['5.12.', 'б) при организованных внебиржевых торгах - 0,3% от суммы сделки.'],
  ['5.13.', 'Налоговый режим доходов продавца определяется законодательством и может зависеть от вида торгов и'],
];

// detectTables() output on page 11, verbatim.
const rows_clause11 = [
  ['6.15.', 'рамках настоящего Договора ИИС и действующего законодательства;'],
  ['6.16.', 'рамках поручения Клиента на покупку-продажу ценных бумаг;'],
  ['6.17.', 'рамках разработанного им Регламента, с которым Клиент ознакомлен;'],
  ['6.18.', 'соответствии с принятой рыночной практикой;'],
  ['6.19.', 'соответствии с правовыми нормами, применяемыми на месте исполнения сделки;'],
  ['6.20.', 'при наступлении рискового случая, связанного со сделками с ценными бумагами.'],
  ['6.21.', 'В соответствии с настоящим Договором ИИС и поручением на совершение сделок покупки-продажи ценных'],
];

test('page 6 clause list ("2.4.15." / "2.5." / "2.5.1.") is recognised as an enumerated list', () => {
  expect(looksLikeEnumeratedList(rows_clause6)).toBe(true);
});

test('page 9 clause list ("5.11." / "5.12." / "5.13.", Cyrillic "а)"/"б)" sub-markers) is recognised', () => {
  expect(looksLikeEnumeratedList(rows_clause9)).toBe(true);
});

test('page 11 clause list ("6.15."–"6.21.") is recognised', () => {
  expect(looksLikeEnumeratedList(rows_clause11)).toBe(true);
});

// ── Defense in depth: catches what looksLikeProseNotData alone would miss ──
console.log('\nlooksLikeEnumeratedList — defeats looksLikeProseNotData\'s blind spot:');

test('a clause row whose text IS a bare percentage still reads as a list, even though ' +
     'that defeats looksLikeProseNotData\'s numeric-anchor check', () => {
  const rows = [
    ['1.', 'Оказывать услуги на рынке ценных бумаг без соответствующей лицензии'],
    ['2.', '5%'], // bare number — a real cell that could be mistaken for tabular data
    ['3.', 'Возврат ценных бумаг из залога в соответствии с законодательством'],
  ];
  // looksLikeProseNotData is fooled: cell "5%" matches its numeric-anchor
  // regex, so it reports "this has a numeric anchor, might be real data"
  // and does NOT flag it — demonstrating why a second, structural guard
  // (column-1 marker shape) is needed independently.
  expect(looksLikeProseNotData(rows)).toBe(false);
  expect(looksLikeEnumeratedList(rows)).toBe(true);
});

// ── Must NOT exclude genuine numbered tables ────────────────────────────────
console.log('\nlooksLikeEnumeratedList — leaves genuine numbered tables alone:');

test('a genuine numbered price list ("1. | Widget A | $10.00") is NOT flagged as a list', () => {
  const rows = [
    ['№', 'Item', 'Price'],
    ['1.', 'Widget A', '$10.00'],
    ['2.', 'Widget B', '$25.00'],
    ['3.', 'Widget C', '$5.00'],
  ];
  // Column 1 markers ("1.", "2.", "3.") match the same clause-numbering
  // shape, but the OTHER columns are short (item name + price), not
  // prose — the words-per-cell gate must keep this a real table.
  expect(looksLikeEnumeratedList(rows)).toBe(false);
});

test('a plain non-numbered table is NOT flagged', () => {
  const rows = [
    ['Name', 'Amount'],
    ['Alice', '100'],
    ['Bob', '200'],
    ['Carol', '300'],
  ];
  expect(looksLikeEnumeratedList(rows)).toBe(false);
});

test('fewer than 2 rows never qualifies', () => {
  expect(looksLikeEnumeratedList([['1.', 'Some clause text here']])).toBe(false);
  expect(looksLikeEnumeratedList([])).toBe(false);
});

test('a table with no marker-shaped column 1 at all is NOT flagged', () => {
  const rows = [
    ['Alpha', 'A very long descriptive sentence about the first item in this list'],
    ['Beta', 'A very long descriptive sentence about the second item in this list'],
    ['Gamma', 'A very long descriptive sentence about the third item in this list'],
  ];
  expect(looksLikeEnumeratedList(rows)).toBe(false);
});

// ── looksLikeProseNotData: existing guard, previously untested ─────────────
console.log('\nlooksLikeProseNotData:');

test('two unrelated prose columns (e.g. resume Skills/Interests) are flagged as prose', () => {
  const rows = [
    ['Skills', 'Interests'],
    ['Fluent in JavaScript and Python programming', 'Hiking in the mountains every weekend'],
    ['Experienced with cloud infrastructure design', 'Playing chess competitively since childhood'],
    ['Strong background in distributed systems work', 'Cooking traditional regional recipes at home'],
  ];
  expect(looksLikeProseNotData(rows)).toBe(true);
});

test('a real data table with a numeric anchor is NOT flagged as prose', () => {
  const rows = [
    ['Product', 'Revenue'],
    ['Widgets', '$1,234.56'],
    ['Gadgets', '$789.00'],
  ];
  expect(looksLikeProseNotData(rows)).toBe(false);
});

test('fewer than 2 rows never qualifies', () => {
  expect(looksLikeProseNotData([['A', 'B']])).toBe(false);
});

// ── Summary ──────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
