# Error classes — the quality loop's ledger

How PDFree's conversion quality is improved (owner, 2026-10-18): not one bug
at a time, and not "the average score went up" — **one class of error at a
time, closed with evidence**.

1. **Find a class.** After a corpus run, group the errors by *cause* (the
   metric's counters and `numberCauses`, then a look at the documents), not by
   how bad the output looks. One cause per class: "years reversed in RTL lines"
   and "numbers lost to page furniture" are two classes even if both show as
   lost numbers.
2. **Confirm it.** Open the PDFs and the DOCX by hand: is the cause really the
   same? It must hold on documents from **independent sources** — several
   files from one website or one generator are one source. Split the
   documents: a *discovery* set (where the class was found, used to build the
   fix) and a *control* set (never looked at while fixing, used to judge it).
3. **Rank it** by harm to a user, then frequency, then cost: lost amounts,
   dates and IDs, unreadable Arabic order, broken tables, an empty result —
   high; OCR accuracy — by measurement; small visual differences — later.
   A real user's report outranks any corpus finding.
4. **Compare with competitors** on 2–5 of its documents (popular online
   converters; a desktop editor where a licence is at hand) through their
   ordinary web UI, by hand — never automated, never a user's document, only the public corpus
   documents. Same criteria for all: text, numbers, reading order, structure,
   a usable DOCX, time. Competitors are letters here (A, B, …), never names:
   their products change and a named number goes stale (owner, 2026-10-19).
   Record the findings here as text; no competitor output
   is committed.
5. **Fix the cause**, test first: a reproducible test of the error, then the
   code. Then the discovery set, the control set and the whole corpus run
   (`scripts/quality/arabic.py --compare`, `npm run corpus:diff:*`). Better on
   the discovery set but worse on the control set or elsewhere = not fixed.
   A deliberate regression is allowed only as a planned one: what breaks, why
   it is the price of the change, when it is restored, who approved it — in
   `tests/corpus/GOLD_CHANGELOG.md`.
6. **Close it**: the competitors' documents again, after the fix; what is
   fixed, what is left, on which kinds of PDF. Tests in place, verified on
   pdfree.io. Only then the status is `closed`.

Claims stay the size of the evidence: "on the documents checked", never
"better than competitors", until a reproducible comparison on one corpus
says so.

Statuses: `found` → `confirmed` → `compared` → `fixing` → `closed`
(or `wontfix`, with the reason). Documents are named by corpus ID
(`tests/corpus/cloud/sample-v1.json`); the files themselves are never
committed.

---

## C1 — pages with /Rotate lose their text → an empty or picture-only DOCX

- **Status:** `fixing` — fix shipped and verified on pdfree.io 2026-10-18; open: OCR tool layout, competitor re-check
- **Harm:** high — the user gets a Word file with no text, nothing tells them why.
- **Cause, one in two forms:**
  - text layers: `_p2wBuildPageData` (`js/pdf2readCore.js`) calls an item
    rotated when its matrix's b dominates a — in the page's unrotated space.
    On a /Rotate 90/270 page, upright text has exactly that matrix, so every
    item goes to the rotated-labels path and the page's text is lost;
  - scans: `createOcrLayer().ocrPage` (`js/pdf2wordOcr.js`) returns null for
    any page with /Rotate ≠ 0; a scan whose only text layer is a site
    watermark comes out empty (the watermark goes as a running header).
- **Discovery set:** 1161722, 2026350, 2815708, 2952792, 3812118, 4145235,
  4820963, 5615468 — one source (an exam-papers site, iLovePDF-made): every
  page rotated, output empty; the site's unrotated scans (0261098, 4111221)
  are OCRed and give text.
- **Independent sources (confirm the class):** 0152391 (Canon scanner,
  Japanese newspaper, /Rotate 270), 0228973 (/Rotate 90), 1687201
  (/Rotate 270) — pictures only, 0 characters; 2022469 (Acrobat Distiller,
  Persian book, 62 pages /Rotate 90, a good text layer) — 0 characters. 2867656
  (bizhub, page 2 /Rotate 180) to check per page.
- **Control set:** to be drawn from the rest of the sample (all strata), not
  looked at while fixing.
- **Competitors (2026-10-18, by hand by the owner, free tiers — OCR is paid
  on both; scored with `scripts/quality/arabic.py`):**
  - 2022469 (text layer, 4,700 words and 157 numbers both readers agree on):
    **Competitor A** recall 90.5 %, numbers 99.4 % (1 lost), 319 split words,
    41 dot errors, 24 glued; keeps presentation forms (59,860 of its
    letters — reads right, but Word's search and spell-check see other
    letters) and 2,313 unmapped glyphs (boxes); pages landscape.
    **PDFree** 0 % — 62 page pictures, 17 MB for a 473 KB PDF.
  - 4820963 (scan): **Competitor B** (free tier) — the page pictures plus the
    watermark text only, no OCR (paid); **PDFree** — the pictures, nothing
    else. A tie at zero.
  - **The bar for the fix:** on 2022469 at least competitor A's recall and
    numbers, in plain letters; on 4820963 the exam's text — which neither
    free competitor gives.
- **Status after comparison:** `compared` → `fixing`.
- **Fix (4293ea1b, 2026-10-18):** one matrix to the page as shown
  (`uprightMatrix`, `js/pdf2readCore.js`) for text items, table rules,
  image placements and OCR boxes; OCR on rotated pages; `recognizePage` no
  longer turns the upright render back by /Rotate (rotated scans went to
  Tesseract sideways — the OCR tool read them as noise too). Test first:
  `rotated-pages.pdf` (/Rotate 0/90/180/270) in `pdf2word-arabic.e2e.mjs`,
  failing before (page 2: 18 % of its words).
- **Measured (local, against v8 = production before the fix):** only the 12
  documents with rotated pages changed, all for the better; unrotated
  documents unchanged. 2022469 0 → 96.1 %, 157/157 numbers (competitor A 90.5 %,
  99.4 %); 0997713 (5 of 82 pages rotated) 68.5 → 72.7 %, lost numbers
  203 → 103; 3122010 95.9 → 96.6 %; long documents' lost numbers −259.
  *Correction:* the commit message's "5,056 → 4,701" compared with the
  rolled-back strict-ActualText build and mixes that rollback in — the C1
  effect alone is −259. The exam scans now give their text (800–1,600 OCR
  words each, e.g. 4820963 "المملكة الأردنية … وزارة التربية والتعليم"),
  which the metric cannot score (its reference is the watermark). Control
  set outside Arabic: 0810920 (Chinese, 100 % of characters), 1943977
  (Japanese, right text; MuPDF itself reads it as garbage), 1687201,
  2867656 — all from no text to text.
- **Cost:** OCR now runs on those pages — 5 → 47–95 s on the exam scans;
  0152391 (4 dense newspaper pages) now times out at 300 s (C2).
- **Left:** the OCR tool's searchable PDF draws the words of a rotated page
  unrotated in its own space (searchable, but each word its own sideways
  line); vertical CJK writing order (0810920); a competitor re-check.
- **Verified on pdfree.io (4293ea1b, 2026-10-18):** 2022469 96.1 %, 157/157
  numbers; 4820963 7 pages OCRed, 4,768 characters; 1687201 and 2867656 the
  same text as locally; the unrotated control 0046581 unchanged (0.8387).
- **Metric limitation found (reported, not changed):** `--compare` called
  2022469 "worse" — its dot errors went 0 → 5 because it went from no text
  to 96 % of it. The worse-rule compares error counts without the words
  they are out of.
- **Measurement note:** the Arabic metric scores the watermark-only scans
  against the watermark ("short", recall 0) — it sees that output is
  missing, not how much content was lost.

## C2 — OCR language detection costs most of a short scan's time

- **Status:** `found` (2026-10-18), measured
- **Harm:** medium — slow, and in CI a timeout; the result is right.
- **Cause:** `detectOcrLanguage` probes script models one by one (a new
  Tesseract worker and model each) until one clearly wins. 3508224 (2 pages):
  74.6 s of 125 s detecting (ara+eng, heb+eng, kor+eng, rus+eng, chi_sim+eng,
  jpn+eng, ara, fas → ara), 28 + 16 s reading the pages. Its text layer
  (thin text over a scan) is Arabic and is not used as a hint.
- **The five CI-slow documents, profiled (2026-10-18, local, behaviour as
  production):** detection is the cause on two only — 3508224 (74.6 s, 8
  probes) and 7491997 (61.4 s, 8 probes; plus one page OCRed in 58 s). The
  others are large: 3939389 ~120 OCR pages × 1.7 s; 5955337 35 OCR pages and
  44 s capturing visuals; 6977632 ~263 pages at ~0.4 s each.
- **A text-layer hint alone would not help:** `ara+eng` is already the first
  probe on both; probing goes on because no model passes the clear-winner bar
  (≥ 25 % and ≥ 15 confident own-script words on the small render).
- **Next:** prototype — when the text layer's script agrees with the first
  probe, accept it at a lower bar; experimental build only; the 289 documents
  for detection time, total time, text, numbers, mixed-language and watermark
  scans. Kept only if better without regressions. Separately, not yet
  explained: 7491997's 58 s page, 5955337's 44 s of visuals.

## C3 — numbers in RTL lines (known debt)

- **Status:** `fixing` — partly fixed (aca5c4af and earlier); the rules are
  written down as debt in `js/textLayoutUtils.js` (`joinSplitNumbers`).
- **Measured and rolled back (2026-10-18):** refusing ActualText with digits
  the glyphs don't show lost 96 numbers and added 99 dot errors on two Adobe
  documents, fixing none.
- **Left:** 2,421 lost numbers with no named cause in the 289-document run
  (811 of them in 4 documents with broken font encodings).
- **Fixed (2026-10-19):** a digit piece with a space at its end — an
  /ActualText "1" over a mirrored bracket glyph, the item " 1" — was no piece
  of a number, and "2021" drawn as "202" | "1" came out "1202" (5494457, a
  footnote "مايو 1202م"). It joins now, its space kept. 289 documents: 3
  improve (1772036 lost numbers 34 → 9, 5494457 103 → 71, 5295408 3 → 1),
  none worse; words unchanged.

## C4 — the text layer gives other digits than the page draws

- **Status:** `fixing` — part 1 (Type0 fonts, #51) verified on pdfree.io
  2026-10-21; part 2 open (2026-10-22, below)
- **Harm:** high — wrong numbers that look right, and they reach the DOCX:
  on pdfree.io 4 of 4 checked documents carry them (0045417: "2011" on the
  page, "3122" eight times in the Word file and "2011" never).
- **Cause (confirmed on 5470407):** the font draws the right glyph, the PDF's
  ToUnicode names it wrongly — B Nazanin's glyph 14 is "zero" in the
  embedded font's own Unicode cmap (U+0030/0660/06F0), ToUnicode says "3";
  glyph 20 (six) → "3", 21 (seven) → "2", 22 (eight) → "1". Elsewhere a
  one-off shift (0045417, Arial: 2→3, 0→1, 1→2).
- **How it is measured (independent of both text readers):**
  1. candidates — a digit glyph whose ToUnicode digit differs from the
     embedded font's own Unicode cmap (Mac/symbol cmaps map char codes,
     not digits — left out);
  2. arbiter — the glyph's drawn shape, matched against 606 reference
     digits (Latin, Arabic-Indic, Persian; system fonts), deciding between
     the two candidate digits, with the glyph's height (an Arabic-Indic
     zero is a dot). Tesseract on the crops read ≤ 7 of 16 — not usable;
  3. calibration — 120 crops hand-labeled from the page images (9 left
     out as ambiguous): the arbiter picked the right digit on 54/54 and, on
     documents it was not tuned on, 57/57. Errors are per document: in each,
     either the text layer or the font's cmap is right throughout.
