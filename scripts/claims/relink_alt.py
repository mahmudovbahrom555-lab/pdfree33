#!/usr/bin/env python3
"""Links to the competitor-named pages -> /alternative-to-cloud-pdf-tools/ with a neutral label.
Usage: python3 relink_alt.py <file-list>"""
import re, sys
LBL = {'iLovePDF Alternative': 'Alternative to cloud PDF tools', 'Smallpdf Alternative': 'Alternative to cloud PDF tools',
 'Smallpdf alternative': 'Alternative to cloud PDF tools', 'Adobe Acrobat Alternative': 'Alternative to cloud PDF tools',
 'Alternativa a iLovePDF': 'Alternativa a las herramientas PDF en la nube', 'Alternativa ao iLovePDF': 'Alternativa às ferramentas PDF na nuvem',
 'Alternative à iLovePDF': 'Alternatives aux outils cloud', 'iLovePDF-Alternative': 'Alternative zu Cloud-PDF-Tools',
 'Альтернатива iLovePDF': 'Альтернатива облачным PDF-сервисам', 'iLovePDFの代替': 'クラウドPDFツールの代わりに',
 'iLovePDF-alternatief': 'Alternatief voor cloud-PDF-tools', 'iLovePDF 대안': '클라우드 PDF 도구 대안',
 'iLovePDF Alternatifi': 'Bulut PDF araçlarına alternatif', 'Giải Pháp Thay Thế iLovePDF': 'Thay thế công cụ PDF đám mây',
 'Alternatywa dla iLovePDF': 'Alternatywa dla narzędzi PDF w chmurze', 'Alternatif iLovePDF': 'Alternatif alat PDF cloud',
 'Alternatives aux outils cloud': 'Alternatives aux outils cloud'}
OLD = r'/(?:ilovepdf-alternative|smallpdf-alternative|pdf24-alternative|adobe-acrobat-alternative|best-free-pdf-tools)/'
NEWURL = '/alternative-to-cloud-pdf-tools/'
unk = set(); n = dup = 0
for f in open(sys.argv[1]).read().split():
    t = open(f, encoding='utf-8').read(); o = t
    def rl(m):
        new = LBL.get(m.group(2).strip())
        if new is None: unk.add((f, m.group(2).strip()[:80])); new = m.group(2)
        return re.sub(OLD, NEWURL, m.group(1)) + new + '</a>'
    t = re.sub(r'(<a [^>]*href="' + OLD + r'"[^>]*>)([^<]*)</a>', rl, t)
    t = re.sub(r'(href=")' + OLD, r'\1' + NEWURL, t)
    a = r'<a [^>]*href="' + NEWURL + r'"[^>]*>[^<]*</a>'
    t2 = re.sub('(' + a + r')(\s*(?:<span[^>]*>[^<]*</span>|·|\|)?\s*)' + a, r'\1', t)
    if t2 != t: dup += 1; t = t2
    if t != o: open(f, 'w', encoding='utf-8').write(t); n += 1
print(n, 'files; duplicate links merged in', dup); print('unknown labels:', sorted(unk))
