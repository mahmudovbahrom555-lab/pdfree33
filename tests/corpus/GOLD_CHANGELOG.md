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

## 2026-10-18 — #28 merged without the owner's review (the bootstrap)

- **What happened:** pull request #28 (the guard v2 above) was merged by the
  owner's account before an approving review was given. CODEOWNERS arrived
  with that same pull request, so GitHub did not yet require the review; a
  merged pull request can't be approved afterwards.
- **What caught it:** the guard itself — deploy run 39142347314 stopped at
  `check_gold.py --ci`: "fb31a90d: pull request #28 has no approving review
  by the owner". fb31a90d stays in the history with that failed check; it
  changes nothing users see, and later pushes are checked on their own.
- **Content:** main's tree at fb31a90d equals #28's last commit c60c1a38 —
  exactly what was reviewed in the session; the owner confirmed the setup
  there.
- **From now on:** a pull request touching the measuring sticks or .github/
  can't merge without the owner's review (CODEOWNERS on main, ruleset
  main-guard); the owner approves, the bot merges.
- **Approved by:** this pull request's review.

## 2026-10-18 — Arabic metric v2 (schema 3) and the set-aside registry

- **What:** `scripts/quality/arabic.py` metric 1 → 2, schema 2 → 3. The
  header lists `timedOut` and `notEvaluated` (each with why) — in a run and in
  a merge of shards. "Worse than baseline" judges dot errors, reversed and
  glued words per word found (`worse_on`), not as totals. The set-aside
  registry `tests/corpus/cloud/arabic-known.json` takes the owner's fields:
  sha, kind (bothWrong / unverifiable), scope (all / numbers / words — what
  is not judged on it), issue, check, status (unreviewed / known_issue /
  fixed / excluded), dated history; only an entry not `fixed` sets anything
  aside, and only within its scope. The page-furniture cause also takes a
  line repeated word for word on many pages, numbers only or not (a running
  header's date: 4364566, 63 "unexplained" lost numbers) — a cause's name,
  not a score: unexplained 1,034 → 924, furniture 1,835 → 1,945. Control
  cases 20 → 23.
- **Why:** v1 called 2022469 "worse" when it went from no text to 96 % of it
  (its dot errors 0 → 5) — found while fixing C1, reported, not changed then.
  The owner's conditions for a baseline: timeouts and the not-evaluated in
  the schema; known limits as a registry, not a free list.
- **Registry, first entries (known_issue):** 7853393 (font encoding broken —
  846 of the corpus's unexplained lost numbers), 6965328 (Arabic as Latin-1
  lookalikes, both readers agree on it), 1000122 (Urdu, unmapped glyphs),
  3508224 (byte noise) — all scope `all`; evidence in each entry.
- **Moves (--migrate, the same 289 outputs, v1 → v2):** no score changes;
  nothing moved by the new rule on those outputs. v8 → v10 (the C1 fix)
  under v2: 0 worse (v1: 1, 2022469, wrongly).
- **Approved by:** this pull request's review.

## 2026-10-19 — Arabic metric v3 (schema 4): reading order

- **What:** `scripts/quality/arabic.py` metric 2 → 3, schema 3 → 4: `order`
  and `anchors` per document (`order_of`) — the anchors are words of 4+
  letters found exactly once in MuPDF's text, in poppler's and in the
  output; `order` is the share the output keeps in the readers' order (the
  longest run in order). None under 20 anchors. A drop of more than 0.03 is
  "worse". Control cases 23 → 26: the right text keeps order ≥ 0.95, two
  paragraphs swapped fall to ≤ 0.7 with recall unchanged, a glued word moves
  order by ≤ 0.05.
