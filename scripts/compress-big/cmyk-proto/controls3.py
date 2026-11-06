#!/usr/bin/env python3
"""Stage 3 controls (PROTO-PREREG.md): synthetic CMYK / grey images with stamps, thin lines, small text,
ramps and a photo-like field, at 300 and 600 ppi, plus a manifest of the line/text elements (for G3).
Ink values are what a PDF reader shows (stored = ink, see Stage 1). Never user or corpus documents.

  python3 controls3.py <out-dir>   → <name>.raw (W×H×nc) + manifest.json
"""
import sys, os, json
import numpy as np
from PIL import Image, ImageDraw, ImageFont

NOTO = os.path.expanduser('~/pdfree33/pdfree33/js/vendor/noto')
LATIN, CJK = f'{NOTO}/notosans-v42.ttf', f'{NOTO}/notosansjp-v56.ttf'
INKS = {'C': (255, 0, 0, 0), 'M': (0, 255, 0, 0), 'Y': (0, 0, 255, 0), 'K': (0, 0, 0, 255),
        'rich': (153, 102, 102, 255), 'red': (0, 255, 255, 0), 'blue': (255, 153, 0, 0), 'CM': (255, 255, 0, 0)}


def canvas(w_in, h_in, ppi, bg=(0, 0, 0, 0)):
    """4 ink planes as separate 'L' images (Pillow's CMYK drawing works per channel)."""
    w, h = round(w_in * ppi), round(h_in * ppi)
    return [Image.new('L', (w, h), v) for v in bg]


def draw(planes, fn, ink):
    for p, v in zip(planes, ink):
        if v: fn(ImageDraw.Draw(p), v)


def stack(planes):
    return np.stack([np.asarray(p) for p in planes], -1)


def pt(ppi, points):
    return max(1, round(points * ppi / 72))


