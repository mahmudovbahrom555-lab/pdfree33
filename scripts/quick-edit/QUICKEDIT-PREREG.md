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

## Step 3 — the save off the main thread (criteria fixed 2026-11-12, BEFORE the candidate is built)
Why: on the phone case the tab is frozen during Save; Android may offer to kill an unresponsive page.
Measured on main bb88baa8 (phone.mjs + long-task observer, zh-book-300, 1 Latin edit, CPU 4×, 2 runs):
save 15 s / 15 s; main thread blocked 12.6 s / 12.5 s in total; **longest single block 4.7 s / 4.7 s**.
Phases (phases.mjs, 1 Han edit): MuPDF open+redact+save 3.6 s; pdf-lib save with the full Noto SC 5.8 s (12.6 MB);
MuPDF subset 1.4 s + save 2.8 s.
| # | Criterion | Bar |
|---|---|---|
| S1 | longest main-thread long task during Save, phone case, both runs | ≤ 250 ms |
| S2 | Save time, phone case | ≤ 1.2 × baseline (≤ 18 s) |
| S3 | same results: quickEdit e2e + skeleton all pass; UI corpus run (run.mjs/compare.py) saved count ≥ 22/33 with every layout criterion as before | no regression |
| S4 | error messages still in the page's language (zh/ru checked) | yes |
| S5 | open: longest long task while the editor opens, phone case | ≤ 250 ms (baseline 237 / 113) |
Time reduction is NOT a criterion of this step (worker first; less work later, measured separately).

