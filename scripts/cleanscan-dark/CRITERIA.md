# Clean Scan: light text on a dark or coloured background — pre-registered 2026-11-03, before code

Trigger: a user (SD, mobile, 2026-10-30 16:10–16:23 UTC) ran Clean Scan, got a >50 MB result from a
<1 MB file after 9.5 min, then wrote "اريد النص فقط لا اريد الخلفية الزرقاء" (text only, not the blue
background). Reproduced on prod: dark-blue page with white text → keepColor on: blue blobs kept, PNG
915 KB/page (56 KB → 8.9 MB for 10 pages); keepColor off: the white text becomes black blots.
Cause: Clean Scan takes the lighter side as paper; a dark background is kept as "coloured ink".

Design: find regions (blocks of the page) whose background is darker than their text; invert the
source there before the usual pipeline. No such region → the page goes through today's code
unchanged. Unsure → unchanged. Part of a page only where only part is dark.

Sets: (S) synthetic, committed — dark blue / black / dark green / maroon pages with white text,
gradient and textured backgrounds, cyanotype-like handwriting, a mixed page (normal caption +
dark box with white text), a white page with a dark title band, a stamp on a dark background;
truth = the text rendered. (C) controls — tests/fixtures/clean-scan, light coloured paper, the
earlier light-blue and blue-panel pages, real scans from the corpus cache (≥ 20 pages), pages
with dark photos. (R) the three real examples the owner sent (local only, not committed).

Criteria (local build vs main, same harness, keepColor on = the default, and off):
1. S: OCR (tesseract CLI) character recall of the output ≥ 0.9 on every page where main's is
   < 0.5; no page's recall lower than main's.
2. S: no visible background left: ≥ 97 % of the page's non-text pixels white in the output.
3. S: output size per page ≤ 2× that of the same text on white paper.
4. C: output byte-identical to main on every control page (no region found).
5. Mixed page: the normal caption keeps recall ≥ main's; only the dark box inverted.
6. Time per page ≤ +10 % on C (detection cost), reported for S.
7. R: looked at by eye, before/after shown to the owner — not a pass/fail gate.
Unit tests for the detector on built arrays (dark region found / not found / partial).

## Run 1 (block classifier v1) — FAILED, 2026-11-03
- S: every full-dark page unchanged (light-on-dark blocks only 13–14 % of a page with margins;
  the 20 % share rule rejected them). mixed-box 0.96 → 1.00, title-band changed (nokeep 1.00 → 0.95).
- C: 14 of 36 control pages changed (12 of 24 corpus scans + blue-panels). Looked at: a bold black
  Chinese heading turned hollow (0988799) — light gaps inside heavy strokes read as light-on-dark;
  dark newspaper photos partly inverted (2871607); a white-horse-on-black poster arguably better
  (1363272) but changed.

## Amendment 1 (before writing v2)
v2 is designed having seen run 1's S and C pages, so those are no longer an independent test.
Final evaluation of v2: the same criteria 1–7 on S (kept: built before any design) plus a FRESH
control draw — 24 first pages of corpus scans with seed 20261104, none of run 1's — and the
adversarial pages (night photo, paper on a desk, B/W photo) as before; R by eye.
Run 1's controls are dev data from now on.
