#!/usr/bin/env python3
"""OCR every <name>.<variant>.pdf in a directory (MuPDF render 300 dpi, or Ghostscript with --gs),
cache the text, score with metric v3 against <S>/<name>.gt.txt (or, with --ref <cache> --ref-variant
orig, against another OCR text for real scans without ground truth).

  python3 ocr_dir.py <S-dir> <pdf-dir> <cache> [--gs] > rows.jsonl
"""
import sys, os, json, glob, subprocess, tempfile
import fitz
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from metrics_v3 import metrics
LANG = {'en': 'eng', 'zh': 'chi_sim', 'ru': 'rus'}
S, D, CACHE = sys.argv[1:4]; GS = '--gs' in sys.argv
os.makedirs(CACHE, exist_ok=True)
man = {m['name']: m for m in json.load(open(f'{S}/manifest.json'))}


def render(pdf, tmp):
    if GS:
        subprocess.run(['gs', '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=png16m', '-r300', f'-sOutputFile={tmp}/p%03d.png', pdf], check=True, capture_output=True)
        return sorted(glob.glob(f'{tmp}/p*.png'))
    with fitz.open(pdf) as d:
        out = []
        for i, pg in enumerate(d): p = f'{tmp}/p{i:03d}.png'; pg.get_pixmap(dpi=300).save(p); out.append(p)
        return out


for pdf in sorted(glob.glob(f'{D}/*.pdf')):
    name, variant = os.path.basename(pdf)[:-4].rsplit('.', 1)
    if name not in man: continue
    m = man[name]; key = f'{CACHE}/{name}.{variant}{".gs" if GS else ""}.txt'
    if not os.path.exists(key):
        with tempfile.TemporaryDirectory() as tmp:
            txt = '\n'.join(subprocess.run(['tesseract', p, '-', '--psm', '3', '-l', LANG[m['lang']]], capture_output=True, text=True).stdout for p in render(pdf, tmp))
        open(key, 'w').write(txt)
    r = metrics(open(key).read(), open(f'{S}/{name}.gt.txt').read(), m['lang'])
    print(json.dumps({'name': name, 'class': m['class'], 'lang': m['lang'], 'v': variant, 'engine': 'gs' if GS else 'mupdf', 'bytes': os.path.getsize(pdf), **r}), flush=True)