## Step 3 — RESULT (branch feat/quick-edit-worker, js/quickEditWorker.js, 2026-11-12)
| # | Bar | Before (main) | After |
|---|---|---|---|
| S1 longest main-thread block during Save (phone, 2 runs) | ≤ 250 ms | 4,715 / 4,699 ms | **153 / 155 ms** (after the i18n follow-up: 177 / 154) — met |
| S2 Save time phone | ≤ 18 s | 15 / 15 s | 5 / 5 s — met (hypothesis: CDP CPU throttling may not slow worker threads; the drop is partly the measurement, not claimed as a speed-up) |
| S3 same results, 32 docs main vs branch, same harness | no regression | — | **0 per-document differences** (open, save, pages, text kept, edit present, layout); desktop save median 586 → 632 ms — met |
| S4 messages in the page's language | yes | engine refusals en/zh only | ru/zh/en checked: worker refusals now i18n keys in all 15 locales — met |
| S5 open longest block | ≤ 250 ms | 237 / 113 | 217 / 148, 229 / 105 — met |
Corpus note: 32 of the 33 documents (gip-31's original was deleted from scratch with old compress outputs; dropped from BOTH runs).
The harness waits for editable lines, so Internet Archive scans (hidden OCR layer → honest "scan" note) count as "timeout" in both.

## Step 4 — Find & replace on every page (criteria fixed 2026-11-13, BEFORE building; owner: "like Word's auto-replace")
Scope: in the page editor, "Find" + "Replace with" (empty = remove) → count of matches and pages → "Replace all".
A match lies inside one text line (a phrase broken across two lines is NOT found — a stated limit, shown to the user).
Repeated-line auto-detection is the NEXT step, not this one.
| # | Criterion | Bar |
|---|---|---|
| F1 | zh-book-300: find the promo line, remove all | 300 matches on 300 pages; output: promo gone from every page; every other line identical (per-page verification); page count same; untouched pages' pixels < 0.1 % changed; the edited band only changes |
| F2 | count vs an independent reader (PyMuPDF search_for, per page, matches inside one line) on 3 Latin + 2 CJK corpus docs, 1 word/phrase each | equal on every page |
| F3 | replace a Latin word on wikipedia-en (all its occurrences that fit) | every occurrence replaced or named with its page ("too long"); nothing else changes (verification) |
| F4 | phone 390×664, CPU 4×, zh-book-300 remove-all | done ≤ 60 s; longest main-thread block ≤ 250 ms; progress moves; Cancel stops it and no file is offered |
| F5 | nothing found | a specific message ("0 found — the text may be a picture or split across lines"), never silence |
| F6 | languages | every new UI string in all 15 full locales; zh + ru checked in a browser |
| F7 | regressions | Quick Edit e2e + skeleton all pass; all 37 CI e2e + npm test |

## Step 4 — RESULT (branch feat/quick-edit-find-replace, 2026-11-13)
| # | Bar | Result |
|---|---|---|
| F1 | zh-book-300 promo removed everywhere, nothing else | **met**: 300 found on 300 pages; check_removed.py (PyMuPDF): 300→300 pages, promo left on 0, other text changed on 0, pixels changed outside the line's band on 0 (desktop + 2 phone runs) |
| F2 | count = MuPDF per page (5 docs) | **met**: wikipedia-en "Adobe" 154/22, arxiv "model" 94/10, en-web "PDF" 2/1, wikipedia-zh "文件" 106/14, ja-web "モード" 4/1; replaced + left per page = MuPDF on every page |
| F3 | every occurrence replaced or named | **met**: replaced 148/154, 94/94, 2/2, 93/106, 4/4; the rest left with their pages named in a message |
| F4 | phone: ≤ 60 s, block ≤ 250 ms, progress, Cancel | **met**: find 1.1–1.3 s, save 1.9–2.2 s, longest block 148–150 ms; progress 5 % → 30 %; Cancel: no file, no success card |
| F5 | nothing found → specific message | **met** (e2e) |
| F6 | 15 locales, zh + ru in a browser | **met**: zh/ru placeholders, buttons, status; 44 px controls, no sideways scroll at 390 px |
| F7 | regressions | see the PR (all CI e2e + npm test) |
Found along the way (each fixed test-first or checked both ways):
- Chinese PDFs store 更 as U+F901 (compatibility ideograph), 文 as ⽂ (Kangxi radical), 页 as ⻚ (radicals supplement): matched via NFC, NFKC for Kangxi only, and a table from Noto SC's own glyphs (scripts/gen_cjk_radicals.py).
- pdf.js reads MuPDF's spaces as ordinary spaces, MuPDF as U+00A0 — any space counts as one (site + checker).
- Chrome-printed Chinese: one font split into a subset per character → lines grouped by the real font name, so whole lines are editable (page editor too).
- The save check after writing was itself wrong in two ways (an edited piece mid-row; pieces 0.6 pt apart) → rows chained within 1.5 pt, built from pdf.js pieces, the edit put into its row. Negative tests (neighbour removed, text tampered) still caught on en-web and arxiv; honest edits pass.
- MuPDF vs pdf.js name some glyphs differently (radical vs ideograph, — vs ―), and a glyph set tight after the line was taken in → tolerant per-character compare, end bound by size.
- One refused line no longer undoes a Replace all: that line is left and named.
Not met / known: wikipedia-zh 13 occurrences left (6 pages), wikipedia-en 6 (2 pages); each skip costs a full pass (wikipedia-zh save 18.6 s desktop). Phrases across two lines not found (stated in the UI).

## Step 5 — repeated lines found for the person (criteria fixed 2026-11-13 night, BEFORE building)
Design: after the page editor opens, every page's lines are read in the background (the same readPage as Find). Lines are
grouped by their text with digits ignored ("Page 3 of 10" = "Page # of #"), NFC/radicals/spaces as Find; a group is
offered when it stands on ≥ 50 % of the pages (≥ 3 pages), within 15 pt of the group's median height, and has ≥ 2
letters (bare page numbers are not offered). Up to 3 offers, most pages first: "On 298 of 300 pages: «…» — Remove
everywhere". Removing uses the in-place edits (each occurrence → empty), verified as every save is.
| # | Criterion | Bar |
|---|---|---|
| R1 | zh-book-300: the promo line offered first, on 300 of 300 pages; removing it leaves every other line and the pictures outside its band unchanged (check_removed.py) | yes |
| R2 | precision on the corpus (tests/corpus/real 25 + groundtruth web pages): every offered line judged by hand — a running header/footer/watermark text, not body text | ≥ 90 % of offers |
| R3 | silence: a document whose pages share no such line gets no offer | 0 offers on single-page docs and on docs with no repeated header/footer (judged by hand) |
| R4 | phone 390×664 CPU 4×, zh-book-300: offer shown | ≤ 5 s after the editor opens; longest main-thread block ≤ 250 ms |
| R5 | languages / regressions | 16 locales; Quick Edit e2e + all CI e2e + npm test |
