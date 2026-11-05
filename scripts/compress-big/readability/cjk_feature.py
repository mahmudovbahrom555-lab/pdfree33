#!/usr/bin/env python3
"""CJK-likeness of a scanned page from its ink mask (addendum B, DEV probe): inside each text line
(projection-profile lines, as line_stats.py), split by empty columns; share of pieces whose width is
0.7–1.2 × the line height (square blocks = Han/kana) among pieces wider than 0.25 × line height."""
import sys, os, io, json
import numpy as np, fitz
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mrc_lib import ink_mask, despeckle


def lines(mask):
    H, W = mask.shape
    rows = mask.sum(1) > 0.002 * W
    out, start = [], None
    for y, r in enumerate(list(rows) + [False]):
        if r and start is None: start = y
        elif not r and start is not None:
            if 4 <= y - start <= 0.08 * H: out.append((start, y))
            start = None
    return out


def squareness(mask):
    sq = tot = 0
    for a, b in lines(mask):
        lh = b - a; cols = mask[a:b].any(0)
        w, run = [], 0
        for c in list(cols) + [False]:
            if c: run += 1
            elif run: w.append(run); run = 0
        w = [x for x in w if x > 0.25 * lh]
        tot += len(w); sq += sum(0.7 * lh <= x <= 1.2 * lh for x in w)
    return sq / tot if tot else None, tot


S = sys.argv[1]
for m in json.load(open(f'{S}/manifest.json')):
    with fitz.open(f"{S}/{m['name']}.pdf") as d:
        img = Image.open(io.BytesIO(d.extract_image(d[0].get_images()[0][0])['image'])).convert('RGB')
    s, n = squareness(despeckle(ink_mask(img)[3], 4))
    print(json.dumps({'name': m['name'], 'class': m['class'], 'square_share': None if s is None else round(s, 3), 'pieces': n}), flush=True)
