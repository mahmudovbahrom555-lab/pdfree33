#!/usr/bin/env python3
"""P2b: lossless L for CMYK Flate images — the same sample bytes, deflated at level 9, without and
with a PNG predictor (Up, Paeth per row, the best per image). Reports totals and per file.
python3 flate_measure.py <list-of-pdfs>"""
import sys, os, zlib, collections
import fitz
def png_filter(data, w, comps, kind):
    stride = w * comps; out = bytearray(); prev = bytes(stride)
    for i in range(0, len(data), stride):
        row = data[i:i + stride]
        if len(row) < stride: break
        if kind == 2: f = bytes((row[j] - prev[j]) & 255 for j in range(stride))
        else:   # Paeth
            f = bytearray(stride)
            for j in range(stride):
                a = row[j - comps] if j >= comps else 0; b = prev[j]; c = prev[j - comps] if j >= comps else 0
                p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                f[j] = (row[j] - pr) & 255
            f = bytes(f)
        out += bytes([kind]) + f; prev = row
    return bytes(out)
files = [l.strip() for l in open(sys.argv[1]) if l.strip()]
T = collections.Counter(); per = []
for p in files:
    doc = fitz.open(p); b0 = b9 = bbest = 0; n = 0
    for x in range(1, doc.xref_length()):
        try:
            if doc.xref_get_key(x, 'Subtype')[1] != '/Image': continue
            if doc.xref_get_key(x, 'Filter')[1].replace(' ', '') not in ('/FlateDecode', '[/FlateDecode]'): continue
            if 'DeviceCMYK' not in doc.xref_get_key(x, 'ColorSpace')[1]: continue
            if doc.xref_get_key(x, 'BitsPerComponent')[1] != '8': continue
            parms = doc.xref_get_key(x, 'DecodeParms')[0] != 'null'
            raw = doc.xref_stream_raw(x); data = zlib.decompress(raw)
            w = int(doc.xref_get_key(x, 'Width')[1]); h = int(doc.xref_get_key(x, 'Height')[1])
        except Exception: continue
        # with DecodeParms the bytes are already predictor-filtered: re-deflate them as they are
        if not parms and len(data) != w * h * 4: continue
        z9 = len(zlib.compress(data, 9))
        best = z9
        if not parms and len(data) <= 40_000_000:   # Paeth in pure Python is slow; Up only above that
            for k in (2, 4) if len(data) <= 8_000_000 else (2,):
                best = min(best, len(zlib.compress(png_filter(data, w, 4, k), 9)))
        b0 += len(raw); b9 += min(len(raw), z9); bbest += min(len(raw), best); n += 1
    if n:
        T['b0'] += b0; T['b9'] += b9; T['best'] += bbest
        per.append((os.path.basename(p)[:-4], n, b0, b9, bbest, os.path.getsize(p)))
print(f'documents with CMYK Flate: {len(per)}')
for d, n, b0, b9, bb, fs in sorted(per, key=lambda r: -r[2]):
    print(f'{d:10} {n:5} {b0/1e6:8.2f} MB  level9 {100*(b0-b9)/b0:5.1f}%  +predictor {100*(b0-bb)/b0:5.1f}%  of file {100*(b0-bb)/fs:5.2f}%')
b0 = T['b0']
print(f'TOTAL {b0/1e6:.1f} MB → level9 {T["b9"]/1e6:.1f} MB ({100*(b0-T["b9"])/b0:.1f}%), +predictor {T["best"]/1e6:.1f} MB ({100*(b0-T["best"])/b0:.1f}%)')
