# Chinese/Japanese OCR settings — criteria fixed BEFORE results (2026-10-29)

Benchmark: 30 dev docs (21 zh, 9 ja; seed 20261029; recall >= 0.98 text-layer
docs with >= 300 Han), first 2 pages each, made into image-only PDFs:
clean (300 DPI gray PNG) and rough (150 DPI gray JPEG q55). Truth = the source
page's own text (MuPDF, NFKC). Run as a Chinese user: /zh/pdf-zhuan-word/,
browser locale zh-CN, auto language. Score: Han+kana recall (multiset),
bigram recall (catches order/spaces-free adjacency), extra share.

A setting replaces main's (PSM 11 for CJK) only if, on BOTH clean and rough:
1. recall and bigrams each >= main's (whole set), and bigrams up by >= 1 point
   on at least one of them;
2. no document's recall drops by more than 0.05;
3. median time per doc within +20 %;
then confirmed on real scans from the corpus by hand (the 14 zh scans of the
dev set: side by side DOCX, before/after) — no doc visibly worse.
Single-run noise: none expected (same build, same input → same output); if a
rerun of main differs, rerun all twice and use the mean.

Amendment 1 (2026-10-29, after PSM/C/D results, BEFORE variant E's): the fix
candidate E = per-document choice chi_sim vs chi_tra (more confident Han wins).
Same criteria 1–3 for E vs main, plus:
4. script: zh docs whose output script (traditional vs simplified, opencc t2s,
   > 5 % changed) matches the source — E right on every doc main gets right,
   and on most traditional ones;
5. time: E probes two more models on the sample page — median +20 % still the bar.
Then the hand check on real scans (dev + pool real Chinese scans).

Amendment 2 (2026-10-29): E (more confident Han wins) FAILED — all 3
simplified dev docs flipped to traditional (0218641 0.90 → 0.54). Offline probe
(both models on the 1600px sample, PSM 11) shows mean confidence over Han
words separates: traditional docs chi_tra − chi_sim +3..+21, simplified
−13..+2. Rule F: chi_tra when its mean Han confidence is >= 3 above chi_sim's.
F was CHOSEN on the dev 21 → it must be validated on an INDEPENDENT set:
20 zh docs from the control pool (seed 20261030, same eligibility), clean +
rough, full pipeline, before any PR. Accept F only if on the pool set:
(a) output script right on >= 90 % of docs and on every simplified one it
gets right today; (b) recall and bigrams >= main on clean and rough;
(c) no doc's recall drops by more than 0.05; (d) median time within +20 %.

Amendment 3 (2026-10-29, before G results): G = on top of F, a low-confidence
single CJK glyph kept when both its line neighbours are kept (holes inside
words: 史志[诚], 陕[西]省). Accept vs F only if on dev AND pool, clean AND rough:
recall and bigrams up; extra up by no more than 0.01; no doc's recall down by
more than 0.05; median time within +5 %.

G REJECTED (vs F, all four sets): recall +1–2 pts, extra +0.011..+0.019 (> 0.01).
Amendment 4 (before H/I results): H = no Enhance for CJK (grayscale only);
I = CJK render cap 3000 px instead of 4200. Screening on dev (clean+rough) vs F;
promising = recall and bigrams up on both with extra not up > 0.01 → then the
pool set with the same bar plus no doc down > 0.05.

H/I screening (dev, vs F): I (3000 px) much worse → 4200 stays. H (no Enhance
for CJK) zh clean .73→.76 / bigrams .60→.65, rough .63→.72 / .48→.61, extra
down; ja clean slightly worse, rough better. But Enhance holds deskew (phone
photos) — H not acceptable as is. Amendment 5 (before H2/H3 results):
H2 = skip only the contrast/background step for CJK (deskew + rule erase kept);
H3 = skip only rule erasing for CJK. Same screening bar as amendment 4; the
winner must also keep a tilted-photo check (a dev doc rendered tilted 3°,
reading order and recall not worse than F).

H2 screening PASSED (dev, vs F): zh clean .73→.78 / bigrams .60→.68, rough
.63→.75 / .48→.64, tilt .57→.68 / .43→.58, extra down; ja .45→.49 / .34→.42.
H3 (no rule erase) worse than F. (First H2 run invalid: port 8983 served a stale
server of a removed worktree — caught by cmp, rerun on 8985.)
Validation (as amendment 4): H2r (= H2 for chi_sim/chi_tra/jpn only, kor
untouched) vs F on the POOL set clean + rough: recall and bigrams up; extra up
<= 0.01; no doc down > 0.05; time within +5 %; plus the 24 real pool scans
(mostly Japanese) F vs H2r: every changed doc looked at, none visibly worse.
