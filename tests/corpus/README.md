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
| `traps.mjs` | Run-time traps (built with pdf-lib, nothing committed): the image shapes that broke Compress, each with `why` and `expect`. Also used by `tests/e2e/compress.e2e.mjs`. |

## Running

```
python3 scripts/build.py && python3 -m http.server 8934 --directory dist &
npm run corpus:diff:compress        # needs: pip install pymupdf==1.26.5
npm run corpus:diff:merge           # input + tests/fixtures/normal-1page.pdf
npm run corpus:diff:split           # per-page ZIP re-joined by page number
npm run corpus:diff:pdf2md          # text oracle: recall / garbage / inflation / ERI vs the original's text
python3 scripts/corpus-diff/check.py <out-dir> -v   # per-file metrics (text tools)
```

## Adding a file

- **Never** a user-supplied or personal document — this repository is public.
  Reproduce a user's problem with a synthetic trap instead.
- Only licences you verified at the source (public domain, CC0, CC BY, CC BY-SA),
  recorded in `MANIFEST.json` with the source URL.
- Prefer small files (≲ 2 MB) that add a shape the corpus doesn't have yet — a
  new image encoding, script, structure — over more of the same.
