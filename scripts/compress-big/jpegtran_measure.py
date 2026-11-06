#!/usr/bin/env python3
"""P2 (owner/audit 2026-11-05): would lossless CMYK JPEG re-encoding (L) pay off?
For every CMYK image with exactly /DCTDecode in the given PDFs: jpegtran -optimize -copy all
(Huffman only, same DCT coefficients) and, for comparison, + -progressive. Checks the decoded CMYK
pixels are identical; reports total before/after, per file, % of the whole file, and time.
python3 jpegtran_measure.py <list-of-pdfs>"""
import sys, os, subprocess, tempfile, time, io, collections
import fitz
from PIL import Image
files = [l.strip() for l in open(sys.argv[1]) if l.strip()]
tot = collections.Counter(); per = []; bad = 0; n_img = 0; t_opt = t_prog = 0.0
tmp = tempfile.mkdtemp()
for p in files:
    doc = fitz.open(p); fsize = os.path.getsize(p); b0 = b1 = b2 = 0; cnt = 0
    for x in range(1, doc.xref_length()):
        try:
            if doc.xref_get_key(x, 'Subtype')[1] != '/Image': continue
            if doc.xref_get_key(x, 'Filter')[1] != '/DCTDecode': continue
            cs = doc.xref_get_key(x, 'ColorSpace')[1]
            if 'DeviceCMYK' not in cs: continue
            raw = doc.xref_stream_raw(x)
        except Exception: continue
        src = os.path.join(tmp, 'a.jpg'); open(src, 'wb').write(raw)
        outs = {}
        for name, args in (('opt', ['-optimize']), ('prog', ['-optimize', '-progressive'])):
            dst = os.path.join(tmp, name + '.jpg'); t0 = time.time()
            r = subprocess.run(['jpegtran', '-copy', 'all', *args, '-outfile', dst, src], capture_output=True)
            dt = time.time() - t0
            if name == 'opt': t_opt += dt
            else: t_prog += dt
            outs[name] = open(dst, 'rb').read() if r.returncode == 0 and os.path.exists(dst) else raw
        try:   # lossless check on decoded CMYK samples
            ref = Image.open(io.BytesIO(raw)); ref.load()
            for k in outs:
                im = Image.open(io.BytesIO(outs[k])); im.load()
                if im.mode != ref.mode or im.tobytes() != ref.tobytes(): bad += 1
        except Exception: bad += 1
        b0 += len(raw); b1 += min(len(raw), len(outs['opt'])); b2 += min(len(raw), len(outs['prog'])); cnt += 1
    if cnt:
        n_img += cnt; tot['before'] += b0; tot['opt'] += b1; tot['prog'] += b2
        per.append((os.path.basename(p)[:-4], cnt, b0, b1, b2, fsize))
print(f'documents with CMYK JPEG: {len(per)} of {len(files)}; images: {n_img}; pixel mismatches: {bad}')
print(f'{"doc":10} {"imgs":>5} {"CMYK JPEG MB":>12} {"-optimize":>10} {"+progressive":>13} {"% of file (opt)":>15}')
for d, c, b0, b1, b2, fs in sorted(per, key=lambda r: -r[2]):
    print(f'{d:10} {c:5} {b0/1e6:12.2f} {100*(b0-b1)/b0:9.1f}% {100*(b0-b2)/b0:12.1f}% {100*(b0-b1)/fs:14.2f}%')
b0 = tot['before']
print(f'TOTAL CMYK JPEG {b0/1e6:.1f} MB → -optimize {tot["opt"]/1e6:.1f} MB ({100*(b0-tot["opt"])/b0:.1f}%), +progressive {tot["prog"]/1e6:.1f} MB ({100*(b0-tot["prog"])/b0:.1f}%)')
print(f'time (native jpegtran, all images): -optimize {t_opt:.1f} s, +progressive {t_prog:.1f} s')
