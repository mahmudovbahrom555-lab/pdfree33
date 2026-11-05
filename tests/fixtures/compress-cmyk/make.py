#!/usr/bin/env python3
"""Synthetic CMYK fixtures for the Compress branch-A gate (criteria v0.2, 2026-11-05).

Built at test time, deterministic (fixed seeds), nothing binary committed — the OutputIntent
and ICC fixtures embed Ghostscript's default_cmyk.icc from the machine (CI installs ghostscript).
Needs: pikepdf, pillow, numpy.   Run: python3 tests/fixtures/compress-cmyk/make.py <out-dir>

  photo-jpeg       a CMYK JPEG photo-like image (Adobe CMYK), full width
  photo-flate      the same samples as 8-bit CMYK Flate
  k-only           a CMYK JPEG photo with pure-K text and thin lines drawn INTO the pixels (C=M=Y=0 before JPEG)
  k-only-flate     the same as Flate — the pure-K pixels stay exactly C=M=Y=0
  rich-black       a CMYK image with a rich-black block (C60 M40 Y40 K100) and pure K beside it
  overprint        an ExtGState /OP /op /OPM 1, a pure-K vector text overprinting a CMYK image
  spot             a Separation (spot) image and a DeviceN image next to a CMYK one
  transparency     a CMYK image under a transparency group with /BM /Multiply
  output-intent    an OutputIntent (GTS_PDFX) with a CMYK DestOutputProfile, and a CMYK image
  icc-cmyk         an image in /ICCBased N=4
  shared           ONE CMYK image drawn 3 times at different sizes on 2 pages, once inside a Form XObject
  mixed            an RGB image, a CMYK image and vector art on one page
"""
import io, os, sys, glob
import numpy as np
import pikepdf
from pikepdf import Name, Dictionary, Array, Stream
from PIL import Image, ImageDraw, ImageFont

W, H = 480, 320

