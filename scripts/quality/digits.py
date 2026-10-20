# SPDX-License-Identifier: AGPL-3.0-only
"""The digits a page DRAWS, where both text readers read others (metric v5).

Class C4 (tests/corpus/ERROR_CLASSES.md): a font's ToUnicode can name its
digit glyphs wrongly — "3122" for a drawn "2011" — and MuPDF and poppler
then agree on the wrong number, so a converter that writes the drawn one
scored as if it had lost it. This finds those digits on its own, without
PDFree's code:

1. candidates — a digit glyph (MuPDF's text trace: the glyph id and what
   ToUnicode names it) whose embedded font's own Unicode cmap calls it
   another digit (Mac Roman / symbol cmaps map char codes, not digits);
2. the page decides — each candidate glyph cut from the page MuPDF renders
   and matched against reference digits (digit_refs.npz, open-licensed fonts,
   make_digit_refs.py), between the two candidate digits, with its height
   (an Arabic-Indic zero is a dot); a font's digits are taken as drawn only
   where the page backs its cmap on ≥ 2/3 of its candidates.

PDFree's own fix (js/pdfDigitFix.js) reads the glyph's outline instead; this
reads the rendered page, so the two don't share a mistake.

corrections(pdf) → {'numbers': Counter((as read, as drawn)), 'runs': …} —
numbers as the metric tokenizes them, and every digit run (a word can hold
one: Urdu "دربمس0202ء") — for arabic.score to correct both readers'
references with.
"""
import collections, io, os, re
import numpy as np
import fitz
from fontTools.ttLib import TTFont

N = 24
REFS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'digit_refs.npz')
BASES = (0x30, 0x660, 0x6F0)
MAX_JUDGED = 12          # glyphs judged per font (the decision is per font)


def fold(ch):
    c = ord(ch)
    for b in BASES:
        if b <= c <= b + 9:
            return c - b
    return None


def area_resize(img, n=N):
    """Exact area averaging of a square image to n×n."""
    s = img.shape[0]
    if s == n:
        return img.astype(np.float32)
    edges = np.linspace(0, s, n + 1)
    out = np.zeros((n, n), np.float32)
    c = np.zeros((s + 1, s + 1), np.float64)
    c[1:, 1:] = np.cumsum(np.cumsum(img.astype(np.float64), 0), 1)

    def area(y0, y1, x0, x1):          # integral over fractional bounds, bilinear on the cumulative table
        def at(y, x):
            yi, xi = min(int(y), s - 1), min(int(x), s - 1)
            fy, fx = y - yi, x - xi
            a, b, cc, d = c[yi, xi], c[yi, xi + 1], c[yi + 1, xi], c[yi + 1, xi + 1]
            return a + (b - a) * fx + (cc - a) * fy + (d - b - cc + a) * fx * fy
        return at(y1, x1) - at(y0, x1) - at(y1, x0) + at(y0, x0)
    for i in range(n):
        for j in range(n):
            out[i, j] = area(edges[i], edges[i + 1], edges[j], edges[j + 1]) / ((edges[1] - edges[0]) ** 2)
    return out


