#!/usr/bin/env python3
"""Step 4 F1: a line removed on every page — check with PyMuPDF (independent of pdf.js).
  python3 check_removed.py <original.pdf> <output.pdf> <removed text>
Per page: the removed text is gone; every other text line is the same (NFC, spaces removed);
pixels differ only inside the removed line's band (rendered at 72 dpi; band = its bbox ± 2 pt)."""
import re, sys, unicodedata
import fitz
orig, out, removed = fitz.open(sys.argv[1]), fitz.open(sys.argv[2]), sys.argv[3]
norm = lambda s: re.sub(r'\s+', '', unicodedata.normalize('NFC', s))
target = norm(removed)
bad_text = bad_gone = bad_pixels = 0
for i, (a, b) in enumerate(zip(orig, out)):
    la = [norm(l) for l in a.get_text().split('\n') if l.strip()]
    lb = [norm(l) for l in b.get_text().split('\n') if l.strip()]
    if any(target in l for l in lb): bad_gone += 1
    if [l for l in la if target not in l] != lb: bad_text += 1
    band = None
    for x0, y0, x1, y1, text, *_ in a.get_text('blocks'):
        if target in norm(text.replace('\n', '')): band = (y0 - 2, y1 + 2)
    pa, pb = a.get_pixmap(dpi=72), b.get_pixmap(dpi=72)
    n = pa.n; diff = 0
    for y in range(pa.height):
        if band and band[0] <= y <= band[1]: continue
        ra = pa.samples[y * pa.stride:(y + 1) * pa.stride]; rb = pb.samples[y * pb.stride:(y + 1) * pb.stride]
        if ra != rb: diff += 1
    if diff: bad_pixels += 1
print({'pages': f'{len(orig)}→{len(out)}', 'removed_still_present': bad_gone, 'other_text_changed': bad_text, 'pixels_changed_outside_band': bad_pixels})
