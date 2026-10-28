"""Structural defects in a copy of a DOCX, one kind per copy, seeded:
merge (two adjacent body paragraphs into one), split (a long paragraph cut in
two), demote (a heading loses its style), unlist (a list item loses its
numbering), untable (a table's cells become body paragraphs)."""
import json, os, random, re, sys, zipfile
PARA = re.compile(r'<w:p[ >].*?</w:p>', re.S)
TBL = re.compile(r'<w:tbl>.*?</w:tbl>', re.S)
KINDS = ('merge', 'split', 'demote', 'unlist', 'untable')
def text(p): return ''.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>', p))
def body_paras(xml):
    """(start, end, xml) of paragraphs outside tables."""
    spans = [m.span() for m in TBL.finditer(xml)]
    inside = lambda i: any(a <= i < b for a, b in spans)
    return [(m.start(), m.end(), m.group(0)) for m in PARA.finditer(xml) if not inside(m.start())]
def plain(p): return '<w:numPr>' not in p and 'w:pStyle w:val="Heading' not in p
def runs(p): return ''.join(re.findall(r'<w:r[ >].*?</w:r>', p, re.S))
def break_one(xml, kind, rnd):
    ps = body_paras(xml)
    if kind == 'merge':
        cand = [i for i in range(len(ps) - 1) if plain(ps[i][2]) and plain(ps[i + 1][2]) and len(text(ps[i][2])) >= 20 and len(text(ps[i + 1][2])) >= 20 and xml[ps[i][1]:ps[i + 1][0]].strip() == '']
        if not cand: return None, None
        i = rnd.choice(cand); a, b = ps[i], ps[i + 1]
        merged = a[2].replace('</w:p>', '<w:r><w:t xml:space="preserve"> </w:t></w:r>' + runs(b[2]) + '</w:p>')
        return xml[:a[0]] + merged + xml[b[1]:], {'how': f'paragraphs {i},{i + 1} merged', 'texts': [text(a[2]), text(b[2])]}
    if kind == 'split':
        cand = [i for i, p in enumerate(ps) if plain(p[2]) and len(re.findall(r'<w:r[ >]', p[2])) >= 2 and len(text(p[2])) >= 80]
        if not cand: return None, None
        i = rnd.choice(cand); s, e, p = ps[i]
        rs = re.findall(r'<w:r[ >].*?</w:r>', p, re.S); cut = len(rs) // 2
        head = re.match(r'<w:p[ >].*?(?=<w:r[ >])', p, re.S)
        ppr = head.group(0) if head else '<w:p>'
        new = ppr + ''.join(rs[:cut]) + '</w:p>' + ppr + ''.join(rs[cut:]) + '</w:p>'
        return xml[:s] + new + xml[e:], {'how': f'paragraph {i} split at run {cut}', 'texts': [text(p)]}
    if kind == 'demote':
        cand = [i for i, p in enumerate(ps) if 'w:pStyle w:val="Heading' in p[2]]
        if not cand: return None, None
        i = rnd.choice(cand); s, e, p = ps[i]
        return xml[:s] + re.sub(r'<w:pStyle w:val="Heading\d"/>', '', p) + xml[e:], {'how': f'heading {i} demoted', 'texts': [text(p)]}
    if kind == 'unlist':
        cand = [i for i, p in enumerate(ps) if '<w:numPr>' in p[2]]
        if not cand: return None, None
        i = rnd.choice(cand); s, e, p = ps[i]
        p2 = re.sub(r'<w:numPr>.*?</w:numPr>', '', p, flags=re.S).replace('<w:pStyle w:val="ListParagraph"/>', '')
        return xml[:s] + p2 + xml[e:], {'how': f'list item {i} unlisted', 'texts': [text(p)]}
    if kind == 'untable':
        ts = list(TBL.finditer(xml))
        if not ts: return None, None
        m = rnd.choice(ts)
        cells = re.findall(r'<w:tc>(.*?)</w:tc>', m.group(0), re.S)
        flat = ''.join(PARA.findall(''.join(cells)))
        return xml[:m.start()] + flat + xml[m.end():], {'how': f'table at {m.start()} flattened ({len(cells)} cells)', 'texts': [text(c) for c in cells]}
def main(files, out, seed=20261027, docs=None):
    kinds = {k: {} for k in KINDS}
    for name in sorted(os.listdir(files)):
        if not name.endswith('.pdf2word.docx'): continue
        doc = name[:-len('.pdf2word.docx')]
        if docs and doc not in docs: continue
        z = zipfile.ZipFile(os.path.join(files, name)); xml = z.read('word/document.xml').decode('utf8')
        for kind in KINDS:
            b, how = break_one(xml, kind, random.Random(f'{seed}:{doc}:{kind}'))
            if b is None: continue
            os.makedirs(os.path.join(out, kind), exist_ok=True)
            with zipfile.ZipFile(os.path.join(out, kind, name), 'w', zipfile.ZIP_DEFLATED) as w:
                for item in z.infolist():
                    w.writestr(item.filename, b.encode('utf8') if item.filename == 'word/document.xml' else z.read(item.filename))
            kinds[kind][doc] = how
    json.dump({'seed': seed, 'kinds': kinds}, open(os.path.join(out, 'kinds.json'), 'w'), indent=1)
    print(', '.join(f'{k} {len(v)}' for k, v in kinds.items()))
if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], docs=set(json.load(open(sys.argv[3]))) if len(sys.argv) > 3 else None)
