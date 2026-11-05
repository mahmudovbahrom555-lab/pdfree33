# Flate L for CMYK images — held-out check, PRE-REGISTERED 2026-11-05 (before any held-out number)

Owner (2026-11-05): Flate L approved for development once the dev 9.4% is confirmed on files
not used in development. Not a guarantee for all CMYK Compress: one stream class, one corpus.

Dev set: ~/pdfree33/cb-data/all52.txt (52 files) — 9.4% pooled, zlib level 9, 7 files.

Held-out set H: every PDF in tests/corpus/real, ~/.cache/pdfree-corpus, ~/.cache/pdfree-corpus-reserve,
~/.cache/pdfree-corpus-en whose basename is NOT in all52, with >= 1 target stream:
image XObject, /ColorSpace /DeviceCMYK, 8 bits, single /FlateDecode filter, no SMask/Mask.
(Streams with a predictor in /DecodeParms included: the predicted bytes are re-deflated as they are.)

Per stream: inflate, deflate again, keep the smaller of old/new (as the implementation will).
Reported: pooled saving over target-stream bytes at zlib level 6 (browser/pdf-lib default) and 9;
per file; the saving as a share of each file's size; number of files and of sources.

Confirmed if, at level 9 (the encoder of the dev number):
  1. H has >= 5 files, and
  2. pooled saving on H >= 6.4 % (dev 9.4 % minus 3 points).
Otherwise: report to the owner, no implementation.
Level 6 decides the encoder: if level 6 keeps >= 2/3 of the level-9 saving on H, ship the built-in
encoder (no new library); else the owner decides on vendoring a level-9 deflate.
Decoded samples must be byte-identical for every stream (checked, not assumed).
