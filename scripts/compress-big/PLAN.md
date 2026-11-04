# Compress on large files — investigation (pre-registered 2026-11-04, before any measurement)

## Why
Analytics, country=IN, 30 days (owner exports 2026-11-04): of people adding a >50 MB file 41 of ~57
got a result still >50 MB (72 %); 10–50 MB → 10–50 MB 40 of 57; 1–10 MB → < 1 MB only 22 of 88.
81 people re-compressed the same file, 85 came back fast after downloading (signals, not proof).
Only 4 timeouts. Owner: investigate first, classify before touching presets, check it is not India-only.

## Step 0 — is it global? (owner's SQL, same query without the country filter, grouped by country)

## Step 1 — the set (drawn before measuring; documents never committed)
- B50: 10 PDFs > 50 MB — CC-MAIN zips, central directories read (find_big.py, seed `compress-big-50-2026-11-04`), at most 2 per zip.
- B10: 10 PDFs 10–50 MB — same, seed `compress-big-10-2026-11-04`.
- MIX: 10 PDFs from the local corpus caches > 10 MB chosen to cover content types not in B50/B10 (filled after Step 2's classification of B50/B10, by type, not by result).

## Step 2 — per document, before compressing
size, pages, producer, content class (colour scan / B&W scan / photos / text+vector / mixed / already compressed),
images: count, total bytes, per-image filter (DCT, JPX, Flate, CCITT, JBIG2), pixel size, effective DPI on the page,
colour space, bits; share of the file that is images, fonts, content streams, other.

## Step 3 — our Compress, through the real site build (current main), each preset the UI offers
(Light = low, Standard = medium [default], Maximum = high) and what the scan recommends by default:
output size, ratio, time, peak memory (Chrome's process RSS), pages and text kept (pdf.js text per page vs
original), visual quality: per page SSIM at 100 DPI vs the original render and per-image MuPDF diff as the
corpus gate does.

## Step 4 — causes
For each class: where the bytes went in our output (images left untouched? why — filter we skip, size
threshold, JPX/JBIG2 we can't decode, per-image guards from the 2026-09 corruption fixes) — read in code,
confirmed on the document.

## Step 5 — competitors (by hand, the owner or me; names private — letters A/B/C)
3 documents per class, same files, default settings and their strongest setting: size + the same SSIM/text checks.
A smaller file with unreadable text is not a win.

## What counts as a finding (before any fix)
A cause that explains ≥ 3 documents of B50+B10 from ≥ 2 independent sources, shown on the bytes.
Then a fix gets its own pre-registered criteria (size, quality, speed, no lost pages/content, memory).
No new presets unless Step 4 shows the current strategy can't fit a class.

## Analytics change (separate small PR)
Size buckets under 1 MB: < 100 KB, 100–200 KB, 200–500 KB, 500 KB–1 MB; plus reduction % as a number
on Compress success (owner's addition).
