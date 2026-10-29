# PaddleOCR step 3 — the same models in a browser (pre-registered 2026-10-29, before any run)

Site unchanged: a standalone test page served locally, PP-OCRv5 mobile det+rec (the
same .onnx files as step 2's M4), onnxruntime-web (wasm), our own JS pre/post-processing
in a Web Worker.

1. FIDELITY (the JS port is right): on dev + pool clean, Han recall within 0.02 of the
   Python M4 run (step 2) on each set, and script right 20/20 on pool. Otherwise the
   port is wrong — fix the port, don't judge the models by it.
2. SPEED, desktop (this Mac, Chromium, no throttling): median seconds per page reported;
   bar for going on: median <= 15 s/page (prod's whole PDF→Word now ~28 s per doc of
   1–2 pages, so roughly the same ballpark).
3. SPEED, weak device proxy: Chromium CPU throttling ×4 and ×6 — reported, plus a real
   phone if the owner can open the test URL (owner's call). No hard bar; it decides
   whether a phone gets PaddleOCR, Tesseract, or a choice.
4. MEMORY: peak JS heap + wasm memory per page (performance.measureUserAgentSpecificMemory
   or process RSS via Playwright CDP) — reported; must not exceed ~1 GB on a 4200 px page.
5. DOWNLOAD: total bytes the page fetches (models + wasm + JS), compressed — reported.
6. LICENSES: every file shipped (models, onnxruntime-web, any copied code) listed with its
   license; all must be AGPL-compatible.
Go to integration (a separate PR, owner approves) only if 1 and 2 pass and 4 holds.

## Amendment 1 (2026-10-29, after the pool fidelity run — stated as such)
JS (no cls model) pool clean recall .995 vs Python M4 (with cls) .954: outside the 0.02
fidelity band, in the better direction. Per doc the gap is whole lines missing in Python;
Python with use_cls=False on the two worst docs: 7048112 .824→.985 (JS .982), 7144036
.809→1.000 (JS 1.000) → the port is faithful; the PP-OCRv4 cls model was flipping upright
lines. "No cls" was picked after seeing the pool → its check is DEV (JS, no cls), plus an
upside-down page test (180°) before integration: our pipeline must rotate such pages
first (C1 OSD), since without cls a flipped line reads as junk.

## RESULT step 3 (2026-10-29)
1 FIDELITY: PASS. JS (no cls) pool clean zh .995, script 20/20; dev clean zh .977, ja .979
  (Python M4 with cls: .954/.979) — the no-cls choice holds on dev. 0 browser errors.
2 DESKTOP SPEED (1 thread, no isolation = today's pdfree.io): median 10.3 s/page pool,
  13.3 s/page dev (p90 40 s on dense pages) → PASS (≤ 15). 4 threads (needs COOP/COEP,
  which pdfree.io doesn't send): ×2.55 on the same 15 pages.
3 WEAK DEVICE: proxy INVALID — CDP CPU throttling doesn't slow Web Workers (×6 = same times).
  Not measured; needs a real phone.
4 MEMORY: FAIL — renderer peak 1.05–1.36 GB on A4 300-dpi pages (after init 0.36 GB),
  detection runs at full 2496×3520 (max_side 4000). → NOT go to integration as is.
  Next: detection at lower resolution (M = 2000 px: dev −2 pts with cls) or tiled
  detection — new variant, re-validate on dev + pool.
5 DOWNLOAD: det 4.2 + rec 13.1 + ort wasm 2.3 MB (brotli) ≈ 20 MB first time.
6 LICENSES: PP-OCRv5 models Apache-2.0 (PaddleOCR), onnxruntime-web 1.31.1 MIT, our JS
  is a port of RapidOCR 3.10.0 (Apache-2.0) → NOTICE + attribution needed. Compatible.
