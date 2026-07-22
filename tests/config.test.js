// ============================================================
//  tests/config.test.js — Unit tests for js/config.js
//  Запуск: node tests/config.test.js
//
//  Тестирует: getLocalizedTool (язык/fallback), структуру TOOLS,
//  структуру ACCEPTED_MIME.
//
//  config.js → getLang() читает document.documentElement.lang.
//  В Node нет DOM, поэтому мокаем минимальный document ДО импорта.
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
  };
}

// ── Mock DOM (getLang reads document.documentElement.lang) ──
// Мутируемый lang позволяет переключать язык между тестами.
global.document = { documentElement: { lang: '' } };
function setLang(l) { global.document.documentElement.lang = l; }

const { TOOLS, ACCEPTED_MIME, getLocalizedTool, getLang } = await import('../js/config.js');

// ── getLang ────────────────────────────────────────────────
console.log('\ngetLang:');

test('пустой lang → "en"', () => {
  setLang('');
  expect(getLang()).toBe('en');
});

test('читает установленный lang', () => {
  setLang('fr');
  expect(getLang()).toBe('fr');
});

// ── getLocalizedTool ───────────────────────────────────────
console.log('\ngetLocalizedTool:');

const sampleTool = {
  title: 'EN-fallback title',
  desc:  'EN-fallback desc',
  btn:   'EN-fallback btn',
  titles: { en: 'EN Title', fr: 'FR Titre' },
  descs:  { en: 'EN Desc',  fr: 'FR Desc' },
  btns:   { en: 'EN Btn',   fr: 'FR Btn' },
};

test('возвращает значения для текущего языка (fr)', () => {
  setLang('fr');
  const t = getLocalizedTool(sampleTool);
  expect(t.title).toBe('FR Titre');
  expect(t.desc).toBe('FR Desc');
  expect(t.btn).toBe('FR Btn');
});

test('язык без перевода → fallback на en из словаря', () => {
  setLang('de'); // нет de в sampleTool.titles
  const t = getLocalizedTool(sampleTool);
  expect(t.title).toBe('EN Title');
  expect(t.desc).toBe('EN Desc');
  expect(t.btn).toBe('EN Btn');
});

test('нет словарей titles/descs/btns → fallback на tool.title/desc/btn', () => {
  setLang('fr');
  const plain = { title: 'Plain T', desc: 'Plain D', btn: 'Plain B' };
  const t = getLocalizedTool(plain);
  expect(t.title).toBe('Plain T');
  expect(t.desc).toBe('Plain D');
  expect(t.btn).toBe('Plain B');
});

test('сохраняет остальные поля инструмента (spread)', () => {
  setLang('en');
  const t = getLocalizedTool({ ...sampleTool, accept: '.pdf', implemented: true });
  expect(t.accept).toBe('.pdf');
  expect(t.implemented).toBe(true);
});

// ── TOOLS structure ────────────────────────────────────────
console.log('\nTOOLS structure:');

const toolKeys = Object.keys(TOOLS);

test('TOOLS содержит инструменты', () => {
  expect(toolKeys.length > 0).toBeTruthy();
});

test('каждый инструмент имеет обязательные поля (title, btn, accept, implemented)', () => {
  const missing = [];
  for (const [key, tool] of Object.entries(TOOLS)) {
    for (const field of ['title', 'btn', 'accept', 'implemented']) {
      if (tool[field] === undefined) missing.push(`${key}.${field}`);
    }
  }
  if (missing.length) throw new Error(`Missing fields: ${missing.join(', ')}`);
  expect(missing.length).toBe(0);
});

test('каждый accept присутствует в ACCEPTED_MIME', () => {
  const bad = [];
  for (const [key, tool] of Object.entries(TOOLS)) {
    if (!ACCEPTED_MIME[tool.accept]) bad.push(`${key}: ${tool.accept}`);
  }
  if (bad.length) throw new Error(`accept not in ACCEPTED_MIME: ${bad.join(', ')}`);
  expect(bad.length).toBe(0);
});

test('core-инструменты присутствуют (merge, split, compress)', () => {
  expect(TOOLS.merge).toBeTruthy();
  expect(TOOLS.split).toBeTruthy();
  expect(TOOLS.compress).toBeTruthy();
});

// ── ACCEPTED_MIME structure ────────────────────────────────
console.log('\nACCEPTED_MIME structure:');

test('значения — непустые массивы строк', () => {
  for (const [ext, mimes] of Object.entries(ACCEPTED_MIME)) {
    if (!Array.isArray(mimes) || mimes.length === 0) throw new Error(`${ext} не массив или пуст`);
    for (const m of mimes) {
      if (typeof m !== 'string' || !m.includes('/')) throw new Error(`${ext}: невалидный MIME "${m}"`);
    }
  }
  expect(true).toBeTruthy();
});

test('.pdf → application/pdf', () => {
  expect(ACCEPTED_MIME['.pdf,application/pdf']).toEqual(['application/pdf']);
});

// ── Summary ────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed + ' failed' : '0 failed'}`);
if (failed > 0) process.exit(1);
