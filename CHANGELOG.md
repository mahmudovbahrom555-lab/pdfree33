# Changelog

Selected, source-linked highlights from PDFree development. This is **not** a complete commit history. Dates below refer to **merges into `main`**, not independently verified production deployment dates. See [GitHub Releases](https://github.com/mahmudovbahrom555-lab/pdfree33/releases) for published release artifacts and [the public fixes page](https://pdfree.io/fixes/) for user-facing fix statuses.

## Unreleased

No entries recorded here yet. Add future changes after their corresponding PR is merged; do not mark a feature as deployed without a separate production check.

## Merged into `main`: 2026-11-06

- **PDF decryption recovery:** A qpdf abort no longer leaves subsequent decryptions in the same tab unusable; error messages distinguish wrong passwords from other failures ([#155](https://github.com/mahmudovbahrom555-lab/pdfree33/pull/155)). The associated fix status was updated after documented live checks ([#156](https://github.com/mahmudovbahrom555-lab/pdfree33/pull/156)).
- **Compress readability disclosure:** Added a warning that maximum compression of low-resolution scans can make small text and CJK text harder to read; removed an unsupported readability guarantee ([#152](https://github.com/mahmudovbahrom555-lab/pdfree33/pull/152)).
- **Compress gray JPEG handling:** Corrected color-space labeling for re-encoded gray JPEG scans in Standard/Maximum modes ([#153](https://github.com/mahmudovbahrom555-lab/pdfree33/pull/153)).
- **Public fix tracking:** Updated nine previously pending fix entries following recorded live checks ([#151](https://github.com/mahmudovbahrom555-lab/pdfree33/pull/151)).

## Merged into `main`: 2026-11-05

- **Public fixes page:** Introduced a public list of known fixes and work in progress, with links from tools ([#150](https://github.com/mahmudovbahrom555-lab/pdfree33/pull/150)).
- **Compress integrity:** Tightened image deduplication and mask handling ([#149](https://github.com/mahmudovbahrom555-lab/pdfree33/pull/149)); added lossless re-deflation of eligible CMYK Flate images ([#147](https://github.com/mahmudovbahrom555-lab/pdfree33/pull/147)); improved metadata removal and prevented returning an output larger than the original in the addressed paths ([#139](https://github.com/mahmudovbahrom555-lab/pdfree33/pull/139)).
- **Signed PDF handling:** Added a warning before saving a copy that would invalidate a digital signature ([#143](https://github.com/mahmudovbahrom555-lab/pdfree33/pull/143)); distinguished Adobe usage-rights signatures from digital signatures ([#145](https://github.com/mahmudovbahrom555-lab/pdfree33/pull/145)).
- **Deployment ordering:** Serialized production deployment workflow runs to avoid an older run overwriting a newer one ([#141](https://github.com/mahmudovbahrom555-lab/pdfree33/pull/141)).

## Merged into `main`: 2026-11-04

- **Privacy claims:** Replaced overly broad compliance, tracking, and privacy claims with statements more closely tied to observed product behavior, including localized content ([#134](https://github.com/mahmudovbahrom555-lab/pdfree33/pull/134), [#135](https://github.com/mahmudovbahrom555-lab/pdfree33/pull/135), [#136](https://github.com/mahmudovbahrom555-lab/pdfree33/pull/136)).
- **Page numbering:** Added more flexible numbering styles and corrected missing glyphs in Chinese numbering ([#138](https://github.com/mahmudovbahrom555-lab/pdfree33/pull/138), [#140](https://github.com/mahmudovbahrom555-lab/pdfree33/pull/140)).
- **Clean Scan:** Added an opt-in mode for light text on a dark background ([#132](https://github.com/mahmudovbahrom555-lab/pdfree33/pull/132)).

## Published releases

- [v1.0.0](https://github.com/mahmudovbahrom555-lab/pdfree33/releases/tag/v1.0.0) — published 2026-09-06. This entry links to the historical release; its original description may contain claims superseded by later changes. The source and current documentation take precedence for present-day behavior.

---

**Maintenance:** Add entries with PR links and clear dates. Separate **merged**, **verified on the live site**, and **published as a release**. Do not use test counts, performance claims, or release labels without supporting evidence.
