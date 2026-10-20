# Builds the two class-C4 fixtures (tests/corpus/ERROR_CLASSES.md):
#   c4-wrong-digits.pdf     — draws "Invoice 2011, total 4096"; its ToUnicode
#                             names every digit one higher ("3122 … 5107")
#   c4-font-cmap-wrong.pdf  — the same page, ToUnicode right, but the embedded
#                             font's own cmap swaps 2 and 3: the shape check
#                             must refuse that cmap and change nothing
# Font: Tinos (Apache-2.0, github.com/google/fonts), a subset that keeps its
# cmap. Needs PyMuPDF and fontTools.
#   python3 make-c4-digits.py path/to/Tinos-Regular.ttf
import io, re, sys
import fitz
from fontTools import subset
from fontTools.ttLib import TTFont

TEXT = 'Invoice 2011, total 4096'
opts = subset.Options(); opts.notdef_outline = True; opts.name_IDs = ['*']; opts.layout_features = []
font = TTFont(sys.argv[1]); s = subset.Subsetter(opts); s.populate(text=TEXT + '0123456789'); s.subset(font)
buf = io.BytesIO(); font.save(buf)

def base():
    doc = fitz.open(); page = doc.new_page(width=300, height=120)
    page.insert_font(fontname='tinos', fontbuffer=buf.getvalue())
    page.insert_text((20, 60), TEXT, fontname='tinos', fontsize=18)
    return fitz.open('pdf', doc.tobytes(garbage=3, deflate=True))

def ref(doc, key):
    for x in range(1, doc.xref_length()):
        m = re.search(r'/%s (\d+) 0 R' % key, doc.xref_object(x))
        if m: return int(m.group(1))

doc = base(); t = ref(doc, 'ToUnicode'); cm = doc.xref_stream(t).decode('latin1')
assert '<0003> <000c> <0030>' in cm
cm = cm.replace('2 beginbfrange\n<0003> <000c> <0030>\n', '1 beginbfrange\n')
cm = cm.replace('10 beginbfchar\n', '20 beginbfchar\n' + ''.join('<%04x> <%04x>\n' % (3 + k, 0x30 + (k + 1) % 10) for k in range(10)))
doc.update_stream(t, cm.encode('latin1')); doc.save('c4-wrong-digits.pdf', garbage=3, deflate=True)

doc = base(); ff = ref(doc, 'FontFile2'); tt = TTFont(io.BytesIO(doc.xref_stream(ff)))
for tb in tt['cmap'].tables:
    if 0x32 in tb.cmap and 0x33 in tb.cmap: tb.cmap[0x32], tb.cmap[0x33] = tb.cmap[0x33], tb.cmap[0x32]
b = io.BytesIO(); tt.save(b); doc.update_stream(ff, b.getvalue()); doc.save('c4-font-cmap-wrong.pdf', garbage=3, deflate=True)
