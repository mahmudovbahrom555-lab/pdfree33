#!/usr/bin/env python3
"""Stage 3b (PROTO-PREREG.md): for each downsampled image, the chain at 200 dpi, 300 dpi and no
downsampling (sizes + ink kept in the busiest region), and classifier v0 vs the eye labels.
  QPDF_DIR=… python3 s3b_run.py <prod-dir> <s3b-dir>"""
import sys, os, json, subprocess, collections
import numpy as np, pikepdf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chain_run import scope, largest_rects
HERE = os.path.dirname(os.path.abspath(__file__))
prod, S = sys.argv[1], sys.argv[2]
rows = json.load(open(f'{S}/images.json')); labels = {x['id']: x['label'] for x in json.load(open(f'{HERE}/s3b-labels.json'))}
VAR = {'d200': 200, 'd300': 300, 'none': None}


def classify_v0(a):
    """Fixed before looking (prereg): DETAIL if (flat >= 0.5 and edges >= 0.02) or colours <= 64."""
    a3 = a if a.ndim == 3 else a[..., None]
    h, w = a3.shape[0] // 8 * 8, a3.shape[1] // 8 * 8
    b = a3[:h, :w].astype(float).reshape(h // 8, 8, w // 8, 8, -1)
    flat = float((b.std((1, 3)).max(-1) < 2).mean()) if h and w else 0.0
    gx = np.abs(np.diff(a3.astype(int), axis=1)).max(-1); gy = np.abs(np.diff(a3.astype(int), axis=0)).max(-1)
    edges = float(((gx[:-1, :] > 64) | (gy[:, :-1] > 64)).mean())
    q = (a3 // 16).reshape(-1, a3.shape[-1])
    colours = len(np.unique(q.view(np.dtype((np.void, q.dtype.itemsize * q.shape[1])))))
    det = (flat >= 0.5 and edges >= 0.02) or colours <= 64
    return ('DETAIL' if det else 'PHOTO'), {'flat': round(flat, 3), 'edges': round(edges, 4), 'colours': colours}


jobs = {v: [] for v in VAR}; meta = {}
os.makedirs(f'{S}/work', exist_ok=True)
for r in rows:
    pdf = pikepdf.open(f"{prod}/{r['doc']}.auto.pdf"); o = pdf.get_object(r['xref'], 0)
    kind, nc, inv = scope(o)
    p = f"{S}/work/{r['id']}.{'jpg' if kind == 'dct' else 'raw'}"
    open(p, 'wb').write(o.read_raw_bytes() if kind == 'dct' else o.read_bytes())
    w, h = int(o.Width), int(o.Height); eff = r['eff_dpi']
    for v, dpi in VAR.items():
        nw, nh = (max(1, round(w * dpi / eff)), max(1, round(h * dpi / eff))) if dpi and eff > dpi * 1.1 else (w, h)
        jobs[v].append({'id': r['id'], 'kind': kind, 'src': p, 'w': w, 'h': h, 'nc': nc, 'invert': inv, 'nw': nw, 'nh': nh})
    meta[r['id']] = {'nc': nc, 'w': w, 'h': h, 'orig_bytes': r['bytes']}
res = {}
for v in VAR:
    d = f'{S}/work/{v}'; os.makedirs(d, exist_ok=True)
    json.dump(jobs[v], open(f'{d}/jobs.json', 'w'))
    subprocess.run(['node', f'{HERE}/chain.mjs', f'{d}/jobs.json', d], check=True, capture_output=True, env={**os.environ, 'DUMP': '1'})
    res[v] = {x['id']: x for x in json.load(open(f'{d}/results.json'))}


def load(path, w, h, nc):
    a = np.fromfile(path, np.uint8); return a.reshape(h, w, nc) if nc == 4 else a.reshape(h, w)


out = []
for r in rows:
    i, m = r['id'], meta[r['id']]
    if res['none'][i].get('skip'): out.append({'id': i, 'skip': res['none'][i]['skip']}); continue
    src = load(f"{S}/work/none/{i}.ds.raw", m['w'], m['h'], m['nc'])
    cls, feats = classify_v0(src)
    x, y, c = r['busy']
    rec = {'id': i, 'label': labels[i], 'v0': cls, **feats, 'orig_bytes': m['orig_bytes']}
    for v in VAR:
        z = res[v][i]
        if z.get('skip'): rec[v] = {'skip': z['skip']}; continue
        subprocess.run(['node', f'{HERE}/dec1.mjs', f'{HERE}/node_modules/pdfjs-dist/image_decoders/pdf.image_decoders.mjs', f'{S}/work/{v}/{i}.jpg', f'{S}/work/{v}/{i}.dec.raw'], check=True, capture_output=True)
        dec = load(f'{S}/work/{v}/{i}.dec.raw', z['w'], z['h'], m['nc'])
        sx, sy = z['w'] / m['w'], z['h'] / m['h']
        s_reg = src[y:y + c, x:x + c].reshape(-1, m['nc']).astype(float)
        o_reg = dec[int(y * sy):int(np.ceil((y + c) * sy)), int(x * sx):int(np.ceil((x + c) * sx))].reshape(-1, m['nc']).astype(float)
        ch = int(np.percentile(s_reg, 99.5, axis=0).argmax())
        ps, po = np.percentile(s_reg[:, ch], 99.5), np.percentile(o_reg[:, ch], 99.5)
        # the encoded size counts only when smaller than the original (rule C)
        rec[v] = {'bytes': min(z['bytes'], m['orig_bytes']), 'ink_kept_pct': round(100 * po / ps, 1) if ps else None}
    out.append(rec)
json.dump(out, open(f'{S}/s3b.json', 'w'), indent=1)
ok = [o for o in out if 'skip' not in o]
print('images', len(out), 'measured', len(ok))
by = collections.defaultdict(lambda: collections.Counter())
for o in ok:
    b = by[o['label']]; b['n'] += 1; b['orig'] += o['orig_bytes']
    for v in VAR: b[v] += o[v].get('bytes', o['orig_bytes'])
print('label   n   orig MB  d200 MB  d300 MB  none MB')
for k, b in sorted(by.items()): print(f"{k:7} {b['n']:3} {b['orig']/1e6:8.2f} {b['d200']/1e6:8.2f} {b['d300']/1e6:8.2f} {b['none']/1e6:8.2f}")
conf = collections.Counter((o['label'], o['v0']) for o in ok); print('confusion (label, v0):', dict(conf))
print('MISSES (DETAIL/MIXED called PHOTO):', [o['id'] for o in ok if o['label'] in ('DETAIL', 'MIXED') and o['v0'] == 'PHOTO'])
print('PHOTO called DETAIL:', [o['id'] for o in ok if o['label'] == 'PHOTO' and o['v0'] == 'DETAIL'])
