#!/usr/bin/env python3
"""'Unlike SmallPDF (2 tasks/day) or iLovePDF (daily limits), PDFree …' in every language (not ar)."""
import re, subprocess, sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from comp_tables import lang_of
PAIR = r'SmallPDF\s*[（(][^)）]*[)）]\s*\S{1,4}\s*(?:d[oa]\s+)?iLovePDF\s*[（(][^)）]*[)）]'
U = {'de': (r'Anders als\s*' + PAIR, 'Anders als Cloud-Tools mit Tageslimits im Gratis-Tarif'),
 'es': (r'A diferencia de\s*' + PAIR, 'A diferencia de las herramientas en la nube con límites diarios en el plan gratuito'),
 'fr': (r'Contrairement à\s*' + PAIR, "Contrairement aux outils cloud qui limitent l'usage gratuit par jour"),
 'id': (r'Berbeda dengan\s*' + PAIR, 'Berbeda dengan alat cloud yang membatasi paket gratis per hari'),
 'it': (r'A differenza di\s*' + PAIR, 'A differenza degli strumenti cloud con limiti giornalieri nel piano gratuito'),
 'ja': (PAIR, '無料プランに1日の上限があるクラウドツール'),
 'ko': (PAIR, '무료 플랜에 일일 제한이 있는 클라우드 도구'),
 'nl': (r'In tegenstelling tot\s*' + PAIR, 'In tegenstelling tot cloudtools met daglimieten in het gratis plan'),
 'pl': (r'W przeciwieństwie do\s*' + PAIR, 'W przeciwieństwie do narzędzi w chmurze z dziennymi limitami w darmowym planie'),
 'ru': (r'В отличие от\s*' + PAIR, 'В отличие от облачных сервисов с дневными лимитами на бесплатном тарифе'),
 'vi': (r'Khác với\s*' + PAIR, 'Khác với các công cụ đám mây giới hạn số lần mỗi ngày ở gói miễn phí'),
 'pt': (r'(?:Ao contrário d[oa]|Diferente d[oa])\s*' + PAIR, 'Ao contrário das ferramentas na nuvem com limites diários no plano grátis')}
n = 0
for f in subprocess.run(['git', 'ls-files', '--', '*.html', '**/*.html', ':!dist'], capture_output=True, text=True).stdout.split():
    lang = lang_of(f)
    if lang not in U: continue
    t = open(f, encoding='utf-8').read()
    t2 = re.sub(U[lang][0], U[lang][1], t)
    if t2 != t: open(f, 'w', encoding='utf-8').write(t2); n += 1
print(n, 'files')
