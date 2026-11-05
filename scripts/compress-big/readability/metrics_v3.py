#!/usr/bin/env python3
"""Metric v3 (addendum B, TARGET-SIZE-MEASURE-PREREG.md): CharRecall, CharPrecision (multiset),
zh BigramRecall, CER / WER — each a separate number. Importable; as a script it scores cached OCR:

  python3 metrics_v3.py <S-dir> <ocr-cache> > v3.jsonl     (cache files: <name>.<variant>.txt)
"""
import sys, os, re, json, glob, unicodedata, collections
from rapidfuzz.distance import Levenshtein


def norm_chars(t, lang):
    t = unicodedata.normalize('NFKC', t).casefold()
    return ''.join(c for c in t if not c.isspace() and not unicodedata.category(c).startswith('P'))


def words(t):
    return re.findall(r'\w+', unicodedata.normalize('NFKC', t).casefold())


def bag(seq):
    return collections.Counter(seq)


def metrics(hyp, gt, lang):
    h, g = norm_chars(hyp, lang), norm_chars(gt, lang)
    H, G = bag(h), bag(g)
    inter = sum((H & G).values())
    out = {'char_recall': inter / max(1, len(g)), 'char_precision': inter / max(1, len(h)),
           'cer': Levenshtein.distance(h, g) / max(1, len(g))}
    if lang == 'zh':
        Hb, Gb = bag(h[i:i + 2] for i in range(len(h) - 1)), bag(g[i:i + 2] for i in range(len(g) - 1))
        out['bigram_recall'] = sum((Hb & Gb).values()) / max(1, sum(Gb.values()))
    else:
        hw, gw = words(hyp), words(gt)
        out['wer'] = Levenshtein.distance(hw, gw) / max(1, len(gw))
    return {k: round(v, 4) for k, v in out.items()}


if __name__ == '__main__':
    S, CACHE = sys.argv[1:3]
    man = {m['name']: m for m in json.load(open(f'{S}/manifest.json'))}
    for f in sorted(glob.glob(f'{CACHE}/*.txt')):
        name, variant = os.path.basename(f)[:-4].rsplit('.', 1)
        if name not in man: continue
        m = man[name]
        r = metrics(open(f).read(), open(f'{S}/{name}.gt.txt').read(), m['lang'])
        print(json.dumps({'name': name, 'class': m['class'], 'lang': m['lang'], 'v': variant, **r}))
