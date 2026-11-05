#!/usr/bin/env python3
"""Simulates worker.js _deduplicateImages on each PDF (fingerprint = length + 5×128-byte windows,
canonical = first image object in object order, rewiring only page-level /Resources/XObject),
and classifies every merge: same dict + same bytes (harmless), different dict (C29), different
bytes (false fingerprint match). Also counts uncompressed DeviceCMYK images (no /Filter)."""
import os, sys, glob, pikepdf
from pikepdf import Name
def fp(c):
    n = len(c)
    if n == 0: return '0:0'
    h = n
    def sample(off):
        nonlocal h
        off = max(off, 0)
        for b in c[off:min(off + 128, n)]: h = (h * 31 + b) & 0xffffffff
    for off in (0, int(n * .25), int(n * .5), int(n * .75), n - 128): sample(off)
    return f'{n}:{h}'
def dkey(s):
    return repr(sorted((k, repr(s[k]) if not isinstance(s[k], (pikepdf.Stream, pikepdf.Dictionary, pikepdf.Array)) or not s[k].is_indirect else f'ref{s[k].objgen}') for k in s.keys() if k != '/Length'))
dirs = sys.argv[1:]
files = sorted({p for d in dirs for p in glob.glob(os.path.expanduser(d) + '/*.pdf')})
seen = set(); tot = {'files': 0, 'merge_ok': 0, 'C29_dict': 0, 'C29_bytes': 0, 'raw_cmyk_files': 0, 'raw_cmyk_bytes': 0}
for p in files:
    b = os.path.basename(p)
    if b in seen: continue
    seen.add(b)
    try: pdf = pikepdf.open(p)
    except Exception: continue
    tot['files'] += 1
    imgs = sorted([o for o in pdf.objects if isinstance(o, pikepdf.Stream) and o.get('/Subtype') == Name.Image], key=lambda o: o.objgen)
    canon, repl = {}, {}
    raw_cmyk = 0
    for o in imgs:
        try: c = o.read_raw_bytes()
        except Exception: continue
        if o.get('/ColorSpace') == Name.DeviceCMYK and '/Filter' not in o: raw_cmyk += len(c)
        k = fp(c)
        if k in canon: repl[o.objgen] = (canon[k], c)
        else: canon[k] = (o, c)
    if raw_cmyk: tot['raw_cmyk_files'] += 1; tot['raw_cmyk_bytes'] += raw_cmyk; print(f'RAWCMYK {b} {raw_cmyk/1e6:.2f} MB of {os.path.getsize(p)/1e6:.2f} MB', flush=True)
    done = set()
    for i, pg in enumerate(pdf.pages):
        xo = pg.obj.get('/Resources', {}).get('/XObject') if '/Resources' in pg.obj else None
        if xo is None: continue
        for name in xo.keys():
            v = xo[name]
            if not isinstance(v, pikepdf.Stream) or not v.is_indirect or v.objgen not in repl or (v.objgen, i) in done: continue
            done.add((v.objgen, i))
            (co, cc), c = repl[v.objgen]
            if cc != c: kind = 'C29_bytes'
            elif dkey(co) != dkey(v): kind = 'C29_dict'
            else: kind = 'merge_ok'
            tot[kind] += 1
            if kind != 'merge_ok':
                diff = sorted(set(k for k in set(co.keys()) | set(v.keys()) if k != '/Length' and (k not in co or k not in v or repr(co[k]) != repr(v[k]))))
                print(f'{kind} {b} p{i+1}{name} {v.objgen}->{co.objgen} {len(c)}B keys {diff[:6]}', flush=True)
print('TOTAL', tot)
