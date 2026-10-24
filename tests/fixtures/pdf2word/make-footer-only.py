# Builds footer-only.pdf: four pages that hold only a picture and the same
# three lines at the bottom — a company's address, tax number and website, as
# a page-per-photo catalogue printed by DOMPDF does (4736268, Chinese
# competitor pilot 2026-10-24). PDF→Word put the second bottom line into the
# Word HEADER: with only three lines on a page, the "first three lines" and
# the "last three" were the same lines. They belong in the footer. Needs PyMuPDF.
#   python3 make-footer-only.py
import fitz
LINES = ['Lionard s.r.l. - via dei Banchi 6 - 50123 Firenze - Tel. +39 055 0548100',
         'Tax 01660450477 - REA PT 173842 - share capital 10,000 EUR',
         'www.example-shop.com - info@example-shop.com']
doc = fitz.open()
for k in range(4):
    page = doc.new_page(width=612, height=792)
    page.draw_rect(fitz.Rect(60, 80, 552, 700), color=(0.4, 0.5, 0.6), fill=(0.8, 0.85, 0.9))   # the picture
    for j, line in enumerate(LINES):
        page.insert_text((60, 752 + 13 * j), line, fontname='helv', fontsize=8)
doc.save('footer-only.pdf', garbage=3, deflate=True)
