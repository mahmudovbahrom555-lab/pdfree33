#!/usr/bin/env python3
"""Stage 2 A/B/C checks on the control images (PROTO-PREREG.md), after chain.mjs ran with DUMP=1.
  python3 stage_abc.py <ctl-dir> <s2-dir>"""
import sys, os, json, subprocess, tempfile, numpy as np, pikepdf, fitz
from pikepdf import Name
from PIL import Image
C, S = sys.argv[1], sys.argv[2]
HERE = os.path.dirname(os.path.abspath(__file__))
TC, TG = np.load(f'{C}/truth_cmyk.npy').astype(int), np.load(f'{C}/truth_gray.npy').astype(int)
fails = []

def centres(a, P):
    q = P // 4
    out = []
    for py in range(a.shape[0] // P):
        for px in range(a.shape[1] // P):
            if a.ndim == 3 and py == 4 and px >= 3: continue   # the stroke patches
            out.append(a[py * P + q:py * P + P - q, px * P + q:px * P + P - q].reshape(-1, *a.shape[2:]).mean(0))
    return np.array(out)

def check(name, what, got, truth, tol):
    d = float(np.abs(got - truth).max())
    ok = d <= tol
    if not ok: fails.append(f'{name} {what} max|Δ| {d:.1f} > {tol}')
    return f'{what} {d:.1f}{"" if ok else " FAIL"}'

def ink_pdf(jpg, w, h, nc, tmp):
    pdf = pikepdf.new(); img = pikepdf.Stream(pdf, open(jpg, 'rb').read())
    img.Type = Name.XObject; img.Subtype = Name.Image; img.Width = w; img.Height = h; img.BitsPerComponent = 8
    img.ColorSpace = Name.DeviceCMYK if nc == 4 else Name.DeviceGray; img.Filter = Name.DCTDecode
    pg = pdf.add_blank_page(page_size=(w, h)); pg.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=img))
    pg.Contents = pdf.make_stream(f'q {w} 0 0 {h} 0 0 cm /Im0 Do Q'.encode()); p = f'{tmp}/e.pdf'; pdf.save(p)
    with fitz.open(p) as d:
        pm = d[0].get_pixmap(dpi=72, colorspace=fitz.csCMYK if nc == 4 else fitz.csGRAY, alpha=False)
        mu = np.frombuffer(pm.samples, np.uint8).reshape(pm.height, pm.width, pm.n).astype(int).squeeze()
    dev = 'tiff32nc' if nc == 4 else 'tiffgray'
    subprocess.run(['gs', '-q', '-dNOPAUSE', '-dBATCH', f'-sDEVICE={dev}', '-r72', f'-sOutputFile={tmp}/g.tif', p], check=True)
    return mu, np.asarray(Image.open(f'{tmp}/g.tif')).astype(int)

for r in json.load(open(f'{S}/results.json')):
    if not r.get('ok'): fails.append(f"{r['id']} not encoded: {r}"); continue
    nid = r['id']; nc = 1 if nid.startswith('gray') else 4; w, h = r['w'], r['h']
    P = 32 if nid.endswith('_full') else 16
    truth = centres(TG if nc == 1 else TC, 32)
    line = [nid]
    # A — downsampled samples
    ds = np.fromfile(f'{S}/{nid}.ds.raw', np.uint8).astype(int).reshape(h, w, *([nc] if nc > 1 else []))
    line.append(check(nid, 'A ds', centres(ds, P), truth, 1))
    # B — the JPEG itself (libjpeg-turbo raw)
    hdr = json.loads(subprocess.run([f'{HERE}/ljtool', 'dec', f'{S}/{nid}.jpg', f'{S}/{nid}.lj.raw'], capture_output=True, text=True).stdout)
    want = ('cmyk', 4) if nc == 4 else ('gray', 1)
    if (hdr['jpeg_cs'], hdr['components']) != want or (nc == 4 and (hdr['adobe'], hdr['transform']) != (1, 0)):
        fails.append(f'{nid} B header {hdr}')
    lj = np.fromfile(f'{S}/{nid}.lj.raw', np.uint8).astype(int).reshape(h, w, *([nc] if nc > 1 else []))
    line.append(f"B {hdr['jpeg_cs']}/{hdr['components']}/t{hdr['transform']}/{','.join(hdr['sampling'])}")
    line.append(check(nid, 'B libjpeg', centres(lj, P), truth, 3))
    if nc == 4:   # pure-K patches: K row (py=3) and the rich-black-free strokes; interiors C,M,Y <= 2
        k = lj[3 * P + P // 4:4 * P - P // 4, :, :3]
        if k.max() > 2: fails.append(f'{nid} B pure-K patch interiors C/M/Y max {k.max()}')
        line.append(f'pureK CMY max {k.max()}')
    # C — embedded, 4 decoders
    pj = subprocess.run(['node', '/tmp/claude-501/dec1.mjs', f'{HERE}/node_modules/pdfjs-dist/image_decoders/pdf.image_decoders.mjs', f'{S}/{nid}.jpg', f'{S}/{nid}.pj.raw'], capture_output=True, text=True)
    pjr = np.fromfile(f'{S}/{nid}.pj.raw', np.uint8).astype(int).reshape(lj.shape)
    with tempfile.TemporaryDirectory() as t:
        mu, gsr = ink_pdf(f'{S}/{nid}.jpg', w, h, nc, t)
    for nm, a in (('C pdf.js', pjr), ('C MuPDF', mu), ('C Ghostscript', gsr)):
        line.append(check(nid, nm, centres(a, P), truth, 3))
    line.append(f"{r['bytes']} B")
    print(' | '.join(line))
print('FAILS:', fails if fails else 'none')
