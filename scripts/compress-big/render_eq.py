#!/usr/bin/env python3
"""Pairs base-X / L-X rendered by MuPDF, Poppler and Ghostscript at 50 dpi (first 6 pages): pixel-identical?"""
import sys, os, subprocess, tempfile, hashlib, fitz, glob
def mupdf(p):
    with fitz.open(p) as d: return [hashlib.sha256(pg.get_pixmap(dpi=50).samples).hexdigest() for pg in list(d)[:6]]
def poppler(p):
    with tempfile.TemporaryDirectory() as t:
        subprocess.run(['pdftoppm', '-r', '50', '-l', '6', p, t + '/x'], check=True, capture_output=True)
        return [hashlib.sha256(open(f, 'rb').read()).hexdigest() for f in sorted(glob.glob(t + '/x*'))]
def gs(p):
    with tempfile.TemporaryDirectory() as t:
        subprocess.run(['gs', '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=ppmraw', '-r50', '-dLastPage=6', f'-sOutputFile={t}/x%03d.ppm', p], check=True, capture_output=True)
        return [hashlib.sha256(open(f, 'rb').read()).hexdigest() for f in sorted(glob.glob(t + '/x*'))]
d = sys.argv[1]
for b in sys.argv[2:]:
    row = []
    for name, fn in (('MuPDF', mupdf), ('Poppler', poppler), ('Ghostscript', gs)):
        try:
            a, c = fn(f'{d}/base-{b}'), fn(f'{d}/L-{b}')
            row.append(f"{name} {'same' if a == c and a else 'DIFF'}({len(a)}p)")
        except Exception as e: row.append(f'{name} ERR {str(e)[:40]}')
    print(f'{b:24}', ' | '.join(row), flush=True)
