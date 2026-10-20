# Builds the metric v5 control fixtures (scripts/quality/digits.py, class C4):
#   c4-ar-wrong-digits.pdf     — draws "فاتورة رقم 2011 المجموع 4096 دينار";
#                                its ToUnicode names every digit one higher
#                                (both readers read "3122 … 5107")
#   c4-ar-font-cmap-wrong.pdf  — the same page, ToUnicode right, the embedded
#                                font's own cmap swapping 2 and 3: the page
#                                must back ToUnicode, nothing redrawn
# Font: Amiri (SIL OFL, github.com/google/fonts), a subset that keeps its
# cmap. PyMuPDF draws the Arabic unshaped; both readers read it alike, which
# is all these cases need. Needs PyMuPDF and fontTools.
#   python3 make-c4-digits.py path/to/Amiri-Regular.ttf
import io, re, sys
import fitz
from fontTools import subset
from fontTools.ttLib import TTFont

TEXT = 'فاتورة رقم 2011 المجموع 4096 دينار'
opts = subset.Options(); opts.notdef_outline = True; opts.name_IDs = ['*']; opts.layout_features = []
font = TTFont(sys.argv[1]); s = subset.Subsetter(opts); s.populate(text=TEXT + '0123456789'); s.subset(font)
buf = io.BytesIO(); font.save(buf)


def base():
    doc = fitz.open(); page = doc.new_page(width=420, height=140)
    page.insert_font(fontname='amiri', fontbuffer=buf.getvalue())
    page.insert_text((20, 70), TEXT, fontname='amiri', fontsize=18)
    return fitz.open('pdf', doc.tobytes(garbage=3, deflate=True))


def ref(doc, key):
    for x in range(1, doc.xref_length()):
        m = re.search(r'/%s (\d+) 0 R' % key, doc.xref_object(x))
        if m:
            return int(m.group(1))


doc = base(); t = ref(doc, 'ToUnicode'); cm = doc.xref_stream(t).decode('latin1')
m = re.search(r'<([0-9a-f]{4})> <[0-9a-f]{4}> <0030>\n', cm)
first = int(m.group(1), 16)
cm = cm.replace(m.group(0), '').replace('4 beginbfrange', '3 beginbfrange')
cm = re.sub(r'(\d+) beginbfchar\n', lambda k: '%d beginbfchar\n' % (int(k.group(1)) + 10)
            + ''.join('<%04x> <%04x>\n' % (first + d, 0x30 + (d + 1) % 10) for d in range(10)), cm)
doc.update_stream(t, cm.encode('latin1')); doc.save('c4-ar-wrong-digits.pdf', garbage=3, deflate=True)

doc = base(); ff = ref(doc, 'FontFile2'); tt = TTFont(io.BytesIO(doc.xref_stream(ff)))
for tb in tt['cmap'].tables:
    if 0x32 in tb.cmap and 0x33 in tb.cmap:
        tb.cmap[0x32], tb.cmap[0x33] = tb.cmap[0x33], tb.cmap[0x32]
b = io.BytesIO(); tt.save(b); doc.update_stream(ff, b.getvalue()); doc.save('c4-ar-font-cmap-wrong.pdf', garbage=3, deflate=True)
