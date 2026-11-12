#!/usr/bin/env python3
"""A 300-page Chinese 'e-book' for the phone case of Quick Edit step 0 (QUICKEDIT-PREREG.md, point 6) and the
later find-and-remove step: body text from an open source (Wikipedia zh article in tests/corpus/real, CC BY-SA),
Noto Sans SC embedded as a SUBSET (as e-books ship), and a distributor's promo line at the foot of every page —
the shape of the zh user's files (2026-11-11). No user document is used.

  python3 make_book.py <wikipedia-zh.pdf> <NotoSansSC.ttf> <out.pdf> [pages=300]
"""
import sys, hashlib, textwrap
import fitz

src, font_path, out = sys.argv[1:4]
pages = int(sys.argv[4]) if len(sys.argv) > 4 else 300
text = ''.join(p.get_text() for p in fitz.open(src)).replace('\n', '')
assert len(text) > 5000, 'source text too short'
PROMO = '进群获取更多最新文章、书籍，绝版赠品加 微信 example0001 或 微信 example0002 最新最全'

doc = fitz.open()
pos = 0
for i in range(pages):
    page = doc.new_page(width=420, height=595)          # A5-ish, as phone e-books often are
    page.insert_font(fontname='noto', fontfile=font_path)
    chunk = text[pos:pos + 520] or text[:520]
    pos = (pos + 520) % max(1, len(text) - 520)
    y = 50
    page.insert_text((40, 32), f'第 {i + 1} 章', fontname='noto', fontsize=12)
    for line in textwrap.wrap(chunk, 26):
        page.insert_text((40, y), line, fontname='noto', fontsize=11.5)
        y += 17
        if y > 520: break
    page.insert_text((40, 560), PROMO, fontname='noto', fontsize=7.5, color=(0.2, 0.4, 0.8))
    page.insert_text((200, 580), str(i + 1), fontname='noto', fontsize=8)
doc.subset_fonts()
doc.save(out, garbage=4, deflate=True)
print(out, len(doc), 'pages', round(len(open(out, 'rb').read()) / 1e6, 2), 'MB',
      'sha256', hashlib.sha256(open(out, 'rb').read()).hexdigest())
