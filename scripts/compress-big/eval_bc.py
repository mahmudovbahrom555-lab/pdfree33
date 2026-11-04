#!/usr/bin/env python3
"""Pre-registered criteria B1–B4, C1–C3 (PLAN.md) on the 52 documents: baseline (local-run, cloud-run)
vs fix (fix-local, fix-cloud). Usage: python3 eval_bc.py <cb-data>"""
import json, os, re, subprocess, sys, statistics, hashlib
import numpy as np, fitz
D = sys.argv[1]
def runs(log):
    r = {}
    for l in open(f'{D}/{log}'):
        try: j = json.loads(l)
        except Exception: continue
        if 'doc' in j and 'preset' in j:
            if 'outBytes' not in j and 'err' not in j: j['err'] = 'toast:' + str(j.get('toast'))
            r[(j['doc'], j['preset'])] = j
    return r
def originals():
    o = {os.path.basename(p)[:-4]: p for p in open(f'{D}/local10.txt').read().split() if p.endswith('.pdf')}
    for f in os.listdir(f'{D}/docs'):
        if f.endswith('.pdf'): o[f[:-4]] = f'{D}/docs/{f}'
    return o
def obj_xmp_bytes(path):
    doc = fitz.open(path); cat = doc.pdf_catalog(); cat_meta = None
    k = doc.xref_get_key(cat, 'Metadata')
    if k[0] == 'xref': cat_meta = int(k[1].split()[0])
    n = 0
    for x in range(1, doc.xref_length()):
        try:
            if doc.xref_get_key(x, 'Type')[1] == '/Metadata' and x != cat_meta and doc.xref_is_stream(x):
                n += len(doc.xref_stream_raw(x))
        except Exception: pass
    return n
def render_text(path, pages=20):
    doc = fitz.open(path); idx = list(range(len(doc)))
    if len(idx) > pages: idx = [round(i * (len(doc) - 1) / (pages - 1)) for i in range(pages)]
    imgs = [hashlib.md5(doc[i].get_pixmap(dpi=72).samples).hexdigest() for i in idx]
    return len(doc), imgs, hashlib.md5(''.join(p.get_text() for p in doc).encode()).hexdigest()
def qpdf_errs(path):
    r = subprocess.run(['qpdf', '--check', path], capture_output=True, text=True)
    return sorted(set(l for l in (r.stdout + r.stderr).splitlines() if 'ERROR' in l.upper() or 'error' in l))
def out(kind, doc, preset):
    d = {'base-l': 'local-run', 'base-c': 'cloud-run', 'fix-l': 'fix-local', 'fix-c': 'fix-cloud'}[kind]
    p = f'{D}/{d}/{doc}.{preset}.pdf'
    return p if os.path.exists(p) else None
base = {**runs('local-run.log'), **runs('cloud-run.log')}; fix = {**runs('fix-local.log'), **runs('fix-cloud.log')}
orig = originals(); docs = sorted({d for d, _ in fix})
res = {'B1': [], 'B2': [], 'B3': [], 'C1': [], 'C2': [], 'C3': [], 'missing': []}
times_b, times_f = [], []
for doc in docs:
    src = orig.get(doc); loc = 'l' if doc in [os.path.basename(p)[:-4] for p in open(f'{D}/local10.txt').read().split()] else 'c'
    xmp = obj_xmp_bytes(src); size = os.path.getsize(src)
    for preset in ('auto', 'low', 'medium', 'high'):
        b, f = base.get((doc, preset)), fix.get((doc, preset))
        if not b or not f: res['missing'].append((doc, preset, bool(b), bool(f))); continue
        if 'err' in b or 'err' in f:
            res.setdefault('errors', []).append((doc, preset, 'base:' + b.get('err', 'ok')[:40], 'fix:' + f.get('err', 'ok')[:40]))
            if 'err' in f and 'err' not in b: res.setdefault('B4_new_timeout', []).append((doc, preset, f['err'][:60]))
            continue
        times_b.append(b['ms']); times_f.append(f['ms'])
        # C1–C3
        if f['outBytes'] > f['inBytes']: res['C1'].append((doc, preset, f['outBytes'], f['inBytes']))
        bp, fp = out('base-' + loc, doc, preset), out('fix-' + loc, doc, preset)
        if b['outBytes'] > b['inBytes']:
            if f['outBytes'] != f['inBytes']: res['C3'].append((doc, preset, 'output size != input', f['outBytes'], f['inBytes']))
            elif fp and open(fp, 'rb').read() != open(src, 'rb').read(): res['C3'].append((doc, preset, 'bytes differ from input'))
        if preset in ('medium', 'high'):
            if xmp >= 0.01 * size:   # B1/B2
                saved = b['outBytes'] - f['outBytes']
                if saved < 0.9 * xmp: res['B1'].append((doc, preset, 'saved', saved, 'xmp', xmp))
                if bp and fp:
                    nb, ib, tb = render_text(bp); nf, iF, tf = render_text(fp)
                    if nb != nf or ib != iF or tb != tf:
                        res['B2'].append((doc, preset, 'pages' if nb != nf else 'render' if ib != iF else 'text',
                                          sum(a != c for a, c in zip(ib, iF))))
                    eb, ef = qpdf_errs(bp), qpdf_errs(fp)
                    new = [e for e in ef if e not in eb]
                    if new: res['B2'].append((doc, preset, 'qpdf', new[:2]))
                    try: fitz.open(fp)
                    except Exception as e: res['B2'].append((doc, preset, 'mupdf', str(e)))
                else: res['missing'].append((doc, preset, 'file', bool(bp), bool(fp)))
            elif b['outBytes'] <= b['inBytes']:  # B3 (and C2)
                if f['outBytes'] != b['outBytes']: res['B3'].append((doc, preset, b['outBytes'], f['outBytes']))
                elif bp and fp and open(bp, 'rb').read() != open(fp, 'rb').read(): res['B3'].append((doc, preset, 'bytes'))
        if b['outBytes'] <= b['inBytes'] and not (preset in ('medium', 'high') and xmp >= 0.01 * size):
            if f['outBytes'] != b['outBytes']: res['C2'].append((doc, preset, b['outBytes'], f['outBytes']))
    print(doc, loc, 'xmp%', round(100 * xmp / size, 2), flush=True)
mb, mf = statistics.median(times_b), statistics.median(times_f)
res['B4'] = {'median_ms_base': mb, 'median_ms_fix': mf, 'change_%': round(100 * (mf - mb) / mb, 1)}
print(json.dumps({k: (v if isinstance(v, dict) else {'fails': len(v), 'list': v[:12]}) for k, v in res.items()}, indent=1, default=str))
