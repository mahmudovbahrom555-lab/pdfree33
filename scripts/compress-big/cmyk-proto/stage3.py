#!/usr/bin/env python3
"""Stage 3 (PROTO-PREREG.md): known-good / known-bad encodings of the Stage 3 controls through the chain,
then G1/G2 (encoding error, same decoder: pdf.js) and G3 (ink kept along lines and glyphs).
  QPDF_DIR=… python3 stage3.py <ctl3-dir>   → <ctl3-dir>/stage3.json + a printed table
"""
import sys, os, json, subprocess
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
D = sys.argv[1]
man = json.load(open(f'{D}/manifest.json'))
VARIANTS = {'good': (200, 75, 0), 'bad-q30': (200, 30, 0), 'bad-shift2': (200, 75, 2), 'bad-72dpi': (72, 75, 0)}
if os.environ.get('S3_D300'):   # Stage 4: the same controls at 300 dpi (G3 only)
    VARIANTS = {'good': (300, 75, 0)}


def load(path, w, h, nc):
    a = np.fromfile(path, np.uint8)
    return a.reshape(h, w, nc) if nc == 4 else a.reshape(h, w)


def run_chain(var, dpi, q, shift):
    out = f'{D}/{var}'; os.makedirs(out, exist_ok=True); jobs = []
    for it in man['images']:
        src = f"{D}/{it['name']}.raw"
        if shift:
            a = np.roll(load(src, it['w'], it['h'], it['nc']), shift, axis=1); src = f"{out}/{it['name']}.src.raw"; a.tofile(src)
        s = dpi / it['ppi']
        jobs.append({'id': it['name'], 'kind': 'raw', 'src': src, 'w': it['w'], 'h': it['h'], 'nc': it['nc'], 'invert': False,
                     'nw': max(1, round(it['w'] * s)), 'nh': max(1, round(it['h'] * s))})
    json.dump(jobs, open(f'{out}/jobs.json', 'w'))
    env = {**os.environ, 'Q': str(q), 'DUMP': '1'}
    subprocess.run(['node', f'{HERE}/chain.mjs', f'{out}/jobs.json', out], check=True, env=env, capture_output=True)
    return {r['id']: r for r in json.load(open(f'{out}/results.json'))}


def decode(jpg, out_raw):
    subprocess.run(['node', f'{HERE}/dec1.mjs', f'{HERE}/node_modules/pdfjs-dist/image_decoders/pdf.image_decoders.mjs', jpg, out_raw], check=True, capture_output=True)


def blocks(before, after):
    a, b = before.astype(float), after.astype(float)
    if a.ndim == 2: a, b = a[..., None], b[..., None]
    h, w = a.shape[0] // 8 * 8, a.shape[1] // 8 * 8
    d = np.abs(a[:h, :w] - b[:h, :w]).reshape(h // 8, 8, w // 8, 8, -1).mean((1, 3))
    return float(d.max()), float(np.percentile(d, 99.9))


res = {'G12': {}, 'G3': []}
good_ds = {}
for var, (dpi, q, shift) in VARIANTS.items():
    r = run_chain(var, dpi, q, shift)
    for it in man['images']:
        n = it['name']; x = r[n]
        if x.get('skip'): res['G12'].setdefault(var, {})[n] = {'skip': x['skip']}; continue
        w, h, nc = x['w'], x['h'], it['nc']
        decode(f'{D}/{var}/{n}.jpg', f'{D}/{var}/{n}.dec.raw')
        after = load(f'{D}/{var}/{n}.dec.raw', w, h, nc)
        ds = load(f'{D}/{var}/{n}.ds.raw', w, h, nc)
        if var == 'good': good_ds[n] = ds
        before = good_ds[n] if var == 'bad-shift2' else ds      # the shift is judged against the unshifted image
        g1, g2 = blocks(before, after)
        res['G12'].setdefault(var, {})[n] = {'G1': round(g1, 2), 'G2': round(g2, 2), 'bytes': x['bytes']}
        if var in ('good', 'bad-72dpi'):
            src = load(f"{D}/{n}.raw", it['w'], it['h'], nc)
            sx, sy = w / it['w'], h / it['h']
            for el in man['elements']:
                if el['img'] != n: continue
                x0, y0, x1, y1 = el['box']
                s = src[y0:y1, x0:x1].reshape(-1, nc).astype(float)
                o = after[int(y0 * sy):max(int(y0 * sy) + 1, int(np.ceil(y1 * sy))), int(x0 * sx):max(int(x0 * sx) + 1, int(np.ceil(x1 * sx)))].reshape(-1, nc).astype(float)
                ch = int(s.max(0).argmax())            # the element's main ink
                peak_s, peak_o = np.percentile(s[:, ch], 99.5), np.percentile(o[:, ch], 99.5)
                res['G3'].append({'variant': var, 'img': n, 'kind': el['kind'], 'ink_kept_pct': round(100 * peak_o / peak_s, 1) if peak_s else None})
json.dump(res, open(f'{D}/stage3.json', 'w'), indent=1)
for var in VARIANTS:
    v = res['G12'][var]
    print(f"{var:11} G1 " + ' '.join(f"{k.split('-')[0][:5]}{k.split('-')[-1][:3]}:{v[k].get('G1')}" for k in v))
    print(f"{'':11} G2 " + ' '.join(f"{k.split('-')[0][:5]}{k.split('-')[-1][:3]}:{v[k].get('G2')}" for k in v))