- **Prevalence (289 Arabic-script documents, first 60 pages each):** text
  layer wrong in 26 of the 269 with digits (≥ 3 digits, majority); 2,304
  wrong digits of ~151,000 (1.5 %, concentrated in those 26). 20 more
  flagged documents were the font's cmap being wrong, the text right.
  Sources: B Nazanin, B Mitra, Arial, Times New Roman, Jameel Noori
  Nastaleeq, Simplified/Traditional Arabic… — many generators.
- **Not measured:** ~47,000 digits in fonts whose program couldn't be read
  (recall unknown there); digit ORDER flips (٢٦ read "62") are a separate
  class.
- **Fix (`js/pdfDigitFix.js`, `js/digitGlyphs.js`):** for a Type0 font over
  an embedded TrueType program, the digit glyphs whose ToUnicode digit
  differs from the font's own Unicode cmap; the glyph's OUTLINE (not the
  page) rasterized and matched against 390 reference digits made the same
  way from open-licensed fonts (`js/digitTemplates.js`,
  `scripts/gen_digit_templates.mjs`); the font is corrected only where the
  shape backs its cmap on ≥ 2/3 of them. pdf.js's items are corrected font
  by font, in drawing order, only where every digit of an item is the one
  ToUnicode names — pdf.js doesn't always take digits from ToUnicode (it
  read the right "2018" on 6304362 where ToUnicode in drawing order says
  "8102"); a reversed match there would have broken it. PDF→Word,
  PDF→PowerPoint and Read.
- **Measured (44 flagged documents, real pdf.js, vs pdfree.io):** the 26
  confirmed documents all corrected (0045417 "3122" → "2011", 0247454
  "0202" → "2021", 3608860 "۱۸۸۱" → "۱۸۴۳", 5470407's contents page now
  ۱۰۱ ۱۰۳ ۱۰۶ ۱۱۷); of the 18 the page-render arbiter had called "text
  right", 15 untouched and 3 changed — each checked by hand on the page,
  each a real fix the coarser per-document label had missed (7733378 "03" →
  "30", 6304362 "8102" → "2018", 3122010 "3122" → "2011"). Fixtures:
  `c4-wrong-digits.pdf` (corrected) and `c4-font-cmap-wrong.pdf` (a font
  whose own cmap is wrong — left alone).
