# ТЗ: Расширение batch-обработки (BATCH_TOOLS)

## Контекст

В `js/processor.js` уже реализована и работает в проде batch-обработка для
`compress` / `watermark` / `rotate` — последовательная очередь через общий
`_worker`, ZIP-упаковка результатов, изоляция ошибок по файлу, watchdog-таймаут,
корректная отмена. Реализация зрелая, с явно задокументированными причинами
архитектурных решений (см. комментарий над `const BATCH_TOOLS` в processor.js).

Это ТЗ — **не** про создание batch с нуля. Это про расширение зоны действия
уже существующего механизма на дополнительные инструменты + закрытие одного
реального пробела (upfront-предупреждение о памяти), которого сейчас нет.

Ничего в `js/worker.js` не трогаем — файл off-limits (см. CLAUDE.md). Все
изменения ниже — в `processor.js`, `files.js`, `i18n.js` и локалях.

---

## Часть 1 — Расширение `BATCH_TOOLS`

### 1.1. Что добавляем сразу: `protect`, `pagenum`, `flatten`

Все три — `runner: 'worker'` в `toolRegistrations.js`, та же форма, что уже
обкатана на `watermark`/`rotate`. Механически это `_batchWorkerToolOne()` без
изменений — она уже принимает произвольный `tool` через `getWorkerTool(tool)`.

**Почему именно эти три:**

- **`protect`** — самый ценный кейс из всего обсуждения. Юрист/бухгалтер
  выбирает 50 файлов, вводит один пароль, получает zip с защищёнными копиями.
  Семантика «применить настройки file[0] ко всем» здесь не просто безопасна —
  она и есть весь смысл фичи (один пароль на пачку).
- **`pagenum`** — настройки (позиция, формат, стартовый номер) не зависят от
  содержимого файла. Безопасно применить к N файлам без сюрпризов.
- **`flatten`** — у инструмента фактически нет настроек (блокирует то, что
  есть в файле). Риска несовпадения семантики между файлами нет вообще.

**Что НЕ добавляем и почему:**

- **`fill`** — панель настроек строится из полей формы **file[0]**
  (`init` получает конкретный файл, читает его AcroForm-поля). Применить
  значения, введённые для одной формы, к другим файлам корректно только если
  все файлы — экземпляры одного шаблона. Это не общий случай, а частный —
  добавлять в общий `BATCH_TOOLS` сейчас значит либо тихо портить результат на
  несовпадающих формах, либо городить отдельную ветку валидации схемы полей.
  Оставляем вне scope; если понадобится — это отдельная фича
  «batch-fill по шаблону», не расширение текущего флага.
- **`meta`** — технически безопасно (как pagenum), но семантически спорно:
  вписать одинаковый Title/Author в 50 разных документов — специфичный,
  не самый частый кейс. Не вредно, но и не приоритет. Можно добавить одной
  строкой в `BATCH_TOOLS` в любой момент без остального scope этого ТЗ, если
  появится спрос — риска нет, просто не первая очередь.
- **`merge`, `split`, `unlock`** — другая архитектура. `merge`/`split` уже
  N→1 или имеют собственный zip-flow вне `_runBatch`. `unlock` — `runner:
  'unlock'`, не `'worker'`, свой раннер с другим контрактом. Расширение на них
  — отдельное ТЗ с новым кодом, не однострочное добавление в Set.

### 1.2. Код

```js
// было:
const BATCH_TOOLS = new Set(['compress', 'watermark', 'rotate']);
const _BATCH_SIZE_LIMITS = { compress: MAX_COMPRESS_MB, watermark: 200, rotate: 150 };
const _BATCH_SUFFIX      = { watermark: '-watermarked', rotate: '-rotated' };

// стало:
const BATCH_TOOLS = new Set(['compress', 'watermark', 'rotate', 'protect', 'pagenum', 'flatten']);
const _BATCH_SIZE_LIMITS = {
  compress: MAX_COMPRESS_MB, watermark: 200, rotate: 150,
  protect: 200, pagenum: 200, flatten: 150,
};
const _BATCH_SUFFIX = {
  watermark: '-watermarked', rotate: '-rotated',
  protect: '-protected', pagenum: '-numbered', flatten: '-flattened',
};
```

Лимиты (`200`/`150` МБ) — по аналогии с уже существующими watermark/rotate,
не с потолка: protect/pagenum структурно лёгкие операции (как watermark),
flatten — как rotate (нет перекодирования изображений, только правки
структуры PDF).

Больше в `processor.js` для этого шага менять не нужно — `_runBatch()`,
`_batchWorkerToolOne()`, `_postToWorkerForBatch()` уже общие для любого
`runner: 'worker'`-инструмента, диспетчеризация в `doProcess()` через
`BATCH_TOOLS.has(currentTool)` тоже не завязана на конкретный список.

### 1.3. Что проверить перед мержем (не код, а ручное тестирование)

- `protect`: batch из 10 файлов, один пароль → все 10 открываются этим паролем
- `pagenum`: batch из файлов с разным числом страниц → номерация в каждом файле своя, не «общая на всех»
- `flatten`: batch из файлов с формами и без форм → файлы без форм не падают в `error`, просто проходят насквозь
- Отмена на 5-м файле из 10 для каждого нового инструмента — бейджи корректно чистятся (уже общий код `cancelProcess()`, но у каждого runner своя `getWorkerTool()`-строка — стоит проверить, что она матчится)

---

## Часть 2 — Upfront-предупреждение о памяти

### 2.1. Реальный пробел

