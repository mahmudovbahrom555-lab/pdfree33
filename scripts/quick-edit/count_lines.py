#!/usr/bin/env python3
"""Step 4 F2: occurrences of a word per page, counted inside one text line, read by MuPDF (independent of
pdf.js). NFC, case-insensitive, any run of spaces = one space — the same rule the site states.
  python3 count_lines.py <pdf> <word>   → JSON {page: count} (pages with ≥ 1)"""
import json, re, sys, unicodedata
import fitz
doc, word = fitz.open(sys.argv[1]), sys.argv[2]
fold = lambda s: re.sub(r'\s+', ' ', unicodedata.normalize('NFC', s).lower())
target = fold(word).strip()
out = {}
for i, page in enumerate(doc):
    n = 0
    for block in page.get_text('dict')['blocks']:
        for line in block.get('lines', []):
            n += fold(''.join(span['text'] for span in line['spans'])).count(target)
    if n: out[i + 1] = n
print(json.dumps(out))
