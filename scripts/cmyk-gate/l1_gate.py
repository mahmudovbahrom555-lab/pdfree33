#!/usr/bin/env python3
"""Level-1 gate for Compress on CMYK images (criteria v0.2, 2026-11-05) — what must NOT change.

  python3 scripts/cmyk-gate/l1_gate.py --orig in.pdf --new out.pdf [--prod prod.pdf] [--mode L|D] [--json]

--orig  the user's file; --new  the build under test's output; --prod  production's output of the
same file (T3/T4 reference: everything that isn't a CMYK image must be as production writes it;
default: the original). Mode L (Standard) = lossless: every CMYK image decodes to exactly the same
samples. Mode D (Maximum) may change /Width /Height and the samples — T6 is then left to level 2.

A target image = DeviceCMYK, 8 bits, a single DCTDecode or FlateDecode filter, no SMask/Mask.
Everything else is compared as a whole: the document from /Root (page tree, resources, content
streams decoded, ExtGState, groups, ICC, OutputIntents, annotations…) is written out canonically
with every target image replaced by a placeholder of its dictionary, and the two must be equal.

  T1  every use of an image keeps /ColorSpace, components, /BitsPerComponent
  T2  ICC streams and OutputIntents (DestOutputProfile) — decoded bytes, hashes
  T3+T4  everything that isn't a target image's data is as in --prod (canonical walk from /Root)
  T5  not larger than the original; opens (pikepdf, MuPDF); qpdf --check no new problems
  T6  (L) decoded samples identical; JPEG also same DQT tables and SOF (coefficients themselves
      are not read — no coefficient reader here; identical pixels + identical tables stand in)
  T7  a changed image is the one the pages use (uses are found from the pages, not from a list)
  T8  shared images: the uses that pointed at one object still point at one object, and only them
  T9  each image placement's rectangle (MuPDF) within 0.01 pt
  T12 a signed original (/ByteRange that signs something): target images byte-for-byte
Not here: T10 (an error injection into the implementation) and T11 (holds by construction: the
gate reads the final file).
"""
import argparse, hashlib, json, re, subprocess, sys, io
from decimal import Decimal
import pikepdf
from pikepdf import Name
import fitz
import numpy as np
from PIL import Image

TARGET_FILTERS = ('/DCTDecode', '/FlateDecode')
SKIP_KEYS = {'/Parent', '/P', '/Length', '/ModDate', '/CreationDate', '/Producer'}


def filters(s):
    f = s.get('/Filter')
    if f is None: return []
    return [str(x) for x in f] if isinstance(f, pikepdf.Array) else [str(f)]


def is_target(s):
    if not isinstance(s, pikepdf.Stream) or s.get('/Subtype') != Name.Image: return False
    if s.get('/ColorSpace') != Name.DeviceCMYK or int(s.get('/BitsPerComponent', 0)) != 8: return False
    if '/SMask' in s or '/Mask' in s or s.get('/ImageMask', False): return False
    f = filters(s)
    return len(f) == 1 and f[0] in TARGET_FILTERS


def h(b): return hashlib.sha256(b).hexdigest()[:16]


