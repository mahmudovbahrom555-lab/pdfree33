# Contributing to PDFree

## Architecture

PDFree is a fully client-side PDF tool suite. All processing happens in the browser via Web Workers — nothing is uploaded to any server.

### Module map

```
index.html          ← Single page, all tool UI containers
js/
  app.js            ← Main entry: routing, state, event bus
  config.js         ← Tool definitions (icon, title, accept, implemented)
  processor.js      ← Dispatches work to worker.js or main thread
  worker.js         ← Heavy PDF operations (pdf-lib, OffscreenCanvas)
  ui.js             ← Toast, progress bar, page transitions
  files.js          ← File drop/select, validation, drag-to-reorder
  ads.js            ← AdSense zone management
  analytics.js      ← Plausible event wrappers (privacy-safe)
  *UI.js            ← Per-tool option panels (splitUI, compressUI, …)
  extractUI.js      ← Wraps splitUI with forced mode='single'
sw.js               ← Service worker (cache-first + stale-while-revalidate)
manifest.json       ← PWA manifest
```

### Adding a new tool (checklist)

1. **`config.js`** — Add entry to `TOOLS` with `implemented: true`.
2. **`js/<name>UI.js`** — Create options panel module. Export `init*`, `hide*`, `get*Params`.
3. **`worker.js`** — Add `case '<name>'` to switch + `async function handle<Name>`.
4. **`processor.js`** — Add `else if (currentTool === '<name>')` branch.
5. **`app.js`** — Import UI module; add `hide*` to 3 places; add to `files-added` handler; add to button click handler.
6. **`index.html`** — Add `<div id="<name>Options">` container + tool card in grid.
7. **`sw.js`** — Add `/js/<name>UI.js` to `STATIC_ASSETS`.

### Known technical debt (prioritised for next sprint)

**P0 — Architecture (RESOLVED)**
- ✅ Tool registry implemented (`toolRegistry.js` + `toolRegistrations.js`). `app.js` uses `hideAllToolOptions()`, no per-tool hide calls. Issue #12 closed.
- ✅ Processor dispatch uses `runnerMap` object, no if-else chains. Issue #13 closed.

**P0 — Testing (RESOLVED)**
- ✅ 115 tests across 4 suites: utils, processor logic, splitUI logic, worker integration.
- ✅ Real PDF fixtures in `tests/fixtures/` (normal, corrupt, minimal).
- ✅ `handleMerge` and `handleCompress` covered with integration tests.
- Remaining: `handleSplit`, `handleWatermark`, `handlePageNum`, `handleMeta`, `handleJpg2Pdf` — test coverage tracked in #14.

**P2 — CDN dependency**
- `pdf-lib`, `JSZip`, `pdf.js` load from CDN. Service worker caches them after first use, but first visit requires internet. Long-term: bundle locally.

## License

PDFree is released under [GNU AGPLv3](LICENSE). All contributions must be compatible with this license.

Third-party runtime dependencies: pdf-lib (MIT), JSZip (MIT), pdf.js (Apache 2.0).
