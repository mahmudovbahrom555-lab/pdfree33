#!/usr/bin/env python3
"""make_pagenum_fonts.py — small fonts for page-number labels (fonts/pagenum/).

Why: pdf-lib's subset embedding (subset: true, via @pdf-lib/fontkit) drops
glyphs from the Noto Sans TTFs — "第 1 页" came out as "第" alone while the
text layer still said "第 1 页" (seen on pdfree.io 2026-11-05; reproduced in
Node with every Noto file, static or variable, hinted or not). Embedding a
whole Noto font instead adds 1–11 MB to every numbered PDF. So the page-number
worker embeds these small fonts WHOLE (subset: false): the characters page
labels use — digits, Latin with every accent, Greek, Cyrillic, Vietnamese,
dashes, and the CJK/kana/Hangul words people put around page numbers. A label
with anything else is drawn as a picture by the worker (system fonts).

Source: js/vendor/noto/*.ttf (SIL OFL 1.1, see the .OFL.txt next to each),
instanced at Regular, hinting removed, layout features kept.
Run: python3 scripts/make_pagenum_fonts.py   (needs fonttools)
"""
import os
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'js', 'vendor', 'noto')
OUT = os.path.join(ROOT, 'fonts', 'pagenum')

def rng(a, b): return [chr(c) for c in range(a, b + 1)]
ASCII = rng(0x20, 0x7E)
PUNCT = list('—–‒−…·•‧‐‑‹›«»“”‘’„‚°№') + ['\u00A0', '\u2009', '\u202F']
LATIN = ASCII + rng(0xA0, 0x24F) + rng(0x300, 0x36F) + rng(0x370, 0x3FF) + rng(0x400, 0x4FF) + rng(0x1E00, 0x1EFF) + PUNCT
# words written around page numbers in Chinese and Japanese, and every kana
CJK = ASCII + PUNCT + list('第页頁共总總张張章节節卷冊册部篇面号號码碼次之的计計页数數頁數〜・ー、。：；（）【】「」《》〈〉／－') \
    + rng(0x3040, 0x309F) + rng(0x30A0, 0x30FF) + rng(0xFF01, 0xFF5E)
HANGUL = ASCII + PUNCT + list('페이지쪽면장권부편번호제총의') + rng(0x3131, 0x318E)
# (name, source, characters, keep layout features) — Latin keeps them for
# Vietnamese/combining accents, Devanagari and Thai need them to shape; CJK,
# kana and Hangul don't, and vertical metrics go too
FONTS = [
    ('latin', 'notosans-v42.ttf', LATIN, True),
    ('cjk',   'notosanssc-v40.ttf', CJK, False),
    ('kr',    'notosanskr-v39.ttf', HANGUL, False),
    ('deva',  'notosansdevanagari-v30.ttf', ASCII + PUNCT + rng(0x900, 0x97F) + rng(0xA8E0, 0xA8FF), True),
    ('thai',  'notosansthai-v29.ttf', ASCII + PUNCT + rng(0xE00, 0xE7F), True),
]

def main():
    os.makedirs(OUT, exist_ok=True)
    for name, src, chars, layout in FONTS:
        font = TTFont(os.path.join(SRC, src))
        if 'fvar' in font:
            axes = {a.axisTag: (400 if a.axisTag == 'wght' else a.defaultValue) for a in font['fvar'].axes}
            font = instancer.instantiateVariableFont(font, axes)
        opts = subset.Options()
        opts.layout_features = ['*'] if layout else []
        opts.drop_tables += [] if layout else ['vhea', 'vmtx', 'VORG', 'BASE']
        opts.hinting = False
        opts.name_IDs = ['*']
        opts.notdef_outline = True
        sub = subset.Subsetter(opts)
        sub.populate(unicodes=[ord(c) for c in chars])
        sub.subset(font)
        path = os.path.join(OUT, f'pagenum-{name}.ttf')
        font.save(path)
        print(f'{name}: {os.path.getsize(path) // 1024} KB, {len(font.getBestCmap())} characters')

if __name__ == '__main__':
    main()
