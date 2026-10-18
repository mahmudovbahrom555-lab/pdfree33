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

## C1 — scanned pages with /Rotate are never OCRed → an empty or picture-only DOCX

- **Status:** `found` (2026-10-18)
- **Harm:** high — the user gets an empty Word file, nothing tells them why.
- **Cause:** `createOcrLayer().ocrPage` in `js/pdf2wordOcr.js` returns null for
  any page with `/Rotate` ≠ 0 ("left as they are for now"). On a scan whose
  only text layer is a site watermark, the watermark is then dropped as a
  running header and nothing is left.
- **Discovery set:** 1161722, 2026350, 2815708, 2952792, 3812118, 4145235,
  4820963, 5615468 (ur stratum) — every page rotated, output empty; the same
  site's unrotated scans (0261098, 4111221) are OCRed and give text. **All
  eight are one source** (an exam-papers site, iLovePDF-made): the class is
  not confirmed until independent rotated scans show it.
- **Next:** find rotated scans from other sources in the whole sample (all
  strata, not only Arabic); control set from them; competitors on 2–5.
- **Measurement note:** the Arabic metric scores these documents against the
  watermark only ("short", recall 0) — it sees that output is missing, not
  how much content was lost.

## C2 — OCR language detection costs most of a short scan's time

- **Status:** `found` (2026-10-18), measured
- **Harm:** medium — slow, and in CI a timeout; the result is right.
- **Cause:** `detectOcrLanguage` probes script models one by one (a new
  Tesseract worker and model each) until one clearly wins. 3508224 (2 pages):
  74.6 s of 125 s detecting (ara+eng, heb+eng, kor+eng, rus+eng, chi_sim+eng,
  jpn+eng, ara, fas → ara), 28 + 16 s reading the pages. Its text layer
  (thin text over a scan) is Arabic and is not used as a hint.
- **Next:** profile the other slow documents the same way; a prototype that
  takes the text layer's script as a *hint* (probed first, not obeyed), on
  an experimental build only; compare on the 289 documents — detection time,
  total time, text, numbers, mixed-language and watermark scans. Kept only if
  better without regressions.

## C3 — numbers in RTL lines (known debt)

- **Status:** `fixing` — partly fixed (aca5c4af and earlier); the rules are
  written down as debt in `js/textLayoutUtils.js` (`joinSplitNumbers`).
- **Measured and rolled back (2026-10-18):** refusing ActualText with digits
  the glyphs don't show lost 96 numbers and added 99 dot errors on two Adobe
  documents, fixing none.
- **Left:** 2,421 lost numbers with no named cause in the 289-document run
  (811 of them in 4 documents with broken font encodings).
