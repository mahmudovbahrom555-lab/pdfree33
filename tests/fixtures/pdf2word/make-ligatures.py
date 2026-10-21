# Builds ar-ligatures.pdf (class C10, tests/corpus/ERROR_CLASSES.md): Arabic
# drawn the way older Word and print pipelines draw it — glyph by glyph in
# visual order, left to right, each glyph named by ToUnicode as its
# presentation form, two-letter ligatures as one glyph (ﳎ meem with jeem,
# ﳌ lam with meem, ﳊ lam with hah, ﳉ lam with jeem). pdf.js splits such a
# ligature into its letters and then reverses the item: "مجلس" read "جملس".
# Font: Amiri (SIL OFL, github.com/google/fonts), a subset. Needs PyMuPDF and
# fontTools.
#   python3 make-ligatures.py path/to/Amiri-Regular.ttf
import io, sys, unicodedata
import fitz
from fontTools import subset
from fontTools.ttLib import TTFont

# presentation forms, logical order; the words they stand for are their NFKC
LINES = ['ﳎﻠﺲ ﺍﻷﻣﻦ ﻓﻲ ﺍﻷﻣﻢ ﺍﳌﺘﺤﺪﺓ', 'ﺍﳊﻘﻮﻕ ﻭﺍﳊﺮﻳﺎﺕ ﳉﻤﻴﻊ ﺍﻟﻨﺎﺱ']
opts = subset.Options(); opts.notdef_outline = True; opts.name_IDs = ['*']; opts.layout_features = []
font = TTFont(sys.argv[1]); s = subset.Subsetter(opts); s.populate(text=''.join(LINES)); s.subset(font)
buf = io.BytesIO(); font.save(buf)

doc = fitz.open(); page = doc.new_page(width=420, height=160)
page.insert_font(fontname='amiri', fontbuffer=buf.getvalue())
for k, line in enumerate(LINES):
    page.insert_text((40, 60 + 40 * k), line[::-1], fontname='amiri', fontsize=22)
doc.save('ar-ligatures.pdf', garbage=3, deflate=True)
print('\n'.join(unicodedata.normalize('NFKC', l) for l in LINES))
