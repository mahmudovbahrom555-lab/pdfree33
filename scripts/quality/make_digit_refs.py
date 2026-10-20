# SPDX-License-Identifier: AGPL-3.0-only
"""Builds scripts/quality/digit_refs.npz — the reference digits digits.py
matches page glyphs against (metric v5, class C4).

Each font's Latin, Arabic-Indic and Persian digits, drawn by Pillow and
normalized like a page glyph (digits.normalize); relh is a glyph's height
over the tallest digit of its script in its font. Fonts: open-licensed
(SIL OFL / Apache) from github.com/google/fonts — only the 24×24 pictures
are kept. Needs Pillow and fontTools (to know which digits a font has).

  python3 scripts/quality/make_digit_refs.py <font.ttf>...
"""
import os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import digits  # noqa: E402

vals, relh, imgs, used = [], [], [], []
for path in sys.argv[1:]:
    cmap = TTFont(path, lazy=True).getBestCmap() or {}
    font = ImageFont.truetype(path, 120)
    n0 = len(vals)
    for base in digits.BASES:
        if not all(base + k in cmap for k in range(10)):
            continue
        drawn = []
        for k in range(10):
            im = Image.new('L', (260, 260), 0)
            ImageDraw.Draw(im).text((60, 40), chr(base + k), font=font, fill=255)
            img, h = digits.normalize(np.array(im) > 128)
            if img is not None:
                drawn.append((k, img, h))
        tallest = max(h for _, _, h in drawn)
        for k, img, h in drawn:
            vals.append(k); relh.append(round(255 * h / tallest)); imgs.append(np.round(img * 255).astype(np.uint8))
    used.append(f'{os.path.basename(path)} ({len(vals) - n0})')
np.savez_compressed(digits.REFS, value=np.array(vals, np.uint8), relh=np.array(relh, np.uint8), img=np.array(imgs))
print('refs:', len(vals), '—', ', '.join(used))
