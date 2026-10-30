# PP-OCR as the CJK language probe on desktops — pre-registered 2026-10-30, before code

Problem: Tesseract's language detection isn't confident on table/form/list-heavy pages →
the whole document stays pictures (by design). 6 benchmark docs at 0 for this alone:
pool 3865561, 7144036, 7516005, 7587103; dev 3852070, 4939526 (39 % of dev Japanese).

Change: when detection is NOT confident and the device passes js/fileLimits.js's gate
(desktop ≥ 8 GB), PP-OCRv5 reads the same sample page(s). CJK if, over lines scoring
≥ 0.85: ≥ 30 Han+kana characters AND they are ≥ 50 % of the letters read. Japanese if
kana ≥ 10 % of those characters, else Chinese (simplified/traditional by the C20 rule).
Else unchanged (pictures). Confident detections, phones, other browsers: unchanged.
Thresholds fixed here; not tuned on the docs below.

Criteria (site run, PDF→Word as a zh-CN user):
1. Of the 6 docs above, ≥ 4 read with recall ≥ 0.8.
2. Every other dev/pool doc: DOCX text identical to the current prod run.
3. False positives: synthetic scans in Hebrew, Thai, Hindi (Devanagari), Greek, and Latin
   tables (Noto fonts, tests/fixtures-style, ≥ 5 per script) — 0 read as Chinese/Japanese;
   outcome identical to prod.
4. deviceMemory 4 / mobile: identical to prod.
5. Added time on a probed doc ≤ 15 s median.
Plus: the 24 real pool scans (mostly Japanese newsletters) — every changed one looked at.

## Amendment 1 (2026-10-30, after the code, BEFORE any measurement), from an outside review
6. Repeatable: the 6 docs run twice on the new build — same decision and same text.
7. Fails safe: PP-OCR failing/unreachable → the page stays as today (unit test: a throwing
   probe leaves detection unsure; e2e already covers "models unreachable" for reading).
8. Precision reported beside recall: score.py's `extra` (characters output that the source
   doesn't have) for the probed docs.
Reported, not gated: the probe downloads the PP-OCR models (~21 MB, once, HTTP cache) on a
desktop for every unsure scan, non-CJK ones too; memory is the same PP-OCR path as reading
(C22, not re-measured). Kana share is a heuristic: a Japanese table with < 10 % kana goes to
Chinese — PP-OCR then still reads it (one model for both); listed if it happens.
