#!/usr/bin/env python3
"""For each file: pages where base (dedup by fingerprint) and fix (true duplicates only) render
differently (MuPDF, 72 dpi) — which is closer to the original? Closeness = pixels off by > 64/255."""
import sys, os, json, fitz, numpy as np
def pages(p, n=None):
    with fitz.open(p) as d:
        return [np.frombuffer(pg.get_pixmap(dpi=72).samples, np.uint8).reshape(pg.get_pixmap(dpi=72).h, -1) for pg in list(d)[:n]]
base, fix, files = sys.argv[1], sys.argv[2], sys.argv[3:]
tot = {'pages_differ': 0, 'fix_closer': 0, 'base_closer': 0, 'tie': 0}
for p in files:
    d = os.path.basename(p)[:-4]; b, f = f'{base}/{d}.medium.pdf', f'{fix}/{d}.medium.pdf'
    if not (os.path.exists(b) and os.path.exists(f)): print(d, 'missing output'); continue
    try: O, B, F = pages(p, 30), pages(b, 30), pages(f, 30)
    except Exception as e: print(d, 'ERR', e); continue
    for i, (o, bb, ff) in enumerate(zip(O, B, F)):
        if bb.shape != ff.shape or not np.array_equal(bb, ff):
            tot['pages_differ'] += 1
            if o.shape != bb.shape or o.shape != ff.shape: print(d, i + 1, 'shape differs'); continue
            eb, ef = int((np.abs(o.astype(int) - bb) > 64).sum()), int((np.abs(o.astype(int) - ff) > 64).sum())
            k = 'fix_closer' if ef < eb else 'base_closer' if eb < ef else 'tie'
            tot[k] += 1
            print(f'{d} p{i+1}: off-by>64 base {eb}  fix {ef}  → {k}', flush=True)
print('TOTAL', json.dumps(tot))
