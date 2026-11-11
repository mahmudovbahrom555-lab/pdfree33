# Class candidate C35: figures drawn smaller than the page are not downsampled — pre-registration (2026-11-11)

Status: **written before any code or fix run** (owner gave free choice of tasks, 2026-11-11). Criteria
are not changed after the run; mixed results are reported as mixed.

## Evidence
- Leader comparison (owner run 2026-11-11, A Extreme vs our Maximum on 12 public PDFs): A is 3–4× smaller
  on two arXiv papers (0.14 vs 0.53, 0.08 vs 0.23) at min page SSIM ≥ 0.99.
- Cause, measured on our Maximum outputs: figures stay at 290–510 dpi where they are drawn (target 96).
  worker.js's `_estimateDpi` takes the image's pixels against the PAGE size (and only for images ≥ 600 px),
  so a 1024-px figure drawn 2 in wide counts as ~120 dpi, not 509.
- Prevalence on the 43 stage-0+big documents: RGB/grey images drawn above 106 dpi left on Maximum in
  7 documents besides the 1-bit case — arXiv (5 papers) and USGS (gip-31, 1.72 MB of 1.96) — two
  independent sources.

## Fix (scope)
In the existing pre-pass chain (compressPrepWorker → cmykD.js; worker.js untouched), Standard and Maximum:
8-bit DeviceRGB / DeviceGray / ICCBased N=1|3 images, one /DCTDecode or /FlateDecode (no predictor),
no /Decode but the identity, not a mask or an SMask, an SMask with /Matte → left, drawn on a page we can
measure; **only when the drawn dpi is above 1.1 × the mode's target** (the same target and quality as
worker.js: chosen, else 150/96 and 82/72). Decoded by pdf.js, area-average downsample, qpdf libjpeg,
kept only when smaller; the colour space stays. Everything else stays with worker.js as today.

## Acceptance (fixed now)
1. No document larger than production (save-time-only bytes accepted — owner decision 2026-11-11).
2. Page count and the text of every page identical.
3. Corpus gate 0 FAIL. Colour: pages whose images changed, 50 dpi, mean CIEDE2000 ≤ 2 (jpx_check.py).
   Pages above it are reported one by one with the 96/150-dpi-alone comparison; threshold unchanged.
4. Report: sizes per document on Standard and Maximum; the two arXiv papers vs leader A.
5. e2e: a figure drawn small at ~300 dpi → downsampled on Standard/Maximum, text kept; Light untouched;
   the new tests fail against pdfree.io before the merge.
