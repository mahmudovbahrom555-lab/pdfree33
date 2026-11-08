# Review handoff: personalized PDF copies

## Product flow

In Quick Edit PDF, open **Create personalized copies**, paste one full name per line, or import XLSX/CSV/TSV. A pasted tabular selection from Excel or WPS opens the same column picker. Choose the sheet, first row with a name, and full-name column. The list supports 100 recipients, with a 100 MiB limit on accumulated PDFs per ZIP.

**Preserve original layout** opens the original page with selectable text. Mark each occurrence individually. The same name goes into all marked locations for a recipient. Choose a sample recipient and download a single PDF before generating the ZIP. The existing Quick Edit rebuild route remains available, with a warning that it can change layout.

## Implementation

- `js/quickEditRecipients.js`: local import and column selection. XLSX parsing uses a pinned, locally served official browser bundle. Only the selected column becomes the recipient list. CSV accepts quoted values, UTF-8 BOM, and comma, semicolon or tab separators.
- `js/quickEditOriginal.js`: PDF.js supplies the selection and coordinates. The lazily loaded MuPDF.js WASM engine matches each selected line against source glyphs, rejects candidate rectangles that overlap other glyphs, then removes the original text while retaining graphics and images. The stripped template is prepared once per export. pdf-lib adds the replacement line with a local substitute font. Font family category, bold/italic and color are taken from source glyphs where supported. Simplified Chinese falls back to the existing Noto Sans SC font. Each output is reopened with PDF.js and checked for page count, selected lines and unexpected changes to other extracted lines on edited pages.
- `js/quickEditCopies.js`: selection lifecycle, sample recipient, sequential exports, ZIP, and per-recipient errors. The user must opt in to shrinking a line, with a 15% maximum reduction. ZIP is assembled only if all copies pass.
- `js/vendor/SOURCE.txt`: provenance for the exact upstream packages. Review MuPDF's AGPL distribution requirements before production, including availability of the corresponding source and build instructions for the shipped WASM version. The new 10.4 MB WASM is fetched only for original-layout export.

## Verification

Run `npm ci` before building. The build copies the pinned engine and XLSX reader from npm into same-origin static assets. Run `npm test`, `npm run lint` and `npm run test:e2e:quickedit` against a served build. The browser suite covers the existing single PDF path, CSV import, sample selection, ZIP, and replacing text on two pages of a non-mPDF document while retaining the neighboring column. The original-layout test uses a Chinese name and checks that the replaced standalone glyph is absent.

Private fixtures used locally, excluded from Git:

- Five-page contract. Selected the opening producer placeholder and the standalone placeholder beneath the producer tax ID. Checked two copies generated from fictional names, including Chinese. Both copies retained five pages and both columns. Pixel comparisons confirmed differences only in the marked areas. Extracted text retained the buyer placeholder. The original streams from edited pages were absent in the output.
- XLSX student list. Selected the full-name column starting at row five and imported 28 rows. No student names were used in the export tests.

## Review priorities

1. **Geometry and removal.** Review matching tolerances, rectangles near adjacent glyphs, ligatures, clipping, reordered text, bidi and invisible text. The browser verification checks extracted rows, while the two fixture runs additionally compared rendering. Try negative cases with an overlapping glyph and a too-long name.
2. **Lifecycle and performance.** Check cancellation between recipients, initialization failures, high-page-count inputs and peak memory with large XLSX files or ZIPs. WASM work currently runs on the main thread. The XLSX input cap applies to compressed file size.
3. **Scope and UX.** Current selection is within a single horizontal line. Original-layout mode rejects forms, signatures, cropped or rotated pages, mixed font runs, ambiguous matches and missing characters. It is reached through the existing Quick Edit structural gate. OCR/scan editing, exact font reproduction, cross-line reflow, multiple data columns mapped to different fields, Word import and optional watermark are outside this review. The new copy UI text is English. Browser integration was verified in Chrome.
4. **Deployment.** Verify WASM asset MIME, cache behavior and license/source provenance. Review the branch as a draft before merging.
