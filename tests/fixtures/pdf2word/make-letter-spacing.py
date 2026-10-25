# Builds letter-spacing.pdf: Chinese and Japanese drawn a glyph at a time with
# even gaps — a title, two table headers, a name spread over its cell (P2a,
# Chinese corpus 2026-10-24: "董 事 名 單", "氏 名 所 属", "山 口 那 智") — and
# the spaces that must stay: a Japanese name's family–given gap a whole em
# wider, cells 3 em apart.
# Gaps in em as the corpus documents draw them. Needs reportlab (STSong-Light,
# named without embedding, read through Adobe's CMaps; every glyph 1 em wide).
#   python3 make-letter-spacing.py
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
S = 12
c = canvas.Canvas('letter-spacing.pdf', pagesize=(460, 300))
c.setFont('STSong-Light', S)
def spread(y, glyphs, gaps, x=30):
    for k, g in enumerate(glyphs):
        c.drawString(x, y, g)
        x += S * (1 + (gaps[k] if k < len(gaps) else 0))
spread(260, '董事名單與其角色', [0.3] * 7)
spread(230, '氏名所属', [1.0, 4.38, 1.0])
spread(200, '青山桃子', [0.54, 1.54, 0.53])
spread(170, '日一二三', [3.2, 3.2, 3.2])
c.save()
