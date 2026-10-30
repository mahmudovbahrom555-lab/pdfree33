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

## 2026-10-22 — Arabic metric v6 (schema 7): words as the page's glyphs spell them

- **What:** `scripts/quality/arabic.py` metric 5 → 6, schema 6 → 7: before
  anything is counted, both readers' words are corrected where
  `scripts/quality/glyphs.py` finds a glyph whose letters both readers turn
  around. Read from MuPDF's text trace on its own: in a span drawn left to
  right (its glyphs' x rising on 3 of 4 steps at least — Nastaleeq stacks a
  word's letters back — and ending right of its start) that holds
  Arabic-script letters, a glyph's
  letters are its first character and those the trace marks as no glyph of
  their own (id -1); the span read right to left by glyph against the same
  span read by letter, as the readers read it — a word whose two readings
  differ is a correction (read → spelled). New per-document
  `glyphsRespelled`. No new dependency. Control cases 31 → 34 on two new
  fixtures (`tests/fixtures/quality/make-glyph-letters.py`, Amiri — OFL):
  the right words count and the readers' reversed ones don't; glyphs named
  by one character each respell nothing; a page drawn in reading order
  (Chromium) respells nothing.
- **Why — the owner's decision after PR #56 (C11), 2026-10-22:** Word draws
  a right-to-left line glyph by glyph in visual order and names a ligature
  glyph by its letters in reading order; MuPDF and poppler both turn the
  letters around ("اإلسالمية" for "الإسلامية", "ےک" for "کے"), so v5
  scored PDFree's C11 fix as worse on 117 documents (recall 95.91 → 91.23 %)
  where an independent vocabulary showed it better on 0 worse. Judged before
  use by a vocabulary from the 132 corpus documents it corrects nothing on
  (46,222 words): its 174,849 corrections in 148 documents are words there
  70.8 % of the time, the readers' forms 15.3 %; per document (≥ 20
  corrections) the spelled form is no better on 2 of 114 — 6677618 (0 both:
  a Quartz file with every letter doubled) and 6864345 (a broken font).
  A first version took only spans whose x never fell: Nastaleeq lines
  dropped out (1688739, Word 365: "ےک", "یک" left uncorrected); with the
  3-of-4 rule they are read (155 corrections there: "کے", "کی", "سروے").
  Its wrong corrections are nearly all one document, 7407593 ("وقتی" →
  "تقوی", "لوگ" → "ولگ"): a Nastaleeq font whose glyphs split a word's
  letters oddly ("صو", "ول" for "اصولوں") — neither reading is the word
  there; a candidate for the set-aside list.
  Checked by hand: 6866008 (a legacy Persian font, garbage both ways, the
  correction keeping the real word's structure: "اذتالف" → "اذتلاف" for
  "اختلاف"), 7407593 (a Nastaleeq font whose glyphs split letters oddly —
  neither reading is the word; v6 doesn't rescue it).
- **Moves (--migrate, the same 289 outputs of main 782a05c1, v5 → v6):**
  long documents' recall 91.23 → 95.09 %, missing words 116,683 → 54,298,
  dots 2,321 → 830, reversed 2,356 → 1,348; numbers unchanged; order
  94.87 → 94.82 %. Moved by it: 16 documents, recall up on 5 (5021957
  0.103 → 0.289, 3796638 0.799 → 0.981, 0247454 0.595 → 0.676, 3824251,
  2518740), down on 11 — checked each: on 8 PDFree's output still has the
  reversed words, which v5 counted as right (1373210 0.936 → 0.818, 1688739
  "ےک" ×27, 0045417, 7733378, 6977632 "اسالم" ×12, 4487592 "تسهیالت" ×66,
  1772036 "اطالعات" ×43, 7407593: C11's fix stopped early there — a hamza
  pdf.js splits off, LRM and Arabic format characters the glyphs name —
  fixed in its own PR); on 3 the font is broken and both readings are
  garbage — 0519513 (0.951 → 0.901), 6864345 ("حالهظزخ", 0.892 → 0.885),
  6677618 (every letter doubled, 0.991 → 0.741) — with 7407593, candidates
  for the set-aside list, the owner's call. No comparison
  across metric versions: a new baseline is needed under v6.
- **Approved by:** this pull request's review.

## 2026-10-22 — Arabic set-aside list: three documents whose text layer both readers read wrong

- **What:** `tests/corpus/cloud/arabic-known.json` +3 entries, `scope: all`,
  `status: known_issue`. They stay in every run and are reported on their
  own ("set aside by a human … judged only outside its scope"), out of the
  totals. No metric code and no criterion changes.
  - **6677618.pdf** (`bothWrong`, Mac OS X 10.7.3 Quartz): every letter
    doubled in both readers — each glyph named by its presentation form and
    its letter ("ﻭوﺍاﻟﺩدﻱي" for "والدي"). Checked: page 1 rendered reads
    "والدي الشاعر الإنسان"; both readers give the doubled text.
  - **6864345.pdf** (`bothWrong`, Word 2010): a legacy font encoding — letters
    named as other letters and as Arabic-Indic digits ("كممة عميد الكمية" for
    "كلمة عميد الكلية", "حٌظَر١ش" for "التربية"); 1,367 of 6,520 words carry
    digits inside letters. Checked: page 2 (a contents table) rendered reads
    "كلمة عميد الكلية", "الهيكل الأدارى للكلية".
  - **0519513.pdf** (`unverifiable`, Adobe PDF Library 15): the text layer is
    noise — page 2 shows an Arabic paragraph, its text layer is 2,102
    characters of Hebrew alef and symbols; 101 Arabic-script words in 27
    pages, garbled ("ﻄاﻏﻌ"). Checked: page 2 rendered against both readers.
- **Not set aside, though proposed with these:** 7407593.pdf (Urdu, Word
  2010). Its readers agree on only 16 % of their words, but under metric v6
  and C12 (#61) it is measured (recall 0.91 on 10,227 agreed words) and it
  is the corpus's main check against an Urdu regression; set aside, a future
  break there would not show. Left in, for the owner to decide.
- **Effect on the totals (main 6c5c9084's outputs, v6, long documents):**
  219 documents instead of 222; recall-weighted words 96.20 → 96.23 %, dots
  468 → 377 (almost all 6864345's), reversed 953 → 947, numbers missing
  3,565 → 3,532. The aim is not the number: these three can only produce
  false "worse" and "better" signals.
- **Approved by:** this pull request's review.

## 2026-10-24 — Arabic baseline, metric v6: the first one

- **What:** `tests/corpus/cloud/arabic-baseline.jsonl` — new, the
  `arabic-night.jsonl` of CI run 40037891713 (corpus-nightly #16, commit
  c482b99e) copied as is (sha256 8d9a662888511b90…). From now on each night is compared
  with it (`arabic.py --compare … --fail-on-worse`). No metric code and no
  criterion changes.
- **Two CI runs that agree:** run 39982311965 (#15, commit 4e4bb076, sha256
  7b1312add725ef65…) and run 40037891713 (#16). Same readers (PyMuPDF 1.26.5, poppler
  24.02.0), same corpus hash 2f8cdc58173b4494, 289 documents. Of the 280
  scored in both, all 280 identical on every field (recall, missing, dots,
  reversed, glued, split, numbers missing, order, OCR pages, words) — across
  a deploy between them (#68, CJK CMaps), which changed none of them.
- **The one difference:** 3939389.pdf (124 pages, Excel 2010) timed out in
  #15 (302.8 s, limit 300 s) and finished in #16 (191.3 s, recall 0.81). It
  depends on the CI machine's speed; a later night that times out on it
  shows a ⚠ warning, not a red night (`compare` counts timeouts apart from
  failures). Taken from #16 because it scores one document more.
- **Totals (as the report gives them):** long documents 219, recall 96.36 %,
  order 94.73 % on 200, numbers missing 3,337, dots 372, reversed 943, glued
  2,375; short documents 21, recall 97.87 %, 2 with a serious error; 36 read
  partly with OCR, judged apart; 7 set aside; 8 not evaluated (2 timeouts,
  2 refused, 4 without Arabic-script text both readers agree on).
- **What it is not:** proof that Arabic PDF→Word is error-free — 3,337
  numbers and 40,525 words are still lost against the readers, and the
  set-aside documents are outside it. It is the reference later changes are
  judged against.
- **Approved by:** this pull request's review.

## 2026-10-27 — Arabic baseline, metric v6: after C14

- **What:** `tests/corpus/cloud/arabic-baseline.jsonl` replaced by the night
  of CI run 40278695290 (corpus-nightly #19, commit 68c4e483), sha256
  c50b50e81e704504…: its six `arabic-results-*` shard artifacts merged with
  the same `arabic.py --merge` the workflow runs (the workflow's own
  `arabic-report` artifact is uploaded only on a green night, so there was
  none). No metric code and no criterion changes.
- **Why:** every night since 2026-10-24 is red on one document, and the
  cause is a correct converter change, not a lost number. C14 (#72,
  2dca79a4) reads text drawn over itself once. 7629204.pdf (Persian report,
  Adobe PDF Library 10.0.1) draws its header year "1396" twice at the same
  spot on four pages (62, 63, 70, 76; x 530.72 y 80.0, 10.39 pt); poppler
  already reads it once, MuPDF twice, so the trusted count was poppler's.
  Before C14 our DOCX held those four copies twice, and the extra copies
  filled in for two "1396" missing elsewhere in the document; after C14 they
  are read once, and those two show as lost (298 → 299, with "62" found where
  the old DOCX had "6262"). Checked by building 4105e97f (before C14) and
  main and converting the document with both: every paragraph that differs is
  a doubled header read once. The two missing "1396" were missing before as
  well; they are a real loss the baseline now shows instead of hiding.
- **Two CI runs that agree:** run 40168053291 (#18, commit bbcc6c9f) and run
  40278695290 (#19). Same readers (PyMuPDF 1.26.5, poppler 24.02.0), same
  corpus hash 2f8cdc58173b4494, 289 documents. Of the 285 finished in both,
  all 285 identical on every field but runtime — across #88 and #89 (C15,
  CJK letter spacing) between them, which changed none of them.
- **The differences:** 3479833.pdf and 3939389.pdf timed out in #18 (302.9 s,
  limit 300 s) and finished in #19 (297.9 s, 254.8 s). Taken from #19 because
  it scores two documents more; a night that times out on them shows a ⚠
  warning, not a red night.
- **Against the old baseline:** 13 documents moved. Better: 0190904, 0865218
  (also OCR'd one page more: 8 → 9), 2707064, 3079058, 3503966, 3608860,
  4974198, 5955337 — fewer words or numbers lost, by one to fourteen. Newly
  scored: 3479833 (timed out before), 4799772 (refused before). 2149181:
  refused before, timed out now — still not scored. Slightly worse, both
  hand-checked as C14 reading a fourfold or twofold overprint once:
  7629204 (numbers missing 298 → 299, words 1,725 → 1,729) and 7853393 (a
  title drawn four times in a broken font: words 41,736 → 41,737, dots
  424 → 426, glued 1,470 → 1,473).
- **Totals (as the report gives them):** long documents 220, recall 96.36 %,
  order 94.75 % on 201, numbers missing 3,430, dots 380, reversed 944, glued
  2,588; short documents 21, recall 97.87 %, 2 with a serious error; 37 read
  partly with OCR, judged apart; 7 set aside; 6 not evaluated (2 timeouts:
  2149181, 6567268; 4 without Arabic-script text both readers agree on).
- **What it is not:** proof that Arabic PDF→Word is error-free — 3,430
  numbers and 41,226 words are still lost against the readers, and the
  set-aside documents are outside it. It is the reference later changes are
  judged against.
- **Approved by:** this pull request's review.

## 2026-10-27 — Chinese and English metrics v1; the guard covers scripts/quality/

- **What:** `scripts/quality/chinese.py` (metric v1, schema 1: Chinese and
  Japanese) and `scripts/quality/latin.py` (metric v1, schema 1: English),
  new. Each result names its `measure`; `--compare` refuses two different
  metrics, versions or readers, and with `--private` prints totals only (the
  closed holdout's report). `scripts/quality/break_docx.py`, new: deliberately
  broken copies of outputs, one defect kind per copy, seeded — how a metric is
  checked in both directions. `scripts/quality/EquivalentUnifiedIdeograph.txt`
  (Unicode 17.0.0, unchanged from 16.0.0): which radicals stand for which
  ideographs. Control cases `tests/quality/test_chinese_metric.py` and
  `test_latin_metric.py` on our own text (`tests/fixtures/quality/`, printed by
  `make-text-metrics.mjs`), run in the deploy workflow next to the Arabic one.
  `scripts/check_gold.py` now guards all of `scripts/quality/` (CODEOWNERS
  already did; the guard named `arabic.py` alone, so `digits.py` and
  `glyphs.py`, which the Arabic metric reads with, were unguarded) and the
  holdout's reserve set `tests/corpus/cloud/reserve-v1.json`.
- **Why:** the closed holdout (owner, 2026-10-25) judges Chinese, Arabic and
  English PDF→Word; Arabic had its metric in the repository, the other two
  didn't. chinese.py is the draft that judged C13, C14 and C15 (2026-10-23 to
  10-25), which lived in a scratch folder and was lost when /tmp was wiped; it
  is restored from the session log and moved here, where a measuring stick
  belongs.
- **Changed from the draft (v0):** `extra` now counts what the output has
  beyond EITHER reader. v0 subtracted the two readers in turn, so a paragraph
  written twice counted 0 — found by this PR's control case, never tested
  before. No other score changes; the tolerances are v0's.
- **Changed from the draft after the English check:** `spaced` counts letters
  beyond the LARGER reader count, not the smaller. A title letter-spaced in the
  source is read spaced by poppler and joined by MuPDF; against the smaller
  count, 16,021 letters on 58 English documents were the sources' own spacing
  (now 6,785; of those checked by hand, some are ours — "P r e s i d e n t"
  where both readers have the word whole, a candidate error class — and some
  are map codes, "L A L A M A B"). Found after seeing results; it makes the
  counter match what its own description always said.
- **Added after seeing results — for the owner to decide:** `--exact`, every
  tolerance dropped, for two builds run on the same documents in one run (the
  holdout), where conversions are deterministic. Not the default; the nightly
  and any comparison across machines keep the tolerances.
- **Validated (criteria written down before the runs; dev documents only —
  sample-v1's zh stratum, 128 from the cache, and 60 English sample-v1
  documents, seeded pick; one build served twice; readers PyMuPDF 1.26.5 and
  poppler 26.10.0 on the Mac, CI has 24.02):**
  - Same build twice: Chinese/Japanese 0 worse, 0 mixed, 0 no longer scored
    of 128 (outcomes identical: 123 ok, 4 timeouts, 1 refused); English 0 / 0 /
    0 of 60 (58 ok, 2 timeouts). With `--exact` too: 0.
  - Broken copies (`break_docx.py`, seed 20261027), documents caught on the
    defect's own counter, tolerances as v0 / with `--exact`:
    - Chinese/Japanese: spaces 74/75 / 75; drop 73/78 / 75; radicals
      75/75 / 75; digits 52/75 / 67; swap 29/40 where order is measurable
      (15 more not measurable) / 34; dup 71/78 / 76.
    - English: spaces 15/56 / 54; drop 40/57 / 57; digits 33/58 / 50; swap
      17/51 / 43; dup 35/57 / 57; glue 9/54 / 54; split 5/56 / 53.
  - The misses with tolerances are one error under a per-document tolerance
    (one lost number in hundreds, 20 characters in 9,800, one glued word in
    thousands); the misses left with `--exact` are text that also stands
    elsewhere in the document (a multiset still finds it), order with no
    anchor in the moved paragraph, and documents whose broken text the readers
    don't agree on. Three spacing breaks first counted as misses changed
    nothing (one character per run); `break_docx.py` now skips such copies.
- **What it is not:** the closed holdout. These are dev documents; the
  holdout is drawn later, by CI, from documents never looked at.
- **Approved by:** this pull request's review.

## 2026-10-27 — The closed holdout: its draw, its report, its workflow

- **What:** `scripts/quality/holdout_report.py`, new: the holdout's report —
  per language (zh, ar, en), how many documents got worse, mixed, better or
  stopped being scored between main and the change under test, and nothing
  that names a document; exit 1 when anything got worse, mixed or stopped
  being scored. Chinese and English judged `--exact` (the two builds run on
  the same documents in one run, where conversions are deterministic); Arabic
  by `arabic.py`'s own rule (`worse_on`), documents read partly with OCR left
  out as its report leaves them out. Control cases
  `tests/quality/test_holdout_report.py`, run in the deploy workflow.
  Outside the guarded paths, in the same pull request:
  `scripts/corpus-cloud/pick_holdout.py` (draws the reserve with a public seed
  and the holdout with the `holdout` environment's secret, excluding every
  document already looked at — every pinned one, sample-v1, the slides sample
  — and, for the holdout, the reserve), `robust.mjs --offline --quiet`, and
  `.github/workflows/holdout.yml`.
- **Why:** the owner's holdout decision (2026-10-25): a dev set for tuning, a
  closed holdout for final evaluation only, a reserve set for diagnosing its
  failures; both directions checked; no leakage, restricted technically; a
  human approves.
- **How the "no leakage" holds:** the seed is a secret of the `holdout`
  environment, which only main may use and whose every run the owner
  approves; the change under test is built in a job with neither the secret
  nor a document and only served as static files to a browser that reaches
  nothing but its own host and the three library CDNs the site loads from;
  the measuring code is main's; no document name, path or line is printed and
  nothing is uploaded. What it does not stop: the documents are public, so
  whoever knows the seed can draw them again — the agent does not.
- **Checked:** a rehearsal on 12 dev documents (4 per language) ran every
  step of the workflow on the Mac, `--offline` included — all conversions
  finished as they do online, the report: 0 worse; the report fed broken
  outputs (paragraphs written twice, words glued): worse counted, exit 1, no
  document name in its output.
- **Approved by:** this pull request's review.

## 2026-10-27 — The holdout's reserve set, v1

- **What:** `tests/corpus/cloud/reserve-v1.json`, new (sha256 3b15c192def3920d…): the
  artifact of holdout.yml run 40493113681 (mode reserve, on main ae0dc8ac,
  triggered by the owner), copied as is. 200 documents: zh 60, ja 20, ar 40,
  fa 15, ur 5, en 60 — drawn with the public seed
  `pdfree-reserve-2026-10-27` from the Tika metadata of
  CC-MAIN-2021-31-PDF-UNTRUNCATED, text layer only, not encrypted, excluding
  the 2,306 documents already looked at (every pinned one, sample-v1, the
  slides sample). Checked here: none of the 200 is among those, none twice.
- **Why:** where a holdout failure is diagnosed (owner, 2026-10-25) — its
  documents may be opened, the holdout's never; and the holdout is drawn
  excluding them, so the two never share a document. The holdout can't run
  without this file.
- **Approved by:** this pull request's review.

## 2026-10-27 — The holdout report gives Arabic totals

- **What:** `scripts/quality/holdout_report.py`: the Arabic line's notes now
  carry the change's totals over its text-layer documents — documents, words
  agreed, recall, dots, reversed, glued, numbers missing of agreed, order —
  as Chinese and English already did. No count, rule or tolerance changes;
  still no document name. Control case added to
  `tests/quality/test_holdout_report.py`.
- **Why:** the first holdout run (2026-10-27, main vs main, 0 worse on all
  three languages) printed Chinese and English totals but only "6 read partly
  with OCR" for Arabic — there was nothing to read the Arabic level off.
- **Approved by:** this pull request's review.
