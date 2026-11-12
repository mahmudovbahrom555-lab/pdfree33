# How others edit existing PDF text — research for Quick Edit step 2 (2026-11-12)

Owner asked: gather how open-source projects did it, structure it, then try solutions against our criteria
(QUICKEDIT-PREREG.md — unchanged; this may only ADD traps). Time-boxed. Sources at the end; claims are what the
projects state about themselves unless marked "measured".

## The four approaches

| Approach | What it does | Layout (crit. 3, 5) | Old text gone | Fonts / CJK | Seen in |
|---|---|---|---|---|---|
| **R. Rebuild** | PDF → editable model (HTML/Word) → new PDF | breaks by design (our baseline: 3/20 same pages, 35 % pixels changed) | yes | new fonts; our build refuses CJK/RTL | our Quick Edit today, LibreOffice Draw import, AI prototypes |
| **O. Overlay** | white box over the old text + new text on top | other pages untouched | **no** — old text stays under the box (search, copy, privacy) | any font | many simple web editors, the pdf.js "whiteout + text item" proposal |
| **G. Glyph redaction + insert** | remove exactly the edited glyphs, draw the new text in place | untouched outside the edited line | yes | new text needs a font that has the glyphs | **PyMuPDF/MuPDF recipe** (add_redact_annot → apply_redactions → insert_text/insert_font, subset_fonts on save); **ours** (personalized copies, #173) |
| **S. Source (content-stream) edit** | rewrite the Tj/TJ operands of the run, everything else byte-identical | best (only the run changes) | yes | must re-encode text in the run's font; subset lacks glyphs → extend/supplement | HeyPuter "everything" PDF editor (AGPL-3.0, browser), pdf.js prototype (discussion #21293, no maintainer reply), offpdf (desktop, Tauri) |

## The wall everyone hits: subset fonts (= the zh user's "can select but can't edit")
Embedded fonts carry only the glyphs the document used. Strategies found:
1. **Reuse the embedded font when it already has every needed glyph** — perfect match (HeyPuter; Printcraft;
   offpdf limits itself to this: "single-line replacements using compatible existing fonts/glyphs").
2. **Split the run**: characters the subset has stay in the original face; the missing ones go in a
   SUPPLEMENT run (own Tf/TJ, same size/colour/spacing) in a matching full font, embedded as a subset
   (vr-patel/pdf-editor PR #52: Times→Tinos, Arial→Arimo, else Noto by script; fonts loaded lazily by
   Unicode range; text stays searchable).
3. **Fallback chain**: matching standard font → Noto Sans → Noto Sans CJK, and SAY which fallback was used
   (open-pdf-studio issue #507; HeyPuter).
4. **CJK size on the web**: download only the glyph slices the text needs, not the 16 MB face (HeyPuter).
5. **Extend the embedded program** with outlines from a same-family font (pdfedit, content-stream approach) —
   most faithful, most complex (font formats: TrueType / CFF / CID).
PyMuPDF's own FAQ: the old text's embedded font is not usable for new text by default — register a font
(insert_font) first; subset_fonts() before saving.

## Verification (our criterion 4 + "nothing else changed")
offpdf "verified save": re-extract and compare — the output contains the replacement and no recoverable old
text. Ours (quickEditOriginal.js writeOriginalCopy) already re-extracts every changed page and refuses a file
with any unexpected text change — keep it, make it the rule for every edit.

## Stated limits worth adding as test traps (none removes or relaxes a criterion)
Vertical writing, Type 3 fonts, text clipping paths, /ActualText, inline images without a clear end, text inside
shared Form XObjects (HeyPuter edits those), rotated pages (ours refuses), mixed styles in a line (ours refuses),
single-line only (pdf.js prototype, offpdf). Stirling-PDF (largest OSS PDF suite) has NO existing-text editing:
the request was closed "not planned" (2025-07).

## Licences (what we may reuse)
HeyPuter "everything" — **AGPL-3.0-only, same as ours**: code reusable with attribution. MuPDF — AGPL (already
ours). PyMuPDF — AGPL. pdf.js — Apache-2.0. vr-patel/pdf-editor, offpdf, pdfedit — licences to check before
reading code for reuse (ideas are free).

## Candidates to prototype (measured with run.mjs/compare.py + the 300-page phone book)
- **A (first): G + font strategy 1→2→3** on the MuPDF engine we ship: glyph redaction (have), new text in the
  embedded font when MuPDF says it has every glyph, else a supplement run in a matching font / Noto (CJK via
  self-hosted Noto SC, glyph-subset on save); verification as today; MuPDF moved to a worker, page by page.
  Expected to pass 1–5; risk: matching size/baseline of the supplement run, phone memory (10 MB WASM).
- **B (compare): S** — Tj/TJ rewrite from pdf.js source references (HeyPuter's AGPL code as reference),
  everything else byte-identical. Best fidelity; risk: encodings (CID/CMap), effort.
- O is NOT a candidate: old text survives under the box (fails criterion 4's "edit present / old gone" intent
  and the privacy promise). R stays only for rewriting whole paragraphs.

## New traps added to the corpus for step 2 (criteria unchanged)
1. zh edit needing glyphs absent from the embedded subset (the zh user's case; zh-book-300 has a subset font).
2. Text in a Form XObject; 3. a Type 3 font page; 4. a line with mixed styles; 5. a rotated page.

## Sources
- PyMuPDF: https://artifex.com/blog/how-to-search-and-replace-text-in-pdfs-using-pymupdf ,
  https://github.com/pymupdf/PyMuPDF/discussions/3396 , https://pymupdf.readthedocs.io/en/latest/faq/index.html
- HeyPuter PDF editor: https://github.com/HeyPuter/everything/tree/main/src/pdf
- vr-patel/pdf-editor PR #52: https://github.com/vr-patel/pdf-editor/pull/52
- open-pdf-studio #507: https://github.com/OpenAEC-Foundation/open-pdf-studio/issues/507
- pdf.js prototype: https://github.com/mozilla/pdf.js/discussions/21293
- offpdf PR #141: https://github.com/McanKul/offpdf/pull/141
- Stirling-PDF #3883: https://github.com/Stirling-Tools/Stirling-PDF/issues/3883
- pdfedit (content-stream): https://github.com/xarrakirri/pdfedit (link was 404 when fetched — claims from search snippet only)
