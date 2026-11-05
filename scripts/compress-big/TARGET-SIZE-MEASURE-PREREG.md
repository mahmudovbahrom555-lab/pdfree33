# Compress — Target Size + readability: stage-1 measurement, PRE-REGISTERED 2026-11-05

Written before any number of this stage. Owner + review (2026-11-05): measure first, then
thresholds, then the engine. No code in js/ in this stage.

## What is measured
1. **Target hit rate of today's Target Size** (worker.js single-pass heuristic):
   - targets 0.3, 0.5, 1, 2, 5, 10 MB (decimal: 1 MB = 1,000,000 bytes);
   - only on files larger than the target;
   - hit = the output's byte count <= the target.
2. **Readability against effective DPI.** The same document compressed at targetDpi 96, 150,
   200, 300 (Maximum quality settings otherwise). The DPI recorded is the effective DPI of each
   image after compression, from its real placement (MuPDF image rects), not the setting.
3. Time per run (wall clock). Memory: an approximation only (main-page JS heap via CDP; a
   worker's heap is not visible) — reported as such.

## Corpus (no user documents; public corpus + synthetic)
- **S (synthetic scans with exact ground truth).** Born-digital pages from the public corpus,
  each with a real text layer, rendered at 300 dpi into an image-only PDF. The source page's
  text layer is the ground truth. Classes:
  - S-text: body text >= 10 pt;
  - S-small: pages whose median font size is < 8 pt (footnotes, small print);
  - S-table: pages with ruled tables;
  - S-color: colour pages;
  - S-stamp: S-text pages with a synthetic red and a blue stamp/signature drawn on (visual only);
  - languages: English, plus Chinese (chi_sim) and Russian where the corpus has them.
- **R (real scans, no ground truth).** Image-only PDFs from the corpus. The comparison is
  against OCR of the uncompressed scan (relative; a weaker measure, labelled as such).
- **T (text PDFs)**, to confirm text layers are untouched (exact text equality, as already
  checked on 75 files).
Every class is reported separately; no single average across classes.

## Readability metric
- OCR: Tesseract 5.5.4 CLI (version and command logged), --psm 3, languages per document.
- Pages rendered for OCR at 300 dpi from the compressed PDF.
- **CER and WER against the ground truth** (S), with whitespace normalised and Unicode NFC.
  dCER = CER(compressed) - CER(uncompressed scan); dWER the same.
- R: CER of compressed vs OCR of the uncompressed scan.
- Visual: the owner, blind, on pairs (uncompressed vs compressed at each DPI). Covers small
  print, stamps, signatures and lines. A class can't pass on OCR alone.

## Decision rule (thresholds are proposals — HYPOTHESIS, the owner approves before use)
A DPI level is acceptable for a class if all three hold:
- median dCER <= 0.5 percentage points;
- p90 dCER <= 2 points;
- the owner's blind check passes.
The lowest such level becomes that class's readability floor for the Target Size engine.

## Reproducibility
The same input and parameters give the same bytes except /ID (checked once per class).

## Not in this stage
The engine itself, UI chips, OCR banner, grayscale — all after the owner sees these numbers.

## Addendum A — other engineering paths before a 200 dpi floor (owner 2026-11-05), PRE-REGISTERED

Owner: a 200 dpi readability floor only as a last resort, if no library or other path keeps
small files readable. Before any number of this addendum:

**Variants**, on the same 44 synthetic scans (class S) as stage 1:
- J96 / J150 / J200: today's pipeline (the stage-1 outputs).
- G150 / G200: grayscale JPEG q72, only for classes without meaningful colour.
- X@J96: JPEG 2000 (OpenJPEG via Pillow) at the byte size of J96 (+-10 %).
- MRC: a 1-bit text mask at 300 dpi (CCITT G4), a background at 100 dpi (JPEG q50) and a
  foreground colour layer at 75 dpi (per-block darkest colour, so coloured ink keeps its
  colour), stencil-masked in the PDF.

**Metrics:**
- v1: dCER as in stage 1.
- v2, order-insensitive: word recall = |GT words ∩ OCR words| / |GT words| (multisets,
  case-folded, punctuation stripped); zh uses character-bigram recall. The delta is v2(variant)
  - v2(uncompressed scan).

**A variant beats J96** for a class if:
- its median byte size is <= J96's (+10 %); and
- its median v2 delta is >= J200's median v2 delta - 1 point, i.e. readable like 200 dpi at the
  size of 96 dpi.

**Also required:**
- MuPDF, Poppler, Ghostscript and pdf.js all render the MRC page (a stencil mask of another
  resolution is legal PDF but must be checked in every engine);
- the owner's blind visual check on stamps.

A prototype is Python; the browser path (a G4 encoder in JS/WASM) is a separate step after
these numbers.

## Addendum B — adaptive MRC on independent documents (owner + review 2026-11-05), PRE-REGISTERED

Written before any number of this addendum. No worker.js change, no G4 encoder for the browser:
the question is only whether adaptive MRC wins on documents it was not tuned on.

### Metric v3 (fixed formulas)
Normalisation:
- all languages: Unicode NFKC, case-fold;
- en/ru: punctuation and whitespace removed for character metrics; words = \w+ tokens;
- zh: whitespace and punctuation (Unicode categories P*) removed; full-width = half-width by NFKC.

Character recall and precision are multiset (bag) based:
- CharRecall = |GT chars ∩ OCR chars| / |GT chars|
- CharPrecision = |GT chars ∩ OCR chars| / |OCR chars|

Reported separately:
- zh BigramRecall, the same formula over character pairs — its own metric, never replacing the
  character metrics;
- CER (and WER for en/ru) as in stage 1, a separate column, never mixed into recall/precision.

Every metric is reported as the delta against the same document's uncompressed scan.

### Sets
- **DEV (calibration):** the 44 class-S synthetic scans already seen. Parameters are chosen
  here only.
- **HOLD-S:** new synthetic scans from source PDFs not used by DEV (another seed; a source file
  in DEV is excluded). The same classes.
- **HOLD-R:** real image-only scans from the corpus (no text layer; old, faint, stamps,
  photographed pages), with no ground truth.
  - The metric is relative to OCR of the uncompressed scan: recall and precision of the
    variant's OCR against the original's OCR — weaker, labelled as such.
  - Chosen by a fixed rule before looking: every image-only PDF in the corpus caches, first 2
    pages, at most 3 per source site, up to 30 files.
- HOLD-S and HOLD-R are run **once**, after DEV calibration is frozen in a commit.

### Variants
| | Variant |
|---|---|
| J96 / J150 / J200 | today's pipeline (worker.js, Maximum quality 72) |
| MRC-F | fixed: mask 300 dpi G4, background 100 dpi JPEG q50, foreground 75 dpi |
| MRC-A | adaptive: mask dpi and background dpi chosen per page from text-component statistics |

**MRC-A rule**, calibrated on DEV only:
- Text-like components are connected components of the mask, excluding noise (area < 4 px at
  300 dpi) and blobs (height > 8 % of the page).
- Per page the statistics are: median, p10 and p90 component height, the share of components
  < 12 px, and mask density.
- Grid: mask dpi ∈ {150, 200, 300}, background dpi ∈ {50, 75, 100}.
- The rule maps the statistics to the cheapest grid point that passes the quality criteria
  below on DEV, as a small decision table (≤ 4 rules), frozen in a commit before HOLD.

### Quality criteria (a variant "keeps readability" for a class)
- median CharRecall delta >= -1.0 point and median CharPrecision delta >= -1.0 point;
- worst-10 % CharRecall delta >= -5.0 points;
- zh additionally: median BigramRecall delta >= -2.0 points.

**Engines:**
- OCR on renders by MuPDF and by Ghostscript (300 dpi); a variant must pass in both.
- pdf.js and Poppler render without error and without missing layers (a non-blank check).

**Visual:** the owner's blind check on a sample (pairs in random order, answers: worse / same /
can't tell); no variant passes with "worse" on stamps, signatures or small print in more than
10 % of pairs.

### Size criterion
Median and worst-case byte size per class, relative to J200 and J96.

### Decision (owner, 2026-11-05)
- MRC-A keeps readability AND is smaller than J200 → adopt.
- It works only on some classes → hybrid engine (per page).
- It fails quality → not adopted, whatever its size.

All results are reported per class and with worst 10 %, including failures.

### Addendum B — deviation, recorded before building HOLD-R (2026-11-05)
The corpus manifests (tests/corpus/cloud/sample-v1.json, reserve-v1.json) carry `stratum`
but no source site, so "at most 3 per source site" cannot be enforced.

Replacement rule:
- files with stratum `scan` from both manifests that are in the local caches;
- sorted by file name;
- the first 30 with no text layer on their first 2 pages;
- first 2 pages each.

The CommonCrawl sample spans thousands of sites, so one site dominating is unlikely but not
excluded; reported as such.

**HOLD-S:** make_synth.py with seed 7 (DEV used 20261105), excluding every source file in DEV's
manifest.
