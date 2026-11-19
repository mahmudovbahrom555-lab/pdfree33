# scripts/bench — comparing two builds of a converter

A working bench, kept in the repository so it survives a wiped `/tmp`
(it was lost that way twice, 2026-10-27 and 2026-11-19). Not a gate and not a
measuring stick: the sticks are `scripts/quality/` and `tests/corpus/gold/`,
changed only through the owner's review.

## PDF→Word: does the Word file look like the PDF?

```sh
# 1. the documents: names from a list, fetched out of the cloud corpus
python3 scripts/corpus-cloud/fetch.py ~/pdfree-bench/docs $(cat names.txt)

# 2. each build's Word files (dist served on a port, or https://pdfree.io)
node scripts/corpus-cloud/robust.mjs --docs ~/pdfree-bench/docs --tools pdf2word \
  --base http://127.0.0.1:9000 --out ~/pdfree-bench/out-before --save
node scripts/corpus-cloud/robust.mjs --docs ~/pdfree-bench/docs --tools pdf2word \
  --base http://127.0.0.1:9001 --out ~/pdfree-bench/out-after --save

# 3. the judge: LibreOffice prints each .docx, set beside its PDF
python3 scripts/bench/visual_judge.py ~/pdfree-bench/docs ~/pdfree-bench/out-before/files > before.jsonl
python3 scripts/bench/visual_judge.py ~/pdfree-bench/docs ~/pdfree-bench/out-after/files  > after.jsonl

# 4. what changed
python3 scripts/bench/compare.py before.jsonl after.jsonl
```

`diff` is the mean grey difference (0–255) of the first 3 pages, lower is
closer; `ratio` is Word pages ÷ PDF pages. A number moves for many reasons
(a font, a line wrap): look at the changed documents by eye before deciding.

Rules that cost real time when broken:
- serve a **copy** of `dist/` for a run, never the one you rebuild (a rebuild
  mid-run mixes two builds); `python3 -m http.server` keeps serving a deleted
  folder — restart it after replacing the copy;
- keep the bench data outside `/tmp` (`~/pdfree-bench/`).
