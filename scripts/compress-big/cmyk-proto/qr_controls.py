#!/usr/bin/env python3
"""Stage 4b (b): a PDF of QR codes with known text, each its own CMYK JPEG image (q95, readers' ink
values), placed at 300 or 600 ppi. Never user documents.
  python3 qr_controls.py <out.pdf> <truth.json>"""
import sys, os, json, string, random, subprocess
HERE = os.path.dirname(os.path.abspath(__file__))
import numpy as np, pikepdf, qrcode
from pikepdf import Name
random.seed(20261106)
INK = {'K': (0, 0, 0, 255), 'rich': (153, 102, 102, 255)}
EC = {'L': qrcode.constants.ERROR_CORRECT_L, 'M': qrcode.constants.ERROR_CORRECT_M}


def text(n):
    base = 'https://pdfree.io/t/'
    return base + ''.join(random.choice(string.ascii_letters + string.digits) for _ in range(max(1, n - len(base))))


def code(txt, ec, mod, ink):
    q = qrcode.QRCode(error_correction=EC[ec], box_size=1, border=4); q.add_data(txt); q.make(fit=True)
    m = np.array(q.get_matrix(), bool)
    m = np.kron(m, np.ones((mod, mod), bool))
    a = np.zeros(m.shape + (4,), np.uint8); a[m] = INK[ink]
    return a


pdf = pikepdf.new(); truth = []
page = None; x = y = 36; row_h = 0; W, H = 612, 792; items = []
for n in (20, 60, 150):
    for ec in EC:
        for mod in (2, 3, 4, 6):
            for ink in INK:
                for ppi in (300, 600):
                    t = text(n); a = code(t, ec, mod, ink)
                    items.append((t, ec, mod, ink, ppi, a))
for t, ec, mod, ink, ppi, a in items:
    h, w = a.shape[:2]; pw, ph = w * 72 / ppi, h * 72 / ppi
    if page is None or x + pw > W - 36:
        x = 36; y += row_h + 18; row_h = 0
    if page is None or y + ph > H - 36:
        page = pdf.add_blank_page(page_size=(W, H)); page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary()); page.Contents = pdf.make_stream(b''); x, y, row_h = 36, 36, 0
    raw = f'/tmp/claude-501/qr-{len(truth)}.raw'; a.tofile(raw)
    subprocess.run([os.path.join(HERE, 'ljtool'), 'enc', raw, str(w), str(h), 'cmyk', '95', '1', raw + '.jpg'], check=True)
    img = pikepdf.Stream(pdf, open(raw + '.jpg', 'rb').read())   # a QR inside a JPEG image: the case D touches
    img.Type = Name.XObject; img.Subtype = Name.Image; img.Width = w; img.Height = h; img.ColorSpace = Name.DeviceCMYK; img.BitsPerComponent = 8; img.Filter = Name.DCTDecode
    nm = f'/Q{len(truth)}'; page.Resources.XObject[nm] = img
    page.Contents.write(page.Contents.read_bytes() + f'q {pw:.3f} 0 0 {ph:.3f} {x:.3f} {H - y - ph:.3f} cm {nm} Do Q\n'.encode())
    truth.append({'text': t, 'ec': ec, 'module_px': mod, 'ink': ink, 'ppi': ppi, 'page': len(pdf.pages) - 1, 'bbox': [x, y, x + pw, y + ph]})
    x += pw + 18; row_h = max(row_h, ph)
pdf.save(sys.argv[1]); json.dump(truth, open(sys.argv[2], 'w'), indent=1)
print(len(truth), 'codes on', len(pdf.pages), 'pages')
