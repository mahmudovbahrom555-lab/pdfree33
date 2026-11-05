#!/usr/bin/env python3
"""Addendum A variants (TARGET-SIZE-MEASURE-PREREG.md) from the class-S scans.

  python3 make_variants.py <S-dir> <stage1-out-dir> <out-dir>

  <name>.G150.pdf / .G200.pdf   grayscale JPEG q72 at 150 / 200 dpi
  <name>.X96.pdf                JPEG 2000 at the byte size of the stage-1 dpi96 output
  <name>.MRC.pdf                text mask 300 dpi CCITT G4 + background 100 dpi JPEG q50
                                + foreground colour 75 dpi (per-block darkest), stencil-masked
"""
import sys, os, io, json, glob
import numpy as np
from PIL import Image, ImageFilter
import pikepdf
from pikepdf import Name, Dictionary, Array
import fitz

S, ST1, OUT = sys.argv[1:4]
os.makedirs(OUT, exist_ok=True)


def source(name):
    with fitz.open(f'{S}/{name}.pdf') as d:
        pg = d[0]
        xref = pg.get_images()[0][0]
        img = Image.open(io.BytesIO(d.extract_image(xref)['image'])).convert('RGB')
        return img, pg.rect.width, pg.rect.height


def page_pdf(path, w, h, draws):
    """draws: list of (image stream dict builder) placed full page in order."""
    pdf = pikepdf.new()
    xo, content = {}, b''
    for i, build in enumerate(draws):
        xo[f'/Im{i}'] = build(pdf)
        content += f'q {w} 0 0 {h} 0 0 cm /Im{i} Do Q\n'.encode()
    page = pikepdf.Page(Dictionary(Type=Name.Page, MediaBox=[0, 0, w, h], Resources=Dictionary(XObject=Dictionary(xo))))
    pdf.pages.append(page)
    pdf.pages[0].obj.Contents = pdf.make_stream(content)
    pdf.save(path)


def jpeg_stream(img, q, gray=False):
    def build(pdf):
        b = io.BytesIO(); (img.convert('L') if gray else img).save(b, 'JPEG', quality=q)
        s = pikepdf.Stream(pdf, b.getvalue()); s.Type = Name.XObject; s.Subtype = Name.Image
        s.Width, s.Height = img.size; s.ColorSpace = Name.DeviceGray if gray else Name.DeviceRGB
        s.BitsPerComponent = 8; s.Filter = Name.DCTDecode
        return pdf.make_indirect(s)
    return build


def jpx_stream(img, target_bytes):
    raw = img.width * img.height * 3
    def build(pdf):
        data = None
        for ratio in [raw / target_bytes * f for f in (1.0, 1.15, 1.3, 1.5)]:
            b = io.BytesIO(); img.save(b, 'JPEG2000', quality_mode='rates', quality_layers=[ratio], irreversible=True)
            data = b.getvalue()
            if len(data) <= target_bytes * 1.1: break
        s = pikepdf.Stream(pdf, data); s.Type = Name.XObject; s.Subtype = Name.Image
        s.Width, s.Height = img.size; s.BitsPerComponent = 8; s.Filter = Name.JPXDecode
        return pdf.make_indirect(s)
    return build


def g4(mask_bool):
    """1-bit image (True = ink) → raw CCITT G4 bytes (one strip) + size."""
    im = Image.fromarray(np.where(mask_bool, 0, 255).astype(np.uint8)).convert('1')   # ink = 0 (black)
    b = io.BytesIO(); im.save(b, 'TIFF', compression='group4', strip_size=1 << 30)
    t = Image.open(io.BytesIO(b.getvalue()))
    offs, counts = t.tag_v2[273], t.tag_v2[279]
    assert len(offs) == 1, 'G4 not in one strip'
    return b.getvalue()[offs[0]:offs[0] + counts[0]], im.size


def mrc(img):
    a = np.asarray(img).astype(np.float32)
    gray = 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]
    local = np.asarray(Image.fromarray(gray.astype(np.uint8)).filter(ImageFilter.BoxBlur(15))).astype(np.float32)
    ink = (gray < local - 18) & (gray < 200)
    W, H = img.size
    # background: ink pixels replaced by the local mean, then 100 dpi
    bg = a.copy(); bg[ink] = np.stack([local[ink]] * 3, -1)
    bg_img = Image.fromarray(bg.clip(0, 255).astype(np.uint8)).resize((W // 3, H // 3), Image.BILINEAR)
    # foreground: per 4x4 block, the darkest pixel's colour (75 dpi)
    h4, w4 = H // 4 * 4, W // 4 * 4
    blocks = a[:h4, :w4].reshape(h4 // 4, 4, w4 // 4, 4, 3).transpose(0, 2, 1, 3, 4).reshape(h4 // 4, w4 // 4, 16, 3)
    lum = blocks @ np.array([0.299, 0.587, 0.114], np.float32)
    idx = lum.argmin(-1)
    fg = np.take_along_axis(blocks, idx[..., None, None].repeat(3, -1), 2)[:, :, 0]
    fg_img = Image.fromarray(fg.clip(0, 255).astype(np.uint8))
    g4data, (mw, mh) = g4(ink)

    def build_bg(pdf): return jpeg_stream(bg_img, 50)(pdf)

    def build_fg(pdf):
        m = pikepdf.Stream(pdf, g4data); m.Type = Name.XObject; m.Subtype = Name.Image
        m.Width, m.Height = mw, mh; m.ImageMask = True; m.BitsPerComponent = 1
        m.Filter = Name.CCITTFaxDecode
        m.DecodeParms = Dictionary(K=-1, Columns=mw, Rows=mh, BlackIs1=False)
        m.Decode = Array([1, 0])   # black (ink) = 0 in the data → paint where ink
        b = io.BytesIO(); fg_img.save(b, 'JPEG', quality=75)
        s = pikepdf.Stream(pdf, b.getvalue()); s.Type = Name.XObject; s.Subtype = Name.Image
        s.Width, s.Height = fg_img.size; s.ColorSpace = Name.DeviceRGB; s.BitsPerComponent = 8
        s.Filter = Name.DCTDecode; s.Mask = pdf.make_indirect(m)
        return pdf.make_indirect(s)
    return [build_bg, build_fg]


st1 = {}
for l in open(f'{ST1}/results.jsonl'):
    r = json.loads(l)
    if r.get('dpi') == 96 and 'outBytes' in r: st1[r['name']] = r['outBytes']
man = json.load(open(f'{S}/manifest.json'))
for m in man:
    n = m['name']
    img, w, h = source(n)
    for dpi in (150, 200):
        if m['class'] not in ('en-color', 'en-stamp'):
            small = img.resize((round(img.width * dpi / 300), round(img.height * dpi / 300)), Image.LANCZOS)
            page_pdf(f'{OUT}/{n}.G{dpi}.pdf', w, h, [jpeg_stream(small, 72, gray=True)])
    if n in st1:
        page_pdf(f'{OUT}/{n}.X96.pdf', w, h, [jpx_stream(img, st1[n])])
    page_pdf(f'{OUT}/{n}.MRC.pdf', w, h, mrc(img))
    print(n, flush=True)
