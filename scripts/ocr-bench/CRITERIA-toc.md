# Dot leaders on CJK table-of-contents pages (#120 fix) — criteria BEFORE runs, 2026-10-29

Problem: with #120 (Enhance's contrast step skipped for zh/ja) a TOC page with
dot leaders lost Han next to the leaders (0922125: 資訊, 暨, 措施, 反傾銷 —
reproducible). Fix candidate L: erase dot leaders (rows of small regular dots)
for the languages that skip the contrast step, like table rules.

Sets: (a) the 6 real TOC pages found in the corpus (0922125, 1486630,
1600561, 3598184, 4677533, 7516005), synthetic scans clean + rough;
(b) 24 synthetic TOC pages (fitz CJK fonts china-s / china-t / japan; leader
chars ． … · ‧; 10–12 pt), truth known, clean + rough;
(c) regression: the whole dev, pool and tilt benchmarks.
Builds: F (#119), H2r (#120 now), L (#120 + leader erasing).

Accept L only if:
1. on (a)+(b): Han recall of L >= F's on every set-variant (the #120 regression
   gone) and no page's recall below F's by more than 0.03;
2. on (c): L vs H2r — recall and bigrams not lower than H2r's by more than
   0.005 on any set-variant, extra not up by more than 0.005, no doc down by
   more than 0.05 vs H2r;
3. in-text ellipses (……) are not the target: a synthetic page with prose
   ellipses keeps its Han (part of (b));
4. median time within +5 % of H2r.
