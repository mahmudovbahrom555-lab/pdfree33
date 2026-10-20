import fitz, json, collections, sys
from c4scan import font_digit_map, fold
import shape
rows = json.load(open(sys.argv[2] if len(sys.argv) > 2 else 'c4scan.json'))
out = []
for r in [r for r in rows if r['wrong']]:
    doc = fitz.open('../ar/docs/' + r['doc']); c = collections.Counter()
    for pno, page in enumerate(doc):
        if pno >= 60: break
        byname = {}
        for f in page.get_fonts(full=True): byname.setdefault(f[3].split('+')[-1], f[0])
        for sp in page.get_texttrace():
            xref = byname.get(sp['font']) or byname.get(sp['font'].split('+')[-1])
            fmap, _ = font_digit_map(doc, xref) if xref else (None, None)
            if not fmap: continue
            tv = [fold(chr(x[0])) for x in sp['chars'] if x[0] > 0 and fold(chr(x[0])) is not None]
            gv = [fmap[x[1]] for x in sp['chars'] if x[1] in fmap]
            if tv != gv and sorted(tv) == sorted(gv): c['order_span'] += 1; continue
            gl = []
            for x in sp['chars']:
                fv = fmap.get(x[1]); t = fold(chr(x[0])) if x[0] > 0 else None
                if fv is None or t is None or t == fv: continue
                img, h = shape.page_glyph(page, x[3], sp['bbox']); gl.append((fv, t, img, h))
            if not gl: continue
            hmax = max(g[3] for g in gl) or 1
            for fv, t, img, h in gl:
                if img is None: c['unreadable'] += 1; continue
                c['text_right' if shape.score(img, h / hmax, t) > shape.score(img, h / hmax, fv) else 'text_wrong'] += 1
    out.append({'doc': r['doc'], 'digits': r['digits'], **c})
    print(r['doc'], r['digits'], dict(c), flush=True)
json.dump(out, open('c4prev.json', 'w'))