class Canon:
    """A canonical string of an object graph: indirect objects by content, not by number."""
    def __init__(self, mode):
        self.mode, self.memo, self.path = mode, {}, set()

    def target_dict_skip(self):
        return {'/Length', '/Filter', '/DecodeParms'} | ({'/Width', '/Height'} if self.mode == 'D' else set())

    def __call__(self, o):
        if isinstance(o, (pikepdf.Dictionary, pikepdf.Stream, pikepdf.Array)) and o.is_indirect:
            key = o.objgen
            if key in self.memo: return self.memo[key]
            if key in self.path: return '<cycle>'
            self.path.add(key)
            r = self.direct(o)
            self.path.discard(key)
            self.memo[key] = r
            return r
        return self.direct(o)

    def direct(self, o):
        if isinstance(o, pikepdf.Stream):
            if is_target(o):
                skip = self.target_dict_skip()
                return 'IMG{' + ','.join(f'{k}:{self(o[k])}' for k in sorted(o.keys()) if k not in skip) + '}'
            # content, not encoding: a decodable stream is its decoded bytes (a writer may add or
            # change /Filter on, e.g., an uncompressed palette); an undecodable one keeps its filter
            try: data, skip = o.read_bytes(), SKIP_KEYS | {'/Filter', '/DecodeParms'}
            except Exception: data, skip = o.read_raw_bytes(), SKIP_KEYS
            d = ','.join(f'{k}:{self(o[k])}' for k in sorted(o.keys()) if k not in skip)
            return f'S{{{d}}}#{h(data)}'
        if isinstance(o, pikepdf.Dictionary):
            return '{' + ','.join(f'{k}:{self(o[k])}' for k in sorted(o.keys()) if k not in SKIP_KEYS) + '}'
        if isinstance(o, pikepdf.Array):
            return '[' + ','.join(self(x) for x in o) + ']'
        if isinstance(o, pikepdf.String): return 's' + h(bytes(o))
        if isinstance(o, pikepdf.Name): return str(o)
        if isinstance(o, (float, Decimal)): return f'{float(o):.4f}'
        return repr(o)


def image_uses(pdf):
    """[(where, image stream)] for every image XObject reached from the pages, in Form XObjects too."""
    uses = []
    def walk(res, where, seen):
        if res is None: return
        xo = res.get('/XObject')
        if xo is None: return
        for name in sorted(xo.keys()):
            x = xo[name]
            if not isinstance(x, pikepdf.Stream): continue
            if x.get('/Subtype') == Name.Image: uses.append((f'{where}/{name}', x))
            elif x.get('/Subtype') == Name.Form and x.objgen not in seen:
                walk(x.get('/Resources'), f'{where}/{name}', seen | {x.objgen})
    for i, p in enumerate(pdf.pages):
        walk(p.obj.get('/Resources'), f'p{i + 1}', frozenset())
    return uses


def cs_sig(s):
    cs = s.get('/ColorSpace')
    n = {'/DeviceCMYK': 4, '/DeviceRGB': 3, '/DeviceGray': 1}.get(str(cs)) if isinstance(cs, pikepdf.Name) else None
    if n is None and isinstance(cs, pikepdf.Array) and cs[0] == Name.ICCBased: n = int(cs[1].get('/N'))
    # the filter is encoding, not colour: a lossless re-encoding is allowed, a lossy one fails T6
    return {'cs': Canon('L')(cs) if cs is not None else None, 'n': n, 'bpc': int(s.get('/BitsPerComponent', 0))}


def jpeg_segments(b, markers):
    out, i = [], 2
    while i + 4 <= len(b) and b[i] == 0xFF:
        m, ln = b[i + 1], int.from_bytes(b[i + 2:i + 4], 'big')
        if m in markers: out.append(b[i:i + 2 + ln])
        if m == 0xDA: break
        i += 2 + ln
    return out


def dqt_tables(b):
    """{table id: (precision, 64 values)} — jpegtran may regroup tables into other DQT segments."""
    out = {}
    for seg in jpeg_segments(b, {0xDB}):
        i, end = 4, len(seg)
        while i < end:
            pq, tq = seg[i] >> 4, seg[i] & 15
            n = 128 if pq else 64
            out[tq] = (pq, seg[i + 1:i + 1 + n]); i += 1 + n
    return out


def sof(b):
    """precision, size, components with sampling and table ids — the SOF marker type itself may
    differ (jpegtran -optimize writes baseline as baseline, +progressive as SOF2)."""
    s = jpeg_segments(b, {0xC0, 0xC1, 0xC2})
    return s[0][4:] if s else None


