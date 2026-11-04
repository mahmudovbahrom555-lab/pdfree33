#!/usr/bin/env python3
"""Compare compressed outputs with the original, per document (competitors by letter only).
  python3 compare_pack.py <pack-dir>     (originals/, pdfree/, competitors/)
Per output: size ratio; opens (MuPDF); pages kept; mean / min page SSIM at 72 DPI (grey);
mean colour difference (ΔE76 in Lab, MuPDF's own colour management for CMYK); text kept
(share of the original's words found); rasterized (pages with no vector paths left whose
original had them); XMP streams left; images left by filter.
Compression opportunity per document: the smallest output with min SSIM ≥ 0.9 and text kept ≥ 0.98.
"""
import glob, json, os, re, sys
import numpy as np
import fitz

def render(doc, i, dpi=72):
    pix = doc[i].get_pixmap(dpi=dpi, colorspace=fitz.csRGB, alpha=False)
    return np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, 3).astype(np.float64)

def ssim(a, b):
    if a.shape != b.shape:
        h, w = min(a.shape[0], b.shape[0]), min(a.shape[1], b.shape[1]); a, b = a[:h, :w], b[:h, :w]
    a = a.mean(2); b = b.mean(2); C1, C2 = 6.5025, 58.5225
    def blur(x):
        k = 7; c = np.cumsum(np.cumsum(np.pad(x, ((k, k), (k, k)), mode='edge'), 0), 1)
        s = c[2*k:, 2*k:] - c[:-2*k, 2*k:] - c[2*k:, :-2*k] + c[:-2*k, :-2*k]
        return s[:x.shape[0], :x.shape[1]] / (2*k) ** 2
    ma, mb = blur(a), blur(b); va = blur(a*a) - ma*ma; vb = blur(b*b) - mb*mb; cov = blur(a*b) - ma*mb
    return float((((2*ma*mb + C1) * (2*cov + C2)) / ((ma*ma + mb*mb + C1) * (va + vb + C2))).mean())

def lab(rgb):
    c = rgb / 255; c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    xyz = c @ np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]).T / [0.9505, 1, 1.089]
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116*f[..., 1]-16, 500*(f[..., 0]-f[..., 1]), 200*(f[..., 1]-f[..., 2])], -1)

def xmp_count(doc):
    n = 0
    for x in range(1, doc.xref_length()):
        try: n += doc.xref_get_key(x, 'Type')[1] == '/Metadata'
        except Exception: pass   # a dangling reference in the file
    return n

def words(doc): return re.findall(r'\w{3,}', ' '.join(p.get_text() for p in doc).lower())

def has_paths(page): return len(page.get_drawings()) > 20

def measure(orig, out, pages=8):
    o = fitz.open(orig); size_o = os.path.getsize(orig)
    row = {'out': os.path.basename(out), 'ratio': round(os.path.getsize(out) / size_o, 3)}
    try: c = fitz.open(out); row['opens'] = c.page_count > 0
    except Exception as e: return {**row, 'opens': False, 'error': str(e)[:60]}
    row['pages_kept'] = c.page_count == o.page_count
    idx = sorted(set(int(v) for v in np.linspace(0, o.page_count - 1, min(pages, o.page_count))))
    ss, de, rast = [], [], 0
    for i in idx:
        if i >= c.page_count: break
        a, b = render(o, i), render(c, i)
        ss.append(ssim(a, b))
        h, w = min(a.shape[0], b.shape[0]), min(a.shape[1], b.shape[1])
        de.append(float(np.linalg.norm(lab(a[:h, :w]) - lab(b[:h, :w]), axis=-1).mean()))
        if has_paths(o[i]) and not has_paths(c[i]): rast += 1
    wo = set(words(o)); wc = set(words(c))
    row.update({'ssim_mean': round(float(np.mean(ss)), 3), 'ssim_min': round(float(np.min(ss)), 3), 'dE_mean': round(float(np.mean(de)), 2),
                'text_kept': round(len(wo & wc) / max(1, len(wo)), 3) if wo else None, 'pages_rasterized': rast,
                'xmp_streams': xmp_count(c)})
    return row

if __name__ == '__main__':
    pack = sys.argv[1]; res = {}
    for orig in sorted(glob.glob(f'{pack}/originals/*.pdf')):
        doc = os.path.basename(orig)[:-4]
        outs = sorted(glob.glob(f'{pack}/pdfree/{doc}.*.pdf') + glob.glob(f'{pack}/competitors/{doc}.*.pdf'))
        rows = [measure(orig, f) for f in outs]
        ok = [r for r in rows if r.get('opens') and r.get('ssim_min', 0) >= 0.9 and (r.get('text_kept') is None or r['text_kept'] >= 0.98)]
        best = min(ok, key=lambda r: r['ratio']) if ok else None
        res[doc] = {'rows': rows, 'opportunity': best and {'out': best['out'], 'ratio': best['ratio']}}
        for r in rows: print(doc, json.dumps(r))
        print(doc, 'OPPORTUNITY', json.dumps(res[doc]['opportunity']), flush=True)
    json.dump(res, open(f'{pack}/results.json', 'w'), indent=1)
