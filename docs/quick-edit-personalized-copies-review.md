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

## Chinese visual regression and WPS/OFD

A real WPS/OFD sample (page 50 of the [public Chinese procurement template](https://zcc.bbc.edu.cn/_upload/article/files/ac/32/a49638f14a189f42e2e9727e5c3e/fee04f39-dabd-46dd-93a5-a754338be0ff.pdf)) uses an inverted CropBox and a slanted placeholder alongside upright text. The editor normalizes equivalent CropBox endpoints, splits slanted runs from neighboring upright text, and carries the shear through to the output. Where the bounding union of the selected glyphs touches a neighboring glyph, it attempts small safe rectangles inside the selected glyphs and verifies extracted text again after export.

The first Chinese quote demo exposed invisible glyphs despite correct Unicode extraction. For Noto Sans SC fallback, PDFree now embeds the full font temporarily, then uses MuPDF to subset it before saving. A browser regression test renders the output and checks for visible ink in each character's slot. Both the WPS excerpt and the synthetic Chinese quote were exported for three fictional companies. Independent pixel comparison found changes only in the marked regions, and Poppler and MuPDF rendered the names. The public source and demo output are outside Git.

## Batch safety and independent original entry

- The upload panel offers **Open original for personalized copies** while Quick Edit builds its regular preview and after the structural gate refuses the rebuild. That path only exposes original-layout export, so the safety gate still applies to ordinary Save PDF. Pages without selectable text display a specific message.
- Original-layout export measures the selected lines for every recipient before writing the first PDF. Overflow and missing characters identify recipient number and page. A batch remains all-or-nothing. **Stop export** cooperatively stops after the current operation, leaves the input intact and permits retry.
- The import review counts skipped blank/non-text cells and repeated names. A duplicate is a distinct recipient row and gets a numbered filename. A local XLSX test confirmed cached text from a formula, skipped an uncached formula and merged blank cells, and retained a hidden row. Hidden rows are explicitly called out because the parser imports their values.
- Chrome exported 30 PDFs from the full 167-page public WPS/OFD source via the independent original entry. The ZIP was 43.5 MB and took 52 seconds on the test Mac. All 30 PDFs retained 167 pages, the targeted page had the intended name, duplicate filenames remained distinct, and sampled unmodified pages matched pixel for pixel. The test used three fictional companies repeated across 30 rows.
- The full Quick Edit browser suite passed 7/7 in Chrome, Firefox and Playwright WebKit. WebKit here is a desktop engine test, not a test on iPhone hardware.
- The [official MuPDF 1.28.1 WASM source tree](https://github.com/ArtifexSoftware/mupdf/tree/1.28.1/platform/wasm) matches the release version pinned in npm. Distribution compliance and a production source-disclosure mechanism are review items before deployment.
A second batch test generated 100 one-page Chinese quotes (31.93 MB ZIP). Independent PDF extraction checked all 100 filenames and both placements per file, plus the unchanged total. Three fictional company names were repeated across the 100 rows. The large-document and maximum-recipient tests are separate; the existing 100 MiB ZIP cap still applies.


## Name appearance and scanned pages

Original-layout export now has a **Name appearance** section. Explicitly enabling customization applies family, size, color, bold and italic to the inserted name runs only. Surrounding runs keep their matched style, subject to the same substitute-font limitation as the earlier original-layout mode. If permitted, width correction in custom mode shrinks the name runs while retaining the surrounding sizes. The Chinese fallback is regular Noto Sans SC. Unsupported bold or italic Chinese names fail preflight with recipient and page.

On a raster-only page, **Add name on scan** places a name field at a blank area selected by the user. The original image remains in the PDF, with a searchable text overlay. This flow does not erase or replace words printed in the image. Use the sample PDF to confirm visual placement. Geometry and field spacing are bounded. Files with both text and image-only pages can use both field types in one export.

The E2E fixture verifies an inline red 14 pt bold/italic monospace name, unchanged 12 pt surrounding words, a searchable name on the raster page, and the presence of the original raster content. The eight tests passed in Chrome, Firefox and desktop WebKit. The scan-and-style test also passed at a 390 px touch viewport in Chrome emulation. Physical-device peak memory remains unmeasured.

The original-layout panel links the distributed MuPDF license and the exact upstream source and build tree. Production distribution review still needs to verify the complete corresponding-source offering for the delivered binary.

## Simplified Chinese and appearance controls

The new panel, import feedback, recipient checks, export progress and cancellation have Simplified Chinese copy on the Chinese Quick Edit route. English remains the fallback for other locales. Font family, size, color, bold and italic are grouped in a disabled fieldset until **Customize inserted names** is enabled. Turning it off preserves the chosen values for a later re-enable.

The Chrome suite passed 9/9. The new Chinese test uses the actual localized route and verifies the import confirmation, long-name error with recipient and page, and cancellation message. The appearance test toggles all five controls off, on, and off again before checking the exported PDF.
