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
