import fitz, io, os, sys, json, collections
from fontTools.ttLib import TTFont
from concurrent.futures import ProcessPoolExecutor
DIG = {}
for base in (0x30, 0x660, 0x6F0):
    for k in range(10): DIG[base + k] = k
def fold(ch):
    return DIG.get(ord(ch))
def font_digit_map(doc, xref):
    try:
        name, ext, typ, buf = doc.extract_font(xref)
        if not buf or ext not in ('ttf', 'otf'): return None, ext
        tt = TTFont(io.BytesIO(buf), lazy=True)
        order = tt.getGlyphOrder(); gid_of = {n: i for i, n in enumerate(order)}
        m = {}
        # Unicode cmaps only: a Mac Roman (1,0) or symbol (3,0) table's 0x30
        # is a char code, not the digit zero
        for t in tt['cmap'].tables:
            if not (t.platformID == 0 or (t.platformID == 3 and t.platEncID in (1, 10))): continue
            for cp, gn in t.cmap.items():
                if cp in DIG and gn in gid_of: m.setdefault(gid_of[gn], set()).add(DIG[cp])
        return {g: v.pop() for g, v in m.items() if len(v) == 1}, ext
    except Exception as e:
        return None, 'err'
def scan(path):
    try: doc = fitz.open(path)
    except Exception: return None
    res = {'doc': os.path.basename(path), 'digits': 0, 'checked': 0, 'wrong': 0, 'fonts_wrong': set(), 'examples': [], 'pages_wrong': set(), 'unchecked_fonts': collections.Counter()}
    cache = {}
    for pno, page in enumerate(doc):
        if pno >= 60: break
        byname = {}
        for f in page.get_fonts(full=True):
            byname.setdefault(f[3].split('+')[-1], f[0])
        try: trace = page.get_texttrace()
        except Exception: continue
        for sp in trace:
            fname = sp['font']; xref = byname.get(fname) or byname.get(fname.split('+')[-1])
            if xref not in cache: cache[xref] = font_digit_map(doc, xref) if xref else (None, 'nofont')
            fmap, ext = cache[xref]
            # a span whose digits are the font's digits in another order is an
            # ORDER problem (RTL), not a wrong-digit one: classify the span first
            if fmap:
                tv = [fold(chr(c[0])) for c in sp['chars'] if c[0] > 0 and fold(chr(c[0])) is not None]
                gvs = [fmap[c[1]] for c in sp['chars'] if c[1] in fmap]
                if tv != gvs and sorted(tv) == sorted(gvs):
                    res['order_spans'] = res.get('order_spans', 0) + 1
                    res['checked'] += len(tv); res['digits'] += len(tv)
                    continue
            for ch in sp['chars']:
                u = chr(ch[0]) if ch[0] > 0 else ''
                gv = fmap.get(ch[1]) if fmap else None
                uv = fold(u) if u else None
                if uv is not None: res['digits'] += 1
                if gv is None and uv is not None:
                    if not fmap: res['unchecked_fonts'][ext] += 1
                    continue
                if gv is None: continue
                res['checked'] += 1
                if uv != gv:
                    res['wrong'] += 1; res['fonts_wrong'].add(fname); res['pages_wrong'].add(pno + 1)
                    if len(res['examples']) < 6: res['examples'].append((pno + 1, fname, repr(u), gv))
    res['fonts_wrong'] = sorted(res['fonts_wrong']); res['pages_wrong'] = sorted(res['pages_wrong'])[:20]; res['unchecked_fonts'] = dict(res['unchecked_fonts'])
    return res
if __name__ == '__main__':
    D = sys.argv[1]; files = sorted(os.path.join(D, f) for f in os.listdir(D) if f.endswith('.pdf'))
    with ProcessPoolExecutor(6) as ex: rows = [r for r in ex.map(scan, files) if r]
    json.dump(rows, open(sys.argv[2], 'w'), ensure_ascii=False)
    bad = [r for r in rows if r['wrong']]
    print('docs', len(rows), '| with digits', sum(1 for r in rows if r['digits']), '| digits', sum(r['digits'] for r in rows), '| checkable', sum(r['checked'] for r in rows))
    print('docs with ToUnicode≠font digit VALUE:', len(bad), '| wrong digits', sum(r['wrong'] for r in bad), '| docs with digit ORDER-only spans:', sum(1 for r in rows if r.get('order_spans')), 'spans', sum(r.get('order_spans', 0) for r in rows))
    for r in sorted(bad, key=lambda r: -r['wrong']): print(' ', r['doc'], r['wrong'], '/', r['checked'], r['fonts_wrong'][:3], r['examples'][:3])
    unc = collections.Counter()
    for r in rows: unc.update(r['unchecked_fonts'])
    print('digits in fonts we could not check, by font kind:', dict(unc))
