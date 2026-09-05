# @pdfree/pdf2read-core

Reflow a fixed-layout PDF into structured reading blocks — headings,
paragraphs, lists, tables — the same engine behind
[pdfree.io's Read PDF tool](https://pdfree.io/?tool=read), runnable locally
as a library or CLI. Your files never leave your machine — not because of a
policy, but because there's no server in the loop at all.

## Why this exists

Adobe's own reflow feature ("Liquid Mode") only ships in the iOS/Android app
and on Chromebooks — there's no way to reflow a PDF from a plain desktop
browser or a script, which is exactly where "batch this over 200 reports" or
"pipe this into something else" lives. This package is the same
structure-detection logic pdfree.io's own browser tool uses (literally — see
[Relationship to pdfree.io](#relationship-to-pdfreeio) below), packaged so it
can be scripted, piped, and dropped into a pipeline instead of clicked
through one file at a time.

## Install

```
npm install @pdfree/pdf2read-core --omit=optional
```

`--omit=optional` is recommended, not just tolerated: `pdfjs-dist` lists
`@napi-rs/canvas` as an optional dependency for rendering features this
package doesn't use in v1 (see [Limitations](#limitations-v1--read-this-before-relying-on-it)
below). Plain `npm install` still works — if a prebuilt binary for your
platform isn't available, the install just fails harmlessly and pdf.js logs
a couple of startup warnings about it — `--omit=optional` just skips
attempting it entirely.

Requires Node 20+ (pdfjs-dist 5.x's own floor).

## Usage — library

```js
import { pdfToReadingBlocks } from '@pdfree/pdf2read-core';

const { pages, pageCount } = await pdfToReadingBlocks('report.pdf');
// or: await pdfToReadingBlocks(buffer) / await pdfToReadingBlocks(uint8Array)

for (const page of pages) {
  if (page.scanned) continue; // no extractable text on this page
  for (const block of page.blocks) {
    // block.type: 'heading' | 'paragraph' | 'list-item' | 'table' | 'image'
  }
}
```

## Usage — CLI

```
npx @pdfree/pdf2read-core report.pdf > report.txt
npx @pdfree/pdf2read-core report.pdf --json > report.json
npx @pdfree/pdf2read-core report.pdf --out report.txt
```

Default output is a simple plain-text reflow (one paragraph per line,
headings uppercased, list markers kept/synthesized) — not a faithful
re-render of every formatting detail. Pass `--json` for the raw
`{ pages, pageCount }` structure if you need the real block types.

## What you get

- Real headings, detected from font size/position/boldness — not just
  "bigger text."
- Paragraphs joined across a source PDF's own wrapped lines into one
  continuous string — a PDF's line breaks are just where the original
  fixed-width column happened to wrap, not real paragraph breaks.
- Numbered list items keep their own marker ("1.", "2.5.1.") — real sequence
  information, not discarded. Bullet/lettered items are normalized to a
  single marker-agnostic shape.
- Real structured tables (including merged/spanned cells from bordered
  tables), not flattened rows of text.
- Reading order that survives multi-column layouts (two-column academic
  papers, mixed layouts) — each column's own blocks come out in full,
  left-to-right (or right-to-left for RTL pages), never interleaved.

## Limitations (v1) — read this before relying on it

This package intentionally ships **without** a Canvas dependency (no
`node-canvas`/native build step — those are a common source of broken `npm
install`s across platforms). One consequence:

- **`image`-type blocks carry no picture.** A formula-heavy line that can't
  be rendered as real text (LaTeX/math-font glyphs), or a table/grid that
  straddles a column boundary and can't be split cleanly, becomes an
  `{ type: 'image', region: {x0,x1,y0,y1} }` block — a bounding box in PDF
  points, not pixel data. Real cropping needs a rendered `<canvas>`, which
  plain Node doesn't have. (Text, headings, lists, and tables are completely
  unaffected — none of that needs a canvas.)
- **No equation OCR.** The formula-heavy-line guard above prevents garbled
  text from a math-heavy line; it does not recognize or transcribe the
  formula itself. This is a stricter limitation than
  [@pdfree/pdf2md-core](https://www.npmjs.com/package/@pdfree/pdf2md-core),
  which at least flattens inline math to `$...$` text — pdf2read-core's
  reflow use case has no equivalent fallback text representation for a
  genuinely 2D equation layout, so it's left as an unfilled image
  placeholder instead of a misleading text guess.
- **Diagrams/photos in the source PDF produce no picture either** (same
  bounding-box-only `image` block type as above) — their surrounding
  captions/text still come through normally.

You may see harmless startup warnings like `Cannot polyfill DOMMatrix` /
`Cannot polyfill Path2D` — that's pdf.js's own Node build reporting the same
"no canvas installed" fact above. It does not affect the reading-block
output. Verified directly that these are printed to **stdout**, not stderr
(pdf.js's own `console.warn` call, not something this package controls) —
if you're piping the CLI's `--json` output into another program, a plain
`2>/dev/null` will NOT filter them out; redirect/filter stdout itself
(e.g. `... | grep -v '^Warning:'`) if that matters for your pipeline.

## Security note

`pdfjs-dist` is pinned to `5.0.375` — the same version
[@pdfree/pdf2md-core](https://www.npmjs.com/package/@pdfree/pdf2md-core)
already verified working on Node 20 (see that package's own `src/index.js`
for the full version-bisection history: two newer candidates were tried and
rejected, one requiring a Node version this floor doesn't support, one
crashing at module load with no canvas installed). `isEvalSupported: false`
is set on every `getDocument()` call — Mozilla's own defense-in-depth flag
related to [CVE-2024-4367](https://github.com/advisories/GHSA-wgrm-67xf-hhpq)
(a malicious PDF could trigger arbitrary JS execution via pdf.js's own
`eval` use). `disableJavaScript: true` is also set (blocks the PDF's own
embedded `/JavaScript` actions, a separate, unrelated safeguard).

## Relationship to pdfree.io

This package's `src/core/` is synced verbatim from the parent
[pdfree33](https://github.com/mahmudovbahrom555-lab/pdfree33) repository's
`js/pdf2readCore.js` (and its shared dependencies) — the exact same code
that runs in your browser when you use pdfree.io's Read PDF tool, not a
reimplementation. When pdfree.io's tool improves, running `npm run sync` in
this package and re-publishing picks up the same improvement here.

## License

AGPL-3.0-only, same as the parent project.
