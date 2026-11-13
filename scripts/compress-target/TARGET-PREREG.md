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

## RESULT (branch feat/compress-fit-size, 2026-11-13) — 12 documents × (50 %, 25 %, 4 MB if larger) = 30 runs
Three candidates were measured; the criteria did not move.
- v1 (first step guessed from size ratio, then halving): T2 **6/7** — on report.pdf (34 MB → 16 MB) the budget ran out with a
  gentler step unrun; and when nothing fit it kept a lossy step where lossless gave the same size (A4 file, 0.38 MB).
- v2 (steps predicted from measured sizes; lossless tried when unreachable): T2 **5/7** — worse; two fits left the step
  just gentler unrun.
- v3 (pure halving over 11 places: none fits … all fit) — shipped candidate:
| # | Bar | v3 result |
|---|---|---|
| T1 | "fits" ≤ target, 100 % | **met** 7/7 |
| T2 | least loss proven ≥ 90 % | **met 7/7** (the step just gentler was run and missed, or the step is lossless) |
| T3 | unreachable → message, smallest reached, file given | **met** 23/23; the strongest step ran in all 23 |
| T4 | ≤ 4 full runs, Cancel | **met** (max 4) |
| T5 | not worse than today's 5 MB chip | **met**: pamphlet — chip 4.77 MB at 96 dpi q≤0.42, new 5.12 MB at 120 dpi q0.60 (fits, gentler); report.pdf — chip 8.4 MB (over), new 4.88 MB (fits); 4 others unreachable both ways |
| T6 | phone 17 MB → 4 MB | **met**: 27 s, 4 runs, longest block 0 ms, progress moved 4×; pamphlet 14 MB → 6 MB in 7 s (200 dpi q0.80) |
| T7 | UI | ru checked at 390 px (44 px field/unit, empty size blocked with a message); 16 locales |
| T8 | regressions | compress e2e 25/25 (2 new); see PR for all CI e2e |
Known costs/limits (said, not hidden): up to 4 full runs — report.pdf (34 MB) 4.3–5.5 min on desktop vs 1.4 min for today's
chip; when nothing fits the gentlest step within 3 % of the smallest file is kept, but lossless (step 0) is not among the
halving's runs, so a vector book keeps 150 dpi/65 % even if its pictures bought nothing. Batch compress still uses
worker.js's one-pass formula for a size. 23 of 30 targets were unreachable — most documents here are vector/text-heavy
(the same files are over the 5 MB chip on prod too).

## Step 2 — faster: estimate first (criteria fixed 2026-11-13, BEFORE building; owner: speed up 4–5.5 min, say "can't" honestly)
Candidate: the pages holding the heaviest images are copied into a small sample PDF; the SAME compression code runs on it
at every step (cheap: small file); the full file's size per step is predicted as non-image bytes + image bytes × the
sample's ratio for that step. Then the full file runs only at the predicted gentlest fitting step s and at s − 1 (the
proof for least loss); more runs only when the prediction was wrong. An unreachable size is said before any full run when
even step 9 is predicted to stay over by a clear margin.
| # | Criterion | Bar |
|---|---|---|
| E1 | prediction: predicted vs actual full size per (document, step) on the 12 documents | within ±15 % on ≥ 90 % of pairs |
| E2 | upfront "can't": unreachable targets said before full runs | ≥ 80 % of unreachable targets; **0** said "can't" where some step really fits |
| E3 | time: report.pdf (34 MB) to 16 MB and 8 MB | ≤ 50 % of v3's time (v3: 272 s / 258 s) |
| E4 | T1 (fits ≤ target 100 %), T2 (least loss proven by runs ≥ 90 %), T3 (unreachable said, a file given) of the fit-size criteria | still met on the same 30 targets |
| E5 | phone 17 MB → 4 MB | not slower than v3 (27 s); longest main-thread block ≤ 250 ms |
