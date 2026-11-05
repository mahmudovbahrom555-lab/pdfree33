#!/usr/bin/env python3
"""Synthetic scans with an exact ground truth (TARGET-SIZE-MEASURE-PREREG.md, class S).

Born-digital pages from the public corpus are rendered at 300 dpi into image-only one-page
PDFs (JPEG q92, like a scanner writes). The page's own text layer is the ground truth.
Each page is classified: text / small (median span size < 8 pt) / table (>= 6 ruled lines) /
color (meaningful chroma in the render); language: zh (CJK), ru (Cyrillic), en (Latin).
S-stamp: copies of text pages with a red round stamp and a blue signature stroke drawn on.

  [SEED=7 EXCLUDE_MANIFEST=<dev manifest.json>] python3 make_synth.py <out-dir> [per-class=8]
"""
import os, sys, glob, json, io, random, statistics, unicodedata
import fitz, numpy as np
from PIL import Image, ImageDraw

DIRS = ['/Users/murodjon/pdfree33/pdfree33/tests/corpus/real'] + [os.path.expanduser(d) for d in
        ('~/.cache/pdfree-corpus', '~/.cache/pdfree-corpus-reserve', '~/.cache/pdfree-corpus-en')]
out, PER = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 8
os.makedirs(out, exist_ok=True)
random.seed(int(os.environ.get('SEED', 20261105)))
# HOLD sets: another seed, and no source file the DEV set used
EXCLUDE = {m['src'] for m in json.load(open(os.environ['EXCLUDE_MANIFEST']))} if os.environ.get('EXCLUDE_MANIFEST') else set()


def lang_of(text):
    cjk = sum('一' <= c <= '鿿' for c in text)
    cyr = sum('Ѐ' <= c <= 'ӿ' for c in text)
    lat = sum(c.isascii() and c.isalpha() for c in text)
    if cjk > 50 and cjk > lat: return 'zh'
    if cyr > 100 and cyr > lat: return 'ru'
    if lat > 300: return 'en'
    return None


def classify(page, img):
    sizes = [s['size'] for b in page.get_text('dict')['blocks'] for l in b.get('lines', []) for s in l['spans'] if s['text'].strip()]
    if not sizes: return None
    lines = sum(1 for d in page.get_drawings() for it in d['items'] if it[0] == 'l' or (it[0] == 're'))
    a = np.asarray(img.convert('RGB')).astype(int)
    chroma = (a.max(-1) - a.min(-1))
    colorful = (chroma > 60).mean() > 0.02
    if statistics.median(sizes) < 8: return 'small'
    if lines >= 6: return 'table'
    if colorful: return 'color'
    return 'text'


def stamp(img):
    im = img.convert('RGB').copy(); d = ImageDraw.Draw(im)
    w, h = im.size
    cx, cy, r = int(w * 0.72), int(h * 0.82), int(w * 0.08)
    for k in range(3): d.ellipse([cx - r + k * 9, cy - r + k * 9, cx + r - k * 9, cy + r - k * 9], outline=(200, 30, 40), width=6)
    pts = [(int(w * 0.15) + i * 9, int(h * 0.86) + int(25 * np.sin(i / 3))) for i in range(60)]
    d.line(pts, fill=(25, 50, 170), width=5)
    return im


def save_scan(img, path, page_rect):
    b = io.BytesIO(); img.convert('RGB').save(b, 'JPEG', quality=92)
    doc = fitz.open(); pg = doc.new_page(width=page_rect.width, height=page_rect.height)
    pg.insert_image(pg.rect, stream=b.getvalue()); doc.save(path, garbage=3, deflate=True); doc.close()


files = sorted({p for d in DIRS for p in glob.glob(d + '/*.pdf')})
random.shuffle(files)
have = {}
manifest = []
for p in files:
    if all(have.get(k, 0) >= PER for k in ('en-text', 'en-small', 'en-table', 'en-color', 'zh-text', 'ru-text')): break
    if os.path.basename(p) in EXCLUDE: continue
    try: doc = fitz.open(p)
    except Exception: continue
    if doc.is_encrypted or doc.page_count == 0: continue
    for pno in random.sample(range(doc.page_count), min(3, doc.page_count)):
        page = doc[pno]
        gt = unicodedata.normalize('NFC', page.get_text())
        lang = lang_of(gt)
        if not lang or page.rect.width > 1000 or page.rect.height > 1400: continue
        if page.get_images(): continue   # born-digital text pages only, no pictures to confuse the ground truth
        pix = page.get_pixmap(dpi=300)
        img = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
        cls = classify(page, img)
        if not cls: continue
        key = f'{lang}-{cls}' if lang == 'en' else f'{lang}-text'
        if have.get(key, 0) >= PER: continue
        have[key] = have.get(key, 0) + 1
        name = f'{key}-{have[key]:02d}'
        save_scan(img, f'{out}/{name}.pdf', page.rect)
        open(f'{out}/{name}.gt.txt', 'w').write(gt)
        manifest.append({'name': name, 'class': key, 'lang': lang, 'src': os.path.basename(p), 'page': pno + 1})
        if key == 'en-text' and have.get('en-stamp', 0) < PER:
            have['en-stamp'] = have.get('en-stamp', 0) + 1
            sname = f'en-stamp-{have["en-stamp"]:02d}'
            save_scan(stamp(img), f'{out}/{sname}.pdf', page.rect)
            open(f'{out}/{sname}.gt.txt', 'w').write(gt)
            manifest.append({'name': sname, 'class': 'en-stamp', 'lang': 'en', 'src': os.path.basename(p), 'page': pno + 1})
        break
json.dump(manifest, open(f'{out}/manifest.json', 'w'), indent=1)
print(json.dumps(have))
