#!/usr/bin/env python3
"""Q1 (PROTO-PREREG.md): JPEG header facts of every DCT image in the given PDFs, counted by kind.
  python3 headers.py <list-of-pdfs.txt>"""
import sys, collections, pikepdf

def facts(raw):
    i, f = 2, {'adobe': None, 'icc': False, 'sof': None, 'nc': None, 'samp': None}
    while i + 4 <= len(raw) and raw[i] == 0xFF:
        m, ln = raw[i + 1], int.from_bytes(raw[i + 2:i + 4], 'big')
        if m == 0xEE and raw[i + 4:i + 9] == b'Adobe': f['adobe'] = raw[i + 15]
        if m == 0xE2 and raw[i + 4:i + 15] == b'ICC_PROFILE': f['icc'] = True
        if m in (0xC0, 0xC1, 0xC2):
            f['sof'] = {0xC0: 'baseline', 0xC1: 'extended', 0xC2: 'progressive'}[m]; nc = raw[i + 9]; f['nc'] = nc
            f['samp'] = ','.join(f'{raw[i + 11 + 3 * k] >> 4}x{raw[i + 11 + 3 * k] & 15}' for k in range(nc))
        if m == 0xDA: break
        i += 2 + ln
    return f

c = collections.Counter()
for path in open(sys.argv[1]).read().split():
    pdf = pikepdf.open(path)   # keep a reference: a temporary Pdf yields no objects
    for o in pdf.objects:
        if isinstance(o, pikepdf.Stream) and o.get('/Subtype') == '/Image' and o.get('/Filter') == '/DCTDecode':
            f = facts(o.read_raw_bytes()); cs = o.get('/ColorSpace'); cs = str(cs[0]) if isinstance(cs, pikepdf.Array) else str(cs)
            c[(cs, f['nc'], f['adobe'], f['sof'], f['samp'], f['icc'], '/Decode' in o, int(o.get('/BitsPerComponent', 0)))] += 1
print('count | PDF colour space, components, APP14 transform, SOF, sampling, ICC in JPEG, /Decode, BPC')
for k, v in c.most_common(): print(v, '|', *k)
