#!/usr/bin/env python3
"""Stage 3b: list the images the Stage 2 chain DOWNSAMPLES in the given PDFs (same scope + dpi rule as
chain_run.py), with a thumbnail and a 1:1 crop of the busiest region for labelling by eye.
  python3 s3b_list.py <prod-dir> <out-dir>   → <out-dir>/images.json + thumbs/<doc>-<xref>.png"""
import sys, os, json, glob
import numpy as np, fitz, pikepdf
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chain_run import scope, largest_rects, TARGET, THRESHOLD

src_dir, out = sys.argv[1], sys.argv[2]
rows = []
for f in sorted(glob.glob(f'{src_dir}/*.auto.pdf')):
    doc = os.path.basename(f).split('.')[0]
    rects = largest_rects(f)
    pdf = pikepdf.open(f)
    smasks = {int(o.SMask.objgen[0]) for o in pdf.objects if isinstance(o, pikepdf.Stream) and isinstance(o.get('/SMask'), pikepdf.Stream)}
    with fitz.open(f) as d:
        for o in pdf.objects:
            if not (isinstance(o, pikepdf.Stream) and o.get('/Subtype') == pikepdf.Name.Image): continue
            xr = o.objgen[0]
            if xr in smasks or isinstance(scope(o), str): continue
            w = int(o.Width); pw = rects.get(xr, (0, 0))[0]
            if pw <= 0: continue
            eff = w / (pw / 72)
            if eff <= THRESHOLD: continue
            try:
                pm = fitz.Pixmap(d, xr)
                if pm.n - pm.alpha != 3: pm = fitz.Pixmap(fitz.csRGB, pm)
                im = Image.frombytes('RGB', (pm.width, pm.height), pm.samples) if not pm.alpha else Image.frombytes('RGBA', (pm.width, pm.height), pm.samples).convert('RGB')
            except Exception as e:
                continue
            g = np.asarray(im.convert('L')).astype(float)
            # busiest 256×256 region by gradient energy
            gy, gx = np.abs(np.diff(g, axis=0))[:, :-1], np.abs(np.diff(g, axis=1))[:-1, :]
            e = gy + gx; c = min(256, e.shape[0], e.shape[1])
            ii = e.cumsum(0).cumsum(1); best = (-1, 0, 0)
            for y in range(0, e.shape[0] - c + 1, 32):
                for x in range(0, e.shape[1] - c + 1, 32):
                    s = ii[y + c - 1, x + c - 1] - (ii[y - 1, x + c - 1] if y else 0) - (ii[y + c - 1, x - 1] if x else 0) + (ii[y - 1, x - 1] if x and y else 0)
                    if s > best[0]: best = (s, x, y)
            _, x, y = best
            th = im.copy(); th.thumbnail((360, 360))
            cv = Image.new('RGB', (360 + 8 + c, max(360, c)), 'white'); cv.paste(th, (0, 0)); cv.paste(im.crop((x, y, x + c, y + c)), (368, 0))
            name = f'{doc}-{xr}'
            cv.save(f'{out}/thumbs/{name}.png')
            rows.append({'id': name, 'doc': doc, 'xref': xr, 'w': w, 'h': int(o.Height), 'eff_dpi': round(eff), 'bytes': len(o.read_raw_bytes()),
                         'cs': str(o.ColorSpace), 'busy': [x, y, c]})
json.dump(rows, open(f'{out}/images.json', 'w'), indent=1)
print(len(rows), 'downsampled images,', round(sum(r['bytes'] for r in rows) / 1e6, 1), 'MB')