def decoded_equal(a, b):
    """T6: (ok, detail) for two target streams."""
    if a.read_raw_bytes() == b.read_raw_bytes(): return True, 'same bytes'
    if filters(a) == ['/FlateDecode']:
        return (a.read_bytes() == b.read_bytes()), 'Flate samples'
    ra, rb = a.read_raw_bytes(), b.read_raw_bytes()
    if dqt_tables(ra) != dqt_tables(rb): return False, 'DQT tables differ'
    if sof(ra) != sof(rb): return False, 'SOF (size/sampling) differs'
    pa, pb = np.asarray(Image.open(io.BytesIO(ra))), np.asarray(Image.open(io.BytesIO(rb)))
    if pa.shape != pb.shape: return False, f'shape {pa.shape} vs {pb.shape}'
    d = int(np.abs(pa.astype(int) - pb.astype(int)).max())
    return d == 0, f'JPEG pixels max |Δ| {d}'


def icc_hashes(pdf):
    out = []
    for o in pdf.objects:
        if isinstance(o, pikepdf.Array) and len(o) == 2 and o[0] == Name.ICCBased: out.append(h(o[1].read_bytes()))
    for oi in pdf.Root.get('/OutputIntents', []):
        p = oi.get('/DestOutputProfile')
        out.append('OI:' + str(oi.get('/S')) + ':' + (h(p.read_bytes()) if p is not None else '-'))
    # ICCBased arrays are often direct inside a resource dict: find them in the canonical walk too
    return sorted(set(out))


def icc_in_resources(pdf):
    found = set()
    def scan(o, depth=0):
        if depth > 12: return
        if isinstance(o, pikepdf.Array):
            if len(o) == 2 and o[0] == Name.ICCBased: found.add(h(o[1].read_bytes())); return
            for x in o: scan(x, depth + 1)
        elif isinstance(o, (pikepdf.Dictionary, pikepdf.Stream)):
            for k in o.keys():
                if k != '/Parent': scan(o[k], depth + 1)
    for p in pdf.pages: scan(p.obj.get('/Resources'))
    return found


def signed(path):
    b = open(path, 'rb').read()
    for m in re.finditer(rb'/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]', b):
        a0, b0, c0, d0 = map(int, m.groups())
        if a0 == 0 and 0 < b0 < c0 and c0 + d0 <= len(b):
            hole = b[b0:min(c0, b0 + 4096)]
            if hole[:1] == b'<' and re.search(rb'[1-9a-fA-F]', hole[1:]): return True
    return False


def qpdf_problems(path):
    r = subprocess.run(['qpdf', '--check', path], capture_output=True, text=True)
    lines = [l for l in (r.stdout + r.stderr).splitlines() if 'WARNING' in l]   # + exit code 2 = errors
    return r.returncode, len(lines)


def rects(path):
    out = []
    with fitz.open(path) as d:
        for i, p in enumerate(d):
            for info in p.get_image_info():
                out.append((i, *[round(v, 2) for v in info['bbox']]))
    return sorted(out)


