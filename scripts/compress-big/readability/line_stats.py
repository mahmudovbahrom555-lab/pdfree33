#!/usr/bin/env python3
"""Line-height feature (addendum B, DEV): text lines from the horizontal projection profile of the
despeckled ink mask at 300 dpi. A line = a run of rows whose ink share > 0.2 % of the page width,
separated by gaps; runs shorter than 4 px or taller than 8 % of the page are dropped.
Per page: median / p10 line height and the line count.  python3 line_stats.py <S-dir> > lines.jsonl"""
import sys, os, io, json
import numpy as np, fitz
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mrc_lib import ink_mask, despeckle


def line_heights(mask):
    H, W = mask.shape
    rows = mask.sum(1) > 0.002 * W
    hs, run = [], 0
    for r in rows:
        if r: run += 1
        elif run: hs.append(run); run = 0
    if run: hs.append(run)
    return [h for h in hs if 4 <= h <= 0.08 * H]


S = sys.argv[1]
for m in json.load(open(f'{S}/manifest.json')):
    with fitz.open(f"{S}/{m['name']}.pdf") as d:
        pg = d[0]
        img = Image.open(io.BytesIO(d.extract_image(pg.get_images()[0][0])['image'])).convert('RGB')
    hs = line_heights(despeckle(ink_mask(img)[3], 4))
    print(json.dumps({'name': m['name'], 'class': m['class'], 'lines': len(hs),
                      'lh_med': float(np.median(hs)) if hs else 0, 'lh_p10': float(np.percentile(hs, 10)) if hs else 0}), flush=True)
