# Builds overprint.pdf: text a printer driver drew several times over itself
# to fake bold (class C14, Chinese corpus 2026-10-24) — a glyph four times a
# quarter point apart, a line twice, copies cut into different pieces ("備註"
# over "備" + "註") — and what must stay: "謝謝", the same text in two cells.
# Every text reader reads each once. Needs reportlab (STSong-Light, named
# without embedding, read through Adobe's CMaps).
#   python3 make-overprint.py
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
c = canvas.Canvas('overprint.pdf', pagesize=(420, 300))
c.setFont('STSong-Light', 14)
for dx, dy in ((0, 0), (0.24, 0), (0, 0.24), (0.24, 0.24)):
    c.drawString(30 + dx, 250 + dy, '年柱壬戌')
for dx in (0, 0.3):
    c.drawString(30 + dx, 220, '技術於校園安全建置之經驗分享')
c.drawString(30, 190, '備')
c.drawString(30.24, 190.24, '備註欄')
c.drawString(44.2, 190, '註')
c.drawString(30, 160, '謝謝您的參與')
c.drawString(30, 130, '合計'); c.drawString(200, 130, '合計')
c.save()