def gate(orig, new, prod=None, mode='L'):
    prod = prod or orig
    res = {}
    def put(t, ok, detail=''): res[t] = {'ok': bool(ok), 'detail': detail}

    po, pn, pp = pikepdf.open(orig), pikepdf.open(new), pikepdf.open(prod)
    uo, un = image_uses(po), image_uses(pn)

    # T1 per use, by place (page / form / resource name)
    mo, mn = dict(uo), dict(un)
    bad = [w for w in mo if w not in mn] + [w for w in mn if w not in mo]
    bad += [f'{w}: {cs_sig(mo[w])} → {cs_sig(mn[w])}' for w in mo if w in mn and cs_sig(mo[w]) != cs_sig(mn[w])]
    put('T1', not bad, '; '.join(bad[:5]) or f'{len(mo)} uses')

    # T2
    io_, in_ = icc_hashes(po) + sorted(icc_in_resources(po)), icc_hashes(pn) + sorted(icc_in_resources(pn))
    put('T2', sorted(set(io_)) == sorted(set(in_)), f'{sorted(set(io_))} vs {sorted(set(in_))}' if sorted(set(io_)) != sorted(set(in_)) else f'{len(set(io_))} profiles')

    # T3+T4: the whole document from /Root, target images as placeholders
    def root_canon(pdf):
        c = Canon(mode)
        return {k: c(pdf.Root[k]) for k in sorted(pdf.Root.keys()) if k not in ('/Metadata',)}
    cp, cn = root_canon(pp), root_canon(pn)
    diff = [k for k in set(cp) | set(cn) if cp.get(k) != cn.get(k)]
    if '/Pages' in diff:   # say which page
        c1, c2 = Canon(mode), Canon(mode)
        pages = [i + 1 for i, (a, b) in enumerate(zip(pp.pages, pn.pages)) if c1(a.obj) != c2(b.obj)]
        diff.append(f'pages {pages[:10]}' + ('' if len(pp.pages) == len(pn.pages) else f' count {len(pp.pages)}→{len(pn.pages)}'))
    put('T3+T4', not diff, ', '.join(map(str, diff)))

    # T5
    import os
    so, sn = os.path.getsize(orig), os.path.getsize(new)
    try:
        with fitz.open(new) as d: _ = [p.get_text() for p in d]
        opens = True
    except Exception as e: opens = f'MuPDF: {e}'
    qo, qn = qpdf_problems(orig), qpdf_problems(new)
    ok5 = sn <= so and opens is True and qn[1] <= qo[1] and not (qn[0] == 2 and qo[0] != 2)
    put('T5', ok5, f'{so}→{sn} bytes; qpdf problems {qo[1]}→{qn[1]} (exit {qo[0]}→{qn[0]}); opens {opens}')

    # T6 / T7 / T12 over target uses
    targets = [(w, mo[w], mn[w]) for w in mo if w in mn and is_target(mo[w])]
    changed, bad6 = [], []
    for w, a, b in targets:
        if a.read_raw_bytes() != b.read_raw_bytes(): changed.append(w)
        if mode == 'L':
            ok, det = decoded_equal(a, b) if is_target(b) else (False, 'not a target any more')
            if not ok: bad6.append(f'{w}: {det}')
    put('T6', not bad6, '; '.join(bad6[:5]) if bad6 else (f'{len(targets)} target uses, {len(changed)} changed' if mode == 'L' else 'mode D: level 2'))
    put('T7', True, f'{len(changed)} changed uses, found from the pages: {changed[:6]}')

    # T8: same partition of uses into objects
    def partition(uses):
        g = {}
        for w, s in uses: g.setdefault(s.objgen, set()).add(w)
        return sorted(sorted(v) for v in g.values())
    put('T8', partition(uo) == partition(un), '' if partition(uo) == partition(un) else f'{partition(uo)} → {partition(un)}')

    # T9
    ro, rn = rects(orig), rects(new)
    worst = max((max(abs(x - y) for x, y in zip(a[1:], b[1:])) for a, b in zip(ro, rn)), default=0)
    put('T9', len(ro) == len(rn) and worst <= 0.01, f'{len(ro)}→{len(rn)} placements, max shift {worst:.3f} pt')

    # T12
    if signed(orig):
        moved = [w for w, a, b in targets if a.read_raw_bytes() != b.read_raw_bytes()]
        put('T12', not moved, f'signed: changed {moved[:5]}' if moved else 'signed: target images untouched')
    else:
        put('T12', True, 'not signed')
    return res


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--orig', required=True); ap.add_argument('--new', required=True); ap.add_argument('--prod')
    ap.add_argument('--mode', choices=['L', 'D'], default='L'); ap.add_argument('--json', action='store_true')
    a = ap.parse_args()
    r = gate(a.orig, a.new, a.prod, a.mode)
    if a.json: print(json.dumps(r, ensure_ascii=False))
    else:
        for t, v in r.items(): print(f"{'PASS' if v['ok'] else 'FAIL'} {t:6} {v['detail']}")
    sys.exit(0 if all(v['ok'] for v in r.values()) else 1)
