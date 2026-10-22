# Builds running-header.pdf: three pages, each with the same document symbol
# at the top ("A/HRC/55/L.12") and the same line at the bottom ("Distr.:
# General"), Arabic body text between. PDF→Word keeps such repeated text out
# of the body as page furniture; it must land in the Word header and footer
# instead of being lost (2563334, a UN document: the symbol was in no part
# of our .docx). Font: Amiri (SIL OFL), a subset. Needs PyMuPDF and fontTools.
#   python3 make-running-header.py path/to/Amiri-Regular.ttf
import io, sys
import fitz
from fontTools import subset
from fontTools.ttLib import TTFont

BODY = ['ﺍﻟﺠﻤﻌﻴﺔ ﺍﻟﻌﺎﻣﺔ', 'ﻣﺠﻠﺲ ﺣﻘﻮﻕ ﺍﻹﻧﺴﺎﻥ', 'ﺍﻟﺪﻭﺭﺓ ﺍﻟﺨﺎﻣﺴﺔ ﻭﺍﻟﺨﻤﺴﻮﻥ']
# a page of body text: nine lines, the page number in each, so none repeats
opts = subset.Options(); opts.notdef_outline = True; opts.name_IDs = ['*']; opts.layout_features = []
font = TTFont(sys.argv[1]); s = subset.Subsetter(opts); s.populate(text=''.join(BODY) + ' 0123456789'); s.subset(font)
buf = io.BytesIO(); font.save(buf)
doc = fitz.open()
for k in range(3):
    page = doc.new_page(width=420, height=595)
    page.insert_font(fontname='amiri', fontbuffer=buf.getvalue())
    page.insert_text((300, 40), 'A/HRC/55/L.12', fontname='helv', fontsize=10)
    for j in range(9):
        line = BODY[j % 3]
        page.insert_text((60, 120 + 45 * j), str(10 * k + j) + ' ' + line[::-1], fontname='amiri', fontsize=20)
    page.insert_text((40, 570), 'Distr.: General', fontname='helv', fontsize=9)
doc.save('running-header.pdf', garbage=3, deflate=True)
