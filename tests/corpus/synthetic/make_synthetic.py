#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
#
# Regenerates the few synthetic corpus PDFs that can't be built at test time
# with pdf-lib (tests/corpus/README.md): encryption and a CCITT G4 scan.
# Deterministic content, no real documents. Requires: pymupdf, pillow.
# Usage: python3 tests/corpus/synthetic/make_synthetic.py

import io
import os
import struct

import fitz
from PIL import Image, ImageDraw

OUT = os.path.dirname(os.path.abspath(__file__))


def _text_page(doc, text):
    page = doc.new_page(width=595, height=842)
    page.insert_text((60, 90), text, fontsize=18)
    img = Image.linear_gradient('L').resize((240, 160)).convert('RGB')
    buf = io.BytesIO(); img.save(buf, 'PNG')
    page.insert_image(fitz.Rect(60, 120, 540, 440), stream=buf.getvalue())
    return page


def encrypted():
    for name, kw in [
        ('encrypted-user-password.pdf', dict(encryption=fitz.PDF_ENCRYPT_AES_256, user_pw='user', owner_pw='owner')),
        ('encrypted-owner-only.pdf', dict(encryption=fitz.PDF_ENCRYPT_RC4_128, user_pw='', owner_pw='owner',
                                          permissions=fitz.PDF_PERM_PRINT)),
    ]:
        doc = fitz.open()
        _text_page(doc, f'Synthetic test page — {name}')
        doc.save(os.path.join(OUT, name), **kw)


def ccitt_scan():
    # A bilevel "scanned page" encoded CCITT G4, embedded as-is (/CCITTFaxDecode).
    # Pillow writes mode-'1' G4 as WhiteIsZero, hence /BlackIs1 true below.
    w, h = 1700, 2200
    img = Image.new('1', (w, h), 1)
    d = ImageDraw.Draw(img)
    for i in range(40):
        d.text((150, 150 + i * 48), f'Line {i + 1}: synthetic bilevel scan, CCITT group 4.', fill=0)
    d.rectangle((140, 140, w - 140, h - 140), outline=0, width=4)
    from PIL import TiffImagePlugin
    TiffImagePlugin.STRIP_SIZE = 1 << 30  # one strip: PDF /CCITTFaxDecode takes a single G4 stream
    buf = io.BytesIO(); img.save(buf, 'TIFF', compression='group4')
    tif = Image.open(io.BytesIO(buf.getvalue()))
    off, cnt = tif.tag_v2[273], tif.tag_v2[279]
    offs = off if isinstance(off, tuple) else (off,)
    cnts = cnt if isinstance(cnt, tuple) else (cnt,)
    assert len(offs) == 1, 'expected a single G4 strip'
    g4 = buf.getvalue()[offs[0]:offs[0] + cnts[0]]

    objs = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
        (b'<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceGray /BitsPerComponent 1 '
         b'/Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns %d /Rows %d /BlackIs1 true >> /Length %d >>\nstream\n'
         % (w, h, w, h, len(g4))) + g4 + b'\nendstream',
    ]
    content = b'q 612 0 0 792 0 0 cm /Im0 Do Q'
    objs.append(b'<< /Length %d >>\nstream\n' % len(content) + content + b'\nendstream')
    out = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    xref = []
    for i, body in enumerate(objs, 1):
        xref.append(len(out))
        out += b'%d 0 obj\n' % i + body + b'\nendobj\n'
    start = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1)
    out += b''.join(b'%010d 00000 n \n' % x for x in xref)
    out += b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, start)
    open(os.path.join(OUT, 'ccitt-g4-scan.pdf'), 'wb').write(out)


if __name__ == '__main__':
    encrypted()
    ccitt_scan()
    for f in sorted(os.listdir(OUT)):
        if f.endswith('.pdf'):
            print(f, os.path.getsize(os.path.join(OUT, f)))
