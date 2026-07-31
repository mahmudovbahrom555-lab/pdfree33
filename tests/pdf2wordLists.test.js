// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/pdf2wordLists.test.js — Unit тесты для BULLET_RE/NUMBERED_RE,
//  общего детектора списочных строк для pdf2word и pdf2md.
//
//  pdf2word теперь рендерит распознанные строки как настоящий Word-список
//  (native <w:numPr>, маркер убирается из текста — Word сам подставляет
//  bullet/номер), а не как обычный абзац с буквальным "•"/"1." внутри.
//  Ключевое safety-свойство, на которое опирается эта фича: многоуровневая
//  нумерация пунктов договора ("2.5.1.", "5.11.") НИКОГДА не должна
//  совпадать с NUMBERED_RE — иначе pdf2word начал бы "перенумеровывать"
//  юридически значимые номера пунктов через автонумерацию Word, что было
//  бы реальной регрессией, а не улучшением. Этот файл тестирует именно
//  регекспы напрямую (единственную часть логики, которую можно проверить
//  без мокания window.docx/Paragraph/TextRun) — фактическая сборка
//  <w:numPr> в реальном docx проверена вручную через Playwright на
//  синтетическом PDF со списками и на реальном 19-страничном контракте
//  (регрессии нет, ERI остался 100).
// ============================================================

// processor.js touches Worker/document at module load time (it's built for
// the browser), so stub the minimum needed to import it under plain Node —
// same approach pdf2excel.logic.test.js uses.
global.document = {
  documentElement: { lang: 'en' },
  getElementById:  () => null,
  querySelector:   () => null,
  addEventListener: () => {},
  createElement:   () => ({ style: {}, setAttribute() {}, appendChild() {} }),
};
global.window    = globalThis;
global.Worker    = class { postMessage() {} terminate() {} addEventListener() {} };

const { BULLET_RE, NUMBERED_RE } = await import('../js/processor.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

console.log('\nBULLET_RE:');

test('recognises common bullet glyphs', () => {
  for (const glyph of ['•', '◦', '▪', '‣', '●', '○']) {
    if (!BULLET_RE.test(`${glyph} Item text`)) {
      throw new Error(`expected "${glyph} Item text" to match BULLET_RE`);
    }
  }
});

test('does not match plain text starting with a letter or digit', () => {
  if (BULLET_RE.test('Regular paragraph text')) throw new Error('false positive on plain text');
  if (BULLET_RE.test('1. Numbered item')) throw new Error('bullet regex should not claim numbered lines');
});

console.log('\nNUMBERED_RE:');

test('recognises flat "N." and "N)" markers', () => {
  for (const s of ['1. First item', '2) Second item', '10. Tenth item']) {
    if (!NUMBERED_RE.test(s)) throw new Error(`expected "${s}" to match NUMBERED_RE`);
  }
});

test('SAFETY: multi-level clause numbering never matches (real contract examples)', () => {
  // These are the exact patterns found in iia_contract_21057.pdf — if this
  // regression fires, pdf2word's numbered-list renderer would start
  // stripping and Word-auto-renumbering real legal clause references.
  for (const s of ['2.5.1. Оказывать услуги...', '5.11. а) при биржевых торгах...', '6.15. рамках настоящего Договора...']) {
    if (NUMBERED_RE.test(s)) throw new Error(`"${s}" must NOT match NUMBERED_RE — it's a clause reference, not a flat list marker`);
  }
});

test('does not match a decimal number', () => {
  if (NUMBERED_RE.test('3.14 is pi')) throw new Error('false positive on a decimal number');
});

test('does not match letter/roman enumeration (by design)', () => {
  if (NUMBERED_RE.test('a. First item')) throw new Error('letter enumeration should not match');
  if (NUMBERED_RE.test('iv. Fourth item')) throw new Error('roman enumeration should not match');
});

test('does not match a bullet-glyph line', () => {
  if (NUMBERED_RE.test('• Bulleted item')) throw new Error('numbered regex should not claim bullet lines');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
