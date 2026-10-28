#!/usr/bin/env python3
"""Structure truth from a Word document's own styles, as the blocks
tags.blocks() gives: (role, level, text) with role heading / para / item /
cell / toc. A heading is a paragraph whose style (or its basedOn chain) is a
built-in "heading N" or has an outline level, or "Title"; an item has a
numbering (numPr with a real numId, on the paragraph or its style); a cell is
a table cell's text; contents styles ("TOC N") are toc. Hidden and deleted
text, text boxes, headers, footers and footnotes are left out.

  python3 docx_truth.py <file.docx>        → JSON stats + the first blocks
"""
import collections, json, re, sys, unicodedata, zipfile
import xml.etree.ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
def a(e, name): return e.get(W + name)

LEADER = re.compile(r'(?:\.\s?){4,}|…{2,}|(?:·\s?){4,}')   # as compare.LEADER

def norm(t): return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', t)).strip()

LOOK_KEYS = ('sz', 'b', 'i', 'u', 'caps', 'color')

def look_of(rpr):
    """The visible run properties an rPr sets (None where it says nothing)."""
    d = dict.fromkeys(LOOK_KEYS)
    if rpr is None: return d
    for k in LOOK_KEYS:
        e = rpr.find(W + k)
        if e is None: continue
        v = a(e, 'val')
        if k == 'sz': d[k] = int(v) if v and v.isdigit() else None
        elif k == 'color': d[k] = None if (v or 'auto').lower() in ('auto', '000000') else v.lower()
        elif k == 'u': d[k] = v not in ('none', None) if v != 'none' else False
        else: d[k] = v not in ('0', 'false')
    return d

def styles(z):
    try: root = ET.fromstring(z.read('word/styles.xml'))
    except KeyError: return {}
    out = {}
    for s in root.iter(W + 'style'):
        if a(s, 'type') != 'paragraph': continue
        sid = a(s, 'styleId'); n = s.find(W + 'name'); b = s.find(W + 'basedOn')
        ppr = s.find(W + 'pPr'); ol = ppr.find(W + 'outlineLvl') if ppr is not None else None
        num = ppr.find(f'{W}numPr/{W}numId') if ppr is not None else None
        ilvl = ppr.find(f'{W}numPr/{W}ilvl') if ppr is not None else None
        rpr = s.find(W + 'rPr')
        out[sid] = dict(look=look_of(rpr), name=(a(n, 'val') or '').lower() if n is not None else '', based=a(b, 'val') if b is not None else None,
                        outline=int(a(ol, 'val')) if ol is not None else None,
                        num=a(num, 'val') if num is not None else None, ilvl=int(a(ilvl, 'val')) if ilvl is not None else None)
    return out

def resolve(st, sid, key):
    seen = set()
    while sid and sid in st and sid not in seen:
        seen.add(sid)
        if st[sid][key] is not None: return st[sid][key]
        sid = st[sid]['based']
    return None

def style_chain_names(st, sid):
    seen, names = set(), []
    while sid and sid in st and sid not in seen:
        seen.add(sid); names.append(st[sid]['name']); sid = st[sid]['based']
    return names

def effective_look(p, st, defaults):
    """The look of a paragraph's first visible run: docDefaults, then the
    paragraph style's chain (base first), then the run's own rPr."""
    ppr = p.find(W + 'pPr'); s_ = ppr.find(W + 'pStyle') if ppr is not None else None
    sid = a(s_, 'val') if s_ is not None else None
    chain, seen = [], set()
    while sid and sid in st and sid not in seen:
        seen.add(sid); chain.append(st[sid]['look']); sid = st[sid]['based']
    if not chain and 'Normal' in st: chain.append(st['Normal']['look'])
    d = dict(defaults)
    for lk in reversed(chain):
        for k, v in lk.items():
            if v is not None: d[k] = v
    for r in p.iter(W + 'r'):
        if ''.join(t.text or '' for t in r.iter(W + 't')).strip():
            for k, v in look_of(r.find(W + 'rPr')).items():
                if v is not None: d[k] = v
            break
    return tuple(d[k] or (0 if k == 'sz' else False) for k in LOOK_KEYS)

def para_text(p):
    out = []
    boxed = {id(r) for b in p.iter(W + 'txbxContent') for r in b.iter(W + 'r')}   # a text box's own paragraphs
    for r in p.iter(W + 'r'):
        if id(r) in boxed: continue
        rpr = r.find(W + 'rPr')
        if rpr is not None and rpr.find(W + 'vanish') is not None: continue
        for e in r:
            if e.tag == W + 't': out.append(e.text or '')
            elif e.tag == W + 'tab': out.append(' ')
            elif e.tag in (W + 'br', W + 'cr'): out.append(' ')
    return ''.join(out)

