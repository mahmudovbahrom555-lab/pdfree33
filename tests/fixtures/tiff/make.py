# Builds the TIFF fixtures for tests/e2e/jpg2pdf-tiff.e2e.mjs and check_pdf.py.
# Needs Pillow (with libtiff), tifffile and imagecodecs:
#   pip install Pillow tifffile imagecodecs ; python3 tests/fixtures/tiff/make.py
#
# Every page: white, a black frame, an n-wide black bar at the top left
# (the test reads which page it is from the bar), and the page number.
# Fixtures whose pixels are stored turned or inverted are built so that a
# correct reader shows that same upright page — libtiff (Pillow) is the
# reference, and each file is checked against it here before it's kept.
import os, struct, json
import numpy as np
import tifffile
from PIL import Image, ImageDraw, ImageOps

D = os.path.dirname(os.path.abspath(__file__))
P = lambda name: os.path.join(D, name)


def page(n, w=420, h=594, mode='L', text_lines=0):
    im = Image.new('L', (w, h), 255)
    d = ImageDraw.Draw(im)
    d.rectangle([4, 4, w - 5, h - 5], outline=0, width=3)
    s = w / 420
    d.rectangle([30 * s, 30 * s, (30 + 40 * n) * s, 110 * s], fill=0)
    d.text((40 * s, 140 * s), f'Page {n}', fill=0)
    for i in range(text_lines):                      # text-like rows: a real fax's size
        y = int((200 + i * 12) * s)
        for x in range(int(40 * s), int((w - 40 * s)), int(9 * s)):
            if (x * 7 + i * 13) % 5: d.rectangle([x, y, x + int(6 * s), y + int(7 * s)], fill=0)
    return im.convert(mode)


def reference(name):
    """What libtiff shows, upright (Orientation applied), as 8-bit L or RGB."""
    im = Image.open(P(name))
    out = []
    for i in range(getattr(im, 'n_frames', 1)):
        im.seek(i)
        out.append(ImageOps.exif_transpose(im.convert('RGB')))
    return out


def must_match(name, pages):
    ref = reference(name)
    assert len(ref) == len(pages), (name, len(ref))
    for r, p in zip(ref, pages):
        a, b = np.asarray(r.convert('L'), np.int16), np.asarray(p.convert('L'), np.int16)
        assert a.shape == b.shape and np.abs(a - b).max() <= 40, (name, a.shape, b.shape)


def save(name, pages, **kw):
    pages[0].save(P(name), save_all=True, append_images=pages[1:], **kw)


def patch_tag(name, tag, value):
    b = bytearray(open(P(name), 'rb').read())
    assert b[:2] == b'II'
    off = struct.unpack('<I', b[4:8])[0]
    while off:
        n = struct.unpack('<H', b[off:off + 2])[0]
        for i in range(n):
            e = off + 2 + 12 * i
            if struct.unpack('<H', b[e:e + 2])[0] == tag:
                b[e + 8:e + 10] = struct.pack('<H', value)
        off = struct.unpack('<I', b[off + 2 + 12 * n:off + 6 + 12 * n])[0]
    open(P(name), 'wb').write(b)


# ── black and white ─────────────────────────────────────────────────────
pp = [page(i, mode='1') for i in (1, 2, 3)]
save('fax-g4-3p.tif', pp, compression='group4', dpi=(200, 200))                  # libtiff's own strips
must_match('fax-g4-3p.tif', pp)
fn = [page(i, 420, 297, '1') for i in (1, 2)]                                     # fax "normal": 204 × 98 dpi
save('fax-normal-2p.tif', fn, compression='group4', dpi=(204, 98))
a4 = [page(i, 2480, 3508, '1', text_lines=200) for i in (1, 2)]                   # A4 300 dpi, one strip a page
save('g4-a4-single.tif', a4, compression='group4', dpi=(300, 300), tiffinfo={278: 3508})
must_match('g4-a4-single.tif', a4)
inv = [ImageOps.invert(p.convert('L')).convert('1') for p in pp[:1]]              # WhiteIsZero, same picture
save('g4-whiteiszero.tif', inv, compression='group4', dpi=(200, 200), tiffinfo={278: 594})
patch_tag('g4-whiteiszero.tif', 262, 0)
must_match('g4-whiteiszero.tif', pp[:1])
save('g4-fillorder2.tif', pp[:1], compression='group4', dpi=(200, 200), tiffinfo={278: 594, 266: 2})
must_match('g4-fillorder2.tif', pp[:1])
assert Image.open(P('g4-fillorder2.tif')).tag_v2.get(266) == 2
# Orientation 1–8, stored turned so that an upright page is shown
STORE = {2: Image.FLIP_LEFT_RIGHT, 3: Image.ROTATE_180, 4: Image.FLIP_TOP_BOTTOM, 5: Image.TRANSPOSE,
         6: Image.ROTATE_90, 7: Image.TRANSVERSE, 8: Image.ROTATE_270}
