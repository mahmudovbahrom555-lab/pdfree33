# Compress — "fit into N MB/KB" with the least quality loss (criteria fixed 2026-11-13, BEFORE building)

Why: a real user (zh, Windows Edge, 2026-11-13) asked "可以改4MB吗" — compress to 4 MB. Today's Target Size is
three chips (25/10/5 MB) that only set Maximum + 96 dpi + a fixed quality (0.60/0.50/0.42); worker.js then
lowers the quality once by a formula. No search: the result can miss the target, and it can lose more than needed.
Owner (2026-11-13): "the stated size with the least quality loss, and warn honestly".

Design (candidate): a number field (MB or KB). A ladder of settings from least to most loss:
0 Light (lossless structure only) · 1 no downsampling, q 0.85 · 2 200 dpi q 0.80 · 3 150 dpi q 0.75 ·
4 150 dpi q 0.65 · 5 120 dpi q 0.60 · 6 96 dpi q 0.55 · 7 96 dpi q 0.45 · 8 72 dpi q 0.40 · 9 72 dpi q 0.30.
The site runs the real compression (pre-pass + worker, worker.js untouched), at most 4 full runs, and keeps the
LEAST lossy step whose output is ≤ the target. It shows what that cost (dpi, quality); a heavy step (≥ 7) gets a
warning; an unreachable target says so with the smallest size reached and still offers that file.

Documents: the 12 public originals of the compress comparison pack (lpack/originals: 140 KB … 41 MB).
Targets per document: 50 % and 25 % of its size; and 4 MB where the original is above 4 MB.

| # | Criterion | Bar |
|---|---|---|
| T1 | a result called "fits" is ≤ the target | 100 % (never claim a fit that isn't) |
| T2 | least loss: for a fitting result at step i > 0, step i − 1 run alone does NOT fit | ≥ 90 % of fitting results |
| T3 | unreachable target → a specific message with the smallest size reached, file still offered | 100 % of unreachable cases |
| T4 | at most 4 full runs per file; Cancel works between and during runs | yes |
| T5 | not worse than today: where today's 5 MB chip fits a 5 MB target, the new choice is the same step or less lossy (dpi ≥ 96 and quality ≥ today's) | 100 % |
| T6 | phone (390×664, CPU 4×): a 17 MB file → 4 MB | done; longest main-thread block ≤ 250 ms; progress moves |
| T7 | UI: MB/KB field, 44 px targets, all 16 locales, zh + ru checked | yes |
| T8 | regressions: compress e2e + all CI e2e + npm test; the corpus diff gate (default modes unchanged) | pass |
