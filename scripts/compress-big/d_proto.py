#!/usr/bin/env python3
"""CMYK mode D prototype (CMYK-D-MEASURE-PREREG.md): re-encode DeviceCMYK images as CMYK JPEG,
downsampled to a target effective dpi (largest placement decides, never below 200), kept only
when smaller. Measurement only — not the browser implementation.

  python3 d_proto.py <in.pdf> <out-dir>   → <out-dir>/<doc>.<variant>.pdf for each grid point
"""
import sys, os, io
import fitz, pikepdf
from pikepdf import Name
from PIL import Image

GRID = [('D300q85', 300, 85), ('D300q75', 300, 75), ('D200q85', 200, 85), ('D200q75', 200, 75)]


def filters(s):
    f = s.get('/Filter')
    return [str(x) for x in f] if isinstance(f, pikepdf.Array) else ([str(f)] if f is not None else [])


EXTEND = os.environ.get('D_EXTEND') == '1'   # scope extension (owner decides): /Decode [0 1]/[1 0] and SMask images, mask kept


def decode_kind(s):
    d = s.get('/Decode')
    if d is None: return 'none'
    v = [float(x) for x in d]
    if v == [0, 1] * 4: return 'none'
    if v == [1, 0] * 4: return 'invert'
    return 'other'


def is_target(s):
    if not (isinstance(s, pikepdf.Stream) and s.get('/Subtype') == Name.Image and s.get('/ColorSpace') == Name.DeviceCMYK
            and int(s.get('/BitsPerComponent', 0)) == 8 and len(filters(s)) == 1 and filters(s)[0] in ('/DCTDecode', '/FlateDecode')):
        return False
    if '/Mask' in s: return False
    if not EXTEND: return '/SMask' not in s and '/Decode' not in s
    return decode_kind(s) != 'other'


def adobe(raw):
    i = 2
    while i + 4 <= len(raw) and raw[i] == 0xFF:
        m, ln = raw[i + 1], int.from_bytes(raw[i + 2:i + 4], 'big')
        if m == 0xEE and raw[i + 4:i + 9] == b'Adobe': return True
        if m == 0xDA: break
        i += 2 + ln
    return False


def max_rect_widths(path):
    """xref → (largest placed width in pt, largest placed height in pt) over all pages."""
    out = {}
    with fitz.open(path) as d:
        for pg in d:
            for info in pg.get_image_info(xrefs=True):
                x = info.get('xref') or 0
                if not x: continue
                bw, bh = info['bbox'][2] - info['bbox'][0], info['bbox'][3] - info['bbox'][1]
                w0, h0 = out.get(x, (0, 0)); out[x] = (max(w0, bw), max(h0, bh))
    return out


def samples(s):
    """→ PIL CMYK image holding the values a PDF reader means (true CMYK, not Adobe-inverted)."""
    if filters(s) == ['/DCTDecode']:
        raw = s.read_raw_bytes(); im = Image.open(io.BytesIO(raw)); im.load()
        if im.mode != 'CMYK': return None
        if adobe(raw): im = Image.eval(im, lambda v: 255 - v)   # readers invert Adobe CMYK JPEGs
        if decode_kind(s) == 'invert': im = Image.eval(im, lambda v: 255 - v)   # then /Decode [1 0 …]
        return im
    w, h = int(s.Width), int(s.Height)
    data = s.read_bytes()
    if len(data) != w * h * 4: return None
    im = Image.frombytes('CMYK', (w, h), data)
    return Image.eval(im, lambda v: 255 - v) if decode_kind(s) == 'invert' else im


def encode(im, q):
    b = io.BytesIO(); Image.eval(im, lambda v: 255 - v).save(b, 'JPEG', quality=q, subsampling=0)   # written Adobe-style
    return b.getvalue()


def run(src, out_dir, grid=GRID):
    doc = os.path.basename(src)[:-4]
    rects = max_rect_widths(src)
    for tag, dpi, q in grid:
        pdf = pikepdf.open(src)
        changed = before = after = 0
        for o in list(pdf.objects):
            if not is_target(o): continue
            im = samples(o)
            if im is None: continue
            xr = o.objgen[0]; pw, ph = rects.get(xr, (0, 0))
            if pw <= 0: continue
            eff = im.width / (pw / 72)
            if eff > dpi * 1.1:
                s = dpi / eff; nw, nh = max(1, round(im.width * s)), max(1, round(im.height * s))
                im2 = im.resize((nw, nh), Image.LANCZOS)
            else:
                nw, nh, im2 = im.width, im.height, im
            data = encode(im2, q)
            old = len(o.read_raw_bytes())
            if len(data) >= old: continue
            o.write(data, filter=Name.DCTDecode)
            if '/DecodeParms' in o: del o['/DecodeParms']
            if '/Decode' in o: del o['/Decode']   # the new samples are written as readers see them
            o.Width, o.Height = nw, nh
            changed += 1; before += old; after += len(data)
        pdf.save(f'{out_dir}/{doc}.{tag}.pdf')
        print(doc, tag, 'images changed', changed, f'{before/1e6:.1f} → {after/1e6:.1f} MB', flush=True)


if __name__ == '__main__':
    os.makedirs(sys.argv[2], exist_ok=True)
    run(sys.argv[1], sys.argv[2])