def make(out, ppi):
    items, els = [], []
    # 1. red stamp: ring, text, thin border (M100 Y100)
    P = canvas(1.6, 1.6, ppi)
    W = P[0].width
    for size_pt in (6, 8, 10):
        f = ImageFont.truetype(LATIN, pt(ppi, size_pt))
        y = round(W * (0.25 + 0.18 * (size_pt - 6) / 2))
        draw(P, lambda d, v: d.text((round(W * 0.22), y), 'APPROVED 2026', font=f, fill=v), INKS['red'])
        bb = ImageDraw.Draw(P[1]).textbbox((round(W * 0.22), y), 'APPROVED 2026', font=f)
        els.append({'img': f'stamp-red-{ppi}', 'kind': f'text {size_pt}pt red', 'box': bb})
    draw(P, lambda d, v: d.ellipse((W * 0.05, W * 0.05, W * 0.95, W * 0.95), outline=v, width=pt(ppi, 1.5)), INKS['red'])
    draw(P, lambda d, v: d.rectangle((2, 2, W - 3, W - 3), outline=v, width=max(1, round(ppi / 300))), INKS['red'])
    els.append({'img': f'stamp-red-{ppi}', 'kind': 'thin border red', 'box': [0, 0, W, 6]})
    items.append((f'stamp-red-{ppi}', stack(P)))
    # 2. blue stamp on light grey
    P = canvas(1.6, 1.0, ppi, bg=(0, 0, 0, 38))
    W, H = P[0].size
    f = ImageFont.truetype(LATIN, pt(ppi, 8))
    draw(P, lambda d, v: d.rounded_rectangle((W * 0.08, H * 0.15, W * 0.92, H * 0.85), radius=W * 0.05, outline=v, width=pt(ppi, 1.2)), INKS['blue'])
    draw(P, lambda d, v: d.text((W * 0.15, H * 0.4), 'RECEIVED 06 NOV', font=f, fill=v), INKS['blue'])
    bb = ImageDraw.Draw(P[0]).textbbox((W * 0.15, H * 0.4), 'RECEIVED 06 NOV', font=f)
    els.append({'img': f'stamp-blue-{ppi}', 'kind': 'text 8pt blue on K15', 'box': bb})
    items.append((f'stamp-blue-{ppi}', stack(P)))
    # 3. thin lines 1/2/3 px in each ink, horizontal + vertical + diagonal
    P = canvas(2.0, 2.0, ppi)
    W = P[0].width
    y = 10
    for name in ('C', 'M', 'Y', 'K', 'rich'):
        for px in (1, 2, 3):
            draw(P, lambda d, v: d.line((10, y, W - 10, y), fill=v, width=px), INKS[name])
            els.append({'img': f'lines-{ppi}', 'kind': f'line {px}px {name} horizontal', 'box': [10, y - 2, W - 10, y + px + 2]})
            x = y
            draw(P, lambda d, v: d.line((x, W // 2, x, W - 10), fill=v, width=px), INKS[name])
            els.append({'img': f'lines-{ppi}', 'kind': f'line {px}px {name} vertical', 'box': [x - 2, W // 2, x + px + 2, W - 10]})
            y += max(12, W // 40)
    draw(P, lambda d, v: d.line((W // 2, W // 2, W - 10, W - 10), fill=v, width=1), INKS['K'])
    items.append((f'lines-{ppi}', stack(P)))
    # 4. small text: Latin + CJK, 5/6/8/10 pt, in K, rich black, C100 M100
    P = canvas(3.0, 5.0, ppi)
    W, H = P[0].size
    y = 8
    for ink in ('K', 'rich', 'CM'):
        for size_pt in (5, 6, 8, 10):
            for script, font, txt in (('Latin', LATIN, 'Invoice 0486-224 total 1,250.00'), ('CJK', CJK, '請求書 合計金額 東京都')):
                f = ImageFont.truetype(font, pt(ppi, size_pt))
                draw(P, lambda d, v: d.text((10, y), txt, font=f, fill=v), INKS[ink])
                bb = ImageDraw.Draw(P[0]).textbbox((10, y), txt, font=f)
                els.append({'img': f'text-{ppi}', 'kind': f'text {size_pt}pt {script} {ink}', 'box': bb})
                y = bb[3] + 4
                if y > H - 40: break
    items.append((f'text-{ppi}', stack(P)))
    # 5. ramps: K ramp (4 ch) and grey ramp (1 ch)
    w, h = round(3 * ppi), round(0.6 * ppi)
    ramp = np.tile(np.linspace(0, 255, w).round().astype(np.uint8), (h, 1))
    k = np.zeros((h, w, 4), np.uint8); k[..., 3] = ramp
    items.append((f'ramp-k-{ppi}', k))
    items.append((f'ramp-grey-{ppi}', 255 - ramp))
    # 6. photo-like: smooth fields per ink + noise
    rng = np.random.default_rng(6)
    w, h = round(2.5 * ppi), round(2 * ppi)
    yy, xx = np.mgrid[0:h, 0:w] / max(w, h)
    field = np.stack([np.sin(6 * xx + 2 * c) * np.cos(5 * yy - c) for c in range(4)], -1)
    photo = np.clip(110 + 90 * field + rng.normal(0, 12, field.shape), 0, 255).astype(np.uint8)
    items.append((f'photo-{ppi}', photo))
    man = []
    for name, arr in items:
        arr.tofile(f'{out}/{name}.raw')
        man.append({'name': name, 'w': arr.shape[1], 'h': arr.shape[0], 'nc': 1 if arr.ndim == 2 else 4, 'ppi': ppi})
    return man, els


def main(out):
    os.makedirs(out, exist_ok=True)
    man, els = [], []
    for ppi in (300, 600):
        m, e = make(out, ppi); man += m; els += e
    json.dump({'images': man, 'elements': [{**e, 'box': [int(round(v)) for v in e['box']]} for e in els]}, open(f'{out}/manifest.json', 'w'), indent=1)
    print(len(man), 'images,', len(els), 'elements →', out)


if __name__ == '__main__':
    main(sys.argv[1])