def role_of(p, st):
    ppr = p.find(W + 'pPr')
    sid = None; ol = None; num = None; ilvl = None
    if ppr is not None:
        s = ppr.find(W + 'pStyle'); sid = a(s, 'val') if s is not None else None
        o = ppr.find(W + 'outlineLvl'); ol = int(a(o, 'val')) if o is not None else None
        n = ppr.find(f'{W}numPr/{W}numId'); num = a(n, 'val') if n is not None else None
        i = ppr.find(f'{W}numPr/{W}ilvl'); ilvl = int(a(i, 'val')) if i is not None else None
    names = style_chain_names(st, sid)
    if any(re.match(r'(toc|contents) ?\d', n) for n in names): return 'toc', 0
    for n in names:
        m = re.fullmatch(r'heading (\d)', n)
        if m: return 'heading', int(m.group(1))
    if 'title' in names: return 'heading', 1
    if ol is None: ol = resolve(st, sid, 'outline')
    if ol is not None and ol < 9: return 'heading', ol + 1
    if num is None: num = resolve(st, sid, 'num')
    if num is not None and num != '0':
        if ilvl is None: ilvl = resolve(st, sid, 'ilvl') or 0
        return 'item', ilvl + 1
    return 'para', 0

def lookalike(p):
    """A short Normal paragraph whose every run is bold: a heading by look only."""
    runs = [r for r in p.iter(W + 'r') if ''.join(t.text or '' for t in r.iter(W + 't')).strip()]
    if not runs: return False
    t = norm(para_text(p))
    if not t or len(t) > 100 or t[-1:] in '.:;,': return False
    def bold(r):
        b = r.find(f'{W}rPr/{W}b')
        return b is not None and a(b, 'val') not in ('0', 'false')
    return all(bold(r) for r in runs)

def blocks(path, with_lookalikes=False):
    z = zipfile.ZipFile(path); st = styles(z)
    try:
        sroot = ET.fromstring(z.read('word/styles.xml'))
        dflt = sroot.find(f'{W}docDefaults/{W}rPrDefault/{W}rPr')
    except KeyError: dflt = None
    defaults = {k: v for k, v in look_of(dflt).items()}
    body = ET.fromstring(z.read('word/document.xml')).find(W + 'body')
    out, looks, seen_looks = [], 0, []
    def walk(el):
        nonlocal looks
        for c in el:
            if c.tag == W + 'p':
                t = norm(para_text(c))
                if not t: continue
                r, l = role_of(c, st)
                if r == 'para' and lookalike(c): looks += 1
                out.append((r, l, t)); seen_looks.append(effective_look(c, st, defaults))
            elif c.tag == W + 'tbl':
                for tc in c.iter(W + 'tc'):
                    if tc.find(f'.//{W}tbl') is not None: continue   # an outer cell holding a table: its inner cells count
                    t = norm(' '.join(para_text(p) for p in tc.iter(W + 'p')))
                    if t: out.append(('cell', 0, t)); seen_looks.append(None)
            elif c.tag in (W + 'sdt',):
                walk(c.find(W + 'sdtContent') if c.find(W + 'sdtContent') is not None else [])
            elif c.tag in (W + 'customXml', W + 'smartTag'):
                walk(c)
    walk(body)
    # A styled heading counts only when the page shows it: it must look
    # different from the body text (the commonest look of plain paragraphs,
    # by characters). A heading style on body-looking text (an address, a
    # list's items, contents lines — G1 round 1, PLAN.md) is "unseen", and a
    # heading-styled line with a dot leader is a contents line.
    weight = collections.Counter()
    for (r, _, t), lk in zip(out, seen_looks):
        if r == 'para' and lk is not None: weight[lk] += len(t)
    body_look = weight.most_common(1)[0][0] if weight else None
    res = []
    for (r, l, t), lk in zip(out, seen_looks):
        if r == 'heading':
            if LEADER.search(t): r = 'toc'
            elif body_look is not None and lk == body_look: r = 'unseen'
        res.append((r, l, t))
    return (res, looks) if with_lookalikes else res

if __name__ == '__main__':
    b, looks = blocks(sys.argv[1], True)
    print(json.dumps({'roles': dict(collections.Counter(r for r, _, _ in b)), 'lookalikes': looks}))
    for x in b[:25]: print(x[0], x[1], x[2][:80])