for o in range(1, 9):
    stored = pp[0] if o == 1 else pp[0].transpose(STORE[o])
    save(f'orient-{o}.tif', [stored], compression='group4', dpi=(200, 200),
         tiffinfo={274: o, 278: stored.size[1]})
    must_match(f'orient-{o}.tif', pp[:1])
st = pp[0].transpose(STORE[6])                                                    # turned, decoded path
save('orient-6-deflate.tif', [st.convert('L')], compression='tiff_adobe_deflate', dpi=(200, 200), tiffinfo={274: 6})
must_match('orient-6-deflate.tif', pp[:1])
save('g4-100p.tif', [page(1 + i % 9, mode='1') for i in range(100)], compression='group4', dpi=(200, 200),
     tiffinfo={278: 594})

# ── grey and colour ─────────────────────────────────────────────────────
save('lzw-rgb.tif', [page(1, mode='RGB')], compression='tiff_lzw', dpi=(150, 150))
save('deflate-gray-2p.tif', [page(i) for i in (1, 2)], compression='tiff_adobe_deflate', dpi=(150, 150))
save('packbits-gray.tif', [page(1)], compression='packbits', dpi=(150, 150))
save('raw-gray.tif', [page(1, 210, 297)], compression='raw', dpi=(75, 75))       # no compression, kept small
save('jpeg-rgb.tif', [page(1, mode='RGB')], compression='jpeg', dpi=(150, 150))                   # several strips
save('jpeg-tables-1strip.tif', [page(1, mode='RGB')], compression='jpeg', dpi=(150, 150), tiffinfo={278: 594})
assert Image.open(P('jpeg-tables-1strip.tif')).tag_v2.get(347) is not None
ycc = np.asarray(page(1, mode='RGB'))
tifffile.imwrite(P('jpeg-ycbcr.tif'), ycc, photometric='ycbcr', compression='jpeg', rowsperstrip=594,
                 resolution=(150, 150), resolutionunit='INCH')
g = np.asarray(page(1))
tifffile.imwrite(P('tiled-gray.tif'), g, tile=(128, 128), compression='zlib', resolution=(150, 150), resolutionunit='INCH')
tifffile.imwrite(P('planar-rgb.tif'), np.moveaxis(np.asarray(page(1, mode='RGB')), 2, 0), photometric='rgb',
                 planarconfig='separate', compression='zlib', resolution=(150, 150), resolutionunit='INCH')
save('gray16.tif', [Image.fromarray((g.astype(np.uint16) * 257))], compression='tiff_adobe_deflate', dpi=(150, 150))
save('palette.tif', [page(1, mode='RGB').convert('P')], compression='tiff_lzw', dpi=(150, 150))
save('cmyk.tif', [page(1, mode='RGB').convert('CMYK')], compression='tiff_lzw', dpi=(150, 150))
rgba = page(1, mode='RGB').convert('RGBA'); rgba.putalpha(Image.new('L', rgba.size, 255))
ImageDraw.Draw(rgba).rectangle([300, 400, 400, 500], fill=(0, 0, 0, 0))           # a transparent hole
save('rgba.tif', [rgba], compression='tiff_adobe_deflate', dpi=(150, 150))

# ── resolution units ────────────────────────────────────────────────────
tifffile.imwrite(P('dpi-cm.tif'), g, compression='zlib', resolution=(150 / 2.54, 150 / 2.54), resolutionunit='CENTIMETER')
tifffile.imwrite(P('dpi-none.tif'), g, compression='zlib', resolution=(150, 150), resolutionunit='NONE')
tifffile.imwrite(P('dpi-missing.tif'), g, compression='zlib')

# ── for the mixed job and the damaged file ──────────────────────────────
page(4).save(P('bar4.png'))
open(P('broken.tif'), 'wb').write(b'II*\x00' + b'\x00' * 60)                      # header, no pages

sizes = {f: os.path.getsize(P(f)) for f in sorted(os.listdir(D)) if f.endswith(('.tif', '.png'))}
print(json.dumps(sizes, indent=1), sum(sizes.values()) // 1024, 'KB')
