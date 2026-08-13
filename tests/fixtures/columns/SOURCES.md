# Real multi-column PDF corpus — provenance

Real, license-verified documents used to measure PDF→Word's column-reading-order accuracy
against actual multi-column layouts (not just synthetic LibreOffice-exported ones — see
`scripts/pdf2word_capability_map.mjs` and the "column-aware reading order" plan).

Every file here is an arXiv preprint explicitly licensed **CC BY 4.0** by its authors — verified
individually via the "view license" link on each paper's own arXiv abstract page before download,
not assumed from arXiv's default (arXiv's default license, "arXiv non-exclusive distribution
license", does **not** grant redistribution rights — only papers where the author opted into a
Creative Commons license were considered).

Column layout was independently verified (not assumed from the arXiv category) by clustering each
line's leftmost text-item X-coordinate on a sample page — a genuine 2-column layout shows two
distinct, well-separated clusters; a single-column layout shows one. Several other CC BY/CC0
candidates checked this way turned out to be single-column despite being cs.CL papers (arXiv
preprints don't uniformly use 2-column templates) and were not included.

| File | arXiv ID | Title | Authors | License | Retrieved |
|---|---|---|---|---|---|
| `2608.11433.pdf` | [2608.11433](https://arxiv.org/abs/2608.11433) | Stigma and Support in Online Sexual Violence Narratives on Reddit | Shirlene Rose Bandela, Karan Bindal, Vaibhav Garg, Rezvaneh Rezapour | CC BY 4.0 | 2026-08-13 |
| `2608.11441.pdf` | [2608.11441](https://arxiv.org/abs/2608.11441) | DonorRank: Donor Language Selection for Low-Resource Cross-Lingual Speech Recognition | Akriti Dhasmana, Aarohi Srivastava, David Chiang | CC BY 4.0 | 2026-08-13 |
| `2608.11629.pdf` | [2608.11629](https://arxiv.org/abs/2608.11629) | Easper: An Accessible ASR Pipeline for Language Documentation | Aso Mahmudi, Ting Dang, Ekaterina Vylomova, Nick Thieberger | CC BY 4.0 | 2026-08-13 |
| `2608.11694.pdf` | [2608.11694](https://arxiv.org/abs/2608.11694) | The Wording Effect: Quantifying Two-Way Drift in LLM Benchmark Performance | Shailja Thakur, Sungeun An, Chad DeLuca, Hima Patel | CC BY 4.0 | 2026-08-13 |
| `2608.11947.pdf` | [2608.11947](https://arxiv.org/abs/2608.11947) | Accuracy and Order Sensitivity Diverge Under Label-Free Strategies | Karl Hanna, Chen Feng | CC BY 4.0 | 2026-08-13 |

License text: <http://creativecommons.org/licenses/by/4.0/>

## What's missing (scoped honestly, not overpromised)

- **Newspapers**: Library of Congress "Chronicling America" (public-domain historical newspaper
  scans) was the leading candidate but is blocked by Cloudflare bot-protection from this
  environment — its actual PDF/text-layer availability was never verified. Not included rather
  than guessed at.
- **Magazines**: no confident public-domain source was found. Scientific-article diversity
  (different subfields, different author groups, different LaTeX/BibTeX toolchains) substitutes
  for the missing categories per the plan's own allowance that 3 categories aren't a hard
  requirement — real column-layout diversity was the actual goal.

If real newspaper/magazine samples become available later (e.g. the user supplies some, or a
working non-bot-blocked source is found), add them here the same way: one row per file with
verified license + retrieval date, plus a note in `_p2wBuildParagraphs — real-corpus reading
order` in `tests/pdf2wordParagraphs.test.js` if a source is added.
