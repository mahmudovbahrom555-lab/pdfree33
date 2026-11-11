#!/usr/bin/env python3
"""Stage 5 holdout checks (PROTO-PREREG.md): integrity, same-filter worst-page |Δ| vs the input, byte-identity
of docs D300 didn't change.   python3 hold_checks.py <holdout.txt> <out-dir>"""
import sys, os, subprocess, hashlib
import numpy as np, fitz, pikepdf
HERE = os.path.dirname(os.path.abspath(__file__))
LIMIT = 0.51
files, out = [l.strip() for l in open(sys.argv[1]) if l.strip()], sys.argv[2]

def text_pages(p):
    with fitz.open(p) as d: return [pg.get_text() for pg in d]
def uses(p):
    r = []
    with pikepdf.open(p) as pdf:
        for i, page in enumerate(pdf.pages):
            for name, img in sorted(page.images.items()):
                cs = img.get('/ColorSpace'); cs = str(cs[0]) if isinstance(cs, pikepdf.Array) else str(cs)
                sm = img.get('/SMask'); r.append((i, name, cs, hashlib.sha1(sm.read_raw_bytes()).hexdigest() if isinstance(sm, pikepdf.Stream) else None))
    return r
def gs_ok(p):
    r = subprocess.run(['gs', '-q', '-dNODISPLAY', '-dNOSAFER', '-c', f'({p}) (r) file runpdfbegin pdfpagecount = quit'], capture_output=True, text=True)
    return r.stdout.strip().split()[-1:] if r.stdout.strip() else None
def same_filter(a, b, n=4):
    worst = 0
    with fitz.open(a) as A, fitz.open(b) as B:
        for i in range(min(n, A.page_count)):
            x, y = [np.frombuffer(d[i].get_pixmap(dpi=300, colorspace=fitz.csCMYK, alpha=False).samples, np.uint8) for d in (A, B)]
            pa, pb = A[i].get_pixmap(dpi=300, colorspace=fitz.csCMYK, alpha=False), None
            h, w = pa.height, pa.width
            x = x.reshape(h, w, 4).astype(float); y = y.reshape(h, w, 4).astype(float)
            hh, ww = h // 6 * 6, w // 6 * 6
            bx = x[:hh, :ww].reshape(hh // 6, 6, ww // 6, 6, 4).mean((1, 3)); by = y[:hh, :ww].reshape(hh // 6, 6, ww // 6, 6, 4).mean((1, 3))
            worst = max(worst, float(np.abs(bx - by).mean()))
    return worst
fails = []
for q in ('q75', 'q82'):
    for f in files:
        d = os.path.basename(f); o = f'{out}/{q}/{d}'; probs = []
        if open(f, 'rb').read() == open(o, 'rb').read(): print(q, d, 'unchanged (byte-identical)'); continue
        with fitz.open(f) as A, fitz.open(o) as B:
            if A.page_count != B.page_count: probs.append('pages')
        if text_pages(f) != text_pages(o): probs.append('text layer')
        ua, ub = uses(f), uses(o)
        if len(ua) != len(ub): probs.append('image uses')
        elif any(x[2] != y[2] for x, y in zip(ua, ub)): probs.append('colour space')
        elif any(x[3] != y[3] for x, y in zip(ua, ub)): probs.append('SMask')
        if not gs_ok(o): probs.append('Ghostscript')
        pj = subprocess.run(['node', f'{HERE}/pdfjs_pages.mjs', o], capture_output=True, text=True).stdout.strip()
        with fitz.open(o) as B:
            if pj != str(B.page_count): probs.append(f'pdf.js {pj}')
        w = same_filter(f, o)
        if w > LIMIT: probs.append(f'|Δ| {w:.3f} > {LIMIT}')
        print(q, d, 'OK' if not probs else 'FAIL ' + '; '.join(probs), f'| |Δ| {w:.3f} | {os.path.getsize(f)/1e6:.1f} → {os.path.getsize(o)/1e6:.1f} MB', flush=True)
        if probs: fails.append((q, d, probs))
print('FAILS:', fails or 'none')
