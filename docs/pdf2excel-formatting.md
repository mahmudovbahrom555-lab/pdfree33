# PDF to Excel presentation metadata

This branch adds conservative formatting to existing table extraction. The data detector, number parser, confidence gates and Text fallback remain the same. The user complaint asks to preserve colours and spacing. Its original PDF was not supplied, so this work addresses the confirmed general loss of formatting rather than claiming that exact report is reproduced.

## Processing

`pdf2excelStyles.js` consumes the already-loaded PDF.js operator list. It does not render pages, upload files, or run OCR. Solid rectangles and ordinary stroked rules are recorded in upright page coordinates. Graphics-state saves, transforms, form placement, rectangular clipping, and text rendering modes are respected. Pattern fills, unsupported clipping and transparency do not supply guessed colours.

Text colour is accepted only if the normalized full glyph stream exactly matches the extracted text stream. Mixed colours within a text item get no single guessed colour. Font size, weight, italic and a generic available font family are retained only for matching cell contents. Text values and numerical formats are not rewritten to rich text.

Ruled tables retain row bands. They receive approximate physical column widths and row heights, solid cell fills and ordinary borders. The existing detector snaps coordinates to a four-point grid, so style matching admits its maximum two-point rounding error. Borderless tables receive a background only when a rectangle covers the entire row's text extent. A small logo or word highlight cannot become a whole-row fill.

Presentation arrays follow continuation rows when the repeated heading is removed. Merge ranges retain independently assigned styles. Preview styles come from the workbook after styling, so default headers and numeric alignment agree with the file. Document colours use a white background inside the dark interface.

## Work limits and fallbacks

The optional graphics pass stops at 250,000 operators/path steps or two million normalized text characters. Per-table matching is skipped when the cell count multiplied by the combined text-item/paint-record count exceeds two million. This is a workload bound, not a user file limit. Extracted values remain available when optional formatting cannot be recovered.

Unsupported cases include gradients, images, arbitrary typography and inter-letter spacing, exact embedded fonts, mixed formatting within one cell, dashed/diagonal borders, and full page reproduction. Geometry and row wrapping can differ between spreadsheet viewers. Scans still require OCR. Existing incorrect table grouping is not repaired by applying styles.

## Regression coverage

- `tests/pdf2excel.logic.test.js` is already in `npm test`. Tests cover row geometry, continuation styles, RGB typed arrays, colour-stream correspondence, transforms, clipping, transparent/hidden text, logo rejection, numeric preservation, row stripes, rotated forms and the work bound.
- `tests/e2e/pdf2excel-preview.e2e.mjs` is already run by CI. It creates an independent vector PDF and verifies actual XLSX colours, valid ARGB serialization, font size, numeric cell values, and matching browser preview. No workflow changes are required.
- Optional local settings `PDFREE_BROWSER_CHANNEL` and `PDFREE_EXCELJS_PATH` allow installed Chrome/Edge and a local copy of the same CDN library. The existing browser integrity check still applies.

A frozen public-document corpus and before/after workbooks are recorded outside the repository under `pdf2excel-review-evidence/formatting-2026-11-21/`. Fifteen documents are split by source family into four development documents and eleven held-out documents. Unchanged output data is a regression check, not proof that all original extraction was correct. The review report records measured results and platform limitations.

## Local validation, 2026-11-21

Rebased onto main `d0eef94f`. Build, lint (zero errors), full `npm test`, 80 Excel logic checks and four preview browser checks passed. The new browser regression fails on the original code for missing header colours. The curve-border guard also has a failing-before/passing-after test.

On the frozen 15-document corpus, values, cell types, number formats, sheets and merge ranges were unchanged. Ninety cross-profile downloads match final-core data. Tests use Edge on macOS and emulated iPhone/Android profiles in both themes. Actual Windows Excel and physical phones were unavailable.

Three alternating core runs per version/document gave a median document delta of +7.2 ms. The 219-page document went from 1098.5 ms to 1166.9 ms. Library loading and fixture transfer are outside the timer; parsing, extraction, XLSX creation and verification are inside. These are local corpus measurements, not a general speed guarantee.
