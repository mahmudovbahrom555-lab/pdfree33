# @pdfree/pdf2md-core

Convert PDF to Markdown for AI/RAG — the same extraction engine behind
[pdfree.io's PDF-to-Markdown tool](https://pdfree.io/pdf-to-markdown/), runnable
locally as a library or CLI. Your files never leave your machine — not because
of a policy, but because there's no server in the loop at all.

Real output-quality numbers (91.6/100 avg, within 1.1 points of Docling, ahead
of pymupdf4llm), methodology, and honest disclosure of where this engine loses
to Docling/Marker: see [the benchmark write-up](https://pdfree.io/blog/pdf-to-markdown-benchmark/).

## Why this exists

Searching for "PDF to Markdown for RAG" mostly surfaces developer tools you
install and run yourself — Marker, Docling, HURIDOCS. pdfree.io's own tool is
excellent for the same job but only reachable from a browser tab, one file at
a time. This package is the same extraction logic (literally — see
[Relationship to pdfree.io](#relationship-to-pdfreeio) below), packaged so it
can be scripted, piped, and dropped into a pipeline.

## Install

```
npm install @pdfree/pdf2md-core --omit=optional
```

`--omit=optional` is recommended, not just tolerated: `pdfjs-dist` lists
`canvas` as an optional dependency for rendering features this package
doesn't use in v1 (see [Limitations](#limitations-v1--read-this-before-relying-on-it)
below) — installing it pulls in `tar`/`@mapbox/node-pre-gyp` as its own
install-time tooling, which `npm audit` currently flags (unrelated to
`canvas` itself; those packages are never imported or executed by anything
this package does). Plain `npm install` still works — canvas's build just
fails harmlessly and pdf.js logs a couple of startup warnings about it —
`--omit=optional` just skips attempting it.

Requires Node 18+.

## Usage — library

```js
import { pdfToMarkdown } from '@pdfree/pdf2md-core';

const markdown = await pdfToMarkdown('report.pdf');
// or: await pdfToMarkdown(buffer) / await pdfToMarkdown(uint8Array)
```

## Usage — CLI

```
npx @pdfree/pdf2md-core report.pdf > report.md
npx @pdfree/pdf2md-core report.pdf --out report.md
```

## What you get

- Real `#`/`##` headings, detected from font size/position/boldness — not
  just "bigger text."
- GitHub-flavored Markdown tables, not flattened rows of numbers.
- Inline math wrapped as `$...$` ("honest flattening" — see Limitations).
- Reading order that survives multi-column layouts (two-column academic
  papers, mixed layouts).

## Limitations (v1) — read this before relying on it

This package intentionally ships **without** a Canvas dependency (no
`node-canvas`/native build step — those are a common source of broken
`npm install`s across platforms). Two features that need real pixel
rendering are disabled as a result, and degrade gracefully rather than
error:

- **Embedded images are skipped.** Real photos/charts/diagrams in the PDF
  do not appear in the output. (Text, headings, lists, and tables are
  completely unaffected — none of that needs a canvas.)
- **Display-formula image-crop is skipped.** Standalone equations
  (matrices, stacked fractions) that the browser tool renders as a cropped
  image instead fall back to the same left-to-right `$...$` text
  flattening already used for inline math — readable, not always a
  faithful transcription of 2D layout (superscripts/subscripts can be
  lost). This is the exact same fallback tier the browser tool itself uses
  for inline math; nothing here is worse than what pdfree.io already
  discloses.

If you need full parity with the browser tool (embedded images, formula
crops), use [pdfree.io/pdf-to-markdown/](https://pdfree.io/pdf-to-markdown/)
directly, or open an issue — a `canvas`-based opt-in is a plausible future
addition, deliberately deferred out of v1.

You may see harmless startup warnings like `Cannot polyfill DOMMatrix` /
`Cannot polyfill Path2D` in stderr — that's pdf.js's own Node build
reporting the same "no canvas installed" fact above. It does not affect the
Markdown output.

## Security note

`pdfjs-dist` is pinned to `3.11.174` — deliberately, not out of neglect. The
PDF-to-Markdown core (`src/core/pdf2mdCore.js`) hardcodes a few pdf.js
operator-list opcode numbers for image-position detection, tied to that
exact version; jumping to a newer major version needs its own real
verification pass against the new opcodes before it's safe, not just a
version bump. That version is within the range affected by
[CVE-2024-4367](https://github.com/advisories/GHSA-wgrm-67xf-hhpq) (a
malicious PDF could trigger arbitrary JS execution via pdf.js's own `eval`
use) — this package sets `isEvalSupported: false`, Mozilla's own published
workaround, on every `getDocument()` call, which fully mitigates it. A
regression test in `test/` checks this flag stays set. `disableJavaScript:
true` is also set (blocks the PDF's own embedded `/JavaScript` actions,
a separate, unrelated safeguard).

## Relationship to pdfree.io

This package's `src/core/` is synced verbatim from the parent
[pdfree33](https://github.com/mahmudovbahrom555-lab/pdfree33) repository's
`js/pdf2mdCore.js` (and its shared dependencies) — the exact same code that
runs in your browser when you use pdfree.io's PDF-to-Markdown tool, not a
reimplementation. When pdfree.io's tool improves, running `npm run sync` in
this package and re-publishing picks up the same improvement here.

## License

AGPL-3.0-only, same as the parent project.
