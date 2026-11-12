# Quick Edit stage — step 0: baseline measurement, criteria fixed before it runs (2026-11-12)

Status: **written before the baseline run.** The baseline only measures today's Quick Edit; the thresholds
below are the bar the NEW engine (in-place editing, step 2) must pass. They are not changed after a run;
the owner may adjust them before step 2 starts, in writing.

## Why
- Demand (analytics 2026-11-11): on-site search "编辑" 41 people / 30 days (zh-CN), "删除" 6, "edit…" ~15 (en).
- A zh user (2026-11-11/12): find & remove/replace a line repeated on every page of e-books; mainly on her
  PHONE; files of tens to hundreds of pages; font after replacing.
- Owner: "Quick Edit is raw, editing is weak" — do not point users to it until it is solid.

## Corpus (fixed now; no user documents)
- tests/corpus/real — 25 public PDFs: arXiv papers (9), Internet Archive scans (4), IRS forms (2),
  Wikipedia en/ru/ar/fa/he/ja/ko/zh/tr/vi (10).
- Stage-0 compress corpus (public, SHA-256 in corpus.csv): gip-31, ofr20251028 (USGS reports).
- tests/corpus/groundtruth: en-web, ar-web, fa-web, zh/ja ones if present (synthetic, open text).
- Phone case: a public 300-page book (to be chosen from open sources, SHA-256 recorded before the run).

## What one run does (real browser, the site's own UI — scripts/quick-edit/run.mjs)
1. Open /quick-edit-pdf/, add the file. Record: editor opened / refused (the gate's reason) / error; time.
2. If opened: the first text run holding a word of ≥ 3 letters (any script); type " PDFREE" at its end; Save.
   Record: a PDF came out / error text; time.
3. Compare the output with the original (MuPDF):
   - page count;
   - text kept: share of the original's words found in the output (minus the edited run);
   - the edit present: "PDFREE" in the output text;
   - layout: each page rendered at 40 dpi; share of pixels differing by > 32 (any channel) — on the
     edited page outside the edited line's box, and on every other page.
4. Phone (390×664, mobile UA, Chromium device memory limit noted): the 300-page book — time to open,
   time to save, JS heap peak (performance.memory), crash/freeze (no answer within 120 s).

## Thresholds for the new engine (step 2) — the baseline is reported against them
1. Editor opens on ≥ 90 % of documents with a text layer (scans: an honest "this is a picture" message, 100 %).
2. Edit + save gives a PDF on ≥ 95 % of opened documents.
3. Page count identical: 100 %.
4. Text kept ≥ 99.5 % of the original's words on every document; the edit present: 100 %.
5. Layout: pages not edited — differing pixels < 0.1 %; the edited page outside the edited line's box < 0.1 %.
6. Phone, 300 pages: opens and saves without a crash or a 120-s silence; progress visible; Cancel works.
   Time and memory: measured in the baseline, the bar set with the owner from those numbers.

## Not in step 0
Find & replace across pages, auto-detecting repeated lines, fonts for inserted text — steps 3–4, their own
criteria, written before their runs.

## BASELINE — today's Quick Edit on pdfree.io (2dc4d02e), 2026-11-12, 32 documents
(scripts/quick-edit/run.mjs + compare.py; outputs in baseline/. A first run pressed Escape after typing, which
dropped the edit — the harness was fixed to press Enter, as the site's own e2e does, and the whole run repeated.)

| # | Criterion (bar for the new engine) | Baseline |
|---|---|---|
| 1 | Editor opens ≥ 90 % | 32/32 (100 %) — scans open too, as reflowed text |
| 2 | Edit + save gives a PDF ≥ 95 % of opened | **20/32 (63 %)** — refused on EVERY zh/ja/ko/ar/fa/he document and 3 arXiv papers: "characters can't be rendered by Word→PDF's current font" |
| 3 | Page count identical 100 % | **3/20** (2→8 IRS form, 10→17 paper, 16→6 IA book) |
| 4 | Text kept ≥ 99.5 %; edit present 100 % | kept on 14/20 (worst 89.9 %, IRS 1040); edit present 20/20 |
| 5 | Layout: other pages < 0.1 % pixels changed | **0/20** — median 35 % of pixels differ on untouched pages (min 26 %) |
| 6 | Phone, 300 pages | not yet run |

Time: open median 2.8 s, save median 1.4 s (desktop).
**Reading:** the rebuild path re-lays out every page; it cannot meet 3 and 5 by design and refuses non-Latin
scripts — the zh user's files would not save at all. Step 2 = in-place editing (MuPDF) as the default path.

## Phone case — the book, fixed before its run (2026-11-12)
scripts/quick-edit/make_book.py: 300 pages, A5, body text from tests/corpus/real/wikipedia-zh-pdf.pdf (CC BY-SA),
Noto Sans SC (js/vendor/noto, OFL) embedded as a subset, a promo line at the foot of every page.
zh-book-300.pdf — sha256 83d238fb759ee222508d56f341f2fc495a48317baba304a8e39b42601be1de8f, 1.33 MB.
Run: Chromium, 390×664, mobile + touch, CPU throttled 4× (CDP), the same open → edit → save as run.mjs;
JS heap (performance.memory) sampled every second; give up after 300 s for either step.

## Phone case — BASELINE (pdfree.io e0491bf6, 2026-11-12)
zh-book-300.pdf, 390×664 mobile, CPU 4×: editor opened in 21 s (6,961 editable runs); Save **refused** after 6 s —
"characters can't be rendered by Word→PDF's current font". No crash. JS heap of the page ≤ 10 MB (performance.memory
sees only the page's main heap, not pdf.js's worker — a lower bound, not the total).
→ Criterion 6 not met: the zh user's case can't be saved at all today. Step 0 complete.
