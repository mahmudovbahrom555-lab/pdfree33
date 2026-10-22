# Builds ar-ligatures.pdf (class C10, tests/corpus/ERROR_CLASSES.md): Arabic
# drawn the way older Word and print pipelines draw it — glyph by glyph in
# visual order, left to right, each glyph named by ToUnicode as its
# presentation form, two-letter ligatures as one glyph (ﳎ meem with jeem,
# ﳌ lam with meem, ﳊ lam with hah, ﳉ lam with jeem). pdf.js splits such a
# ligature into its letters and then reverses the item: "مجلس" read "جملس".
# And ar-ligatures-letters.pdf (class C11): the same page with ToUnicode
# naming every glyph by its letters, as Word does for Urdu Nastaleeq — a
# ligature glyph by two ("مج"), which pdf.js reverses with the line.
# Font: Amiri (SIL OFL, github.com/google/fonts), a subset. Needs PyMuPDF and
# fontTools.
#   python3 make-ligatures.py path/to/Amiri-Regular.ttf
import io, re, sys, unicodedata
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

doc = fitz.open('ar-ligatures.pdf')
for x in range(1, doc.xref_length()):
    m = re.search(r'/ToUnicode (\d+) 0 R', doc.xref_object(x))
    if not m: continue
    t = int(m.group(1)); cm = doc.xref_stream(t).decode('latin1')
    pairs = {}
    for blk in re.findall(r'beginbfchar(.*?)endbfchar', cm, re.S):
        for a, b in re.findall(r'<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>', blk): pairs[int(a, 16)] = chr(int(b, 16))
    for blk in re.findall(r'beginbfrange(.*?)endbfrange', cm, re.S):
        for a, z, b in re.findall(r'<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>', blk):
            for k in range(int(a, 16), int(z, 16) + 1): pairs[k] = chr(int(b, 16) + k - int(a, 16))
    body = ''.join('<%04x> <%s>\n' % (k, ''.join('%04x' % ord(c) for c in unicodedata.normalize('NFKC', u)))
                   for k, u in sorted(pairs.items()))
    head = cm[:cm.index('endcodespacerange') + len('endcodespacerange')]
    doc.update_stream(t, (head + '\n%d beginbfchar\n%sendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n'
                          % (len(pairs), body)).encode('latin1'))
doc.save('ar-ligatures-letters.pdf', garbage=3, deflate=True)
print('\n'.join(unicodedata.normalize('NFKC', l) for l in LINES))
