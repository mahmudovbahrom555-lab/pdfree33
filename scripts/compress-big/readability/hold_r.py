#!/usr/bin/env python3
"""HOLD-R scoring (addendum B): real scans, no ground truth. Each variant's OCR (eng, MuPDF 300 dpi)
against the OCR of the uncompressed page — metric v3 relative (weaker, labelled as such)."""
import sys, os, json, glob, subprocess, tempfile
import fitz
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from metrics_v3 import metrics
D, CACHE = sys.argv[1], sys.argv[2]   # D: dir with <name>.<variant>.pdf incl. .orig
os.makedirs(CACHE, exist_ok=True)


def ocr(pdf):
    key = f'{CACHE}/{os.path.basename(pdf)[:-4]}.txt'
    if os.path.exists(key): return open(key).read()
    with fitz.open(pdf) as d, tempfile.TemporaryDirectory() as tmp:
        out = []
        for i, pg in enumerate(d):
            png = f'{tmp}/p{i}.png'; pg.get_pixmap(dpi=300).save(png)
            out.append(subprocess.run(['tesseract', png, '-', '--psm', '3', '-l', 'eng'], capture_output=True, text=True).stdout)
    t = '\n'.join(out); open(key, 'w').write(t); return t


for orig in sorted(glob.glob(f'{D}/*.orig.pdf')):
    name = os.path.basename(orig)[:-9]
    ref = ocr(orig)
    for p in sorted(glob.glob(f'{D}/{name}.*.pdf')):
        v = os.path.basename(p)[len(name) + 1:-4]
        if v == 'orig': continue
        r = metrics(ocr(p), ref, 'en')
        print(json.dumps({'name': name, 'v': v, 'bytes': os.path.getsize(p), 'orig_chars': len(ref.strip()), **r}), flush=True)
