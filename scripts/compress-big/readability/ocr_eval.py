#!/usr/bin/env python3
"""CER/WER of Tesseract on compressed synthetic scans vs the exact ground truth (prereg class S).

For each document: the uncompressed scan and each <name>.dpi<N>.pdf are rendered at 300 dpi and
read by Tesseract 5 (--psm 3, eng / chi_sim / rus by the document's language). CER and WER are
against <name>.gt.txt (NFC, whitespace collapsed; zh: CER only, WER not meaningful). Also the
effective DPI of the compressed page image (pixels / placed size in inches, MuPDF image rects).

  python3 ocr_eval.py <S-dir> <out-dir> > rows.jsonl
"""
import sys, os, json, re, subprocess, tempfile, unicodedata, glob
import fitz
from rapidfuzz.distance import Levenshtein

S, OUT = sys.argv[1], sys.argv[2]
LANG = {'en': 'eng', 'zh': 'chi_sim', 'ru': 'rus'}


def norm(t, lang):
    t = unicodedata.normalize('NFC', t)
    t = re.sub(r'\s+', '' if lang == 'zh' else ' ', t).strip()
    return t


def ocr(pdf, lang):
    with fitz.open(pdf) as d, tempfile.TemporaryDirectory() as tmp:
        txt = []
        for i, pg in enumerate(d):
            png = f'{tmp}/p{i}.png'; pg.get_pixmap(dpi=300).save(png)
            r = subprocess.run(['tesseract', png, '-', '--psm', '3', '-l', LANG[lang]], capture_output=True, text=True)
            txt.append(r.stdout)
        return '\n'.join(txt)


def eff_dpi(pdf):
    with fitz.open(pdf) as d:
        vals = []
        for pg in d:
            for info in pg.get_image_info():
                bw = info['bbox'][2] - info['bbox'][0]
                if bw > 1: vals.append(round(info['width'] / (bw / 72)))
        return min(vals) if vals else None


def scores(hyp, gt, lang):
    h, g = norm(hyp, lang), norm(gt, lang)
    cer = Levenshtein.distance(h, g) / max(1, len(g))
    wer = None if lang == 'zh' else Levenshtein.distance(h.split(), g.split()) / max(1, len(g.split()))
    return cer, wer


man = json.load(open(f'{S}/manifest.json'))
for m in man:
    gt = open(f"{S}/{m['name']}.gt.txt").read()
    variants = [('orig', f"{S}/{m['name']}.pdf")] + [(f'dpi{p.split(".dpi")[1][:-4]}', p) for p in sorted(glob.glob(f"{OUT}/{m['name']}.dpi*.pdf"))]
    for tag, p in variants:
        cer, wer = scores(ocr(p, m['lang']), gt, m['lang'])
        print(json.dumps({'name': m['name'], 'class': m['class'], 'lang': m['lang'], 'variant': tag,
                          'bytes': os.path.getsize(p), 'eff_dpi': eff_dpi(p), 'cer': round(cer, 4),
                          'wer': None if wer is None else round(wer, 4)}), flush=True)
