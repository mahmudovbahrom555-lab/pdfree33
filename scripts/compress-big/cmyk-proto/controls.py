#!/usr/bin/env python3
"""Control CMYK/grey images with KNOWN ink values (PROTO-PREREG.md Q3), encoded by ljtool, wrapped
in one-image PDFs. Reader value R = ink amount 0..255. Stored = R: PDF readers (Ghostscript, MuPDF,
pdf.js) take an Adobe CMYK/YCCK JPEG's stored samples as ink with no inversion (checked
2026-11-06 with readers.py); Pillow, a stand-alone JPEG reader, returns 255 − stored.
  python3 controls.py <out-dir>   → <out-dir>/<name>.{raw,jpg,pdf} + truth.json
"""
import sys, os, json, subprocess, numpy as np, pikepdf
from pikepdf import Name
HERE = os.path.dirname(os.path.abspath(__file__))
P = 32   # patch size (px) — a multiple of 16 so 2×2 sampling blocks never straddle patches

def chart():
    """4-channel reader values: rows = C, M, Y, K at 0/25/50/75/100 %, then rich black, red disc row."""
    levels = [0, 64, 128, 191, 255]
    rows = []
    for ink in range(4):
        row = np.zeros((P, P * 5, 4), np.uint8)
        for i, v in enumerate(levels): row[:, i * P:(i + 1) * P, ink] = v
        rows.append(row)
    r = np.zeros((P, P * 5, 4), np.uint8)
    r[:, 0:P] = (153, 102, 102, 255)          # rich black C60 M40 Y40 K100
    r[:, P:2 * P] = (0, 255, 255, 0)           # red M100 Y100
    r[:, 2 * P:3 * P] = (255, 255, 255, 255)   # total ink 400 %
    for k, x in enumerate(range(3 * P, 5 * P, 8)): r[:, x:x + 1 + k % 4, 3] = 255   # pure-K strokes 1–4 px
    rows.append(r)
    return np.concatenate(rows, 0)

def main(out):
    os.makedirs(out, exist_ok=True)
    truth = {}
    R = chart(); h, w = R.shape[:2]
    g = np.tile(np.repeat(np.array([0, 64, 128, 191, 255], np.uint8), P)[None, :], (P * 2, 1))   # grey ramp, 1 ch
    cases = [(f'{cs}_s{s}_q{q}', cs, s, q) for cs in ('cmyk', 'ycck') for s in (1, 2) for q in (100, 75) if not (cs == 'cmyk' and s == 2)]
    cases += [(f'gray_s1_q{q}', 'gray', 1, q) for q in (100, 75)]
    for name, cs, s, q in cases:
        arr = g if cs == 'gray' else R   # stored = what PDF readers show
        arr.tofile(f'{out}/{name}.raw')
        subprocess.run([f'{HERE}/ljtool', 'enc', f'{out}/{name}.raw', str(arr.shape[1]), str(arr.shape[0]), cs, str(q), str(s), f'{out}/{name}.jpg'], check=True)
        pdf = pikepdf.new()
        img = pikepdf.Stream(pdf, open(f'{out}/{name}.jpg', 'rb').read())
        img.Type = Name.XObject; img.Subtype = Name.Image; img.Width = arr.shape[1]; img.Height = arr.shape[0]
        img.ColorSpace = Name.DeviceGray if cs == 'gray' else Name.DeviceCMYK; img.BitsPerComponent = 8; img.Filter = Name.DCTDecode
        W, H = arr.shape[1], arr.shape[0]   # 1 px = 1 pt, rendered at 72 dpi → 1:1
        page = pdf.add_blank_page(page_size=(W, H))
        page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=img))
        page.Contents = pdf.make_stream(f'q {W} 0 0 {H} 0 0 cm /Im0 Do Q'.encode())
        pdf.save(f'{out}/{name}.pdf')
        truth[name] = {'cs': cs, 'sampling': s, 'q': q, 'w': W, 'h': H}
    np.save(f'{out}/truth_cmyk.npy', R); np.save(f'{out}/truth_gray.npy', g)
    json.dump(truth, open(f'{out}/truth.json', 'w'), indent=1)
    print(len(cases), 'controls →', out)

if __name__ == '__main__':
    main(sys.argv[1])
