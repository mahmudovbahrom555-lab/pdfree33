#!/usr/bin/env python3
"""Stage 2 D (PROTO-PREREG.md): run the JS chain (chain.mjs: pdf.js decode → box downsample → site qpdf
encode → guard) on every in-scope image of a PDF and write the result PDF. Python only selects images
and swaps the streams — the pixel work is the JS a browser worker would run.

  QPDF_DIR=… python3 chain_run.py <in.pdf> <out.pdf> <work-dir>   → one JSON line of counts
"""
import sys, os, json, subprocess, collections
import fitz, pikepdf
from pikepdf import Name

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET, THRESHOLD = 200, 220


def filters(s):
    f = s.get('/Filter')
    return [str(x) for x in f] if isinstance(f, pikepdf.Array) else ([str(f)] if f is not None else [])


def decode_kind(s, nc):
    d = s.get('/Decode')
    if d is None: return 'none'
    v = [float(x) for x in d]
    return 'none' if v == [0, 1] * nc else 'invert' if v == [1, 0] * nc else 'other'


def jpeg_facts(raw):
    """(adobe, progressive) from the markers before the first scan."""
    i, adobe, prog = 2, False, False
    while i + 4 <= len(raw) and raw[i] == 0xFF:
        m, ln = raw[i + 1], int.from_bytes(raw[i + 2:i + 4], 'big')
        if m == 0xEE and raw[i + 4:i + 9] == b'Adobe': adobe = True
        if m == 0xC2: prog = True
        if m == 0xDA: break
        i += 2 + ln
    return adobe, prog


def scope(o):
    """→ (kind, nc, invert) or a skip reason string."""
    cs = o.get('/ColorSpace')
    if cs == Name.DeviceCMYK: nc = 4
    elif cs == Name.DeviceGray: nc = 1
    else: return 'colour space ' + (str(cs[0]) if isinstance(cs, pikepdf.Array) else str(cs))
    if int(o.get('/BitsPerComponent', 0)) != 8: return 'bpc'
    if '/Mask' in o: return '/Mask'
    if o.get('/ImageMask'): return 'image mask'
    f = filters(o)
    if len(f) != 1 or f[0] not in ('/DCTDecode', '/FlateDecode'): return 'filter ' + '+'.join(f)
    dk = decode_kind(o, nc)
    if dk == 'other': return '/Decode other'
    if f[0] == '/FlateDecode':
        dp = o.get('/DecodeParms')
        if isinstance(dp, pikepdf.Dictionary) and int(dp.get('/Predictor', 1)) > 1: return 'flate predictor'
        return ('raw', nc, dk == 'invert')
    adobe, prog = jpeg_facts(o.read_raw_bytes())
    if prog: return 'progressive JPEG'
    if nc == 4 and not adobe: return 'non-Adobe CMYK JPEG'
    return ('dct', nc, dk == 'invert')


def largest_rects(path):
    out = {}
    with fitz.open(path) as d:
        for pg in d:
            for info in pg.get_image_info(xrefs=True):
                x = info.get('xref') or 0
                if not x: continue
                bw, bh = info['bbox'][2] - info['bbox'][0], info['bbox'][3] - info['bbox'][1]
                w0, h0 = out.get(x, (0, 0)); out[x] = (max(w0, bw), max(h0, bh))
    return out


def main(src, dst, work):
    os.makedirs(work, exist_ok=True)
    rects = largest_rects(src)
    pdf = pikepdf.open(src)
    skips, jobs, objs = collections.Counter(), [], {}
    smask_of = {int(o.SMask.objgen[0]) for o in pdf.objects if isinstance(o, pikepdf.Stream) and isinstance(o.get('/SMask'), pikepdf.Stream)}
    for o in pdf.objects:
        if not (isinstance(o, pikepdf.Stream) and o.get('/Subtype') == Name.Image): continue
        xr = o.objgen[0]
        if xr in smask_of: skips['is an SMask'] += 1; continue
        sc = scope(o)
        if isinstance(sc, str): skips[sc] += 1; continue
        kind, nc, inv = sc
        w, h = int(o.Width), int(o.Height)
        pw, ph = rects.get(xr, (0, 0))
        if pw <= 0: skips['not placed'] += 1; continue
        eff = w / (pw / 72)
        nw, nh = (max(1, round(w * TARGET / eff)), max(1, round(h * TARGET / eff))) if eff > THRESHOLD else (w, h)
        p = f'{work}/{xr}.{"jpg" if kind == "dct" else "raw"}'
        open(p, 'wb').write(o.read_raw_bytes() if kind == 'dct' else o.read_bytes())
        jobs.append({'id': str(xr), 'kind': kind, 'src': p, 'w': w, 'h': h, 'nc': nc, 'invert': inv, 'nw': nw, 'nh': nh})
        objs[str(xr)] = o
    json.dump(jobs, open(f'{work}/jobs.json', 'w'))
    if jobs:
        subprocess.run(['node', f'{HERE}/chain.mjs', f'{work}/jobs.json', work], check=True, capture_output=True)
        results = json.load(open(f'{work}/results.json'))
    else:
        results = []
    c = collections.Counter(); before = after = 0
    for r in results:
        o = objs[r['id']]
        if r.get('skip'): skips['chain: ' + r['skip'].split(':')[0]] += 1; continue
        if not r['ok']: c['guard rejected'] += 1; continue
        data = open(f"{work}/{r['id']}.jpg", 'rb').read()
        old = len(o.read_raw_bytes())
        if len(data) >= old: c['not smaller'] += 1; continue
        o.write(data, filter=Name.DCTDecode)
        for k in ('/DecodeParms', '/Decode'):
            if k in o: del o[k]
        o.Width, o.Height = r['w'], r['h']
        c['replaced'] += 1; before += old; after += len(data)
    pdf.save(dst)
    print(json.dumps({'doc': os.path.basename(src), 'replaced': c['replaced'], 'guard_rejected': c['guard rejected'], 'not_smaller': c['not smaller'],
                      'img_mb_before': round(before / 1e6, 2), 'img_mb_after': round(after / 1e6, 2), 'skips': dict(skips)}))


if __name__ == '__main__':
    main(*sys.argv[1:4])
