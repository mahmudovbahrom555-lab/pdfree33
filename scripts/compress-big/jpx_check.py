#!/usr/bin/env python3
"""JPX class acceptance (JPX-PREREG.md, criteria 1, 2, 3-colour) — production output vs the new build's output.

  python3 jpx_check.py <in-dir> <prod-dir> <new-dir> [<in-dir2> <prod-dir2> <new-dir2> ...]

Each *-dir holds <doc>.<preset>.pdf (run_compress.mjs) and results.jsonl.
 1. size: new <= prod for every doc and preset (and new <= input)
 2. page count and the text of every page (MuPDF) identical new vs prod
 3. colour: pages where an image changed between prod and new are rendered at 50 dpi (original vs new);
    mean CIEDE2000 over the page (sRGB → Lab) must be <= 2
"""
import sys, os, json, hashlib
import numpy as np
import fitz
from PIL import Image, ImageCms
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from d_metrics import de2000

SRGB = ImageCms.createProfile('sRGB'); LAB = ImageCms.createProfile('LAB')
TO_LAB = ImageCms.buildTransform(SRGB, LAB, 'RGB', 'LAB')


def lab(pix):
    im = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
    # PIL's LAB keeps a and b as SIGNED bytes (sRGB grey → a = b = 0), not offset by 128:
    # read them as int8. (d_metrics.to_lab subtracts 128 — reported to the owner 2026-11-10.)
    a = np.asarray(ImageCms.applyTransform(im, TO_LAB))
    return np.stack([a[..., 0].astype(np.float64) * 100 / 255, a[..., 1].view(np.int8).astype(np.float64), a[..., 2].view(np.int8).astype(np.float64)], -1)


def image_hashes(doc, pno):
    out = []
    for x in doc[pno].get_images(full=True):
        try: out.append(hashlib.md5(doc.xref_stream_raw(x[0]) or b'').hexdigest())
        except Exception: out.append('?')
    return sorted(out)


def check(inp, prod, new):
    rows = {}
    for l in open(os.path.join(new, 'results.jsonl')):
        d = json.loads(l); rows[(d['doc'], d['preset'])] = {'new': d}
    for l in open(os.path.join(prod, 'results.jsonl')):
        d = json.loads(l)
        if (d['doc'], d['preset']) in rows: rows[(d['doc'], d['preset'])]['prod'] = d
    fails = []; report = []
    for (doc, preset), r in sorted(rows.items()):
        n, p = r['new'], r.get('prod')
        if not p or 'outBytes' not in p or 'outBytes' not in n:
            report.append((doc, preset, 'no output', p and p.get('toast'), n.get('toast') or n.get('err'))); continue
        line = {'doc': doc, 'preset': preset, 'in': n['inBytes'], 'prod': p['outBytes'], 'new': n['outBytes']}
        if n['outBytes'] > p['outBytes']: fails.append(f'1 larger than prod: {doc} {preset} {p["outBytes"]} → {n["outBytes"]}')
        if n['outBytes'] > n['inBytes']: fails.append(f'1 larger than input: {doc} {preset}')
        o = fitz.open(os.path.join(inp, doc + '.pdf'))
        a = fitz.open(os.path.join(prod, f'{doc}.{preset}.pdf')); b = fitz.open(os.path.join(new, f'{doc}.{preset}.pdf'))
        if len(a) != len(b): fails.append(f'2 page count: {doc} {preset} {len(a)} vs {len(b)}')
        else:
            for i in range(len(a)):
                if a[i].get_text() != b[i].get_text(): fails.append(f'2 text differs: {doc} {preset} page {i + 1}'); break
        des = []
        for i in range(min(len(a), len(b))):
            if image_hashes(a, i) == image_hashes(b, i): continue
            po, pn = o[i].get_pixmap(dpi=50, alpha=False), b[i].get_pixmap(dpi=50, alpha=False)
            if (po.width, po.height) != (pn.width, pn.height): fails.append(f'3 render size: {doc} p{i + 1}'); continue
            des.append(float(de2000(lab(po), lab(pn)).mean()))
        if des:
            line['pages_changed'] = len(des); line['de_mean_max'] = round(max(des), 2); line['de_mean_avg'] = round(sum(des) / len(des), 2)
            if max(des) > 2: fails.append(f'3 ΔE2000 page mean {max(des):.2f} > 2: {doc} {preset}')
        report.append(line)
    return report, fails


if __name__ == '__main__':
    args = sys.argv[1:]; allrep = []; allfails = []
    for k in range(0, len(args), 3):
        rep, f = check(*args[k:k + 3]); allrep += rep; allfails += f
    tot = {}
    for x in allrep:
        if isinstance(x, dict):
            t = tot.setdefault(x['preset'], [0, 0, 0]); t[0] += x['in']; t[1] += x['prod']; t[2] += x['new']
            if x['new'] != x['prod'] or 'pages_changed' in x: print(json.dumps(x))
        else: print('NO OUTPUT', x)
    for p, (i, a, b) in tot.items(): print(f'TOTAL {p}: input {i / 1e6:.1f} MB, prod {a / 1e6:.1f} MB, new {b / 1e6:.1f} MB')
    print('FAILS:', len(allfails)); [print('  ' + f) for f in allfails]