- **Whole corpus (289, real pdf.js, vs pdfree.io):** 30 documents' text
  changed — the 29 above and 0399787 (under the 3-digit flag, "حزيران 51 …
  آرت أون 15" → "15 … 56", as drawn); the other 253 identical. The
  Arabic metric reports these as worse (numbers missing 3,441 → 4,444, and
  0247454's recall 1.0 → 0.95, its words carrying digits): it scores
  against MuPDF and poppler, which both read the wrong digits — the blind
  spot this class was found in. Reported to the owner, not changed.
- **Not covered yet:** simple TrueType fonts (0045417's second Arial,
  4681141's B Mitra), CFF fonts, digit-order flips.
- **Part 2 measured (2026-10-22):** 0045417's dates table ("42 مارس 3122"
  for "31 مارس 2011") is drawn by a simple TrueType Arial (WinAnsi, no
  ToUnicode) whose every table — encoding, Mac and Windows cmaps — names the
  shifted digit: only the outline knows. Part 1's rule (two sources
  disagree, the shape decides between them) has nothing to start from. A
  shape-only check (each digit glyph against all ten references, page
  render) was tried as a scan: 57 documents flagged, most plainly false
  (Helvetica, Gotham, Myriad read as "every digit a 1") — not usable. Open:
  a second source from the same document — a Type0 font of the same name
  whose shift part 1 confirmed (0045417: `ABCDEE+Arial`, +1) gives the
  candidate, the page decides; a handful of documents at most. The metric
  (v5/v6) shares this blind spot: it counts the readers' "3122" as right.

## C5 — a table of contents comes out as one paragraph

- **Status:** `fixing` (2026-10-18) — confirmed, partly fixed
- **Harm:** medium — every entry and its page number run together; numbers
  survive, the list doesn't.
- **Confirmed:** 12 of the 15 documents with a contents page in the Arabic
  corpus, from Word 2010/2016/Office, Acrobat Distiller, Adobe PDF Library,
  pdfFactory (most of their entries in shared paragraphs).
- **Cause:** a contents line is long and ends without punctuation — the
  paragraph builder read it as a wrapped line of the paragraph above.
- **Fix:** a line with a dot leader and a page number at either end is a
  paragraph of its own (`isContentsEntry`, `js/textLayoutUtils.js`).
- **Measured (local, 289 documents):** entries sharing a paragraph 598 → 408
  of ~780 — 7407593 49/52 → 4/52, 7204460 37 → 2, 5494457 20 → 3, 7389718
  16 → 2, 1152703 42 → 14, 5470407 36 → 14, 0997713 30 → 13. Word metric:
  no document changed.
- **Left:** 6977632 (351/367 → 339) and 7351637 (11/23, unchanged) — their
  entries must be built otherwise (leaders as graphics or tab leaders);
  competitors not compared yet.

## C6 — columns read across each other: narrow gutters, two-page spreads

- **Status:** `fixing` — cause 1 (#43) verified on pdfree.io; cause 2
  found, one source only — searched for a second 2026-10-22, none (below)
- **Harm:** high where it happens — sentences of different columns run
  together; numbers stick to the other column's words.
- **Seen:** 4974198 (Adobe PDF Library 15, an annual report, 97 landscape
  spreads with 3–4 columns): "…أكثر من 116,539 خدمات وزارة التجارة…" joins
  two columns. 6579225 (a three-column student newsletter, Adobe PDF Library
  15): every line of its three columns read across ("…در شرایطی که بسیاری از
  انحصارطلبانه نشان میدهد. خودتان و خودتان…"); order 0.64 under metric v4.
- **Measured with:** metric v4 (#42). v3 couldn't judge this class: poppler,
  its only order reference, reads brochures and spreads across their panels
  itself.
- **Cause 1 — narrow gutters:** column detection joined two items of a line
  into one run when the gap was ≤ 12 pt; 6579225's gutters are 8.5–11 pt at
  10 pt text, so its three columns were one run and no gutter showed. Fix:
  when the usual 12 pt join finds no gutter, a second look joins at 0.6 em
  of the page's median text size (`runJoin`, `js/pdf2wordColumns.js`).
  Tried first as the only join: order better on 7, worse on 8 — newspapers
  whose midpoint columns read better (0364023 0.73 → 0.61, 2315841, 4904228,
  3079058) got other "gutters"; as a second look, worse on none.
- **Measured (289 documents vs main, metric v4):** order better on 5
  (6579225 0.64 → 0.96, 4197540 0.83 → 0.94, 5857593 0.78 → 0.87, 0865218
  0.78 → 0.83, 6866008 0.95 → 0.99), worse on 0; recall 94.83 → 94.83 %;
  3 documents lost 1–3 numbers each with order and words unchanged;
  5857593's recall 0.922 → 0.914. Ground-truth pages: 40 of 40 identical.
- **Weakness found, not fixed:** the first look (12 pt) can take the empty
  space beside paragraph-ending lines for gutters when every full line is
  one page-wide run — the full lines drop out of the profile as "wide", and
  only the short lines are left in it (a synthetic three-column page cut at
  x ≈ 217 and 384, inside its columns). Not seen on a real document yet.
- **Cause 2 — two-page spreads:** a landscape spread holds two pages of two
  columns each — four columns, over MAX_COLUMNS (3), so detection gives up
  (4974198 pages 5, 6: no regions though 92–94 % of their lines hold
  columns side by side). Only one spread document in the corpus (one
  source): needs a second source before it is a class.
- **Cause 2, second source searched (2026-10-22):** landscape pages with
  text in two halves and an empty middle band, the whole corpus: three real
  spreads (2022469 Distiller 6, a Persian book; 0519513, a magazine;
  4974198 itself) — the other two have one column a page, two in all, and
  read right (order 0.97, 0.99). Still one source: not a class yet.
- **Also seen:** 6579225's headline comes out four times — the PDF draws it
  at four heights (y 637, 613, 587, 561), three hidden (clipped, most
  likely); MuPDF and poppler both read it four times too, so the metric
  can't see it. Needs clip-path awareness; low harm, not started.
- **Layout-model experiment (2026-10-20, not shipped):** PP-DocLayoutV3's
  boxes, ordered right to left, read 4974198 0.60 → 0.95 and 6579225
  0.64 → 1.0, but lost order on simple pages (1574594 1.0 → 0.87): only
  for multi-column pages, if ever; 130 MB.

## C7 — a one-column RTL page cut into "two columns" at a midpoint

- **Status:** `fixed` — shipped in #41 (418d3ef4) and verified on pdfree.io
  2026-10-19 (6 documents, production = local: 1373210 0.74 → 0.99, 1752892
  0.70 → 1.0, 2278552 0.71 → 1.0; newspapers kept their columns). Order
  figures above are metric v3; under v4 (#42) 4442085 and 6997456 read 0.92
  and 0.93 — part of the "worse on 3" was poppler's order, not PDFree's.
- **Harm:** high, and hidden — words all there, their order scrambled: a
  justified one-column Arabic page (1373210, Acrobat Distiller 11) read
  "حينما أراد في أعقاب العالمية الحرب الأولى…" for "في أعقاب الحرب العالمية
  الأولى … وذلك حينما أراد"; a bag-of-words metric scores it 94 %.
- **Cause, three parts:**
  1. `detectColumnRegions` (`js/pdf2wordColumns.js`) — when the
     direction-aware detection finds no gutter it falls back to clustering
     the lines' LEFT edges, meaningless on right-to-left text: the short,
     right-aligned last lines of paragraphs made a second "column", cut at a
     midpoint, and every line was read column by column.
  2. The gutter search rejected real gutters crossed by more than 3 % of all
     runs (headings, captions): 4197540, a real two-column magazine page.
  3. Columns were detected twice per page — on the lines as drawn
     (`_splitCrossColumnLines`, which cuts them) and again on the cut lines
     (`processor.js`, `_rpBuildPageBlocks`), which read them. The two answers
     differed on many pages (24 of 32 on 1373210): lines cut at one x, read
     by regions at another.
- **Fix:** an RTL page with no gutter is one column unless its lines hold two
  columns side by side (≥ 25 % of lines with a gap wider than 2 em —
  newspapers 0.22–0.77, justified one-column pages 0–0.2); a valley may hold
  a tenth of the text's own cover, not only 3 % of runs; the regions found on
  the lines as drawn travel with the page (`columnRegions`) and every later
  pass uses them.
- **Measured, 289 documents** (order = the share of unique anchor words — in
  both readers once each — in the output's order; the metric of the owner's
  PR #39, not yet merged): order 87.0 → 92.0 % over 205 documents, better on
  76, worse on 3; recall unchanged (94.82 → 94.83 %); the +153 "lost numbers"
  are repeated footers now dropped as page furniture, as on other one-column
  pages (7762669: "1 وبالگ … mihanblog.com" on every page). Ground-truth pages
  (40, all languages): identical.
- **Left (worse on 3):** 4197540 (columns at different heights — its lines
  never merge, so the side-by-side test can't see them; 0.905 → 0.83),
  4442085 and 4904228 (a midpoint boundary in the wrong place, which the
  second detection used to hide). All three need the same thing: a gutter
  search that finds an RTL page's real gutter.
- **Discovery set:** 1373210, 1752892, 2278552; control: the 11 real
  two-column pages the first attempt broke (2315841, 3079058, 4904228,
  0364023, 6997456, 4197540, …).

## C8 — a right-to-left line in stream order lost its word spaces

- **Status:** `fixing` — fixed locally 2026-10-19 (found while measuring C7)
- **Cause:** word gaps became spaces only on lines `reorderVisualRtlLine`
  found drawn in visual order; a logical line with no space items — a PDF
  drawing each letter alone (macOS Quartz) — kept none:
  "الأردن–مركزالحیاة–راصد" (6199289).
- **Fix:** logical lines get spaces at gaps of a fifth of an em too — spaces
  only: the ZWNJ for a final form meeting the next letter (a Persian
  half-space) stays a visual-line rule; on logical lines it marked word
  boundaries that had lost their space ("تربیت‌و", 3201970: ZWNJ 415 → 879,
  glued +53 — measured, then dropped).
- **Measured, 289 documents:** 37 documents' recall up (1574594 90.2 →
  99.2 %, 7000003 93.7 → 100 %, 3836451 96.8 → 100 %, 6240805 91.4 → 94.2 %),
  2 down by 0.0001; glued words 4,246 → 4,128.

## C9 — words glued where the gap is narrower than a fifth of an em

- **Status:** `fixing` — part 1 (#53) and part 2 (#54) verified on
  pdfree.io 2026-10-21
- **Harm:** medium–high — two words become one, search and spell-check fail
  on both: a Persian book read "درايران", "ايراندر", "کهدر",
  "امپرياليسمبريتانيا" (7389718: 909 glued words); a Persian admissions list
  "محلخدمت", "عنوانرشته" (7351637: 477).
- **Cause:** a space was inserted between two words only where the gap was
  over 0.2 em; 7389718 sets its 13 pt words 2.5 pt apart with a 2.6 pt space
  glyph (exactly 0.2 em), so every slightly tight gap was taken for none.
- **Fix:** the threshold is 0.8 of the line's own space glyph where that is
  narrower than 0.2 em (the narrowest whitespace item of the line —
  justification stretches the others; near-zero lam-alef splits ignored);
  a line without space glyphs keeps the 0.2 em rule (`js/textLayoutUtils.js`).
- **Measured (289 documents vs main, metric v5):** glued words 4,790 →
  3,419, missing words 58,474 → 52,555, recall 94.89 → 94.99 %, split words
  12,167 → 12,072, worse on 1 (2262154, one dot error more, recall up).
  Ground-truth pages: 40 of 40 identical. Side effect, checked by hand: about
  4,170 Persian half-spaces (ZWNJ) became spaces — nearly all between two
  separate words ("نوع توليد", "محل دريافت", "خدمت خرمشهر"); a few compounds
  usually written with a half-space now carry a space ("ماشين آلات", "شاهين
  شهر") — a style difference, not a broken word.
- **Part 2 — the threshold itself:** a Persian table at 6.4 pt had its words
  0.19 em apart and no space glyph on its lines ("عنوانرشته", 7351637), so
  part 1 couldn't reach it; the word-gap threshold is 0.15 em (glyphs of one
  word sit 0–0.05 em apart), in running RTL text and in table cells.
  Measured vs part 1 (289 documents, metric v5): glued 3,420 → 2,637,
  missing words 52,602 → 49,109, recall 94.93 → 95.19 %; split words
  12,108 → 12,318, all of the rise in the set-aside 7853393 (+269; without
  it 7,907 → 7,848); worse on 5 by one dot or reversed word each. 72
  non-Arabic corpus documents (zh, ja, ko, ru, tr, vi, id, forms, random):
  text unchanged; ground-truth pages 40 of 40 identical.

## C10 — two-letter ligatures read with their letters swapped

- **Status:** `fixing` — #55 verified on pdfree.io 2026-10-21 (8
  documents, production = local; e2e)
- **Harm:** high — a misspelt word in nearly every line, which search and
  spell-check fail on: "جملس" for "مجلس", "املتحدة" for "المتحدة",
  "احلقوق" for "الحقوق", "يف" for "في" (0997713: 5,516 such words; prod
  and main alike).
- **Cause (confirmed on 1898617, glyph by glyph):** PDFs drawn in visual
  order with ToUnicode naming each glyph as its presentation form — a
  two-letter ligature as one (U+FCCE meem with jeem, U+FCCC lam with
  meem, U+FCCA lam with hah). pdf.js normalizes the ligature into its two
  letters in logical order and only then reverses the right-to-left item,
  so the pair comes out backwards: the item reads "جمﻠﺲ" (U+062C U+0645
  U+FEE0 U+FEB2). Read without that normalization the item is "ﳎﻠﺲ", whose
  NFKC is "مجلس". Lam-alef ligatures are not affected.
- **Found by:** words the output has and neither reader has, that become a
  word both readers have when two adjacent letters are swapped — 8,057 such
  words in 53 of 289 documents (main). Five independent generators among
  the worst: Acrobat Distiller 6/8/9 (1898617, 0997713, 6698709), PDFMaker 9
  (6889061), bioPDF (2563334); 2006–2017.
- **Fix (`js/pdf2readCore.js`):** a page with a right-to-left item of
  presentation forms that holds a run of 2–3 plain letters (the split
  ligature) is read a second time without normalization; right-to-left
  items take the raw string when both reads have the same items, and
  `toArabicBaseLetters` decomposes the ligature in order. Rejected first: a
  heuristic that reverses such runs back — both orders exist as ligatures
  ("مج" and "جم"), and some documents have real plain-letter runs (2022469).
- **Measured (289 documents vs main, metric v5):** recall 95.19 → 95.91 %,
  missing words 49,109 → 41,840, dot errors 977 → 308, reversed words
  1,599 → 1,566, numbers unchanged (3,565), order unchanged (94.92 %); the
  swap count 8,057 → 1,325 words in 39 documents (747 of them in the
  set-aside 7853393). Glued words 2,637 → 2,649 — checked by hand on the one
  document flagged worse (6992356, Qur'anic text): both readers split its
  words ("ر بى", "متكبر ي ن"); the output's "رىب", "متكربي" became "ربى",
  "متكبري", right letters that the metric now sees as glued. 72 non-Arabic
  corpus documents: text identical; ground-truth pages 40 of 40 identical.
- **Left:** 1,325 swap-shaped words, other causes not yet looked at —
  Urdu (2262154, 7407593: "سے" → "ےس"), Persian (0250420, 7629204), and
  0525394 ("مشروع" → "مرشوع", 16), which the fix did not reach.
- **Test:** `tests/e2e/pdf2word-arabic.e2e.mjs` — `ar-ligatures.pdf`
  (`make-ligatures.py`, Amiri): fails on main (44 % of the words), passes.

## C11 — a glyph named by several letters, read backwards with its line

- **Status:** `fixing` — #56 merged with the owner's approval and verified
  on pdfree.io 2026-10-22 (6 documents, production = local; e2e); part 2
  (coverage) below; the metric's blind spot answered by metric v6 (#57)
- **Harm:** high — a misspelt word in nearly every line, search and
  spell-check fail: "اإلسالمية" for "الإسلامية", "املحكمة" for "المحكمة",
  "خالل" for "خلال", "اطالعات" for "اطلاعات"; Urdu "ےک" for "کے", "یک" for
  "کی", "رکےن" for "کرنے" (5021957: 15 % of the words a real word).
- **Cause (confirmed glyph by glyph on 2262154, 7041235):** Word draws a
  right-to-left line glyph by glyph in visual order and names a ligature
  glyph by its letters in reading order — Urdu Nastaleeq "سے", "کی", "نو";
  Arabic and Persian lam-alef "لا", "لم", "لح". pdf.js turns the line
  around letter by letter, the glyph's letters with it: "ےس", "ال", "مل".
  MuPDF and poppler do the same, so the metric's two readers agree on the
  wrong word and an output carrying it scored as right. (Distinct from C10:
  there the glyph is a presentation-form ligature, one character, which
  pdf.js's own normalization splits.)
- **Fix (`restoreGlyphOrder`, `js/textLayoutUtils.js`):** pdf.js's operator
  list keeps each glyph's letters; the items are paired with the glyphs one
  to one (letters compared after NFKC, whitespace aside; the first item that
  does not pair stops the page), and a glyph whose letters an item holds
  reversed at the glyph's own place gets them in order. Only on pages pdf.js
  gives in reading order — a page `rtlItemsAreVisual` turns back whole has
  its glyphs turned with it — and that verdict is kept after the mend (a
  first version let the mended "ال" re-vote two Persian Word files visual:
  every word reversed, caught by the arbiter below, fixed).
- **How it is judged — not by the metric, which shares the error:** an
  independent vocabulary — the words both readers agree on in the 154
  corpus documents whose fonts name no glyph by several letters (55,052
  words; "الإسلامية" 37, "اإلسالمية" 0; "في" 2,484, "يف" 18). The share
  of output words found in it, on the other 130 documents: **68.04 →
  72.33 %** (1.2 million words), **worse on none**; up most on 6240805
  0.46 → 0.73, 3836300 0.58 → 0.78, 3096442 0.69 → 0.85, 5021957 0.15 →
  0.36. By hand: the 16 vocabulary documents the fix still changed (pdf.js
  takes some glyphs' letters from glyph names) — 15 now right, 1 a broken
  font both ways (2320914); 5 random documents of those the metric calls
  worse — all 5 now right.
- **What the metric says (v5, 289 documents vs main):** recall 95.91 →
  91.23 %, missing words 41,840 → 116,683, worse on 117 documents — its
  references are the readers' reversed words. Not a regression: a blind
  spot of the measuring stick, reported to the owner (a reader correction
  from the glyphs, as v5 did for digits, would be a metric change of its
  own). 72 non-Arabic documents: text identical; ground-truth pages 40 of
  40 identical.
- **Test:** `tests/e2e/pdf2word-arabic.e2e.mjs` — `ar-ligatures-letters.pdf`
  (`make-ligatures.py`: every glyph named by its letters, as Word does):
  fails on main ("جملس األمن"), passes; unit tests in
  `tests/textLayoutUtils.test.js`.
- **Part 2 — coverage (2026-10-22), found by metric v6 (#57):** on 8
  documents the output still had the reversed words (1373210 "املحكمة"
  ×129, 1688739 "ےک", 4487592 "تسهیالت" ×66, 0045417, 7733378 …) — the
  pairing stopped early: pdf.js splits "أ" and the reversal carries the
  hamza off ("ٔالاساس"), glyphs name LRMs and Arabic signs (U+0604) pdf.js
  drops, a contents line with dot leaders is a left-to-right item whose
  Arabic run alone is reversed, ﷺ is one character of four words. Now an
  item is mended where pdf.js's own string is reproduced exactly — the
  glyphs' letters through the bidi algorithm (`_bidiOrder`: digits and
  their separators, Arabic punctuation, neutrals, levels) give the item;
  the same with each reversed glyph's letters turned give it mended —
  compared decomposed, vowel marks and format characters aside; then the
  first rule for the items left, which catches lines this doesn't model
  (bracket mirroring, measured: modelling it turned 244 right "في" wrong
  on 5955337 — dropped, not understood). Reproduced exactly: 99.5 %+ of
  the items with a several-letter glyph on the documents checked.
  Mistakes found on the way and fixed before this shipped, each by v6 or
  the vocabulary: decomposed-only reversal broke "لأ" (68 documents
  worse); a one-letter "ئ" counted as two; vowel marks shifted a "لا" onto
  the article "ال" ("الصَّالَة"); the madda dropped ("ايات" for "الآيات").
  **Measured (289 documents vs main, metric v6):** recall 95.09 → 95.49 %,
  dots 830 → 473, reversed 1,348 → 993, glued 2,537 → 2,671 (real Urdu
  words the readers split, "ہونا", "کردیں"; checked by hand); vocabulary
  arbiter: words found 72.33 → 72.50 %, worse on none; vocabulary words
  gained 4,532, lost 745 (mostly the readers' forms that are words too:
  "یک", "ال"); losing more than gaining: 2 documents, both broken fonts
  (6864345, 6866008 — garbage both ways). 72 non-Arabic documents: text
  identical; ground-truth pages 40 of 40 identical.

## Candidates — seen, not yet confirmed as classes (2026-10-22)

Found while preparing the competitor comparison and measuring C4 part 2 /
C11 part 2. Each needs its cause confirmed on documents from independent
sources before it is a class.

- **Page headers dropped, not moved.** PDF→Word removes text repeated on
  every page as page furniture and puts it nowhere — 2563334's document
  symbol "NPT/CONF.2020/PC.I/WP.19" is not in the .docx at all, not even in
  a Word header. The metric's lost numbers are mostly this ("furniture"
  2,008 of 3,565). Harm: document numbers, dates, UN symbols lost.
- **A font naming letters wrongly, both readers agreeing.** 0045417's
  Arabic font names "ي" as the tanween "ٌ" ("متغٌر", "فبراٌر"); 1373210's
  names letters U+0604/U+0605 and Arabic Extended forms ("ࢭــي" for
  "في"). The letter-level twin of C4; the metric can't see it.
- **Persian ی / ھ in Arabic text** (6199289, macOS Quartz: "أیار",
  "ھذا") — the PDF itself names them so; Arabic search fails on them.
  **Closed — not a conversion defect (owner, 2026-10-23).** Measured
  2026-10-22: the source PDFs' own text layer holds these letters (6199289:
  ی 121, ھ 19 in the PDF and in our .docx alike), so the .docx reproduces
  what the author typed. An offline experiment replaced them with ي / ه on
  Arabic lines of documents detected as Arabic (25 documents; Persian and
  Urdu controls untouched): an Arabic-vocabulary share rose 99.79 → 99.89 %,
  but metric v6 fell 91.73 → 84.29 % recall, 20 documents worse, none better
  — it edits the author's text. Faithful conversion and normalising letters
  for search are different features; no automatic replacement ships, and a
  normalising option waits for proven demand for Arabic search.

## C12 — Urdu Nastaleeq words run together

- **Status:** `fixing` (2026-10-22) — fix in a pull request
- **Harm:** high for Urdu — whole lines as one word: "اسٹیٹبینکنےپاکستانیمعیشتکیکیفیت"
  (0247454), "مولاناصدرالدیناصلاحیصاحعلمیدنیامیں" (7407593). Found in the
  competitor comparison (2026-10-22): converter D kept these words apart,
  though it cut others into pieces ("ا گرچہ").
- **Cause (confirmed on 7407593, 5021957, 0247454):** Word sets Urdu
  Nastaleeq glyph by glyph, each a text operator of its own, and its word
  spaces are space glyphs pdf.js drops when the next glyph is drawn over
  them. The same fonts name joining pieces and dots " " too — zero wide
  (codes 460–471, 1649–1654), lifted off the line, or with the next glyph
  put down at the very same point ("وزیر اعظم": 0 inside each word, 0.6pt
  between them). MuPDF and poppler make a space of every one of these and
  cut words apart ("پ ا اتسکن"); pdf.js of none.
- **Fix:** `_glyphRuns` (`js/pdf2readCore.js`) gives restoreGlyphOrder the
  word spaces only (`.words`: a space glyph with a width, on the line, the
  text moving on after it; a space glyph its font names otherwise, "۽", as
  named); `restoreGlyphOrder` puts back a dropped space between two glyphs
  drawn one after the other, on items whose bidi it reproduces exactly — into
  pdf.js's own string when only spaces are missing. Not on a page that
  would come apart into letters (1902417, Word 2013 Arabic: "و ق ال ش ي خ"
  — kept as it was), nor on a font that names its space "۽" (2262154).
  restoreDroppedSpaces keeps reading every space glyph (3540977: a zero
  wide space glyph that is a real word space there).
- **Mistakes caught before shipping:** every space glyph taken (in-word
  pieces split "ن اشر"); "۽" fonts (+444 stray letters on 2262154);
  Word 2013 Arabic split into letters (1902417); spaces between items lost
  when the item was rebuilt decomposed (3540977).
- **Measured (289 documents vs main, metric v6):** recall 95.49 → 95.88 %,
  missing words 50,545 → 43,553; 31 documents changed, worse on none by
  metric v6 or the vocabulary; 7407593 recall 0.28 → 0.91, 5021957 0.29 →
  0.47, 0979902 0.81 → 0.84; Urdu vocabulary share 0247454 0.34 → 0.57,
  0979902 0.27 → 0.67, 7407593 0.21 → 0.51. Glued 2,671 → 3,025, all of the
  rise on 7407593 and 5021957: runs of many words that became pairs
  ("نہیںہے", "گیاہے" — glue left), and words the readers cut ("ہونا",
  "ہوگی"). 72 non-Arabic documents: text identical; ground-truth pages 40
  of 40 identical.
- **Left:** two-word glue on those pages; letters some of these fonts name
  wrongly ("دزخواست" for "درخواست", 5021957 — all readers alike).

## C13 — CJK text in fonts named through Adobe's CMaps: missing, or not drawn

First class of the Chinese PDF→Word stage (2026-10-23). Corpus: the cloud
sample's Chinese stratum (128 fetched) as discovery, and a control pool of
323 Chinese-language documents picked by producer and known pains (Quartz,
Founder, WPS, InDesign, LaTeX, scanners, web print, unmapped Unicode) —
never looked at while fixing. Metric: a draft Chinese metric (Han both
readers agree on, bigrams, numbers, order; not a measuring stick yet).

- **Cause.** No pdf.js `getDocument()` on the site passed `cMapUrl`, and no
  CMap files were served. A CJK font a PDF names without embedding it
  (UniGB-UCS2-H, UniCNS-UTF16-H, 90ms-RKSJ-H — TCPDF, Acrobat PDFWriter,
  reportlab) or one in an Adobe character collection without ToUnicode
  (Adobe-CNS1, -GB1, -Japan1: Hong Kong filings, macOS Quartz in Japanese,
  xdvipdfmx) gave pdf.js no text, and drew nothing — PDF→JPG, thumbnails,
  Organize, Draw showed the Latin lines only. Known since a 2026-08 note
  in `scripts/gen_benchmark_corpus.py`, left then as out of scope.
- **Frequency.** 8 of 128 sample documents, 17 of 323 pool documents, from
  independent producers (Apogee, TCPDF, PDFWriter, Bullzip, Distiller,
  Quartz, xdvipdfmx, InDesign, iText).
- **Fix.** Adobe's CMaps from pdfjs-dist 3.11.174 served from pdfree.io
  (`js/vendor/pdfjs-cmaps/`, not a CDN: jsdelivr is unreliable from mainland
  China), and the one pdf.js loader (`js/pdf2jpgUI.js`) gives every
  `getDocument()` the `cMapUrl`. Fixture `cjk-cmaps.pdf`
  (`make-cjk-cmaps.py`): simplified, traditional, Japanese and Korean.
- **Result, PDF→Word.** Discovery: recall 94.72 → 98.10 % (Japanese 91.4 →
  97.6), numbers lost 7,145 → 322; 0 worse, 4 mixed (recall up, plus spaces
  or OCR'd pages), 4 better. Control: Chinese recall 85.13 → 98.95 %,
  Japanese 98.95 → 99.60; 17 better, 11 mixed (recall up in all but one,
  3344057: bigrams up), 1 worse by the metric (1744868: a scan, OCR noise,
  its .docx otherwise identical). Same build twice: 0 changes of 128.
- **Left.** Letter-spaced Han in table cells ("董 事 名 單", 0738745: bigrams
  0.20); fake bold drawn four times over ("壬壬壬壬", one producer so far);
  3658566 (Ghostscript 8.50) still an empty .docx.

## C14 — text drawn over itself (fake bold) read two to four times

Chinese PDF→Word stage, 2026-10-24. Printer drivers fake bold by drawing a
line two to four times a fraction of a point apart, or fill it and then
stroke it. pdf.js gives every copy; the .docx read "壬壬壬壬", "北原北原北原北原
泰輔プロ泰輔プロ", "透透過學校過過學校".

- **Frequency.** 14 of 368 Chinese corpus documents read without OCR,
  30–790 extra Han each, from independent producers: EXP Systems, Distiller 9,
  Ghostscript 8.15 / 8.50 / 8.70 / 9.04 / 9.07, Quartz. Two shapes: copies
  as identical items at one point, and copies cut into different items
  ("備註" over "備" + "註").
- **Fix.** `dropOverprintedText` (js/textLayoutUtils.js), after the steps
  that match items to the page's glyphs: a copy is the same glyph, the same
  size within 2 % and direction, at the same point within 0.15 of its size;
  items of CJK glyphs and full-width marks only are compared glyph by glyph
  and keep the pieces no earlier item drew, other items only when they repeat
  one whole. Unit tests: two of the same character in a row, the same text in
  two cells, a vertical column, kerned glyphs, a shadow 10 % larger, a stamp
  turned, Arabic — all kept. Fixture `overprint.pdf` (`make-overprint.py`).
- **Result.** Discovery (17): 14 without a duplicate left, recall unchanged
  everywhere. Chinese sample (128): 5 better, none worse — the one the metric
  flagged (4734358) has its repeated title in the Word header now (#62),
  which the draft metric doesn't read. Control pool (323): 11 better; of 3
  flagged, one was real and is fixed (0988799: a title's shadow 10 % larger,
  half matched — hence the 2 % size rule), one a metric artifact (4078202:
  the old output's "別別科科" held the bigram), one a runner refusal that
  converted on rerun. Arabic corpus (289, main vs fix, same machine): 0
  worse; Latin sample (72): 67 identical, 5 lost a duplicate drawn at the
  same point ("Частная лавочкаЧастная лавочка", "참고참고").
- **Left.** Copies cut together with spaces, digits or Latin ("（ 星期三）",
  "2 0 11 年"): positions inside such items can't be told from their width
  — 2208776, 5569194 keep part of their duplicates.

## C15 — letter-spaced Chinese and Japanese read with a space between every glyph

Chinese PDF→Word stage (P2a), 2026-10-25. A title, a table header or a name
spread to a cell's width is drawn a glyph at a time with even gaps; pdf.js
puts a space in each gap, and the .docx read "董 事 名 單", "氏 名 所 属",
"山 口 那 智".

- **Frequency.** 98 of 451 Chinese and Japanese corpus documents, from
  independent producers (Crystal Reports, Excel, iText, Bullzip, Ghostscript,
  Distiller, Quartz).
- **Fix.** `markLetterSpacing` (js/textLayoutUtils.js): neighbours on a line,
  each a single Han or kana glyph under 2 em apart, form a chain; its spacing
  is the narrowest gap (at least 0.1 em — touching glyphs are plain text), and
  gaps within 0.2 em of it are spacing; a chain needs two such gaps, or
  another chain on the line with the same spacing. Wider gaps stay spaces — a
  Japanese name's family–given gap is a whole em wider ("青山 桃子"). The
  items are only **marked**; text is assembled from the marks (`spacedText`:
  the .docx paragraphs, list items, table cells, `joinSpacedItems`). Run 1
  deleted pdf.js's space items instead: table detection reads those gaps and
  built other tables in 17 documents (0 tables → 4, 84 cells from none) —
  rejected, fixed, re-run. Unit tests (geometry untouched, names as words
  keep their space, full-width digits, 3 em cells, Korean, a typed space);
  e2e fixture `letter-spacing.pdf` (`make-letter-spacing.py`).
- **Result (run 2; criteria fixed before run 1, `scratchpad` CRITERIA_P2a.md).**
  Chinese/Japanese (451, the set the rule was tuned on — evidence of effect,
  not generality): 2,884 spaces closed in 98 documents; structure (tables,
  cells, paragraphs) identical in 448/448; header/footer and paragraph count
  unchanged; 0 spaces added; draft metric 0 worse, 0 mixed, 54 better; order
  and numbers worse in none; time the same. Hand check of a seeded sample of
  100 closed gaps: 92 right, 2 wrong, 6 in source text already garbled; no
  name with a wider family–given gap glued. Arabic control (60): byte-identical.
  English control (25): 23 byte-identical, 2 (Japanese and Chinese Wikipedia
  PDFs) only lost spaces.
- **Left.** Evenly spaced one-glyph table columns can't be told from
  spacing: a calendar header "日 月 火 水 木 金 土" reads "日月火水木金土"
  (4196938, both wrong cases). Names spread with even gaps lose their
  family–given space ("島野博幸") — the source draws none. Proof of
  generality waits for the holdout set.

## C16 — short lines stacked without a gap read as one paragraph

Structure stage (S1), 2026-10-27. A paragraph break needed an indent or a gap
over 1.25× the line pitch, so single-spaced lines that stop short — a list
without markers, form fields ("Last Name: ___ First Name: ___"), a contact
list, a poem, an exam's options line and the next question
("…物件導向資料庫第33題至第38題…") — ran together into one paragraph.

- **Found by** the draft structure metric (tagged-PDF ground truth,
  `scripts/quality/structure_draft/`, branch wip/structure-metric):
  paragraphs merged in 15 of 25 trusted tagged documents; a hand check of 8
  random merges: 7 real.
- **Fix.** `startsAfterHardBreak` (js/textLayoutUtils.js): a line that starts
  at the start margin (or a paragraph indent) in a column ≥ 10 em ends a
  paragraph when the room left before the column's edge exceeds the next
  line's first word + 2 em — the word would have fitted, so wrapping didn't
  end the line. The edge: each line's **local** edge (`localLineEdges`: the
  farthest end two body lines within four of it share, ±2 pt), else the
  column's common end margin, else the farthest end two body lines share
  (`bodyFar`) — never a single line: pdf.js joined a UN document's
  "联合国" with its number at the top right into one line ending at 555 pt
  against a body ending at 489, and a Chinese article beside a picture came
  apart line by line before the local edge. Also: a line repeated on ⅔ of the
  pages is dropped as a header, footer or stamp only if it sits at the same
  height (±3 %) on them — a repeated name set apart by the new breaks
  ("彼得·维蒂希(德国)") was otherwise deleted wherever it stood.
- **Result** (criteria written before the runs; base = main dd07a125; dev sets):
  text metrics 0 worse (zh 128, en 60, ar 60; `--exact` too for zh/en);
  better: an English document recall 0.969 → 1.000 (repeated lines no longer
  deleted), Han spaces down in 2; Arabic missing words +6 = a page footer that
  had leaked into the body twice, now removed like its 21 other copies.
  Structure (25 trusted tagged documents): merged paragraphs 41.4 → 33.8 %,
  split 3.0 → 3.1 %, STEDS 0.432 → 0.454. Hand check of 20 random new breaks
  (seed 20261028): 19 right — news paragraphs, footnotes, glossary entries,
  bullet and numbered items, code lines, table rows, bibliography — 1 wrong.
  Time ±1 % (Arabic +5.6 %). e2e pdf2word-arabic/forms/ocr/visuals pass.
- **Left.** 6639660 still splits some wrapped prose lines (one wrong break in
  the hand check: "…博士領" ‖ "銜…"). Merged paragraphs remain at 33.8 %:
  stacks whose lines run close to the edge, and lines the rule can't see
  (no common edge). Proof of generality: the holdout run.

## C17 — numbered section headings only a little larger than the text read as body text

Structure stage (S2), 2026-10-28. A heading needed a font ≥ 1.3× the body
size or a fully bold line. Reports and standards set their numbered section
headings at 1.1–1.3× and not bold: a statistics office's Word report
("5.7.3.2.1.1 Calculating trade and transport margins") had 0 of 36 found, a
standard's blue "3.1.1 Minimum standards for Project Proponents" 0 of 26
(pdf.js gives no colour; the number and the size are what's left).

- **Found by** the draft structure metric (tagged-PDF ground truth,
  `scripts/quality/structure_draft/`, branch wip/structure-metric): headings
  the tags hold that we wrote as paragraphs, grouped by how they look.
- **Fix.** `isNumberedSectionLine` (js/textLayoutUtils.js): a multi-level
  number ("1.2", "3.1.1", up to 7 levels) opening a line ≤ 120 characters at
  ≥ 1.1× the body size, the title not starting lower-case ("3.14 is the
  value…" is a sentence), not ending like a sentence or a form field (".", ",",
  ";", ":"), not a contents line. `numberedSectionHeads` takes them per page
  only alone or in twos: three or more in a row are a form's numbered fields,
  over a quarter of the page's lines is a form, and a page with two contents
  lines is a contents page (an entry too long for one line ends its first
  line without the dot leader). Such a line alone in its paragraph becomes
  Heading 3.
- **Result** (criteria written before the runs; base = main; dev sets + 200
  reserve documents): text metrics 0 worse, 0 better, exact (zh 128, en 60,
  ar 60, reserve zh/ja 80); conversion outcomes identical; time +1…5 %.
  Structure (tagged documents): headings found 646 → 696 of 906 (71.3 →
  76.8 %); paragraphs, merges, splits, list items, cells and STEDS unchanged.
  Hand checks of 20 random new headings: version 1 10/20 (a ship's
  certificate's fields), version 2 12/20 (wrapped contents entries, seed
  20261028), version 3 18/20 on a fresh seed (20261029) — the 2 wrong are a
  certificate field and a table row. e2e pdf2word-arabic/forms/ocr/visuals
  pass.
- **Left.** New headings land in few documents (94 in 7 of ~450): the class
  is narrow. Wrong ones left: certificate fields not in a run of three
  (7111155, 6 lines), numeric table rows with a letter in them (5754431,
  4581812). Colour-only headings (0 of 6) need colour from pdf.js. Proof of
  generality: the holdout run.

## C18 — Word's Symbol / Wingdings bullets kept as private-use characters, not lists

Structure stage (S3, lists), 2026-10-28. Word draws a bullet with the Symbol
font's U+F0B7 (Wingdings U+F0A7 ▪, U+F0D8 ➢, U+F0FC ✓, U+F06E ■, U+F076 ❖,
U+F0E0, U+F071; Symbol U+F0A8); the PDF keeps the private-use code point.
BULLET_RE knew only "•◦▪‣●○", so such a line became a paragraph opening with a
character Word shows as a box — or ran on into its neighbours.

- **Found by** the round-trip structure check (a real DOCX's styles as truth:
  `scripts/quality/structure_draft/roundtrip/`, branch wip/structure-metric):
  list items written as Word lists 27–28 % on both PDF generators; before
  U+F0B7 in 296 of ~376 items left as plain paragraphs. **Confirmed** on real
  PDFs from independent sources: 19 documents in the dev and reserve corpora
  (Word 2007/2010/2013/2016, Acrobat, Distiller, PowerPoint, Skia) — our DOCX
  kept the character as text (e.g. 44 such paragraphs in one).
- **Fix.** BULLET_RE (js/textLayoutUtils.js; PDF→Word and the reading view)
  takes the symbol fonts' bullets, and a bullet must be followed by text: a
  line of bullet glyphs alone ("❖ ❖ ❖" between sections) is an ornament — it
  became an empty list item (first hand check). A list item's pieces are now
  joined with the paragraph's own gap rule (`_gapIsSpace`, shared): joined
  bare they read "Distribution CentersLEED-Certified…" where an item met a
  caption beside it (7759542, Latin metric "worse" before this).
- **Result** (criteria written before the runs; base = main; dev sets,
  reserve 200, round-trip pilot 50): tagged documents: list items 408 → 948 of
  1,258; paragraphs 5,054 → 5,017 — all 37 checked: lines the PDF itself opens
  with a symbol bullet that the tags call P ("❑ Penicillin ❑ Tetracycline…",
  "➢ Crop production"); headings, cells, merges, splits unchanged; STEDS 0.342 →
  0.343. Round trip: items 28.0 → 82.8 % (LibreOffice PDFs), 27.0 → 34.8 %
  (Chromium PDFs: its HTML bullets are mostly "•" already); STEDS 0.341 →
  0.353 / 0.315 → 0.318. Text metrics (exact): Latin dev 2 better, 2 mixed
  (±1 extra word); reserve other-language 2 better, Arabic 0 worse; Chinese
  and Japanese 2 "worse" by Han spaces, both looked at: 0379139 is unreadable
  font junk (recall 0.02), and in 1376256 a list item spans two table cells —
  main glued them ("原子力災害対策本部気象庁気象研究所"), now a space parts them.
  Hand checks of 20 random new list items: 18/20 (two ornament lines), then
  20/20 on a fresh seed (20261031) — two of them are form check-boxes
  (Wingdings ❑/◻) now list items. Time ±3 %. e2e pdf2word 12/2/4/7 pass;
  pdf2md corpus gate 0 FAIL.
- **Left.** A check-box (❑, ◻) becomes a bullet: the empty box is lost.
  A list item set beside a caption or a table cell still takes their text
  (columns read as one line). Lettered sub-bullets in Courier "o" are not
  recognised.

## C19 — a line repeated on every page deleted from the body wherever it stood

Chinese/Japanese stage, 2026-10-29. A line of up to 60 characters that stands
at the same height on at least two thirds of the pages (min 3) is page
furniture (`_repeatTextSet`). PDF→Word deleted such a line from the body
wherever it stood, but put only a page's top three / bottom three lines into
the Word header and footer — a repeated line in the middle of the page was in
no part of the .docx.

- **Found by** the Chinese dev set (128, main output): 4223578, a ski
  competition's results (10 pages) — the table's heading rows
  (順位 Bib 選手名 学年 得点 順位, the event groups) gone on every page: the
  numbers stayed, what they mean did not (recall 0.79 by the metric).
  **Confirmed** on the real .docx of the dev sets (lines repeated on ≥ ⅔ of
  pages and absent from body, header and footer, checked by words): zh 3/125,
  en 1/57, ar ≈ 0 (the rest were furniture: a site's stamp, "Page:").
- **Fix.** `_p2wEdgeLines` (js/processor.js) — a page's top three lines in its
  upper half, bottom three in its lower half — is shared by `_p2wRunningLines`
  (what goes into the header/footer) and the body: a repeated line leaves the
  body only when it stands there, so only for the header or footer. A
  scanner's stamp (CamScanner) leaves it wherever it is, as before.
- **Result** (criteria written before the run, `/tmp/claude-501/repq`; base =
  main a8e901cc; docs with ≥ 3 pages only — fewer pages have no repeat set;
  dev zh 31, en 48, ar 39, control zh/ja pool 116; 224 converted by both):
  nothing removed from any body (multiset), body order unchanged, header and
  footer XML identical, tables and every cell's text identical, time ±2 %.
  Text gained in 5 docs, all looked at on the page: 4223578 heading rows;
  5446413 a bracket's score labels; 0852727 "Product Name: …" in section 1 of
  a safety data sheet; 5997414 a scanned audit report's sub-header (the
  company name, under each page's letterhead); 7111155 a law's running "Act"
  on 6 of 212 pages where other lines stand above it (noise, one doc).
  Chinese metric (exact): dev 0 worse, 2 mixed (4223578 recall 0.79 → 0.98,
  its restored headings' real word spaces count as Han spaces; 5446413
  numbers 0.90 → 1.00); pool **1 worse by the letter**: 5997414 extra
  2805 → 2849 — the 4 restored lines on its scanned pages, which the readers
  can't see (no text layer), so the metric counts OCR text as extra. The
  pre-registered criterion "0 worse" is not met by this one document; told
  the owner rather than changing the criterion.
- **Left.** A running line that carries the page number on its own baseline
  ("PERIOD ENDING 4/30/17 … PAGE 7"; a title beside "1/3") is not the same
  string on each page, so it is no header — and the page-number filter drops
  it from the body: in no part of the .docx (7406078 en, 5187789 ja title).
  Measured, not fixed (next candidate).
## C20 — traditional Chinese scans read with the simplified model

Chinese stage, 2026-10-29 — the first OCR measure with truth. Detection only
ever picked `chi_sim` for Chinese: a traditional page (Hong Kong, Taiwan) came
out in simplified characters — the document's own script changed
(傳媒集團 → 传媒集团) — and with half its Han wrong. The `chi_tra` model was
vendored and never used.

- **Found by** a synthetic-scan benchmark (`/tmp/claude-501/zhocr`, criteria
  written before results): 30 dev text documents (21 zh, 9 ja), their first
  two pages made into image-only PDFs, clean (300 DPI) and rough (150 DPI
  JPEG), truth = the source page's text; run as a Chinese user
  (/zh/pdf-zhuan-word/, browser zh-CN). Main: zh Han recall 0.50, bigrams
  0.31; the output's script wrong on 16 of 21. 17 of the 21 were traditional.
  Also measured and **kept**: PSM 11 for CJK (PSM 6: 0.46, PSM 3: 0.45);
  the per-glyph confidence gate (without it 0.58 but twice the junk).
- **Fix.** `_judgeImage` (js/ocrEngine.js): when Chinese wins, `chi_sim` and
  `chi_tra` each read the sample page alone; `chi_tra` takes it when its mean
  confidence over Han words is 3 or more above `chi_sim`'s (traditional
  pages +3..+21, simplified −13..+2 on the dev set). "More confident Han
  words" was tried first and failed: `chi_tra` reads simplified pages with
  confidence too — all three simplified dev documents turned traditional.
  `chi_tra+eng` like `chi_sim+eng` when a fifth of the words are Latin.
- **Result.** The rule was chosen on the dev set, so it was validated on an
  **independent** set: 20 zh documents of the control pool (seed 20261030;
  15 traditional, 5 simplified), criteria written before the run:
  script right 6 → 17 of 20 (every simplified one still right; the 3 left are
  traditional read as simplified, as before); Han recall 0.55 → 0.74 clean,
  0.47 → 0.65 rough; bigrams 0.38 → 0.64 / 0.29 → 0.51; extra 0.14 → 0.03;
  no document's recall down more than 0.05 (0 on the dev and pool sets,
  clean and rough). **Two criteria missed by the letter:** script right on
  ≥ 90 % (got 85 %), median time within +20 % (+21 % clean, +15 % rough:
  two more models read the sample page, ~5 s). Dev set: recall 0.50 → 0.73,
  bigrams 0.31 → 0.60. Real scans of the pool (24, almost all Japanese): 22
  byte-identical, 2 changed — both Taiwanese (a menu, a poster), now read
  with chi_tra, one clearly better, neither worse. Owner decides.
- **Left.** Japanese scans: recall 0.43 on clean synthetic scans — the next
  thing to measure. Flyers and posters (text on graphics) read mostly as
  junk. The OCR stays far below a text layer: 0.74 is not good, only better.
