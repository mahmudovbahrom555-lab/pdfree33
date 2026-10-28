# DOCX → PDF → our DOCX: structure truth from the author's styles (pilot)

Pre-registered 2026-10-28 07:10 (+05), before any result was seen.

## What
A real Word document's styles say what each paragraph is: Heading N (or an
outline level), a numbered/bulleted list item and its level, a table cell.
Export it to PDF, convert the PDF with our PDF→Word, and compare our DOCX's
structure with the original's — the same blocks, alignment, counts and STEDS
as the tagged-PDF draft (compare.py, steds.py), truth read by docx_truth.py.

## Pilot set (50 documents)
- Source: govdocs1 (Digital Corpora, ~1M files from US .gov sites, 2009),
  zips drawn at random with seed `pdfree-roundtrip-2026-10-28`, their
  .doc/.docx members. Documents are fetched at run time, never committed.
- Kept: LibreOffice opens it; ≤ 40 pages; ≥ 3 paragraphs with a heading
  style; styled headings ≥ "lookalike" headings (short all-bold Normal
  paragraphs — authors who fake headings make the truth incomplete). First 50
  in the seeded order.
- Two generators, reported separately:
  A. LibreOffice DOCX → PDF (tagged).
  B. LibreOffice DOCX → HTML, printed to PDF by Chromium (a second layout engine).

## The method is good enough to scale up (no owner needed) if all hold
- G1 truth is right: hand check of 10 documents (seeded): the truth's
  headings and lists match what the page shows on ≥ 9 of 10.
- G2 metric sanity: the source DOCX scored against itself gives 100 % /
  STEDS 1.0; deliberate breaks of our output (merge, demote, unlist, untable)
  are caught on ≥ 80 % of the documents where they apply.
- G3 two readers agree: on generator A, the PDF's tags (tags.py) and the
  DOCX styles agree on heading/para/item for ≥ 90 % of aligned blocks; where
  they don't, a hand look says which one is wrong.
- G4 agrees with independent evidence: C16 (fix/s1-short-lines-apart)
  lowers paraMerged here too, as on tagged PDFs; S2 raises heading recall
  where numbered headings exist. Disagreement → find out why before trusting.
- G5 a class counts only when seen on both generators.

## Risks, said up front
1. One source: govdocs1 is US government English from 2009, almost all .doc
   (Word 97–2003) — no Chinese or Arabic (the Common Crawl index returned
   502/504 on 2026-10-28; retry it for zh/ar .docx later).
2. LibreOffice is in the chain twice (reads the .doc, writes A's PDF) — its
   import shapes the truth and its export the layout. B changes the layout
   engine, not the import.
3. Authors fake headings (bold Normal) — filtered by the lookalike rule, and
   counted.
3b. (seen 2026-10-28 07:25 on the first 3 files, before any score) the reverse:
   a heading style put on text for its look (081041: an address in
   "Heading 1"). No rule finds it; the G1 hand check counts it.
4. Born-digital, Word-like documents only: says nothing about scans, slides,
   InDesign/LaTeX or vertical text. Tagged PDFs and the holdout stay the judge.
5. A development set only; never the release judge.
