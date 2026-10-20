import fitz, numpy as np, cv2, os
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTCollection, TTFont
SYS = ['/System/Library/Fonts/', '/System/Library/Fonts/Supplemental/']
FONTS = ['Arial.ttf', 'Arial Bold.ttf', 'Arial Narrow.ttf', 'Times.ttc', 'Helvetica.ttc', 'Courier New.ttf', 'Georgia.ttf', 'Arial Unicode.ttf',
         'GeezaPro.ttc', 'Al Nile.ttc', 'Baghdad.ttc', 'Damascus.ttc', 'DecoTypeNaskh.ttc', 'Farah.ttc', 'Nadeem.ttc', 'Sana.ttc', 'KufiStandardGK.ttc', 'ArialHB.ttc']
BASES = (0x30, 0x660, 0x6F0)
N = 24
def _path(f):
    for d in SYS:
        if os.path.exists(d + f): return d + f
def _has(path, idx, cps):
    try:
        tt = TTCollection(path).fonts[idx] if path.endswith('.ttc') else TTFont(path)
        cm = tt.getBestCmap() or {}
        return {cp for cp in cps if cp in cm}
    except Exception: return set()
def norm(binary):
    ys, xs = np.nonzero(binary)
    if not len(ys): return None, 0, 0
    b = binary[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    h, w = b.shape; s = max(h, w)
    sq = np.zeros((s, s), np.uint8); sq[(s - h) // 2:(s - h) // 2 + h, (s - w) // 2:(s - w) // 2 + w] = b
    return cv2.resize(sq.astype(np.float32), (N, N), interpolation=cv2.INTER_AREA), h, w
TEMPL = []   # (value, image, ink_h / ref_h)
def build():
    for f in FONTS:
        p = _path(f)
        if not p: continue
        for idx in range(4 if p.endswith('.ttc') else 1):
            cps = [b + k for b in BASES for k in range(10)]
            have = _has(p, idx, cps)
            if not have: continue
            try: font = ImageFont.truetype(p, 120, index=idx)
            except Exception: continue
            ref = None
            imgs = {}
            for cp in sorted(have):
                im = Image.new('L', (240, 240), 0); ImageDraw.Draw(im).text((40, 20), chr(cp), font=font, fill=255)
                a, h, w = norm(np.array(im) > 128)
                if a is not None: imgs[cp] = (a, h)
            for b in BASES:
                hs = [imgs[b + k][1] for k in range(10) if b + k in imgs]
                if not hs: continue
                ref = max(hs)
                for k in range(10):
                    if b + k in imgs: TEMPL.append((k, imgs[b + k][0], imgs[b + k][1] / ref))
build()
def page_glyph(page, bbox, span_bbox, dpi=600):
    r = fitz.Rect(bbox[0], span_bbox[1], bbox[2], span_bbox[3]) & page.rect
    if r.is_empty: return None, 0
    pix = page.get_pixmap(dpi=dpi, clip=r, colorspace=fitz.csGRAY)
    g = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w)
    if g.size == 0: return None, 0
    _, bw = cv2.threshold(g, 0, 1, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    if bw.mean() < 0.002: return None, 0
    return norm(bw.astype(bool))[0], norm(bw.astype(bool))[1]
def score(img, rel_h, value):
    best = -1
    for v, t, th in TEMPL:
        if v != value: continue
        c = float((img * t).sum() / (np.sqrt((img * img).sum() * (t * t).sum()) + 1e-6))
        c -= 0.5 * abs(rel_h - th)          # an Arabic-Indic zero is a small dot
        best = max(best, c)
    return best
print('templates', len(TEMPL)) if __name__ == '__main__' else None
