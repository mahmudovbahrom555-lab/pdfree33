#!/usr/bin/env python3
"""Comparison tables: competitor rows (or columns) collapse into one 'Other online tools' row/column.
A cell keeps its value when every competitor had the same one, else 'Varies by tool'. Arabic waits
(SEO re-check until 2026-11-16). Usage: python3 comp_tables.py [--write]"""
import re, sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from competitors import NAMES, files
OTHER = {'en': ('Typical cloud PDF tools', 'Varies by tool'), 'de': ('Übliche Cloud-PDF-Tools', 'Je nach Tool'),
 'es': ('Herramientas PDF en la nube habituales', 'Depende de la herramienta'), 'fr': ('Outils PDF cloud courants', "Selon l'outil"),
 'pt': ('Ferramentas PDF na nuvem comuns', 'Depende da ferramenta'), 'it': ('Strumenti PDF cloud comuni', 'Dipende dallo strumento'),
 'nl': ('Gangbare cloud-PDF-tools', 'Verschilt per tool'), 'pl': ('Typowe narzędzia PDF w chmurze', 'Zależy od narzędzia'),
 'tr': ('Yaygın bulut PDF araçları', 'Araca göre değişir'), 'vi': ('Công cụ PDF đám mây phổ biến', 'Tùy công cụ'),
 'id': ('Alat PDF cloud pada umumnya', 'Tergantung alatnya'), 'ja': ('一般的なクラウドPDFツール', 'ツールによる'),
 'ko': ('일반적인 클라우드 PDF 도구', '도구마다 다름'), 'ru': ('Типичные облачные PDF-сервисы', 'Зависит от сервиса'),
 'zh-CN': ('常见的云端 PDF 工具', '因工具而异'), 'fa': ('ابزارهای PDF ابری رایج', 'بسته به ابزار'),
 'he': ('כלי PDF נפוצים בענן', 'משתנה לפי הכלי'), 'ur': ('عام کلاؤڈ PDF ٹولز', 'ٹول کے لحاظ سے مختلف'),
 'bn': ('প্রচলিত ক্লাউড PDF টুল', 'টুলভেদে ভিন্ন'), 'hi': ('आम क्लाउड PDF टूल', 'टूल के अनुसार अलग')}
SKIP = ('blog/pdf-to-markdown-benchmark/', 'ilovepdf-alternative/', 'smallpdf-alternative/', 'pdf24-alternative/',
        'adobe-acrobat-alternative/', 'best-free-pdf-tools/')   # letters by hand / redirected
def lang_of(p):
    s = p.split('/')
    l = s[2] if s[0] == 'data' and len(s) > 2 else s[0]
    l = 'zh-CN' if l in ('zh', 'zh-CN') else l
    return l if l in OTHER or l == 'ar' else 'en'
CELL = re.compile(r'(<t([dh])\b[^>]*>)(.*?)(</t\2>)', re.S)
txt = lambda h: re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', h)).strip()
def merged(cells, label_first, other, varies):
    """cells: list of (open, inner, close) for the competitor entries of one row/column."""
    if label_first: return cells[0][0] + other + cells[0][2]
    vals = {txt(c[1]) for c in cells}
    return cells[0][0] + (cells[0][1] if len(vals) == 1 else varies) + cells[0][2]
def fix_table(s, lang):
    other, varies = OTHER[lang]
    trs = list(re.finditer(r'<tr\b.*?</tr>', s, re.S))
    first = lambda r: txt((CELL.findall(r) or [('', '', '', '')])[0][2])
    comp = [m for m in trs if re.search(NAMES, first(m.group(0)))]
    if comp:   # competitors are rows
        rows = [list(CELL.finditer(m.group(0))) for m in comp]
        n = min(len(r) for r in rows)
        new = comp[0].group(0)
        cells0 = rows[0]
        out = new[:cells0[0].start()]
        for i in range(n):
            out += merged([(r[i].group(1), r[i].group(3), r[i].group(4)) for r in rows], i == 0, other, varies)
            out += new[cells0[i].end():cells0[i + 1].start()] if i + 1 < n else new[cells0[n - 1].end():]
        res = s[:comp[0].start()] + out
        prev = comp[0].end()
        for m in comp[1:]:
            gap = s[prev:m.start()]
            res += '' if not gap.strip() else gap
            prev = m.end()
        return res + s[prev:]
    # competitors are columns: find them in the header row
    head = trs[0].group(0) if trs else ''
    idx = [i for i, c in enumerate(CELL.findall(head)) if re.search(NAMES, txt(c[2]))]
    if not idx: return s
    def fix_row(m):
        r = m.group(0); cs = list(CELL.finditer(r))
        if len(cs) <= max(idx): return r
        is_head = m.start() == trs[0].start()
        cell = merged([(cs[i].group(1), cs[i].group(3), cs[i].group(4)) for i in idx], is_head, other, varies)
        out = r[:cs[idx[0]].start()] + cell; prev = cs[idx[0]].end()
        for i in range(idx[0] + 1, len(cs)):
            if i in idx: out += ''; prev = cs[i].end(); continue
            out += r[prev:cs[i].end()] if i not in idx else ''; prev = cs[i].end()
        return out + r[prev:]
    return re.sub(r'<tr\b.*?</tr>', fix_row, s, flags=re.S)
def main(write):
    n = 0
    for f in files():
        if not f.endswith('.html'): continue
        lang = lang_of(f)
        if lang == 'ar' or f.startswith(SKIP): continue
        t = open(f, encoding='utf-8').read()
        out = re.sub(r'<table\b.*?</table>', lambda m: fix_table(m.group(0), lang) if re.search(NAMES, txt(m.group(0))) else m.group(0), t, flags=re.S)
        if out != t:
            n += 1
            if write: open(f, 'w', encoding='utf-8').write(out)
            elif n <= 3: print(f)
    print(n, 'files', file=sys.stderr)
if __name__ == '__main__': main('--write' in sys.argv)
