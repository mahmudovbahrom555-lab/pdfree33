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

## 2026-10-18 — Arabic metric schema 2: the whole corpus hashed, diagnostics

- **What:** `scripts/quality/arabic.py`, schema 1 → 2, metric still v1 (no
  score changes: all 281 scored documents of the local v8 run score the same
  under both, field for field). Each row carries its document's content `sha`;
  the corpus hash is computed over every row's (doc, sha), so it is the same
  in any order and changes with any one document. `--merge` joins a night's
  shards (refusing shards of other readers or metric versions, or a document
  in two shards) and recomputes the hash over all of them — the nightly report
  had shard 0's hash only. From robust.mjs's results.jsonl (`--results`):
  `outcome` (a timeout is its own status, not "no output"), `ms`, `ocrPages`.
  `numbersAgreed` (the denominator) and `numberCauses` per document: script /
  reversed / split / inside a longer number / page furniture / Word list
  number / unexplained. `--compare` reports, and does not judge: documents
  read partly with OCR, documents set aside in
  `tests/corpus/cloud/arabic-known.json` (both readers wrong, unverifiable —
  file not created yet), documents whose content changed under the same name;
  p50/p95/max runtime, the timed-out documents, a slower-than-baseline warning
  (never red). A document scored in the baseline that fails now is red; one
  that times out now is a warning. `--migrate` reports what a new metric
  version moves on the same outputs. Control cases: 10 → 20.
- **Why:** owner's conditions (2026-10-18) before a baseline candidate: the
  hash over all shards with a second-shard and an order test; runtime and
  timeouts visible; known limits in the schema; OCR not counted as text-layer
  quality; the lost numbers broken down by cause.
- **Known limits of the causes:** heuristics that name a cause, never excuse
  a loss — `numbersMissing` counts every one. Page numbers are taken only
  where they run with the pages at one offset; a manual sample still shows
  some body numbers at a page's edge counted as furniture. A Word list number
  is not read from numbering.xml: whether Word numbers the item the same is
  not checked.
- **Moves:** no score. No baseline exists yet.
- **Approved by:** owner, 2026-10-18, in the working session ("исправление
  хэша — одобряю без оговорок", with the conditions above). No approval link:
  the link rule is the next guard change, which itself waits for the owner's
  comment.

## 2026-10-18 — the guard, v2: the owner's review of a pull request

- **What:** `scripts/check_gold.py` no longer reads a `Gold-Change-Approved:`
  trailer. A guarded change comes through a pull request: `.github/CODEOWNERS`
  names the owner on the measuring sticks and `.github/`; `guard.yml` checks
  the rules on the pull request (no `js/`, a changelog entry, nothing removed
  from it); after the merge, `--ci` in deploy.yml requires an APPROVED review
  by an OWNER on the pull request's last commit, by an account other than its
  author's and the commit's, and main's tree equal to that commit's. Pre-commit
  refuses a guarded change on main. `arabic-known.json` added to the guarded
  paths. Tests: `tests/quality/test_check_gold.py` (a faked GitHub API).
- **Why:** owner's review of v1 (issue #27, 2026-10-18): separate the agent's
  identity from the owner's, bind the approval to a specific change, protect
  it from reuse and editing — "otherwise owner-only stays on paper". A review
  is tied to one commit, a new push dismisses it, and the agent's own account
  can't give an OWNER's approval. It replaces v1 (a trailer linking an issue
  comment), which was never merged.
- **Needs (owner):** a bot account for the agent (Write), its token in the
  agent's session; branch protection on main: pull request required, review
  from code owners, dismiss stale approvals, up-to-date branches, squash merge
  only, no bypass for administrators.
- **Moves:** nothing measured.
- **Approved by:** this pull request's review.
