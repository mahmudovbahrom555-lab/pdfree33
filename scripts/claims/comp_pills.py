#!/usr/bin/env python3
"""'iLovePDF: 25MB limit · SmallPDF: 2 tasks/day · Adobe: paid' pills -> one neutral pill per language."""
import re, subprocess, sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from comp_tables import lang_of
PILL = {'en': 'Cloud tools: size and daily limits on free plans', 'de': 'Cloud-Tools: Größen- und Tageslimits im Gratis-Tarif',
 'es': 'Herramientas en la nube: límites de tamaño y diarios en planes gratis', 'fr': 'Outils cloud : limites de taille et quotidiennes en gratuit',
 'pt': 'Ferramentas na nuvem: limites de tamanho e diários no plano grátis', 'it': 'Strumenti cloud: limiti di dimensione e giornalieri nel piano gratuito',
 'nl': 'Cloudtools: grootte- en daglimieten in het gratis plan', 'pl': 'Narzędzia w chmurze: limity rozmiaru i dzienne w darmowym planie',
 'tr': 'Bulut araçları: ücretsiz planda boyut ve günlük sınırlar', 'vi': 'Công cụ đám mây: giới hạn dung lượng và số lần mỗi ngày ở gói miễn phí',
 'id': 'Alat cloud: batas ukuran dan harian di paket gratis', 'ja': 'クラウドツール：無料プランはサイズと回数に制限',
 'ko': '클라우드 도구: 무료 플랜의 크기·일일 제한', 'ru': 'Облачные сервисы: лимиты размера и задач в день на бесплатном тарифе',
 'zh-CN': '云端工具：免费版有大小和每日次数限制'}
SPAN = r'<span [^>]*>\s*(?:iLovePDF|SmallPDF|Smallpdf|Adobe(?: Acrobat)?|PDF24|Sejda)\s*[:：][^<]*</span>'
n = 0
for f in subprocess.run(['git', 'ls-files', '--', '*.html', '**/*.html', ':!dist'], capture_output=True, text=True).stdout.split():
    lang = lang_of(f)
    if lang == 'ar': continue
    t = open(f, encoding='utf-8').read()
    def rep(m):
        first = re.match(r'(<span [^>]*>)', m.group(0)).group(1)
        return first + PILL[lang] + '</span>'
    t2 = re.sub(SPAN + r'(?:\s*' + SPAN + r')*', rep, t)
    if t2 != t: open(f, 'w', encoding='utf-8').write(t2); n += 1
print(n, 'files')