def photo(seed=1):
    """A smooth photo-like CMYK field with noise (uint8, H×W×4)."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:H, 0:W].astype(float)
    c = 70 + 60 * np.sin(x / 47.0) * np.cos(y / 31.0)
    m = 60 + 50 * np.sin((x + y) / 53.0)
    yy = 60 + 50 * np.cos(x / 23.0)
    k = 12 + 10 * np.sin(y / 17.0)
    a = np.stack([c, m, yy, k], -1) + rng.normal(0, 6, (H, W, 4))
    return np.clip(a, 0, 255).astype(np.uint8)

def with_k_text(arr):
    """Pure-K text and hairlines drawn into the samples: C=M=Y=0, K=255."""
    mask = Image.new('L', (W, H), 0); d = ImageDraw.Draw(mask)
    try: font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 22)
    except Exception: font = ImageFont.load_default()
    d.text((20, 20), 'PURE K text 0.5 mm', fill=255, font=font)
    d.text((20, 60), 'small 7pt black', fill=255, font=font.font_variant(size=11) if hasattr(font, 'font_variant') else font)
    for i in range(6): d.line([(20, 100 + i * 8), (W - 20, 100 + i * 8)], fill=255, width=1)
    m = np.array(mask) > 0
    out = arr.copy(); out[m] = (0, 0, 0, 255)
    return out

def jpeg_cmyk(arr, q=92):
    """CMYK JPEG the way Photoshop writes it: Adobe APP14 marker and INVERTED samples. PDF readers
    (Ghostscript, pdf.js) read an Adobe CMYK JPEG as inverted; Pillow writes the values as given,
    so they are inverted here — written plainly, the image rendered as its negative (2026-11-05)."""
    b = io.BytesIO(); Image.fromarray(255 - arr, 'CMYK').save(b, 'JPEG', quality=q); return b.getvalue()

def image(pdf, arr, mode='jpeg', cs=Name.DeviceCMYK, extra=None):
    h, w = arr.shape[:2]
    if mode == 'jpeg':
        s = Stream(pdf, jpeg_cmyk(arr)); s.Filter = Name.DCTDecode
    else:
        s = Stream(pdf, arr.tobytes())   # pikepdf flate-encodes on save
    s.Type = Name.XObject; s.Subtype = Name.Image; s.Width = w; s.Height = h
    s.ColorSpace = cs; s.BitsPerComponent = 8
    for k, v in (extra or {}).items(): s[k] = v
    return pdf.make_indirect(s)

def page(pdf, content, xobjects=None, extgstate=None, size=(595, 842)):
    p = pikepdf.Page(Dictionary(Type=Name.Page, MediaBox=[0, 0, *size],
                                Resources=Dictionary(XObject=Dictionary(xobjects or {}),
                                                     ExtGState=Dictionary(extgstate or {}),
                                                     Font=Dictionary(F1=Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)))))
    pdf.pages.append(p)
    pdf.pages[-1].obj.Contents = pdf.make_stream(content.encode())

def place(name, x, y, w, h): return f'q {w} 0 0 {h} {x} {y} cm /{name} Do Q\n'

def icc_profile():
    for p in glob.glob('/opt/homebrew/Cellar/ghostscript/*/share/ghostscript/iccprofiles/default_cmyk.icc') \
            + glob.glob('/usr/share/ghostscript/*/iccprofiles/default_cmyk.icc') + glob.glob('/usr/share/color/icc/ghostscript/default_cmyk.icc'):
        return open(p, 'rb').read()
    raise SystemExit('ghostscript default_cmyk.icc not found — install ghostscript')

def build(out):
    os.makedirs(out, exist_ok=True)
    base = photo(1)
    def save(pdf, name): pdf.save(os.path.join(out, name + '.pdf'), deterministic_id=True)

    pdf = pikepdf.new(); page(pdf, place('Im0', 40, 400, 515, 343), {'/Im0': image(pdf, base)}); save(pdf, 'photo-jpeg')
    pdf = pikepdf.new(); page(pdf, place('Im0', 40, 400, 515, 343), {'/Im0': image(pdf, base, 'flate')}); save(pdf, 'photo-flate')
    pdf = pikepdf.new(); page(pdf, place('Im0', 40, 400, 515, 343), {'/Im0': image(pdf, with_k_text(base))}); save(pdf, 'k-only')
    pdf = pikepdf.new(); page(pdf, place('Im0', 40, 400, 515, 343), {'/Im0': image(pdf, with_k_text(base), 'flate')}); save(pdf, 'k-only-flate')

    rb = base.copy(); rb[200:300, 40:200] = (153, 102, 102, 255); rb[200:300, 240:400] = (0, 0, 0, 255)
    pdf = pikepdf.new(); page(pdf, place('Im0', 40, 400, 515, 343), {'/Im0': image(pdf, rb, 'flate')}); save(pdf, 'rich-black')

    pdf = pikepdf.new()
    gs = pdf.make_indirect(Dictionary(Type=Name.ExtGState, OP=True, op=True, OPM=1))
    page(pdf, place('Im0', 40, 400, 515, 343) + 'q /GS0 gs 0 0 0 1 k BT /F1 36 Tf 70 560 Td (OVERPRINT K) Tj ET Q\n',
         {'/Im0': image(pdf, base)}, {'/GS0': gs}); save(pdf, 'overprint')

    pdf = pikepdf.new()
    tint = pdf.make_indirect(Dictionary(FunctionType=2, Domain=[0, 1], C0=[0, 0, 0, 0], C1=[0, 0.9, 0.86, 0], N=1))
    sep = Array([Name.Separation, Name('/PANTONE 185 C'), Name.DeviceCMYK, tint])
    devn_fn = pdf.make_indirect(Stream(pdf, b'{ 0 0 }', FunctionType=4, Domain=[0, 1, 0, 1], Range=[0, 1, 0, 1, 0, 1, 0, 1]))
    devn_fn.write(b'{ pop pop 0 0 0 0 }')
    devn = Array([Name.DeviceN, Array([Name('/Spot1'), Name('/Spot2')]), Name.DeviceCMYK, devn_fn])
    g = (np.mgrid[0:H, 0:W][1] * 255 // W).astype(np.uint8)
    sep_img = image(pdf, g[..., None], 'flate', cs=sep)
    devn_img = image(pdf, np.stack([g, g[::-1]], -1), 'flate', cs=devn)
    page(pdf, place('Im0', 40, 560, 250, 167) + place('Im1', 305, 560, 250, 167) + place('Im2', 40, 360, 250, 167),
         {'/Im0': sep_img, '/Im1': devn_img, '/Im2': image(pdf, base)}); save(pdf, 'spot')

    pdf = pikepdf.new()
    grp = pdf.make_indirect(Stream(pdf, b'q 0.2 0.7 0 0 k 60 420 300 200 re f Q', Type=Name.XObject, Subtype=Name.Form,
                                   BBox=[0, 0, 595, 842], Group=Dictionary(S=Name.Transparency, CS=Name.DeviceCMYK)))
    gsm = pdf.make_indirect(Dictionary(Type=Name.ExtGState, BM=Name.Multiply, ca=0.8, CA=0.8))
    page(pdf, place('Im0', 40, 400, 515, 343) + 'q /GSm gs /Fm0 Do Q\n', {'/Im0': image(pdf, base), '/Fm0': grp}, {'/GSm': gsm})
    save(pdf, 'transparency')

    icc = icc_profile()
    pdf = pikepdf.new()
    prof = pdf.make_indirect(Stream(pdf, icc, N=4))
    pdf.Root.OutputIntents = Array([Dictionary(Type=Name.OutputIntent, S=Name.GTS_PDFX, OutputConditionIdentifier=pikepdf.String('Test CMYK'),
                                               DestOutputProfile=prof)])
    page(pdf, place('Im0', 40, 400, 515, 343), {'/Im0': image(pdf, base)}); save(pdf, 'output-intent')

    pdf = pikepdf.new()
    prof = pdf.make_indirect(Stream(pdf, icc, N=4))
    page(pdf, place('Im0', 40, 400, 515, 343), {'/Im0': image(pdf, base, cs=Array([Name.ICCBased, prof]))}); save(pdf, 'icc-cmyk')

    pdf = pikepdf.new()
    shared = image(pdf, base)
    form = pdf.make_indirect(Stream(pdf, place('Im0', 0, 0, 100, 67).encode(), Type=Name.XObject, Subtype=Name.Form,
                                    BBox=[0, 0, 100, 67], Resources=Dictionary(XObject=Dictionary({'/Im0': shared}))))
    page(pdf, place('Im0', 40, 500, 515, 343) + place('Im0', 40, 300, 120, 80), {'/Im0': shared})
    page(pdf, place('Im0', 300, 300, 240, 160) + 'q 2 0 0 2 60 80 cm /Fm0 Do Q\n', {'/Im0': shared, '/Fm0': form})
    save(pdf, 'shared')

    pdf = pikepdf.new()
    rgb = np.clip(base[..., :3].astype(int) + 20, 0, 255).astype(np.uint8)
    page(pdf, place('Im0', 40, 560, 250, 167) + place('Im1', 305, 560, 250, 167)
         + 'q 0 0 0 1 K 2 w 60 400 m 520 400 l S 1 0 0 0 k 60 300 120 60 re f Q\n',
         {'/Im0': image(pdf, rgb, 'flate', cs=Name.DeviceRGB), '/Im1': image(pdf, base)}); save(pdf, 'mixed')

    print('\n'.join(sorted(f'{n} {os.path.getsize(os.path.join(out, n))}' for n in os.listdir(out) if n.endswith('.pdf'))))

if __name__ == '__main__':
    build(sys.argv[1] if len(sys.argv) > 1 else 'cmyk-fixtures')
