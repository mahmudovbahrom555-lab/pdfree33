"""Draft structure metric: tagged-PDF ground truth (tags.py) vs our DOCX.
Per document: heading recall/precision, list items as real Word lists, paragraph
one-to-one / split / merged, table cells inside a Word table."""
import re, sys, zipfile, collections, unicodedata, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tags
MARK = re.compile(r'^\s*(?:[•·▪◦‣∙●○■□➢►\-–—*]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s+')
def key(t):
    t = MARK.sub('', unicodedata.normalize('NFKC', t))
    return re.sub(r'\W+', '', t).lower()
def docx_blocks(path):
    x = zipfile.ZipFile(path).read('word/document.xml').decode('utf8')
    out = []
    # table cells first: their paragraphs are cells, not body paragraphs
    def walk(xml, in_cell):
        pos = 0
        for m in re.finditer(r'<w:tbl>.*?</w:tbl>|<w:p[ >].*?</w:p>', xml, re.S):
            seg = m.group(0)
            if seg.startswith('<w:tbl>'):
                for c in re.finditer(r'<w:tc>.*?</w:tc>', seg, re.S):
                    t = ' '.join(''.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>', p)) for p in re.findall(r'<w:p[ >].*?</w:p>', c.group(0), re.S))
                    if t.strip(): out.append(('cell', 0, t))
                continue
            t = ''.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>', seg))
            if not t.strip(): continue
            st = re.search(r'<w:pStyle w:val="([^"]*)"', seg)
            st = st.group(1) if st else ''
            h = re.fullmatch(r'Heading(\d)', st)
            if h: out.append(('heading', int(h.group(1)), t))
            elif '<w:numPr>' in seg:
                lv = re.search(r'<w:ilvl w:val="(\d+)"', seg)
                out.append(('item', int(lv.group(1)) + 1 if lv else 1, t))
            elif MARK.match(t) and re.match(r'^\s*[•·▪◦‣∙●○■□➢►]', t): out.append(('lookalike', 0, t))
            else: out.append(('para', 0, t))
    walk(x, False)
    return [(r, l, t.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')) for r, l, t in out]
CJK = re.compile(r'[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]')
def judgeable(k):
    """A text long enough to be found in its own place: 3+ characters, 2 for
    Han / kana / Hangul (a word). "1", "<", "(E)" can't be told apart from
    their neighbours — not judged, not counted as lost."""
    return len(k) >= (2 if CJK.search(k) else 3)


def align(gt, out):
    """Each GT block -> the output block its text sits in, found IN ORDER: the
    output's keys run together into one stream, and each GT block is searched
    from where the last one was found (a short or repeated text — "Author",
    a title on the cover and in the TOC — is matched to its own place, not to
    the first block that happens to contain it). A block found only behind the
    cursor (moved text) is matched there; one not found at all is None."""
    stream, owner = [], []
    for j, (_, _, t) in enumerate(out):
        k = key(t); stream.append(k); owner.extend([j] * len(k))
    s = ''.join(stream)
    res, cur = [], 0
    for r, l, t in gt:
        k = key(t)
        if not judgeable(k): res.append(None); continue
        i = s.find(k, cur)
        if i < 0:
            # tolerate small differences: the longest leading part found ahead
            probe = k[:max(12, len(k) * 4 // 5)]
            i = s.find(probe, cur)
            if i < 0: i = s.find(k)            # moved text, behind the cursor
        if i < 0: res.append(None); continue
        res.append(owner[i] if i >= cur else -1 - owner[i])   # behind the cursor: negative
        if i >= cur: cur = i + len(k)
    return res
def reliability(pdf, gt):
    """How far the tags can be trusted: the page's own text (MuPDF) and the
    tags' text, compared as 4-gram sets. Low `covered`: the tags leave text out
    (pictures of text, untagged pages); low `real`: the tags hold text the page
    doesn't (glyph codes, junk)."""
    import fitz
    page = key(' '.join(p.get_text() for p in fitz.open(pdf)))
    tagged = key(' '.join(t for _, _, t in gt))
    g = lambda k: {k[i:i + 4] for i in range(max(0, len(k) - 3))}
    P, T = g(page), g(tagged)
    return (round(len(P & T) / (len(P) or 1), 3), round(len(P & T) / (len(T) or 1), 3))


OCR_TAGGER = re.compile(r'ABBYY|FineReader|OmniPage|Recogni[sz]|Capture|Readiris|OCR', re.I)
TRUST = (0.8, 0.9)   # covered, real — below either: the document is not judged


def score(pdf, docx):
    gt = [b for b in tags.blocks(pdf) if judgeable(key(b[2]))]
    import fitz
    producer = ' '.join((fitz.open(pdf).metadata or {}).get(k) or '' for k in ('producer', 'creator'))
    if OCR_TAGGER.search(producer):
        return {'skip': 'tags made by OCR, not by the author', 'producer': producer[:60]}
    covered, real = reliability(pdf, gt)
    if covered < TRUST[0] or real < TRUST[1]:
        return {'skip': 'tags not trusted', 'covered': covered, 'real': real}
    out = docx_blocks(docx); raw = align(gt, out)
    # found only behind the cursor (moved, or a repeated text matched to its
    # first place): counts as found, never as part of a merged block
    a = [None if j is None else (j if j >= 0 else -1 - j) for j in raw]
    ahead = [j is not None and j >= 0 for j in raw]
    row = {'covered': covered, 'real': real, 'gt': dict(collections.Counter(r for r, _, _ in gt)), 'out': dict(collections.Counter(r for r, _, _ in out))}
    found = [j is not None for j in a]
    row['found'] = round(sum(found) / (len(gt) or 1), 3)
    def share(role, want):
        idx = [i for i, (r, _, _) in enumerate(gt) if r == role and a[i] is not None]
        return (sum(1 for i in idx if out[a[i]][0] in want), len(idx))
    for role, want in (('heading', {'heading'}), ('item', {'item'}), ('cell', {'cell'}), ('para', {'para'})):
        k, n = share(role, want)
        row[role] = [k, n]
    # list items written as plain paragraphs with a bullet character
    k, n = share('item', {'lookalike'}); row['itemLookalike'] = [k, n]
    # heading precision: our headings that hold GT text, how many are GT headings
    # (heading PRECISION is not measured: authors make headings bold without a
    # heading style, and the tags then call them P — 2026-10-27 hand check)
    back = collections.defaultdict(list)
    for i, j in enumerate(a):
        if j is not None and ahead[i]: back[j].append(i)
    # paragraphs: one GT para → one output block alone (1:1), several GT paras in one block (merged)
    paras = [i for i, (r, _, _) in enumerate(gt) if r == 'para' and a[i] is not None and ahead[i]]
    row['paraMerged'] = [sum(1 for i in paras if len(back[a[i]]) > 1), len(paras)]
    return row
if __name__ == '__main__':
    print(json.dumps(score(sys.argv[1], sys.argv[2]), ensure_ascii=False))
