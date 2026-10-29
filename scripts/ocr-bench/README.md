# OCR benchmark tools (WIP, 2026-10-29) — kept here so a /tmp wipe can't lose them

Not part of the site or the test suite. Data (docs, truth.json, outputs) stays out of
the repo (tests/corpus/README.md: no user documents); sets were drawn from the cloud
corpus pool (seeds 20261029 dev, 20261030 pool) and rendered to image-only PDFs
(clean 300 DPI PNG, rough 150 DPI JPEG q55).

- robust_local.mjs — runs PDF→Word in a real browser as a Chinese user
  (TOOL_PATH=/zh/pdf-zhuan-word/ BROWSER_LOCALE=zh-CN), against a local dist/ server.
- score.py / pool-score.py / toc-score.py / score_tilt.py — Han+kana recall, bigrams,
  extra, script (opencc t2s) against the source PDF's own text.
- run*.sh — the Tesseract variant runs (F, G, H2, H2r ...); CRITERIA-*.md — the
  pre-registered criteria and amendments, in order.
- run.py / dev.sh / CRITERIA.md — PaddleOCR step 2: PP-OCRv5 via RapidOCR 3.10.0
  (pip install --target lib rapidocr onnxruntime) on the same PDFs.
- feat.py — page features (stroke width, ink darkness) vs the contrast step's effect;
  the adaptive-contrast idea was closed on its result.
