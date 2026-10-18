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
4. **Compare with competitors** on 2–5 of its documents (iLovePDF, Smallpdf;
   Adobe Acrobat where a licence is at hand) through their ordinary web UI,
   by hand — never automated, never a user's document, only the public corpus
   documents. Same criteria for all: text, numbers, reading order, structure,
   a usable DOCX, time. Record the findings here as text; no competitor output
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

- **Status:** `fixing` (2026-10-18; confirmed, compared)
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
    **Smallpdf** recall 90.5 %, numbers 99.4 % (1 lost), 319 split words,
    41 dot errors, 24 glued; keeps presentation forms (59,860 of its
    letters — reads right, but Word's search and spell-check see other
    letters) and 2,313 unmapped glyphs (boxes); pages landscape.
    **PDFree** 0 % — 62 page pictures, 17 MB for a 473 KB PDF.
  - 4820963 (scan): **iLovePDF Basic** — the page pictures plus the
    watermark text only, no OCR (paid); **PDFree** — the pictures, nothing
    else. A tie at zero.
  - **The bar for the fix:** on 2022469 at least Smallpdf's recall and
    numbers, in plain letters; on 4820963 the exam's text — which neither
    free competitor gives.
- **Status after comparison:** `compared` → `fixing`.
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
