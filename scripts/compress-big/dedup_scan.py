#!/usr/bin/env python3
"""Simulates worker.js _deduplicateImages on each PDF (fingerprint = length + 5x128-byte windows,
canonical = first image object in object order, rewiring only page-level /Resources/XObject),
and classifies every merge: same dict + same bytes (harmless), different dict (C29), different
bytes (false fingerprint match). Also counts uncompressed DeviceCMYK images (no /Filter).
A file that fails is reported and skipped."""
import os, sys, glob, pikepdf
from pikepdf import Name


def fp(c):
    n = len(c)
    if n == 0: return '0:0'
    h = n
    for off in (0, int(n * .25), int(n * .5), int(n * .75), n - 128):
        off = max(off, 0)
        for b in c[off:min(off + 128, n)]: h = (h * 31 + b) & 0xffffffff
    return f'{n}:{h}'


def dkey(s):
    def v(x):
        if isinstance(x, (pikepdf.Stream, pikepdf.Dictionary, pikepdf.Array)) and x.is_indirect: return f'ref{x.objgen}'
        return repr(x)
    return repr(sorted((k, v(s[k])) for k in s.keys() if k != '/Length'))


def scan(b, p, pdf, tot):
    imgs = sorted([o for o in pdf.objects if isinstance(o, pikepdf.Stream) and o.get('/Subtype') == Name.Image], key=lambda o: o.objgen)
    canon, repl, raw_cmyk = {}, {}, 0
    for o in imgs:
        try: c = o.read_raw_bytes()
        except Exception: continue
        if o.get('/ColorSpace') == Name.DeviceCMYK and '/Filter' not in o: raw_cmyk += len(c)
        k = fp(c)
        if k in canon: repl[o.objgen] = (canon[k], c)
        else: canon[k] = (o, c)
    if raw_cmyk:
        tot['raw_cmyk_files'] += 1; tot['raw_cmyk_bytes'] += raw_cmyk
        print(f'RAWCMYK {b} {raw_cmyk/1e6:.2f} MB of {os.path.getsize(p)/1e6:.2f} MB', flush=True)
    done, hit = set(), False
    for i, pg in enumerate(pdf.pages):
        res = pg.obj.get('/Resources')
        xo = res.get('/XObject') if isinstance(res, pikepdf.Dictionary) else None
        if not isinstance(xo, pikepdf.Dictionary): continue
        for name in xo.keys():
            v = xo[name]
            if not isinstance(v, pikepdf.Stream) or not v.is_indirect or v.objgen not in repl or (v.objgen, i) in done: continue
            done.add((v.objgen, i))
            (co, cc), c = repl[v.objgen]
            kind = 'C29_bytes' if cc != c else 'C29_dict' if dkey(co) != dkey(v) else 'merge_ok'
            tot[kind] += 1
            if kind != 'merge_ok':
                hit = True
                diff = sorted(k for k in set(co.keys()) | set(v.keys()) if k != '/Length' and (k not in co or k not in v or repr(co[k]) != repr(v[k])))
                print(f'{kind} {b} p{i+1}{name} {v.objgen}->{co.objgen} {len(c)}B keys {diff[:6]}', flush=True)
    if hit: tot['files_hit'] += 1


tot = {'files': 0, 'files_hit': 0, 'errors': 0, 'merge_ok': 0, 'C29_dict': 0, 'C29_bytes': 0, 'raw_cmyk_files': 0, 'raw_cmyk_bytes': 0}
seen = set()
for p in sorted({p for d in sys.argv[1:] for p in glob.glob(os.path.expanduser(d) + '/*.pdf')}):
    b = os.path.basename(p)
    if b in seen: continue
    seen.add(b)
    try:
        with pikepdf.open(p) as pdf:
            tot['files'] += 1
            scan(b, p, pdf, tot)
    except Exception as e:
        tot['errors'] += 1
        print(f'ERROR {b} {type(e).__name__} {str(e)[:120]}', flush=True)
print('TOTAL', tot)