- **Why:** words were counted as a bag — a one-column page cut into two
  "columns" and read half by half (1373210) scored 94 % with its sentences
  scrambled; spreads with interleaved columns (4974198) likewise. Word
  trigrams were tried first and rejected: a letter-spaced text layer ("ج
  رائم") broke them where the output was right.
- **Moves (--migrate, the same 289 outputs, v2 → v3):** no score changes;
  nothing moved (a first order has nothing to compare with). Order on the
  289: 230 documents measured, median 0.914; 100 below 0.9, 60 below 0.8 —
  candidates for reading-order classes (C6, C7), to be checked by hand
  before any is called an error.
- **Approved by:** this pull request's review.

## 2026-10-20 — Arabic metric v4 (schema 5): order only where both readers agree

- **What:** `scripts/quality/arabic.py` metric 3 → 4, schema 4 → 5:
  `order_of` keeps only the anchors both readers put in the same order (the
  longest run of poppler's anchors that MuPDF has in that order) and scores
  the output against those; new per-document `readersAgree` (the share
  kept) and `orderUnverifiable` (enough anchors, too few in a common order —
  no order score); the report lists every such document under "order not
  checkable" instead of dropping it from the totals silently. Control cases
  26 → 29: a three-panel brochure read panel by panel scores ≥ 0.95 where
  poppler reads across the panels (v3: 0.42); columns read across each
  other where both readers agree still score ≤ 0.5; readers that share
  almost no order give no score and are listed.
- **Why — a metric bug found while starting C6, reported to the owner
  first:** v3 took the order from poppler alone (its docstring said "the
  readers' order"). Poppler reads a brochure's or a spread's panels line by
  line across each other: a correct output (3537793, read panel by panel
  like MuPDF) scored 0.58. MuPDF's and poppler's orders agree below 0.9 on 71
  of 230 documents. The owner weighed the risks (blind spots where readers
  disagree, both readers wrong alike, scores rising without a product
  change, moving a target before a fix) and asked for v4 with them managed.
- **Moves (--migrate, the same 289 outputs of main after #41, v3 → v4):**
  recall, words, numbers unchanged. Order: scored on 230 → 224 documents;
  long documents 91.88 → 94.66 % on 203; median 0.986 → 0.998; below 0.9:
  48 → 35; below 0.8: 37 → 21. Higher on 50, lower on 1 — 6579225, 0.741 →
  0.636, a three-column newsletter whose output really interleaves its
  columns (checked by hand: v3 underrated a real error). Not checkable now
  (6): 0190904, 2189356, 3286074, 4542735, 5680731, 5986935. No comparison
  across metric versions: a new baseline is needed under v4.
- **Approved by:** this pull request's review.

## 2026-10-21 — Arabic metric v5 (schema 6): digits as the page draws them

- **What:** `scripts/quality/arabic.py` metric 4 → 5, schema 5 → 6: before
  anything is counted, both readers' words and numbers are corrected where
  `scripts/quality/digits.py` finds a font whose ToUnicode names its digit
  glyphs wrongly. Candidates: a digit glyph (MuPDF's text trace) whose
  embedded font's own Unicode cmap calls it another digit; the RENDERED page
  decides — each glyph cut from MuPDF's render and matched against 390
  reference digits (`scripts/quality/digit_refs.npz`, open-licensed fonts,
  `make_digit_refs.py`) between the two candidates, with its height; a
  font's digits are redrawn only where the page backs its cmap on ≥ 2/3 of
  its candidates. Digit runs inside words too (Urdu "دربمس0202ء"). New
  per-document `digitsRedrawn`. Not PDFree's code: the product's fix reads
  the glyph's outline, this reads the page. Control cases 29 → 31 on two
  new fixtures (`tests/fixtures/quality/make-c4-digits.py`, Amiri — OFL):
  an output with the drawn digits loses no number, one with ToUnicode's
  loses both; a font whose own cmap is the wrong one redraws nothing. CI
  installs numpy 2.2.6 and fontTools 4.60.2 where documents are scored.
- **Why — the owner's request after PR #51 (C4), 2026-10-21:** v4 scored
  against MuPDF and poppler, which both read the misnamed digits, so
  PDFree's C4 fix (30 documents, each change checked on the page) showed as
  3,441 → 4,444 lost numbers. The arbiter was calibrated on 120 glyphs
  hand-labeled from page images: 54/54, and 57/57 on documents it was not
  tuned on — with these open-font references as with the earlier ones.
- **Moves (--migrate, the same 289 outputs of PR #51's build, v4 → v5):**
  numbers redrawn in 28 documents (1,577 numbers); long documents' lost
  numbers 4,444 → 3,569; words and order unchanged. Moved worse: 0045417
  (5 → 13) and 7407593 (78 → 112) — digits PDFree still writes wrong (from
  fonts its fix doesn't cover yet: simple TrueType), which v4 counted as
  right. Judged
  by v5, PR #51 (old → new outputs): lost numbers 4,416 → 3,569, worse on 3
  by one number each (0399787, 2435450, 7733378) — a known limit: there
  MuPDF itself doesn't follow the font's ToUnicode, so no candidate is
  found; the product's change on 7733378 and 0399787 was checked correct on
  the page. No comparison across metric versions: a new baseline under v5.
- **Approved by:** this pull request's review.
