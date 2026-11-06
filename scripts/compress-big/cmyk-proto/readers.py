#!/usr/bin/env python3
"""Q3: what each reader/decoder makes of the control images (PROTO-PREREG.md). Patch-centre means
(inner 16×16 of each 32-px patch) compared with the known ink values.
  python3 readers.py <ctl-dir> <pdfjs-dump-dir>"""
import sys, os, io, json, glob, subprocess, tempfile, numpy as np, fitz
from PIL import Image
C, PJ = sys.argv[1], sys.argv[2]
P = 32
R = np.load(f'{C}/truth_cmyk.npy').astype(int); G = np.load(f'{C}/truth_gray.npy').astype(int)

def centres(a):
    """mean over the inner 16×16 of every 32×32 patch (the stroke row's patches 3–4 skipped)."""
    out = []
    for py in range(a.shape[0] // P):
        for px in range(a.shape[1] // P):
            if a.ndim == 3 and py == 4 and px >= 3: continue
            out.append(a[py * P + 8:py * P + 24, px * P + 8:px * P + 24].reshape(-1, *a.shape[2:]).mean(0))
    return np.array(out)

def gs_ink(pdf, nc):
    with tempfile.TemporaryDirectory() as t:
        if nc == 1:
            subprocess.run(['gs', '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=tiffgray', '-r72', f'-sOutputFile={t}/p.tif', pdf], check=True)
            return np.asarray(Image.open(f'{t}/p.tif')).astype(int)
        subprocess.run(['gs', '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=tiff32nc', '-r72', f'-sOutputFile={t}/p.tif', pdf], check=True)
        return np.asarray(Image.open(f'{t}/p.tif')).astype(int)   # tiff32nc samples = ink amounts

def mu_ink(pdf, nc):
    with fitz.open(pdf) as d:
        pm = d[0].get_pixmap(dpi=72, colorspace=fitz.csGRAY if nc == 1 else fitz.csCMYK, alpha=False)
        return np.frombuffer(pm.samples, np.uint8).reshape(pm.height, pm.width, pm.n).astype(int).squeeze()

rows = []
for name, t in json.load(open(f'{C}/truth.json')).items():
    nc = 1 if t['cs'] == 'gray' else 4; truth = centres(G if nc == 1 else R)
    got = {'ghostscript': gs_ink(f'{C}/{name}.pdf', nc), 'mupdf': mu_ink(f'{C}/{name}.pdf', nc)}
    pim = Image.open(f'{C}/{name}.jpg'); got['pillow(raw read)'] = np.asarray(pim).astype(int)
    pj = f'{PJ}/{name}.jpg.pdfjs.bin'
    if os.path.exists(pj): got['pdf.js decoder(raw)'] = np.frombuffer(open(pj, 'rb').read(), np.uint8).astype(int).reshape(t['h'], t['w'], *([nc] if nc > 1 else []))
    for k, a in got.items():
        c = centres(a); d = np.abs(c - truth); di = np.abs((255 - c) - truth)
        rows.append((name, k, round(float(d.max()), 1), round(float(di.max()), 1)))
for r in rows: print(f'{r[0]:14} {r[1]:22} max|Δ| as given {r[2]:6}   as inverted {r[3]:6}')
