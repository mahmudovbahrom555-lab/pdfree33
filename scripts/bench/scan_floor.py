#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""scan_floor.py — how small a scanned page can get before its text stops reading.

Text PDF pages (their own text is the truth) are rendered as 300 dpi colour
scans (paper tint, noise, JPEG q90), then re-encoded each way Compress could:
colour JPEG at the target ladder's dpi/quality steps, grey JPEG at the same,
and 1-bit CCITT G4 at a few dpi. Each variant is scaled back to 300 dpi (as a
viewer zooms) and read by tesseract; its character recall against the page's
own text is set beside its size. A bench, not a gate or a measuring stick.

  python3 scripts/bench/scan_floor.py out.jsonl doc.pdf:lang[:pages] ...

pages: comma list, 0-based (default 0,1). One JSON line per page and variant:
{"doc", "page", "lang", "variant", "bytes", "recall"} — variant "scan" is the
300 dpi source scan itself. B…g4: one threshold for the page (Otsu); B…sv: a
local one (Sauvola). PHONE=1 makes the scans phone photos (light falling off,
soft blur); VARIANTS=a,b limits the variants run. T300k5 (not in the default
set): the lite Sauvola a browser can afford (stats from a 4× smaller copy),
dpi 300, k 0.5, sized as 1-bit Flate.
"""
import io, json, subprocess, sys, tempfile, os, zlib
from multiprocessing import Pool

import fitz  # PyMuPDF
import numpy as np
from PIL import Image, ImageFilter
from skimage.filters import threshold_sauvola
from collections import Counter

SCAN_DPI = 300
LADDER = [(200, 80), (200, 70), (150, 75), (150, 65), (120, 60), (96, 55), (96, 45), (72, 40), (72, 30)]
BITONAL = [300, 200, 150]
PHONE = os.environ.get('PHONE') == '1'


_CJK = ('chi_sim', 'chi_tra', 'jpn', 'kor')


def _tokens(text, lang):
    """Words, or character pairs for scripts written without spaces — counted,
    in no order (a column read in another order is still read)."""
    if lang.split('+')[0] in _CJK:
        t = ''.join(ch for ch in text if ch.isalnum())
        return Counter(t[i:i + 2] for i in range(len(t) - 1))
    return Counter(w for w in (''.join(ch for ch in w if ch.isalnum()).lower() for w in text.split()) if w)


def recall(truth, read, lang):
    """Share of the truth's tokens the reading has."""
    t, r = _tokens(truth, lang), _tokens(read, lang)
    total = sum(t.values())
    return sum(min(n, r[k]) for k, n in t.items()) / total if total else None


def scan(page, seed):
    pix = page.get_pixmap(dpi=SCAN_DPI, alpha=False)
    a = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, 3).astype(np.float32)
    paper = np.array([244, 241, 232], np.float32)           # off-white paper
    a = a / 255 * paper
    if PHONE:   # a phone photo: light falling off to one corner, a soft blur
        h, w = a.shape[:2]
        yy, xx = np.mgrid[0:h, 0:w]
        light = 1 - 0.45 * (xx / w * 0.6 + yy / h * 0.4) ** 1.5
        a = np.asarray(Image.fromarray(np.clip(a * light[..., None], 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))).astype(np.float32)
    a += np.random.default_rng(seed).normal(0, 4, a.shape)  # sensor noise
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=90)
    return Image.open(io.BytesIO(buf.getvalue())).convert('RGB'), len(buf.getvalue())


def _resize(img, dpi):
    w, h = img.size
    return img.resize((max(1, round(w * dpi / SCAN_DPI)), max(1, round(h * dpi / SCAN_DPI))), Image.LANCZOS)


def _otsu(grey):
    hist = np.bincount(np.asarray(grey).ravel(), minlength=256).astype(np.float64)
    total, sum_all = hist.sum(), np.dot(np.arange(256), hist)
    best, cut, w0, s0 = -1, 128, 0.0, 0.0
    for t in range(256):
        w0 += hist[t]; s0 += t * hist[t]
        if w0 == 0 or w0 == total:
            continue
        m0, m1 = s0 / w0, (sum_all - s0) / (total - w0)
        between = w0 * (total - w0) * (m0 - m1) ** 2
        if between > best:
            best, cut = between, t
    return cut