Сейчас `_runBatch()` проверяет размер **каждого файла по отдельности**
(`_checkSize(file, _BATCH_SIZE_LIMITS[tool])`), но не смотрит на **сумму**
очереди до старта. Пользователь может выбрать 300 файлов по 15 МБ каждый —
каждый пройдёт проверку индивидуально, но суммарно это 4.5 ГБ данных через
последовательную обработку в одной вкладке. Для `compress` конкретно это ещё
хуже, чем для watermark/rotate/protect/pagenum/flatten — decode/recompress
изображений внутри worker.js раздувает промежуточное потребление памяти
сильнее, чем структурные операции (декодированный JPEG в памяти может быть
в 5–10 раз больше исходного закодированного файла — множитель не общий
на все инструменты, а специфичный для операций с перекодированием картинок).

### 2.2. Решение — предупреждение, не блокировка

Прозрачность, не запрет — пользователь сам решает, продолжать или разбить
очередь. Порог по сумме размеров, с отдельным (более строгим) порогом для
`compress` из-за декодирования изображений.

```js
// processor.js — рядом с _BATCH_SIZE_LIMITS

// Compress decodes embedded images to raw pixel buffers before
// recompressing — a 2MB JPEG at 3000×2000px can balloon to ~18MB decoded.
// Structural tools (watermark/rotate/protect/pagenum/flatten) don't touch
// image data, so their in-memory footprint stays close to file size.
const _BATCH_WARN_THRESHOLD_MB = { compress: 150, default: 400 };

function _batchQueueWarning(tool, filesSnapshot) {
  const totalMb = filesSnapshot.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);
  const threshold = _BATCH_WARN_THRESHOLD_MB[tool] ?? _BATCH_WARN_THRESHOLD_MB.default;
  return totalMb > threshold ? { totalMb: Math.round(totalMb), threshold } : null;
}
```

В `doProcess()`, перед вызовом `_runBatch`:

```js
if (BATCH_TOOLS.has(currentTool) && filesSnapshot.length > 1) {
  const warning = _batchQueueWarning(currentTool, filesSnapshot);
  if (warning && !await _confirmBatchWarning(warning)) {
    isProcessing = false;
    setFilesLocked(false);
    hideCancelBtn();
    return; // user cancelled at the warning — not an error, not tracked as one
  }
  try {
    await _runBatch(currentTool, filesSnapshot, extraParams);
  } catch (err) { /* unchanged */ }
  return;
}
```

`_confirmBatchWarning()` — не `window.confirm()` (не соответствует стилю
остального UI в проекте, всё на кастомных модалках/тостах) — нужен маленький
неблокирующий диалог в духе уже существующих `showToast`/модалок в `ui.js`,
с двумя кнопками («Продолжить» / «Отмена»), текст через `t('warn_batch_memory', {mb, threshold})`.

### 2.3. Новые i18n-ключи (EN, добавить в `js/i18n.js`, затем во все 13 локалей)

```js
warn_batch_memory: 'This batch totals {mb} MB — processing may be slow or your browser tab could run out of memory. Consider splitting into smaller batches (under {threshold} MB). Continue anyway?',
batch_memory_continue: 'Process anyway',
batch_memory_split: 'Cancel — I\'ll split it up',
```

Перевод на 13 языков — по уже отработанному в этой сессии паттерну (см.
`rot_*` ключи как пример: перевод, не калька, с учётом принятого на сайте
регистра обращения по языку).

---

## Часть 3 — Параллелизм: сознательно НЕ трогаем

В обсуждении звучала идея «2–4 воркера параллельно». Явно фиксирую: **не
делаю этого в рамках этого ТЗ**, и вот почему — не из лени, а потому что
текущий код прямым текстом объясняет trade-off:

> «reuse the SAME shared `_worker` instance... never concurrent (the shared
> worker's onmessage/onerror are reassigned per call, so parallel calls would
> clobber each other's callbacks)»

Чтобы сделать реальный параллелизм, нужен **пул из N отдельных `new
Worker(...)`** (не трогая содержимое `worker.js` — просто больше экземпляров
того же файла), плюс id-корреляция сообщений вместо текущей модели
«один `onmessage` на весь воркер». Это отдельная, более рискованная работа:
рост пикового потребления памяти (N воркеров = N буферов в памяти
одновременно, а не один), больше поверхности для гонок при отмене. Учитывая,
что batch и так работает и решает реальную проблему пользователя
последовательно — я бы не трогал это, пока нет явного сигнала «слишком
медленно» от реальных пользователей после релиза Части 1–2. Ускорение в
2–4 раза на batch-компрессии не стоит риска сломать то, что уже стабильно
работает, без подтверждённого спроса.

---

## Порядок внедрения

1. Часть 1 (расширение `BATCH_TOOLS` на `protect`/`pagenum`/`flatten`) —
   независима, минимальный риск, можно катить сразу.
2. Часть 2 (upfront-предупреждение) — независима от Части 1, но логичнее
   после неё, т.к. новый набор инструментов расширяет частоту, с которой
   пользователи будут собирать большие очереди.
3. Часть 3 — не делать, пока нет данных о реальной потребности.

## Что явно вне scope этого документа

- `fill` в batch-режиме (нужна отдельная схема «batch по шаблону»)
- `merge`/`split`/`unlock` в batch (другой runner, другой контракт)
- Параллелизм (см. Часть 3)
- Desktop/offline-версия, монетизация — отдельные продуктовые решения,
  не связанные с этим техническим расширением
