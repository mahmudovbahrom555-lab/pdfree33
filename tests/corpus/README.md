# Regression corpus

Real and synthetic PDFs for **old-vs-new** runs: every file goes through a tool
on production and on the new build, and `scripts/corpus-diff/check.py` fails the
deploy if the new output is further from the original than production's
(CI step "Corpus diff" in `.github/workflows/deploy.yml`).

Why it exists: on 2026-09-30 an old-vs-new run over real files found Compress
corruption that had shipped for four months (charts vanishing, garbled scans)
and a savings regression in the fix itself — the synthetic unit tests missed all
of it. Against the pre-fix build this gate failed on every known corruption
shape and on two real arXiv papers; production vs an identical build gave zero
false alarms.

## Layout

| Path | What |
|---|---|
| `real/` | Openly licensed real documents. `real/MANIFEST.json` records source URL, licence (verified at the source on the retrieved date), SHA-256 and image encodings for each. |
| `synthetic/` | Files pdf-lib can't build at run time (encryption, CCITT G4). Regenerate with `python3 tests/corpus/synthetic/make_synthetic.py` (needs pymupdf, pillow, qpdf CLI). User-password files — one per `/Encrypt` form (direct dict / reference) — use password `user`. |
| `groundtruth/` | PDFs rendered FROM a known source (the project's own FAQ copy in 8 languages × 4 layouts: web, book-style indent, loose, two columns), so the true headings, paragraphs and reading order are exact. `make_groundtruth.mjs` regenerates them (needs network + `pip install fonttools`) and rejects any PDF whose own text layer MuPDF can't read (<0.85 of the words) — font choice decides that, see its header. |
| `traps.mjs` | Run-time traps (built with pdf-lib, nothing committed): the image shapes that broke Compress, each with `why` and `expect`. Also used by `tests/e2e/compress.e2e.mjs`. |

## Running

```
python3 scripts/build.py && python3 -m http.server 8934 --directory dist &
npm run corpus:diff:compress        # needs: pip install pymupdf==1.26.5
npm run corpus:diff:merge           # input + tests/fixtures/normal-1page.pdf
npm run corpus:diff:split           # per-page ZIP re-joined by page number
npm run corpus:diff:pdf2md          # text oracle: recall / garbage / inflation / ERI vs the original's text
python3 scripts/corpus-diff/check.py <out-dir> -v   # per-file metrics (text tools)
npm run corpus:groundtruth          # pdf2md structure vs ground truth: recall, reading order,
                                    # paragraph-boundary precision/recall, headings
npm run corpus:groundtruth:word     # same for PDF→Word via the real tool page, plus Arabic
                                    # presentation forms left and RTL markup (w:bidi, w:rtl)
```

## Cloud corpus — nightly robustness run (`scripts/corpus-cloud/`)

The owner's main direction (2026-10-14): measure on as many real documents as
possible, fix what fails, pains first. Two layers:

- **Robustness** (this one, no ground truth needed): a stratified sample of
  CC-MAIN-2021-31-PDF-UNTRUNCATED (Digital Corpora, ~8M PDFs crawled from the
  web) — Arabic, Persian, Chinese, scans, damaged files, forms, the other
  languages we serve, encrypted, long files, a random control group, picked by
  `pick_sample.py` from the corpus's own Tika metadata into
  `tests/corpus/cloud/sample-v1.json` (names only). `.github/workflows/corpus-nightly.yml`
  runs a tenth of it each night through every tool (`robust.mjs`): ok, broken
  output, the site's own error, refused, timeout, crash. `report.py` clusters
  the failures by signature, pains weighted up, and flags raw engine messages
  shown to users. A report, not a deploy gate.
- **Quality** (next): smaller sets WITH ground truth for the converters.

Documents are fetched one at a time out of the remote zips (`fetch.py`, HTTP
Range) and never committed or uploaded — their licences are those of the sites
they were crawled from. Only names and results are kept.

```
python3 scripts/corpus-cloud/fetch.py corpus-cloud-docs 0000007.pdf 0000500.pdf
node scripts/corpus-cloud/robust.mjs --docs corpus-cloud-docs --out corpus-cloud-out
python3 scripts/corpus-cloud/report.py corpus-cloud-out/results.jsonl
```

For runs that compare builds, take the documents through the cache instead
(`cache.py`): it keeps them outside temporary folders (`~/.cache/pdfree-corpus`,
or `$PDFREE_CORPUS_CACHE`), checks each against the SHA-256 pinned in
`tests/corpus/cloud/sha256.json`, fetches a missing or damaged one again, and
stops with `SourceChanged` — never taking it — when the source now holds other
bytes. A document with no pin is refused unless `--pin-new` is given. Copies,
not links: a cleared folder once turned a 60-document run into 60 harness
failures.

```
python3 scripts/corpus-cloud/cache.py materialize run-docs --list names.txt
```

## Adding a file

- **Never** a user-supplied or personal document — this repository is public.
  Reproduce a user's problem with a synthetic trap instead.
- Only licences you verified at the source (public domain, CC0, CC BY, CC BY-SA),
  recorded in `MANIFEST.json` with the source URL.
- Prefer small files (≲ 2 MB) that add a shape the corpus doesn't have yet — a
  new image encoding, script, structure — over more of the same.