def variants(src, only=None):
    """(name, bytes, decoded image) for every way of encoding the scan (or just `only`)."""
    for dpi, q in LADDER:
        for mode in ('RGB', 'L'):
            if only and only != f"{'C' if mode == 'RGB' else 'G'}{dpi}q{q}":
                continue
            img = _resize(src, dpi).convert(mode)
            buf = io.BytesIO()
            img.save(buf, 'JPEG', quality=q)
            yield f"{'C' if mode == 'RGB' else 'G'}{dpi}q{q}", len(buf.getvalue()), Image.open(io.BytesIO(buf.getvalue()))
    for dpi in BITONAL:
        if only and only != f'B{dpi}g4':
            continue
        grey = _resize(src, dpi).convert('L')
        cut = _otsu(grey)
        bw = grey.point(lambda v, c=cut: 255 if v > c else 0).convert('1')
        buf = io.BytesIO()
        bw.save(buf, 'TIFF', compression='group4')
        yield f'B{dpi}g4', len(buf.getvalue()) - 200, Image.open(io.BytesIO(buf.getvalue()))   # ~TIFF header/IFD
    for dpi in BITONAL:   # local (Sauvola) threshold, as Clean Scan's: uneven light
        if only and only != f'B{dpi}sv':
            continue
        grey = np.asarray(_resize(src, dpi).convert('L'))
        window = int(dpi * 0.2) | 1   # ~5 mm
        bw = Image.fromarray(((grey > threshold_sauvola(grey, window_size=window, k=0.2)) * 255).astype(np.uint8)).convert('1')
        buf = io.BytesIO()
        bw.save(buf, 'TIFF', compression='group4')
        yield f'B{dpi}sv', len(buf.getvalue()) - 200, Image.open(io.BytesIO(buf.getvalue()))


def lite_sauvola(grey, k):
    """Sauvola as the browser can afford it: local mean and deviation from a
    copy 4× smaller (box windows of ~4 mm), looked up per pixel."""
    a = np.asarray(grey, np.float64)
    h, w = a.shape
    sh, sw = max(1, h // 4), max(1, w // 4)
    small = np.asarray(grey.resize((sw, sh), Image.BOX), np.float64)
    r = max(2, round(min(sw, sh) * 0.02 * 4 / 4))   # 2 % of the short edge, in small pixels
    def box(x):
        ii = np.pad(x, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
        y0 = np.clip(np.arange(sh) - r, 0, sh); y1 = np.clip(np.arange(sh) + r + 1, 0, sh)
        x0 = np.clip(np.arange(sw) - r, 0, sw); x1 = np.clip(np.arange(sw) + r + 1, 0, sw)
        n = (y1 - y0)[:, None] * (x1 - x0)[None, :]
        return (ii[y1][:, x1] - ii[y0][:, x1] - ii[y1][:, x0] + ii[y0][:, x0]) / n
    m = box(small); sd = np.sqrt(np.maximum(0, box(small * small) - m * m))
    t = m * (1 + k * (sd / 128 - 1))
    ty = np.minimum(np.arange(h) * sh // h, sh - 1); tx = np.minimum(np.arange(w) * sw // w, sw - 1)
    return a > t[ty][:, tx]


def _lite_variant(src, name):
    dpi, k = int(name[1:4]), int(name[5]) / 10
    grey = _resize(src, dpi).convert('L')
    bw = Image.fromarray((lite_sauvola(grey, k) * 255).astype(np.uint8)).convert('1')
    raw = zlib.compress(bw.tobytes(), 9)
    return name, len(raw), bw


def ocr(img, lang):
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'p.png')
        img.save(path)
        psm = '11' if lang.split('+')[0] in _CJK else '3'
        out = subprocess.run(['tesseract', path, '-', '-l', lang, '--psm', psm],
                             capture_output=True, text=True, timeout=600)
        return out.stdout


def job(args):
    doc, pno, lang, want = args
    page = fitz.open(doc)[pno]
    src, src_bytes = scan(page, pno)
    if want == 'scan':
        name, size, img = 'scan', src_bytes, src
    elif want.startswith('T'):   # T300k5: lite Sauvola at 300 dpi, k 0.5, Flate size
        name, size, img = _lite_variant(src, want)
    else:
        name, size, img = next(v for v in variants(src, want) if v[0] == want)
    dpi = SCAN_DPI if want == 'scan' else int(''.join(c for c in want[1:4] if c.isdigit()))
    if dpi != SCAN_DPI:   # back to 300 dpi, as a viewer zooms
        img = img.convert('L').resize(src.size, Image.BICUBIC)
    return {'doc': os.path.basename(doc), 'page': pno, 'lang': lang, 'variant': name, 'bytes': size,
            'recall': recall(page.get_text(), ocr(img, lang), lang)}


NAMES = ['scan'] + [f'{m}{d}q{q}' for d, q in LADDER for m in 'CG'] + [f'B{d}{t}' for d in BITONAL for t in ('g4', 'sv')]
if os.environ.get('VARIANTS'):
    NAMES = ['scan'] + os.environ['VARIANTS'].split(',')


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    out_path, tasks = sys.argv[1], []
    for spec in sys.argv[2:]:
        parts = spec.split(':')
        doc, lang = parts[0], parts[1]
        pages = [int(p) for p in parts[2].split(',')] if len(parts) > 2 else [0, 1]
        n = len(fitz.open(doc))
        tasks += [(doc, p, lang, v) for p in pages if p < n for v in NAMES]
    with open(out_path, 'w') as out, Pool(os.cpu_count()) as pool:
        for row in pool.imap_unordered(job, tasks):
            out.write(json.dumps(row) + '\n'); out.flush()


if __name__ == '__main__':
    main()
