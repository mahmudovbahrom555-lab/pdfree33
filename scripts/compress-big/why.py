#!/usr/bin/env python3
"""Where the bytes of a compressed output still are, and for images why our compressor
leaves them (the skip rules of js/worker.js _recompressImages, read from the code).
  python3 why.py <out.pdf> [target_dpi=96]
"""
import collections, json, os, sys
import fitz

def why(path, target_dpi=96):
    d = fitz.open(path); size = os.path.getsize(path)
    use_dpi = {}
    for p in d:
        for info in p.get_image_info(xrefs=True):
            x = info.get('xref'); bw = (info['bbox'][2]-info['bbox'][0])/72; bh = (info['bbox'][3]-info['bbox'][1])/72
            if x and bw > .2 and bh > .2: use_dpi[x] = max(use_dpi.get(x, 0), d.xref_get_key(x, 'Width')[1] and int(d.xref_get_key(x, 'Width')[1]) / bw or 0)
    out = collections.Counter()
    for x in range(1, d.xref_length()):
        try: st = d.xref_get_key(x, 'Subtype')[1]; ty = d.xref_get_key(x, 'Type')[1]
        except Exception: continue
        if not d.xref_is_stream(x): continue
        n = len(d.xref_stream_raw(x) or b'')
        if st == '/Image':
            f = d.xref_get_key(x, 'Filter')[1]; cs = d.xref_get_key(x, 'ColorSpace'); bpc = d.xref_get_key(x, 'BitsPerComponent')[1]
            csv = cs[1]
            if cs[0] == 'xref':
                csv = d.xref_object(int(cs[1].split()[0]), compressed=True)[:60]
            sm = d.xref_get_key(x, 'SMask')[0] != 'null' or d.xref_get_key(x, 'Mask')[0] != 'null'
            w = int(d.xref_get_key(x, 'Width')[1] or 0); h = int(d.xref_get_key(x, 'Height')[1] or 0)
            if any(k in f for k in ('JPX', 'JBIG2', 'CCITT')): r = 'img: ' + f.strip('[]/').split('Decode')[0] + ' (not handled)'
            elif 'CMYK' in csv or '/N 4' in csv: r = 'img: CMYK (skipped by design)'
            elif bpc == '1': r = 'img: 1-bit'
            elif sm: r = 'img: has SMask/Mask'
            elif csv.startswith('[') and 'ICCBased' not in csv: r = 'img: Indexed/Separation/other array'
            elif '[' in f and f.count('/') > 1: r = 'img: filter chain'
            elif w < 20 or h < 20: r = 'img: tiny'
            elif x in use_dpi and use_dpi[x] <= target_dpi * 1.1: r = 'img: already ≤ target DPI'
            elif max(w, h) < 600: r = 'img: < 600 px (not downsampled)'
            else: r = 'img: eligible but kept (10% rule / failed)'
        elif ty == '/Metadata': r = 'XMP metadata' + (' (raw)' if d.xref_get_key(x, 'Filter')[0] == 'null' else '')
        elif st == '/Form': r = 'form XObjects'
        elif d.xref_get_key(x, 'Length1')[0] != 'null' or d.xref_get_key(x, 'Length2')[0] != 'null' or st in ('/Type1C', '/CIDFontType0C', '/OpenType'): r = 'fonts'
        elif ty in ('/XRef', '/ObjStm'): r = 'xref/objstm'
        else: r = 'page content & other streams'
        out[r] += n
    return {'doc': os.path.basename(path), 'MB': round(size/2**20, 1), 'parts_MB': {k: round(v/2**20, 2) for k, v in out.most_common() if v > 2**16}}

if __name__ == '__main__':
    for p in sys.argv[1:]: print(json.dumps(why(p), ensure_ascii=False), flush=True)