def normalize(ink):
    """A boolean ink mask → its ink box padded to a centred square, n×n."""
    ys, xs = np.nonzero(ink)
    if not len(ys):
        return None, 0
    b = ink[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    h, w = b.shape
    s = max(h, w)
    sq = np.zeros((s, s), np.float32)
    sq[(s - h) // 2:(s - h) // 2 + h, (s - w) // 2:(s - w) // 2 + w] = b
    return area_resize(sq), h


_refs = None


def refs():
    global _refs
    if _refs is None:
        z = np.load(REFS)
        imgs = z['img'].astype(np.float32) / 255
        _refs = (z['value'], z['relh'].astype(np.float32) / 255, imgs, (imgs ** 2).sum((1, 2)))
    return _refs


def score(img, rel_h, value):
    vals, relh, imgs, norm2 = refs()
    sel = vals == value
    if not sel.any():
        return -1
    cos = (imgs[sel] * img).sum((1, 2)) / (np.sqrt(norm2[sel] * (img ** 2).sum()) + 1e-6)
    return float((cos - 0.5 * np.abs(rel_h - relh[sel])).max())


def _font_digits(doc, xref):
    """Embedded font's own Unicode cmap: glyph id → digit, or None."""
    try:
        name, ext, typ, buf = doc.extract_font(xref)
        if not buf or ext not in ('ttf', 'otf'):
            return None
        tt = TTFont(io.BytesIO(buf), lazy=True)
        order = tt.getGlyphOrder()
        gid = {n: i for i, n in enumerate(order)}
        m = {}
        for t in tt['cmap'].tables:
            if not (t.platformID == 0 or (t.platformID == 3 and t.platEncID in (1, 10))):
                continue
            for cp, gn in t.cmap.items():
                d = fold(chr(cp)) if cp < 0x110000 else None
                if d is not None and gn in gid:
                    m.setdefault(gid[gn], set()).add(d)
        return {g: v.pop() for g, v in m.items() if len(v) == 1} or None
    except Exception:
        return None


def _crop(page, char_bbox, span_bbox, dpi=300):
    r = fitz.Rect(char_bbox[0], span_bbox[1], char_bbox[2], span_bbox[3]) & page.rect
    if r.is_empty or r.width < 0.5:
        return None, 0
    pix = page.get_pixmap(dpi=dpi, clip=r, colorspace=fitz.csGRAY)
    g = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w)
    if g.size == 0:
        return None, 0
    ink = g < (int(g.min()) + int(g.max())) / 2
    if ink.mean() < 0.002 or g.max() - g.min() < 40:
        return None, 0
    return normalize(ink)


def _spans(page, fonts):
    """(span, font key) for the page's text trace, the font resolved by name."""
    # the trace and the font list spell a name differently ("Amiri-Regular",
    # "Amiri Regular"): compared without the subset tag, spaces or dashes
    key = lambda name: re.sub(r'[^0-9a-z]', '', name.split('+')[-1].lower())
    byname = {}
    for f in page.get_fonts(full=True):
        byname.setdefault(key(f[3]), f[0])
    for sp in page.get_texttrace():
        yield sp, byname.get(key(sp['font']))


def corrections(pdf, numbers, max_pages=None):
    """Tokens both readers read one way where the page draws another:
    {'numbers': Counter((read, drawn)), 'runs': Counter((read, drawn)),
    'fonts': fonts corrected}. `numbers` tokenizes a span's text the way the
    metric does (arabic.numbers)."""
    doc = fitz.open(pdf)
    pages = range(doc.page_count if max_pages is None else min(max_pages, doc.page_count))
    cmaps = {}
    found = collections.defaultdict(list)                 # font → candidate glyphs
    for p in pages:
        page = doc[p]
        for sp, xref in _spans(page, cmaps):
            if xref is None:
                continue
            if xref not in cmaps:
                cmaps[xref] = _font_digits(doc, xref)
            own = cmaps[xref]
            if not own or len(found[xref]) >= MAX_JUDGED:
                continue
            digit_boxes = [c[3] for c in sp['chars'] if own.get(c[1]) is not None]
            for ch in sp['chars']:
                said = fold(chr(ch[0])) if ch[0] > 0 else None
                o = own.get(ch[1])
                if said is not None and o is not None and o != said and len(found[xref]) < MAX_JUDGED:
                    found[xref].append((p, ch[3], sp['bbox'], said, o, digit_boxes))
    accepted = set()
    for xref, cands in found.items():
        if not cands:
            continue
        agree = judged = 0
        for p, cb, sb, said, o, boxes in cands:
            img, h = _crop(doc[p], cb, sb)
            if img is None:
                continue
            # height relative to the tallest digit of its span
            tallest = max([h] + [_crop(doc[p], b, sb)[1] for b in boxes])
            rel = h / tallest
            judged += 1
            agree += score(img, rel, o) > score(img, rel, said)
        if judged and agree * 3 >= judged * 2:
            accepted.add(xref)
    out = {'numbers': collections.Counter(), 'runs': collections.Counter(), 'fonts': len(accepted)}
    if not accepted:
        return out
    for p in pages:
        page = doc[p]
        for sp, xref in _spans(page, cmaps):
            if xref not in accepted:
                continue
            own = cmaps[xref]
            raw = ''.join(chr(c[0]) for c in sp['chars'] if c[0] > 0)
            fixed = ''.join((chr(BASES[[b <= c[0] <= b + 9 for b in BASES].index(True)] + own[c[1]])
                             if fold(chr(c[0])) is not None and own.get(c[1]) is not None else chr(c[0]))
                            for c in sp['chars'] if c[0] > 0)
            if raw == fixed:
                continue
            runs = lambda t: re.findall(r'[0-9\u0660-\u0669\u06F0-\u06F9]+', t)
            for kind, tok in (('numbers', numbers), ('runs', runs)):
                a, b = tok(raw), tok(fixed)
                if len(a) == len(b):
                    out[kind].update((x, y) for x, y in zip(a, b) if x != y)
    return out
