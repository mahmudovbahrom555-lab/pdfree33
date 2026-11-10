# Class candidate: JPEG 2000 (JPX) images are never compressed — pre-registration DRAFT (2026-11-10)

Status: **APPROVED by owner 2026-11-10. Nothing below is measured as a fix yet; criteria are fixed before any fix run.**

## Evidence so far (stage-0 corpus, 39 public PDFs, prod 2350e0c8/3e6dae7d, run_compress.mjs)

- JPX images are skipped in every mode: worker.js `_recompressImages` and the pre-pass handle DCT/Flate only.
- Stage-0 docs carrying JPX, ratio on Maximum (output/input):
  report.pdf 34.0 MB → 1.00 (118 ICCBased-RGB JPX, 400 dpi);
  ofr20191024_pamphlet 14.4 MB → 0.99 (9.1 MB RGB JPX at 150 dpi);
  gip117_ebook 8.6 MB → 0.98 (5.2 MB CMYK JPX); ia-goodytwoshoes 1.5 MB → 1.00.
- Big-file corpus (cb-data, 52 docs, 1.53 GB): 4 docs with JPX, 27 MB. → by count a minority
  (≈ 8–10 % of docs checked); where present it is most of the file. Sources: USGS, Internet Archive,
  cloud corpus — at least 3 independent sources.
- Estimate (PIL, 12 images per doc, NOT the site chain): JPX → JPEG
  report: 150 dpi q82 −11 %, 96 dpi q72 −64 %; ofr2019: 150 dpi −80 %;
  gip117 (CMYK, 145 dpi) and ia-goodytwoshoes: JPEG LARGER → would be kept as they are.
- pdf.js 4.10.38 `JpxImage` (already vendored, image_decoders) decodes them: 4400×3600 in ~3 s (Node).

## Proposed fix (scope)

In `js/compressPrepWorker.js` (worker.js stays untouched), Standard and Maximum only:
- JPX, 8 bpc, colour space DeviceRGB / DeviceGray / ICCBased N=1|3 (the ICC profile kept as the
  colour space), no /Decode, no /SMaskInData, not an SMask/Mask itself, drawn on a page we can measure;
- downsample like the RGB path does today (Standard 150 dpi q82, Maximum 96 dpi q72; only above
  1.1× target), area average; encode JPEG (the D300 encoder chain, 1/3 channels);
- replace only when smaller. CMYK JPX: out of v1 (estimate says larger; D300 rules if ever).
- Light: untouched. Signed PDFs: untouched (as D300).
- Device-tier cap on decoded megapixels (measured, not guessed), cancel works between images.

## Acceptance (fixed before the fix run)

1. No document larger than production on any mode (stage-0 39 + cb-data 52).
2. Page count, text layer (pdf.js text per page) identical to production.
3. Corpus gate `corpus:diff:compress` 0 FAIL; per-image judge (check.py, MuPDF) PASS on every
   replaced image; colour ΔE2000 mean ≤ 2 vs original on ICCBased images (same rule as D300 review).
4. Report per doc: bytes before/after on Standard and Maximum, time, images replaced/kept/skipped
   with reasons. No target saving is promised; mixed results reported as mixed.
5. e2e: a JPX fixture (open licence) becomes smaller and stays readable; cancel mid-pass; a
   signed file untouched; phone viewport memory check on the largest JPX image.

## What this does NOT do

It does not close the main gap to the leader on print (CMYK) documents: D300 keeps CMYK at 300 dpi
by design. That gap belongs to stage 3 (an explicit "screen & email" mode), which needs the leader's
numbers on the stage-0 pack (~/Desktop/compress-leader-pack, owner run) before it is designed.
