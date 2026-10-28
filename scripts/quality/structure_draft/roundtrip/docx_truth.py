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
import json, re, sys, unicodedata, zipfile
import xml.etree.ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
def a(e, name): return e.get(W + name)

def norm(t): return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', t)).strip()

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
        out[sid] = dict(name=(a(n, 'val') or '').lower() if n is not None else '', based=a(b, 'val') if b is not None else None,
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
    body = ET.fromstring(z.read('word/document.xml')).find(W + 'body')
    out, looks = [], 0
    def walk(el):
        nonlocal looks
        for c in el:
            if c.tag == W + 'p':
                t = norm(para_text(c))
                if not t: continue
                r, l = role_of(c, st)
                if r == 'para' and lookalike(c): looks += 1
                out.append((r, l, t))
            elif c.tag == W + 'tbl':
                for tc in c.iter(W + 'tc'):
                    if tc.find(f'.//{W}tbl') is not None: continue   # an outer cell holding a table: its inner cells count
                    t = norm(' '.join(para_text(p) for p in tc.iter(W + 'p')))
                    if t: out.append(('cell', 0, t))
            elif c.tag in (W + 'sdt',):
                walk(c.find(W + 'sdtContent') if c.find(W + 'sdtContent') is not None else [])
            elif c.tag in (W + 'customXml', W + 'smartTag'):
                walk(c)
    walk(body)
    return (out, looks) if with_lookalikes else out

if __name__ == '__main__':
    b, looks = blocks(sys.argv[1], True)
    import collections
    print(json.dumps({'roles': dict(collections.Counter(r for r, _, _ in b)), 'lookalikes': looks}))
    for x in b[:25]: print(x[0], x[1], x[2][:80])
