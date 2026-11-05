#!/usr/bin/env python3
"""Flate L held-out measurement (pre-registered in FLATE-L-PREREG.md). Prints per-file and pooled."""
import os, sys, glob, zlib, time, pikepdf
from pikepdf import Name
DEV = {os.path.basename(l.strip()) for l in open(os.path.expanduser('~/pdfree33/cb-data/all52.txt')) if l.strip()}
DIRS = ['/Users/murodjon/pdfree33/pdfree33/tests/corpus/real'] + [os.path.expanduser(d) for d in
        ('~/.cache/pdfree-corpus', '~/.cache/pdfree-corpus-reserve', '~/.cache/pdfree-corpus-en')]
mode = sys.argv[1] if len(sys.argv) > 1 else 'heldout'
files = sorted({p for d in DIRS for p in glob.glob(d + '/*.pdf')}) if mode == 'heldout' else \
        [l.strip() for l in open(os.path.expanduser('~/pdfree33/cb-data/all52.txt')) if l.strip()]
seen, tot = set(), {'old': 0, 6: 0, 9: 0}
nfiles, srcs, t0 = 0, set(), time.time()
for p in files:
    b = os.path.basename(p)
    if mode == 'heldout' and (b in DEV or b in seen): continue
    seen.add(b)
    raw = open(p, 'rb').read()
    if b'DeviceCMYK' not in raw: continue          # stream dicts are never in object streams
    try: pdf = pikepdf.open(p)
    except Exception: continue
    f = {'old': 0, 6: 0, 9: 0}; n = 0
    for o in pdf.objects:
        if not isinstance(o, pikepdf.Stream) or o.get('/Subtype') != Name.Image: continue
        if o.get('/ColorSpace') != Name.DeviceCMYK or int(o.get('/BitsPerComponent', 0)) != 8: continue
        if '/SMask' in o or '/Mask' in o or o.get('/Filter') != Name.FlateDecode: continue
        rb = o.read_raw_bytes()
        try: data = zlib.decompress(rb)
        except Exception:
            try: data = zlib.decompressobj().decompress(rb)
            except Exception: continue
        n += 1; f['old'] += len(rb)
        for lv in (6, 9):
            c = zlib.compress(data, lv)
            assert zlib.decompress(c) == data          # byte-identical, checked
            f[lv] += min(len(c), len(rb))
    if not n: continue
    nfiles += 1; srcs.add(os.path.dirname(p))
    for k in f: tot[k] += f[k]
    size = len(raw)
    print(f"{b:24} {n:5} str {f['old']/1e6:8.2f} MB  L6 {100*(1-f[6]/f['old']):5.1f}%  L9 {100*(1-f[9]/f['old']):5.1f}%  of file L9 {100*(f['old']-f[9])/size:5.2f}%  ({os.path.basename(os.path.dirname(p))})", flush=True)
if tot['old']:
    print(f"\n{mode}: {nfiles} files from {len(srcs)} folders; target streams {tot['old']/1e6:.1f} MB; "
          f"pooled L6 {100*(1-tot[6]/tot['old']):.1f}%  L9 {100*(1-tot[9]/tot['old']):.1f}%  ({time.time()-t0:.0f}s)")
else: print(mode, 'no target streams')
