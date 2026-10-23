# Builds cjk-cmaps.pdf: one page per CJK font a PDF may name without
# embedding it, through Adobe's predefined CMaps (UniGB-UCS2-H, UniCNS-UCS2-H,
# UniJIS-UCS2-H, UniKS-UCS2-H) — what TCPDF, Acrobat PDFWriter and Hong Kong
# filing systems write (Chinese corpus, 2026-10-23: 8 of 128 documents, their
# Chinese and Japanese text missing from the .docx, or the whole .docx
# empty). pdf.js needs these CMap files to read such text at all; the line
# after each sentence is Latin, which it reads either way. Needs reportlab.
#   python3 make-cjk-cmaps.py
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase import cidfonts
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
# reportlab (4.5.1) pairs MSung-Light with the simplified-Chinese CMap; the
# traditional one is UniCNS-UCS2-H
cidfonts.defaultUnicodeEncodings['MSung-Light'] = ('cht', 'UniCNS-UCS2-H')
PAGES = [('STSong-Light', '简体中文：董事会成员名单与其角色和职能', 'Simplified Chinese'),
         ('MSung-Light', '繁體中文：董事會成員名單與其角色和職能', 'Traditional Chinese'),
         ('HeiseiMin-W3', '日本語：第四十八回全国学生スキー大会', 'Japanese'),
         ('HYSMyeongJo-Medium', '한국어: 이사회 구성원 명단', 'Korean')]
c = canvas.Canvas('cjk-cmaps.pdf', pagesize=(420, 300))
for font, text, latin in PAGES:
    pdfmetrics.registerFont(UnicodeCIDFont(font))
    c.setFont(font, 16); c.drawString(30, 220, text)
    c.setFont('Helvetica', 12); c.drawString(30, 180, latin + ' 2026')
    c.showPage()
c.save()
