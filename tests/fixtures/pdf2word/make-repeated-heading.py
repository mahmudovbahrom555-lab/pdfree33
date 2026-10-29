# Builds repeated-heading.pdf: three pages, each with the same symbol at the
# top, the same line at the bottom, and the same heading in the MIDDLE of the
# page ("Second qualifying round — scores"), body lines between that differ
# per page. A line repeated on every page leaves the body only for the Word
# header or footer, at the page's edge; one in the middle stays where it is
# (4223578: a results table's heading rows, repeated on each of its 10 pages,
# were deleted, 2026-10-29). Needs PyMuPDF.
#   python3 make-repeated-heading.py
import fitz

# body lines all different in words, not only in digits: lines at a page's
# edge that differ only in digits are taken for page numbers ("Page 1 of 4")
WORDS = ['alpine', 'birch', 'cedar', 'delta', 'ember', 'fjord', 'glacier', 'harbor',
         'island', 'juniper', 'kestrel', 'lagoon', 'meadow', 'nectar', 'orchard', 'prairie',
         'quartz', 'river', 'summit', 'tundra', 'upland', 'valley', 'willow', 'yarrow']
doc = fitz.open()
for k in range(3):
    page = doc.new_page(width=420, height=595)
    page.insert_text((300, 40), 'RES/2021/07', fontname='helv', fontsize=10)
    for j in range(4):
        page.insert_text((60, 100 + 30 * j), f'The {WORDS[8 * k + j]} entry opens this page', fontname='helv', fontsize=12)
    page.insert_text((60, 300), 'Second qualifying round - scores', fontname='helv', fontsize=12)
    for j in range(4):
        page.insert_text((60, 340 + 30 * j), f'Score for {WORDS[8 * k + 4 + j]} under the heading', fontname='helv', fontsize=12)
    page.insert_text((40, 570), 'Printed by the race office', fontname='helv', fontsize=9)
doc.save('repeated-heading.pdf', garbage=3, deflate=True)
