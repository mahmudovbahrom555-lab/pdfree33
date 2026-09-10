// ============================================================
//  tests/files.logic.test.js — Unit тесты логики files.js
//  Тестируем чистую логику: фильтрацию дублей, порядок файлов
//  без DOM-зависимостей (изолированные функции)
// ============================================================

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

function expect(actual) {
  return {
    toBe:     (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toEqual:  (e) => { if (JSON.stringify(actual) !== JSON.stringify(e)) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy: () => { if (!actual) throw new Error(`Expected truthy`); },
  };
}

// ── Изолированная логика (копируем алгоритмы из files.js) ──

function makeFile(name, size = 100) {
  return { name, size };
}

/** Алгоритм добавления файлов без дублей (из files.js) */
function addFilesLogic(existing, incoming) {
  const result  = [...existing];
  let dupes     = 0;
  let invalid   = 0;

  incoming.forEach(f => {
    const isDupe = result.some(x => x.name === f.name && x.size === f.size);
    if (!isDupe) result.push(f);
    else dupes++;
  });

  return { files: result, dupes, invalid };
}

/** Алгоритм drag-to-reorder (из files.js) */
function reorderFiles(files, from, to) {
  const result = [...files];
  const [moved] = result.splice(from, 1);
  result.splice(to, 0, moved);
  return result;
}

// ── Тесты добавления файлов ────────────────────────────────
console.log('\nДобавление файлов:');

test('добавляет новые файлы', () => {
  const { files } = addFilesLogic([], [makeFile('a.pdf'), makeFile('b.pdf')]);
  expect(files.length).toBe(2);
});

test('не добавляет дубли (одинаковое имя + размер)', () => {
  const existing = [makeFile('a.pdf', 100)];
  const { files, dupes } = addFilesLogic(existing, [makeFile('a.pdf', 100)]);
  expect(files.length).toBe(1);
  expect(dupes).toBe(1);
});

test('добавляет файл с тем же именем но другим размером', () => {
  const existing = [makeFile('a.pdf', 100)];
  const { files } = addFilesLogic(existing, [makeFile('a.pdf', 200)]);
  expect(files.length).toBe(2);
});

test('пакетное добавление без дублей', () => {
  const existing = [makeFile('a.pdf')];
  const { files, dupes } = addFilesLogic(existing, [
    makeFile('a.pdf'), // дубль
    makeFile('b.pdf'), // новый
    makeFile('c.pdf'), // новый
  ]);
  expect(files.length).toBe(3);
  expect(dupes).toBe(1);
});

test('добавление к пустому списку', () => {
  const { files } = addFilesLogic([], [makeFile('x.pdf')]);
  expect(files.length).toBe(1);
});

// ── Тесты drag-to-reorder ──────────────────────────────────
console.log('\nDrag-to-reorder:');

const FILES = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf'].map(makeFile);

test('перемещает первый на последнее место', () => {
  const result = reorderFiles(FILES, 0, 3);
  expect(result[0].name).toBe('b.pdf');
  expect(result[3].name).toBe('a.pdf');
});

test('перемещает последний на первое место', () => {
  const result = reorderFiles(FILES, 3, 0);
  expect(result[0].name).toBe('d.pdf');
  expect(result[3].name).toBe('c.pdf');
});

test('перемещение на то же место не меняет порядок', () => {
  const result = reorderFiles(FILES, 1, 1);
  expect(result.map(f => f.name).join()).toBe(FILES.map(f => f.name).join());
});

test('не мутирует оригинальный массив', () => {
  const original = [...FILES];
  reorderFiles(FILES, 0, 2);
  expect(FILES[0].name).toBe(original[0].name);
});

test('перемещает средний элемент', () => {
  const result = reorderFiles(FILES, 1, 3);
  expect(result[3].name).toBe('b.pdf');
  expect(result[1].name).toBe('c.pdf');
});

// ── 'files-added' event's wasEmpty detail (regression) ──────
// Real mobile bug: #mergeBtn's position:sticky pins it to a fixed viewport
// position, and on a short mobile viewport the newly-added #fileList used
// to render right under it — invisible and untappable — on the first file
// add. Fixed in js/app.js by scrolling #fileList into view, gated on
// files.js's addFiles() reporting whether selectedFiles was genuinely
// empty BEFORE this add (not `selectedFiles.length === 1` after, which
// misses a first pick that selects several files at once — jumping
// straight from 0 to N never passes through exactly 1).
console.log("\n'files-added' event wasEmpty detail:");

/** Mirrors files.js's addFiles(): capture emptiness BEFORE the push loop. */
function addFilesWithWasEmpty(existing, incoming) {
  const wasEmpty = existing.length === 0;
  const result = [...existing, ...incoming];
  return { files: result, wasEmpty };
}

test('single first file: wasEmpty is true', () => {
  const { wasEmpty } = addFilesWithWasEmpty([], [makeFile('a.pdf')]);
  expect(wasEmpty).toBe(true);
});

test('multi-select first pick (3 files at once): wasEmpty is still true', () => {
  // The exact case a naive `selectedFiles.length === 1` check misses —
  // length jumps straight from 0 to 3, never passing through 1.
  const { files, wasEmpty } = addFilesWithWasEmpty([], [makeFile('a.pdf'), makeFile('b.pdf'), makeFile('c.pdf')]);
  expect(files.length).toBe(3);
  expect(wasEmpty).toBe(true);
});

test('adding a file when one already exists: wasEmpty is false (no re-scroll)', () => {
  const { wasEmpty } = addFilesWithWasEmpty([makeFile('a.pdf')], [makeFile('b.pdf')]);
  expect(wasEmpty).toBe(false);
});

// ── Summary ────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
