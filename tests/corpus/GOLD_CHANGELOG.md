# Measuring-stick changelog

Every change to the gold pages, the frozen baselines, the Arabic metric, its
control cases or their guard (see `scripts/check_gold.py`) gets an entry here,
in the same commit: what changed, why, which documents it moves, who approved.
A score that moved between two dates is explained by this file or by a
converter commit — never by both at once.

## 2026-10-18 — Arabic metric v1 and its control cases

- **What:** `scripts/quality/arabic.py` (metric v1, schema 1): strict per-pain
  Arabic-script PDF→Word scores against the words and numbers MuPDF and
  poppler both read; short documents (< 50 words) reported apart in absolute
  errors; reader versions, corpus hash and the readers' own agreement
  (`agree`, `numbersAgree`) in every result; `--compare` refuses two metric
  versions. `tests/quality/test_arabic_metric.py` + `tests/fixtures/quality/`
  (our own text): control cases, and two written-down limits — both readers
  read Chrome's lam-alef backwards; MuPDF reverses Arabic-Indic numbers, so
  those go unscored. Run in the deploy workflow.
- **Why:** an external audit of the Arabic runs (2026-10-17): agreement of two
  readers is a signal, not truth; short documents can't hide in averages; a
  metric must be shown to see what it claims. Building it found real defects
  (a number lost to a shifted ActualText; scans under a watermark never
  OCRed; years in RTL lines read "1502").
- **Moves:** nothing yet — no baseline exists. The first one comes from CI
  runs and is approved separately.
- **Approved by:** owner, 2026-10-18 (conditions: control cases, versions and
  coverage in the results, a CI check, a baseline only after two CI runs and
  the owner's review).

## 2026-10-18 — the guard

- **What:** `scripts/check_gold.py` — in pre-commit, and in the deploy
  workflow on every pushed commit: a change to the gold pages, a baseline, the
  Arabic metric, its control cases or this guard is a commit of its own (no
  `js/`), with a `Gold-Change-Approved:` trailer and an entry here. A section
  in CLAUDE.md says the same to agents.
- **Why:** the audit's rule: an agent must not move the target to pass.
- **What it is not:** authorization. Anyone who can push — an agent working
  under the owner's account included — can write the trailer and the entry;
  the guard makes such a change impossible to make quietly or by accident. The
  approval itself is the owner's, given outside the repository.
- **Moves:** nothing measured.
- **Approved by:** owner, 2026-10-18.
