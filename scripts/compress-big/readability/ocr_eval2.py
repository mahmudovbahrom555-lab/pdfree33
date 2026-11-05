#!/usr/bin/env python3
"""Addendum A scoring: v1 CER and v2 order-insensitive recall for every variant of every class-S
document (orig, stage-1 dpi96/150/200 from <stage1-out>, G150/G200/X96/MRC from <variants>).
OCR text is cached in <cache> so a rerun with another metric needs no OCR.

  python3 ocr_eval2.py <S> <stage1-out> <variants> <cache> > rows2.jsonl
"""
import sys, os, json, re, subprocess, tempfile, unicodedata, glob, collections
import fitz
from rapidfuzz.distance import Levenshtein

S, ST1, VAR, CACHE = sys.argv[1:5]
os.makedirs(CACHE, exist_ok=True)
LANG = {'en': 'eng', 'zh': 'chi_sim', 'ru': 'rus'}


def ocr(pdf, lang, key):
    c = f'{CACHE}/{key}.txt'
    if os.path.exists(c): return open(c).read()
    with fitz.open(pdf) as d, tempfile.TemporaryDirectory() as tmp:
        out = []
        for i, pg in enumerate(d):
            png = f'{tmp}/p{i}.png'; pg.get_pixmap(dpi=300).save(png)
            out.append(subprocess.run(['tesseract', png, '-', '--psm', '3', '-l', LANG[lang]], capture_output=True, text=True).stdout)
    t = '\n'.join(out); open(c, 'w').write(t); return t


def cer(h, g, lang):
    f = lambda t: re.sub(r'\s+', '' if lang == 'zh' else ' ', unicodedata.normalize('NFC', t)).strip()
    return Levenshtein.distance(f(h), f(g)) / max(1, len(f(g)))


def units(t, lang):
    t = unicodedata.normalize('NFC', t).casefold()
    if lang == 'zh':
        c = re.sub(r'\s+', '', t)
        return collections.Counter(c[i:i + 2] for i in range(len(c) - 1))
    return collections.Counter(w for w in re.findall(r'\w+', t))


def recall(h, g, lang):
    G, Hh = units(g, lang), units(h, lang)
    return sum((G & Hh).values()) / max(1, sum(G.values()))


for m in json.load(open(f'{S}/manifest.json')):
    n, lang = m['name'], m['lang']
    gt = open(f'{S}/{n}.gt.txt').read()
    vs = [('orig', f'{S}/{n}.pdf')] + [(f'J{d}', f'{ST1}/{n}.dpi{d}.pdf') for d in (96, 150, 200)] \
         + [(t, f'{VAR}/{n}.{t}.pdf') for t in ('G150', 'G200', 'X96', 'MRC')]
    for tag, p in vs:
        if not os.path.exists(p): continue
        h = ocr(p, lang, f'{n}.{tag}')
        print(json.dumps({'name': n, 'class': m['class'], 'lang': lang, 'v': tag, 'bytes': os.path.getsize(p),
                          'cer': round(cer(h, gt, lang), 4), 'rec': round(recall(h, gt, lang), 4)}), flush=True)
