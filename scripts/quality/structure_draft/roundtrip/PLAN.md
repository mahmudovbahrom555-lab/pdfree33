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

## Log
- 2026-10-28 08:05 — G1 round 1 (seed `pdfree-roundtrip-g1`, 10 of the 50): **7/10, FAILED**.
  Wrong truth: 081429 (contents lines and title-page lines in "Heading 1"),
  081188 (some of a list's items in heading styles, looking like the rest),
  081861 (minutes: look-alike numbered entries, some heading-styled, some
  list items). Cause in all three: a heading style on text that does not look
  like a heading on the page. Change: a styled heading counts only when it
  looks different from the body text (size, bold, italic, underline, caps or
  colour); otherwise it is left out of the judged blocks ("unseen"). A
  heading-styled line with a dot leader is a contents line. Round 2 draws 10
  NEW documents (seed `pdfree-roundtrip-g1-r2`, the 10 above excluded).
  Also (081429 kept 377 "visible" headings: a metadata appendix set in
  "Heading 1" in another font): a document with more visible styled headings
  than body paragraphs is left out — its heading styles are formatting.
  "≥ 3 styled headings" now counts visible ones only. The pilot set is
  redrawn with these rules, same seed and order.
- 2026-10-28 08:25 — G1 round 2 (10 new documents): **9/10, passes**. Wrong:
  245673 (its section headings "2.0 / 2.1" are a numbered list, not heading
  styles — the truth calls them items). Small noise in 4 others, judged as in
  round 1 (not counted): a table footnote in "Heading 6" (245668), a running
  header in a heading style (499458), cover-page lines (298149), one heading
  "unseen" while its twin is seen (298351). Truth is right at the document
  level, not every line.
- 2026-10-28 09:10 — G2 **passes**: truth vs itself 50/50 exact; breaks caught
  merge 17/19, split 18/22, demote 22/23, unlist 3/3, untable 20/20.
- G3 first run: cells 0/6819 — a bug in the tagged-PDF draft's reader,
  tags.py: a bare "TD:" line (no "(block)") was read as the tag "TD:", so
  its cells were lost and their paragraphs counted as body paragraphs. 19 of
  301 tagged dev/reserve documents have bare TD/TH (4,279 cells). Fixed in
  tags.py (reported to the owner; the C16/S2 tagged numbers are re-measured).
  G3 after the fix **passes**: para 99.1 %, heading 96.5 %, item 97.5 %,
  cell 100 %. Caveat: LibreOffice writes its tags from the same styles, so G3
  shows our two readers agree, not that the truth is right (that is G1).
- G4: C16 agrees on both generators — merged paragraphs A 32.4 → 21.9 %,
  B 27.1 → 16.7 %; split A 7.2 → 7.8, B 14.3 → 15.2 (as on tagged PDFs);
  STEDS A 0.341 → 0.366, B 0.315 → 0.340. S2: not testable here — 12
  numbered styled headings, main finds all 12; S2 changes nothing (no false
  headings either).
- G5: C16 seen on both generators.
- **Verdict: the method passes (G1 after one rule change, on fresh
  documents).** Scale up to a larger govdocs1 draw. New class candidate seen
  on both generators: list items found as Word lists 27-28 % (numbered items
  written as text with their number, short items merged, items out of order).
