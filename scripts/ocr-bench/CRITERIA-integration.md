# PaddleOCR on pdfree.io, desktop only — pre-registered 2026-10-29, before any code

Owner 2026-10-29: "soglasen realizuy" after export 97 (China, since 10-15, people who
added a file: desktop 270 / mobile 19 = 93 % desktop for pdf2word/pdf2ppt/ocr/pdf2excel).

Scope: recognizePage() reads Chinese/Japanese pages (primary script chi_sim, chi_tra,
jpn) with PP-OCRv5 mobile (det + rec, no cls; max side 4000) when the device is a
desktop with ≥ 8 GB (navigator.deviceMemory ≥ 8 && userAgentData.mobile === false,
the same gate as js/fileLimits.js LARGE). Everything else unchanged: language
detection stays Tesseract; other scripts, phones, Safari/Firefox stay Tesseract.

Judged through the real site (local build, _robust_local as a zh-CN user on
/zh/pdf-zhuan-word/, Chromium, desktop), against prod a806aea5's H2/H2r runs:
1. POOL (independent, 20 zh) clean AND rough: recall ≥ baseline + 0.08,
   bigrams ≥ baseline + 0.08, extra not up by more than 0.02, script right ≥ 17/20.
2. DEV (30: 21 zh, 9 ja) clean, rough, tilt: recall not below baseline on any
   language/set (reported).
3. No other language changes: pdf2word-arabic e2e, ocr e2e suites and the OCR
   language-detection unit tests pass unchanged; a Latin and an Arabic scan give
   byte-identical text with the new build vs main (same seed docs).
4. Gate: with deviceMemory 4 or userAgentData.mobile true (emulated), the CJK page
   goes through Tesseract (checked by which worker ran).
5. Time: median seconds per doc ≤ 1.5 × baseline H2r on pool clean (reported).
6. An upside-down (180°) Chinese page: recall not below Tesseract's on it
   (no cls model — the pipeline's own rotation handling must cover it).
7. Download of models/runtime from pdfree.io only (no CDN), with the stall-retry
   fetch; page works offline-after-first-use (HTTP cache) — reported.
Ship only if 1, 3, 4 hold and 2/5/6 show no regression; anything else is reported
to the owner as is.
