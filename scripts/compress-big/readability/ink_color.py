#!/usr/bin/env python3
"""Coloured-ink share (addendum B, DEV probe): among ink-mask pixels, the share whose chroma
(max − min of RGB) > 80 — red stamps, blue signatures."""
import sys, os, io, json
import numpy as np, fitz
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mrc_lib import ink_mask, despeckle

S = sys.argv[1]
for m in json.load(open(f'{S}/manifest.json')):
    with fitz.open(f"{S}/{m['name']}.pdf") as d:
        img = Image.open(io.BytesIO(d.extract_image(d[0].get_images()[0][0])['image'])).convert('RGB')
    a, _, _, ink = ink_mask(img); ink = despeckle(ink, 4)
    chroma = a.max(-1) - a.min(-1)
    share = float((chroma[ink] > 80).mean()) if ink.any() else 0.0
    print(json.dumps({'name': m['name'], 'class': m['class'], 'color_ink': round(share, 4)}), flush=True)
