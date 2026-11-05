#!/usr/bin/env python3
"""DEV grid for MRC-A (addendum B): every class-S doc × mask dpi {150,200,300} × background dpi
{50,75,100}, despeckled; writes <out>/<name>.M<mask>B<bg>.pdf and stats.jsonl (text-component
statistics per doc, at 300 dpi).

  python3 mrc_grid.py <S-dir> <out-dir>
"""
import sys, os, io, json
import fitz
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mrc_lib import mrc_pdf, ink_mask, despeckle, text_stats

S, OUT = sys.argv[1:3]
os.makedirs(OUT, exist_ok=True)
with open(f'{OUT}/stats.jsonl', 'w') as st:
    for m in json.load(open(f'{S}/manifest.json')):
        n = m['name']
        with fitz.open(f'{S}/{n}.pdf') as d:
            pg = d[0]; img = Image.open(io.BytesIO(d.extract_image(pg.get_images()[0][0])['image'])).convert('RGB')
            w, h = pg.rect.width, pg.rect.height
        st.write(json.dumps({'name': n, 'class': m['class'], **text_stats(despeckle(ink_mask(img)[3], 4))}) + '\n'); st.flush()
        for md in (150, 200, 300):
            for bd in (50, 75, 100):
                mrc_pdf(f'{OUT}/{n}.M{md}B{bd}.pdf', img, w, h, mask_dpi=md, bg_dpi=bd)
        print(n, flush=True)
