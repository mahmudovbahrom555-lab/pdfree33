#!/usr/bin/env python3
"""B1–B4, C1–C3 on the interleaved run (base2 / fix2, run_pair.sh), with B3 as approved by the
owner 2026-11-05: identical in content and structure except /ModDate and the second /ID — compared
after qpdf --qdf (objects uncompressed) with only those two blanked, plus no new qpdf/MuPDF errors.
python3 eval_bc2.py <cb-data>"""
import json, os, re, subprocess, sys, statistics, hashlib, tempfile
sys.path.insert(0, os.path.dirname(__file__))
from eval_bc import obj_xmp_bytes, render_text, qpdf_errs
import fitz
D = sys.argv[1]
def runs(log):
    r = {}
    for l in open(f'{D}/{log}'):
        try: j = json.loads(l)
        except Exception: continue
        if 'doc' in j and 'preset' in j:
            if 'outBytes' not in j and 'err' not in j: j['err'] = 'toast:' + str(j.get('toast'))[:60]
            r[(j['doc'], j['preset'])] = j
    return r
def norm(p):
    t = tempfile.mktemp(suffix='.pdf')
    subprocess.run(['qpdf', '--qdf', '--object-streams=disable', '--stream-data=uncompress', p, t], capture_output=True)
    b = open(t, 'rb').read(); os.remove(t)
    b = re.sub(rb'/ModDate \([^)]*\)', b'/ModDate ()', b); b = re.sub(rb'/ID \[<([0-9a-f]+)><[0-9a-f]+>\]', rb'/ID [<\1><>]', b)
    return hashlib.md5(b).hexdigest()
base, fix = runs('base2.log'), runs('fix2.log')
orig = {os.path.basename(p)[:-4]: p for p in open(f'{D}/all52.txt').read().split()}
res = {k: [] for k in ('B1', 'B2', 'B3', 'C1', 'C2', 'C3', 'errors', 'new_timeout_or_error')}
tb, tf, pairs = [], [], []
for doc in sorted(orig):
    src = orig[doc]; size = os.path.getsize(src); xmp = obj_xmp_bytes(src); has = xmp > 0
    for preset in ('auto', 'low', 'medium', 'high'):
        b, f = base.get((doc, preset)), fix.get((doc, preset))
        if not b or not f: res['errors'].append((doc, preset, 'missing row', bool(b), bool(f))); continue
        if 'err' in b or 'err' in f:
            res['errors'].append((doc, preset, b.get('err', 'ok')[:50], f.get('err', 'ok')[:50]))
            if 'err' in f and 'err' not in b: res['new_timeout_or_error'].append((doc, preset, f['err'][:60]))
            continue
        tb.append(b['ms']); tf.append(f['ms']); pairs.append(f['ms'] / b['ms'])
        bp, fp = f'{D}/base2/{doc}.{preset}.pdf', f'{D}/fix2/{doc}.{preset}.pdf'
        if f['outBytes'] > f['inBytes']: res['C1'].append((doc, preset, f['outBytes'], f['inBytes']))
        grew = b['outBytes'] > b['inBytes']
        if grew:   # C3: the input itself
            if not (os.path.exists(fp) and open(fp, 'rb').read() == open(src, 'rb').read()): res['C3'].append((doc, preset))
            continue
        strips = has and (preset in ('medium', 'high') or (preset == 'auto' and f.get('auto') in ('medium', 'high')))
        if strips:
            if xmp >= 0.01 * size and b['outBytes'] - f['outBytes'] < 0.9 * xmp:
                res['B1'].append((doc, preset, b['outBytes'] - f['outBytes'], xmp))
            nb, ib, tb_ = render_text(bp); nf, iF, tf_ = render_text(fp)
            if (nb, ib, tb_) != (nf, iF, tf_): res['B2'].append((doc, preset, 'pages' if nb != nf else 'render' if ib != iF else 'text'))
            new = [e for e in qpdf_errs(fp) if e not in qpdf_errs(bp)]
            if new: res['B2'].append((doc, preset, 'qpdf', new[:2]))
        else:      # B3 (approved wording) / C2: content and structure identical except /ModDate, /ID
            if norm(bp) != norm(fp): res['B3' if preset != 'low' else 'C2'].append((doc, preset, b['outBytes'], f['outBytes']))
            else:
                new = [e for e in qpdf_errs(fp) if e not in qpdf_errs(bp)]
                if new: res['B3'].append((doc, preset, 'qpdf', new[:2]))
    print(doc, 'object XMP bytes', xmp, flush=True)
xmp_docs = {d for d in orig if obj_xmp_bytes(orig[d]) > 0}
res['B4'] = {'median_ms_base': statistics.median(tb), 'median_ms_fix': statistics.median(tf),
             'change_%_of_medians': round(100 * (statistics.median(tf) - statistics.median(tb)) / statistics.median(tb), 1),
             'median_per_run_ratio': round(statistics.median(pairs), 3), 'runs': len(pairs)}
print(json.dumps({k: (v if isinstance(v, dict) else {'n': len(v), 'list': v[:15]}) for k, v in res.items()}, indent=1, default=str))
