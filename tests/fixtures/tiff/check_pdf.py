# Checks the PDFs tests/e2e/jpg2pdf-tiff.e2e.mjs made (TIFF_PDF_OUT=<dir>) against
# libtiff (Pillow), bit for bit where the conversion is lossless:
#   python3 tests/fixtures/tiff/check_pdf.py <dir>
# Needs Pillow, PyMuPDF (fitz), numpy. Exit 1 on any failure.
#
# Per page: the image stored in the PDF (MuPDF's decode of the XObject, its
# /Decode applied) against libtiff's decode of the TIFF page as stored —
# equal bit for bit for G4 / Flate pages, within JPEG decoder rounding for
# DCT pages; and the page as shown (rendered at the file's own resolution)
# against libtiff's upright page — Orientation, polarity, placement.
import os, sys, json
import numpy as np
import fitz
from PIL import Image

D = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1]
fitz.TOOLS.set_aa_level(0)
fails = []


def frames(name):
    im = Image.open(os.path.join(D, name))
    for i in range(getattr(im, 'n_frames', 1)):
        im.seek(i)
        tags = dict(im.tag_v2)                       # before loading: Pillow resets Orientation to 1 once applied
        f = im.copy()
        if f.mode in ('RGBA', 'LA'):                 # transparency is put on white paper
            bg = Image.new('RGBA', f.size, (255, 255, 255, 255)); bg.alpha_composite(f.convert('RGBA')); f = bg
        yield f, tags


# Pillow's libtiff reader applies Orientation while loading: the page it
# gives is already upright. The pixels as stored are that page turned back.
BACK = {2: Image.FLIP_LEFT_RIGHT, 3: Image.ROTATE_180, 4: Image.FLIP_TOP_BOTTOM, 5: Image.TRANSPOSE,
        6: Image.ROTATE_90, 7: Image.TRANSVERSE, 8: Image.ROTATE_270}


def gray(img):
    if img.mode in ('I;16', 'I;16B', 'I'):            # 16-bit: its top 8 bits, as UTIF.js reads it
        return (np.asarray(img, np.uint16) >> 8).astype(np.int16)
    return np.asarray(img.convert('L'), np.int16)


for f in sorted(os.listdir(OUT)):
    if not f.endswith('.pdf'):
        continue
    meta = json.load(open(os.path.join(OUT, f[:-4] + '.json')))
    doc = fitz.open(os.path.join(OUT, f))
    try:
        src = list(frames(meta['tiff']))
    except Exception as e:                           # libtiff/Pillow itself can't show it: nothing to compare with
        print(f, 'reference unreadable:', str(e)[:60]); continue
    lines = []
    if len(doc) != len(src):
        fails.append(f'{f}: {len(doc)} pages, TIFF has {len(src)}'); continue
    for i, (pg, (img, tags)) in enumerate(zip(doc, src)):
        xref = pg.get_images(full=True)[0][0]
        pm = fitz.Pixmap(doc, xref)
        if pm.alpha or pm.n not in (1, 3):
            pm = fitz.Pixmap(fitz.csRGB, pm)
        got = np.frombuffer(pm.samples, np.uint8).reshape(pm.h, pm.w, pm.n)
        got = got[..., 0] if pm.n == 1 else np.asarray(Image.fromarray(got).convert('L'))
        o = tags.get(274, 1)
        want = gray(img if o == 1 else img.transpose(BACK[o]))
        filt = doc.xref_get_key(xref, 'Filter')[1]
        if got.shape != want.shape:
            fails.append(f'{f} p{i + 1}: stored image {got.shape}, TIFF {want.shape}'); continue
        diff = np.abs(got.astype(np.int16) - want)
        lossless = meta.get('lossless', True) and 'DCT' not in filt
        if lossless and diff.max():
            fails.append(f'{f} p{i + 1}: {filt} not lossless — {int((diff > 0).sum())} pixels differ')
        if not lossless and diff.mean() > 3:
            fails.append(f'{f} p{i + 1}: {filt} mean difference {diff.mean():.1f}')
        # as shown: rendered at the TIFF's resolution, against libtiff's upright page
        xr, yr = (float(tags.get(282, 72)), float(tags.get(283, 72))) if tags.get(296, 2) != 1 else (72, 72)
        if tags.get(296) == 3: xr, yr = xr * 2.54, yr * 2.54
        sx, sy = (yr, xr) if o >= 5 else (xr, yr)
        r = pg.get_pixmap(matrix=fitz.Matrix(sx / 72, sy / 72), colorspace=fitz.csGRAY)
        shown = np.frombuffer(r.samples, np.uint8).reshape(r.h, r.w).astype(np.int16)
        up = gray(img)
        h, w = min(shown.shape[0], up.shape[0]), min(shown.shape[1], up.shape[1])
        if abs(shown.shape[0] - up.shape[0]) > 2 or abs(shown.shape[1] - up.shape[1]) > 2:
            fails.append(f'{f} p{i + 1}: shown {shown.shape} vs upright {up.shape}'); continue
        m = np.abs(shown[:h, :w] - up[:h, :w]).mean()
        if m > 12:
            fails.append(f'{f} p{i + 1}: as shown differs from libtiff (mean {m:.1f}) — turned or inverted?')
        lines.append(f'p{i + 1} {filt or "raw"} max {int(diff.max())} shown {m:.1f}')
    print(f, os.path.getsize(os.path.join(OUT, f)), 'bytes |', '; '.join(lines[:3]) + (' …' if len(lines) > 3 else ''))

print('\n' + ('\n'.join(fails) if fails else 'all lossless pages bit-exact, all pages shown upright'))
sys.exit(1 if fails else 0)
