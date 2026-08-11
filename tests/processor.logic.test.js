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

// ── PDF to PowerPoint: mixed-page-size slide fitting ───────
// Mirrors js/processor.js's _p2pFitRect verbatim — small, pure function,
// same "reimplement inline for testing" approach this file already uses
// elsewhere rather than importing all of processor.js (heavily DOM/UI-
// coupled, not import-safe in Node). Regression coverage for the bug
// fixed here: pages that don't match the deck's page-1-derived layout
// aspect ratio used to be force-stretched into it (visibly distorting
// e.g. a landscape page in an otherwise-portrait deck); this fits and
// centers instead.
console.log('\nPDF to PowerPoint fit-rect (mixed page sizes):');

function p2pFitRect(srcW, srcH, availW, availH) {
  const scale   = Math.min(1, availW / srcW, availH / srcH);
  const scaledW = srcW * scale;
  const scaledH = srcH * scale;
  return { w: scaledW, h: scaledH, x: (availW - scaledW) / 2, y: (availH - scaledH) / 2 };
}

test('страница того же размера что и layout — заполняет слайд без изменений (регресс на прежнее поведение)', () => {
  const fit = p2pFitRect(8.5, 11, 8.5, 11);
  expect(fit).toEqual({ w: 8.5, h: 11, x: 0, y: 0 });
});

test('альбомная страница в портретной колоде — вписывается и центрируется, а не растягивается', () => {
  // deck layout derived from a portrait page-1 (8.5x11); this page is landscape (11x8.5)
  const fit = p2pFitRect(11, 8.5, 8.5, 11);
  // must preserve the page's own aspect ratio — never distort
  expect(Math.abs(fit.w / fit.h - 11 / 8.5) < 1e-9).toBeTruthy();
  // must never enlarge past the available box
  expect(fit.w <= 8.5).toBeTruthy();
  expect(fit.h <= 11).toBeTruthy();
  // must be centered, not pinned to a corner
  expect(Math.abs(fit.x - (8.5 - fit.w) / 2) < 1e-9).toBeTruthy();
  expect(Math.abs(fit.y - (11 - fit.h) / 2) < 1e-9).toBeTruthy();
});

test('меньшая страница не увеличивается сверх 100%', () => {
  const fit = p2pFitRect(4, 3, 8.5, 11);
  expect(fit.w).toBe(4);
  expect(fit.h).toBe(3);
});

// ── PDF to PowerPoint: invisible text-layer merging ─────────
// Mirrors js/processor.js's _p2pMergeLineItems/_p2pMergeParagraphs
// verbatim. Two real bugs were found and fixed in this logic by manual
// testing (inspecting actual generated PPTX XML, since the layer is
// invisible by design so nothing shows up visually): a too-tight line-
// spacing threshold that rejected every real paragraph, and a height
// double-counting bug on the 3rd+ merged line that positioned the shape
// above the actual text. Both are covered below so neither can silently
// come back.
console.log('\nPDF to PowerPoint text-layer merging:');

function p2pMergeLineItems(line) {
  line.sort((a, b) => a.x - b.x);
  const blocks = [];
  let cur = null;
  for (const item of line) {
    if (!cur) { cur = { ...item }; continue; }
    const gap    = item.x - (cur.x + cur.width);
    const maxGap = cur.fontSize * 0.6;
    if (gap < maxGap) {
      const needsSpace = gap > cur.fontSize * 0.1;
      cur.text  += (needsSpace ? ' ' : '') + item.text;
      cur.width  = (item.x + item.width) - cur.x;
      cur.height = Math.max(cur.height, item.height);
    } else {
      blocks.push(cur);
      cur = { ...item };
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

function p2pMergeParagraphs(lineBlockGroups) {
  const out = [];
  for (const group of lineBlockGroups) {
    if (group.length !== 1) { out.push(...group); continue; }
    const block = group[0];
    const prev  = out[out.length - 1];
    if (prev &&
        prev._singleLine &&
        Math.abs(prev.x - block.x) < 2 &&
        Math.abs(prev.fontSize - block.fontSize) / prev.fontSize < 0.15 &&
        (prev._bottomY - block.y) < prev.fontSize * 1.8 &&
        (prev._bottomY - block.y) > 0) {
      prev.text   += '\n' + block.text;
      prev.width   = Math.max(prev.width, block.width);
      prev.height   = prev._topY - block.y;
      prev._bottomY = block.y;
      continue;
    }
    block._singleLine = true;
    block._topY        = block.y + block.height;
    block._bottomY      = block.y;
    out.push(block);
  }
  return out;
}

function makeItem(text, x, y, width, height, fontSize) {
  return { text, x, y, width, height, fontSize };
}

test('склейка внутри строки: близкие фрагменты — одно слово/блок', () => {
  const line = [makeItem('Hel', 50, 700, 14, 12, 12), makeItem('lo', 64, 700, 10, 12, 12)];
  const blocks = p2pMergeLineItems(line);
  expect(blocks.length).toBe(1);
  expect(blocks[0].text).toBe('Hello');
});

test('склейка внутри строки: большой разрыв X — раздельные блоки (колонки)', () => {
  const line = [makeItem('Left', 50, 380, 30, 12, 12), makeItem('Right', 350, 380, 35, 12, 12)];
  const blocks = p2pMergeLineItems(line);
  expect(blocks.length).toBe(2);
});

test('склейка параграфа: 5 строк с обычным интервалом — один блок (регресс на порог 0.7x)', () => {
  const y = [650, 634, 618, 602, 586];
  const lineGroups = y.map((yy, i) => p2pMergeLineItems([makeItem(`line${i}`, 50, yy, 100, 12, 12)]));
  const merged = p2pMergeParagraphs(lineGroups);
  expect(merged.length).toBe(1);
  expect(merged[0].text).toBe('line0\nline1\nline2\nline3\nline4');
});

test('склейка параграфа: высота блока считается от ПЕРВОЙ строки, не накапливается с ошибкой (регресс на double-counting)', () => {
  const y = [650, 634, 618, 602, 586]; // fontSize 12, item.height 12 → top of line0 = 650+12 = 662
  const lineGroups = y.map((yy, i) => p2pMergeLineItems([makeItem(`line${i}`, 50, yy, 100, 12, 12)]));
  const merged = p2pMergeParagraphs(lineGroups);
  // correct height = topOfFirstLine(662) - bottomOfLastLine(586) = 76
  expect(merged[0].height).toBe(76);
  // block.y must stay pinned to the first line — a positive height alone
  // doesn't catch a shape computed to start above the actual text (the
  // real symptom of the bug this covers: a negative PPTX y-offset)
  expect(merged[0].y).toBe(650);
});

test('склейка параграфа: разный размер шрифта — НЕ склеивается (заголовок отдельно от текста)', () => {
  const heading = p2pMergeLineItems([makeItem('Heading', 50, 500, 60, 18, 18)]);
  const body    = p2pMergeLineItems([makeItem('Body text', 50, 470, 60, 12, 12)]);
  const merged = p2pMergeParagraphs([heading, body]);
  expect(merged.length).toBe(2);
});

test('склейка параграфа: большой вертикальный разрыв — НЕ склеивается (разрыв абзаца)', () => {
  const line1 = p2pMergeLineItems([makeItem('Paragraph one', 50, 650, 80, 12, 12)]);
  const line2 = p2pMergeLineItems([makeItem('Paragraph two, far below', 50, 400, 80, 12, 12)]);
  const merged = p2pMergeParagraphs([line1, line2]);
  expect(merged.length).toBe(2);
});

// ── Summary ────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
