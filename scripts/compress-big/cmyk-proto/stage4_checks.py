#!/usr/bin/env python3
"""Stage 4 (PROTO-PREREG.md) integrity + worst-page checks, L (PDFree today) vs a D output dir.
  python3 stage4_checks.py <prod-dir> <d-dir> [<d200-dir>]   → one line per doc + BLOCKING list"""
import sys, os, glob, subprocess, hashlib, tempfile
import numpy as np, fitz, pikepdf
from PIL import Image
prod, ddir = sys.argv[1], sys.argv[2]; d200 = sys.argv[3] if len(sys.argv) > 3 else None
HERE = os.path.dirname(os.path.abspath(__file__))


def text_pages(p):
    with fitz.open(p) as d: return [pg.get_text() for pg in d]


def images(p):
    """xref → (colour space, smask sha or None) for every image XObject (by object number after save: compare by order of pages' use)."""
    out = []
    with pikepdf.open(p) as pdf:
        for i, page in enumerate(pdf.pages):
            for name, img in sorted(page.images.items()):
                cs = img.get('/ColorSpace'); cs = str(cs[0]) if isinstance(cs, pikepdf.Array) else str(cs)
                sm = img.get('/SMask')
                out.append((i, name, cs, hashlib.sha1(sm.read_raw_bytes()).hexdigest() if isinstance(sm, pikepdf.Stream) else None))
    return out


def gs_pages(p):
    r = subprocess.run(['gs', '-q', '-dNODISPLAY', '-dNOSAFER', '-c', f'({p}) (r) file runpdfbegin pdfpagecount = quit'], capture_output=True, text=True)
    try: return int(r.stdout.strip().split()[-1])
    except Exception: return None


def render(p, n=4):
    out = []
    with fitz.open(p) as d:
        for i in range(min(n, d.page_count)):
            pm = d[i].get_pixmap(dpi=50, colorspace=fitz.csCMYK, alpha=False)
            out.append(np.frombuffer(pm.samples, np.uint8).reshape(pm.height, pm.width, 4).astype(int))
    return out


def worst(a, b):
    return max(np.abs(x - y).mean() for x, y in zip(a, b)) if len(a) == len(b) and all(x.shape == y.shape for x, y in zip(a, b)) else None


block = []
for f in sorted(glob.glob(f'{prod}/*.auto.pdf')):
    doc = os.path.basename(f).split('.')[0]; o = f'{ddir}/{doc}.chain.pdf'
    probs = []
    with fitz.open(f) as a, fitz.open(o) as b:
        if a.page_count != b.page_count: probs.append(f'pages {a.page_count}≠{b.page_count}')
    if text_pages(f) != text_pages(o): probs.append('text layer differs')
    ia, ib = images(f), images(o)
    if len(ia) != len(ib): probs.append(f'image uses {len(ia)}≠{len(ib)}')
    else:
        if any(x[2] != y[2] for x, y in zip(ia, ib)): probs.append('a /ColorSpace changed')
        if any(x[3] != y[3] for x, y in zip(ia, ib)): probs.append('an SMask changed')
    g = gs_pages(o)
    if g is None: probs.append('Ghostscript cannot count pages')
    pj = subprocess.run(['node', f'{HERE}/pdfjs_pages.mjs', o], capture_output=True, text=True).stdout.strip()
    with fitz.open(o) as b: n = b.page_count
    if pj != str(n): probs.append(f'pdf.js pages {pj!r}≠{n}')
    rl = render(f); w = worst(rl, render(o)); w2 = worst(rl, render(f'{d200}/{doc}.chain.pdf')) if d200 else None
    if w is None: probs.append('render shape')
    elif d200 and w2 is not None and w > w2 + 1e-9: probs.append(f'worst-page |Δ| vs L {w:.2f} > D200 {w2:.2f} (explain)')
    print(doc, 'OK' if not probs else '; '.join(probs), f'| worst |Δ| vs L {w:.2f}' + (f' (D200 {w2:.2f})' if w2 is not None else ''), flush=True)
    if probs: block.append((doc, probs))
print('BLOCKING:', block or 'none')
