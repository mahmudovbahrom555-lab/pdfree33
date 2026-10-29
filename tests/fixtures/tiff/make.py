# Builds the TIFF fixtures for tests/e2e/jpg2pdf-tiff.e2e.mjs (Pillow with libtiff).
# Each page: white, a black frame, "P<n>" in a large box at the top left —
# the test checks page count, page shape and that the dark box is there.
# Run: python3 tests/fixtures/tiff/make.py
import os
from PIL import Image, ImageDraw
D = os.path.dirname(os.path.abspath(__file__))

def page(n, w=420, h=594, mode='L'):
    im = Image.new('L', (w, h), 255); d = ImageDraw.Draw(im)
    d.rectangle([4, 4, w - 5, h - 5], outline=0, width=3)
    d.rectangle([30, 30, 30 + 40 * n, 110], fill=0)           # n-wide bar: tells pages apart
    d.text((40, 140), f'Page {n}', fill=0)
    return im.convert(mode)

def save(name, pages, **kw):
    pages[0].save(os.path.join(D, name), save_all=True, append_images=pages[1:], **kw)

save('fax-g4-3p.tif', [page(i, mode='1') for i in (1, 2, 3)], compression='group4', dpi=(200, 200))
# fax "normal" mode: half the vertical resolution, pixels twice as tall as wide
save('fax-normal-2p.tif', [page(i, 420, 297, '1') for i in (1, 2)], compression='group4', dpi=(204, 98))
save('lzw-rgb.tif', [page(1, mode='RGB')], compression='tiff_lzw', dpi=(150, 150))
save('deflate-gray-2p.tif', [page(i) for i in (1, 2)], compression='tiff_adobe_deflate', dpi=(150, 150))
save('jpeg-rgb.tif', [page(1, mode='RGB')], compression='jpeg', dpi=(150, 150))
save('packbits-gray.tif', [page(1)], compression='packbits', dpi=(150, 150))
open(os.path.join(D, 'broken.tif'), 'wb').write(b'II*\x00' + b'\x00' * 60)  # header, no pages
