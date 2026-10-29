# PaddleOCR step 2 — offline, site unchanged (pre-registered 2026-10-29, before any run)

Question: do ready PP-OCRv5 models (Apache 2.0, ONNX via RapidOCR 3.10.0, the same
.onnx files a browser build would load) read our Chinese/Japanese scans enough better
than today's pipeline (Tesseract + C20 + C21, = prod a806aea5) to justify step 3
(browser build: size, speed on weak phones, memory, download from China)?

Inputs: the same image-only PDFs — dev zhocr/{clean,rough} (30 docs: 21 zh, 9 ja) and
pool zhocr2/{clean,rough} (20 zh). Page images taken straight from the PDF (no render).
Baseline: existing H2 (dev) / H2r (pool) runs = prod pipeline output (PDF→Word DOCX).
Scoring: zhocr/score.py unchanged (recall, bigrams, extra, folded, script);
PP-OCR text is written into a minimal DOCX in reading order as RapidOCR returns it.

Variants:
- M  = PP-OCRv5 det mobile + rec mobile (ch: simplified+traditional+Japanese in one model)
- M4 = M with max_side_len 4000 (default 2000) — screening on DEV ONLY; the better of
       M/M4 on dev (recall, clean+rough) is the one judged on pool. No other tuning.
- S  = PP-OCRv5 server det+rec — ceiling reference only (too big for a browser, reported).

"Big gain" (→ propose step 3) only if on POOL, clean AND rough, the chosen mobile variant:
(a) zh recall >= baseline + 0.05 and bigrams >= baseline + 0.05;
(b) extra not up by more than 0.02;
(c) script right on >= the baseline's count;
and on DEV ja recall not below baseline (layout docs reported, judged by eye too).
Also reported, not judged here: seconds per page (this Mac, CPU, 1 thread and all
threads), model file sizes. Anything else is "no big gain" — said as is.

## RESULT (2026-10-29)
Dev screening: M4 chosen (clean zh .954/ja .979 vs M .931/.954; rough equal). S (server) not better than mobile.
POOL (independent, 20 zh), M4 vs prod (H2r = a806aea5):
- clean: recall .810 → .954 (+.144), bigrams .745 → .905 (+.160), extra .025 → .020, script 17 → 20/20
- rough: recall .777 → .950 (+.173), bigrams .701 → .882 (+.181), extra .026 → .018, script 17 → 20/20
- dev ja: .490 → .979 clean, .423 → .916 rough
(a) ✓ (b) ✓ (c) ✓ ja ✓ → BIG GAIN → propose step 3 (browser check) to the owner.
Per doc: only 0010853 clean below prod (.95 → .87): its truth repeats fake-bold words (VPN ×4, 學校 ×4,
操作 ×4 ≈ 26 of 323 Han) while OCR reads them once; its extra .50 = real text inside screenshots
(browser UI) that the truth lacks. A truth artifact, not a reading loss — truth NOT edited (measuring stick).
Speed (this Mac, native onnxruntime, 8 cores): M4 median 5.0 s/page clean, p90 14 s. Browser (wasm) unknown.
Sizes: det mobile 4.6 MB + rec mobile 15.9 MB + cls 0.6 MB.
