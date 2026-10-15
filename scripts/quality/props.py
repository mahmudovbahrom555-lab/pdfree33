#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Phase 2 of the corpus plan, step 1: the same properties read independently
from a PDF (MuPDF — not the pdf.js our converter uses) and from a DOCX (its
XML), then compared. No ground truth: the original is its own reference.

Signals (each kept separate; one defect may fire several — they are grouped
per document, not counted as independent proof):
  table.rows       a ruled table in the PDF (MuPDF find_tables) vs the DOCX table
                   with the same first-row text: row / column counts
  table.smell      a DOCX table where most rows have ≤ 1 filled cell
  color.lost       share of the PDF's coloured (non-black/grey) text whose words
                   come out with no colour in the DOCX
  font.lost        PDF uses fonts, the DOCX names none at all
  font.mono        PDF has monospace text, the DOCX has no monospace font
  para.smell       one DOCX paragraph holding several list items "a) … b) …"
                   or several fill-in lines "____"
  watermark.leaked text the PDF repeats on most pages or draws rotated
                   (a watermark) turned into paragraphs of the DOCX
  text.recall      share of the PDF's text (letter 4-grams) found in the DOCX, NFKC-
                   normalised — MuPDF hands Arabic and Persian back as
                   presentation forms (ﻋﺎﺷﻮراء), our DOCX as plain letters
                   (عاشوراء): compared raw, a correct Arabic file scored 0.09
  text.spaced      words broken into letters in the DOCX ("T H E") that are
                   whole in the PDF
  numbers.changed  numbers in the PDF that are missing from the DOCX — a
                   reversed digit run in RTL text (٨٩ → ٩٨) reads fine but is
                   a different number

Watermark-like text (the same string on most pages, or rotated) is left out of
the PDF side: a converter that drops it is right to.

  python3 scripts/quality/props.py original.pdf converted.docx [more.docx …]
"""
import collections, json, re, sys, unicodedata, zipfile

import fitz

MONO = re.compile(r'mono|courier|consolas|menlo|code', re.I)


def pdf_props(path):
    doc = fitz.open(path)
    spans, tables = [], []
    per_page_text = collections.Counter()
    for page in doc:
        seen = set()
        for b in page.get_text('dict')['blocks']:
            for line in b.get('lines', []):
                rotated = abs(line['dir'][1]) > 0.05
                for s in line['spans']:
                    t = s['text'].strip()
                    if not t: continue
                    spans.append({'text': t, 'color': s['color'], 'font': s['font'], 'size': s['size'],
                                  'page': page.number, 'rotated': rotated})
                    if t not in seen: seen.add(t); per_page_text[t] += 1
        for tab in page.find_tables().tables:
            rows = tab.extract()
            cells = [c for r in rows for c in r]
            # a layout grid, not a table: MuPDF also reports slide frames and
            # empty ruled boxes (4 of 9 first table.rows alarms) — skip an
            # empty header row or a grid that is mostly empty
            if not any((c or '').strip() for c in rows[0]) or sum(1 for c in cells if (c or '').strip()) < 0.4 * len(cells):
                continue
            tables.append({'page': page.number, 'rows': len(rows), 'cols': tab.col_count,
                           'first': ' '.join(' '.join((c or '').split()) for c in rows[0] if c)})
    n = doc.page_count
    repeated = {t for t, k in per_page_text.items() if n > 1 and k >= max(2, n * 0.6)}
    body = [s for s in spans if not s['rotated'] and s['text'] not in repeated]
    # only rotated text: a line repeated on every page is often a running
    # header (a company name), which a converter is right to keep
    marks = {s['text'] for s in spans if s['rotated'] and len(s['text']) >= 6}
    return {'pages': n, 'spans': body, 'tables': tables, 'marks': marks,
            'text': ' '.join(p.get_text() for p in doc)}


def _rgb(c):
    return (c >> 16) & 255, (c >> 8) & 255, c & 255


def is_colored(c):
    r, g, b = _rgb(c)
    return max(r, g, b) - min(r, g, b) > 40   # not black, white or grey


def docx_props(path):
    x = zipfile.ZipFile(path).read('word/document.xml').decode('utf-8')
    tables = []
    for t in re.findall(r'<w:tbl>.*?</w:tbl>', x, re.S):
        rows = [[' '.join(''.join(re.findall(r'<w:t[^>]*>([^<]*)', c)).split())
                 for c in re.findall(r'<w:tc>.*?</w:tc>', r, re.S)]
                for r in re.findall(r'<w:tr[ >].*?</w:tr>', t, re.S)]
        tables.append(rows)
    body = re.sub(r'<w:tbl>.*?</w:tbl>', '', x, flags=re.S)
    paras = [''.join(re.findall(r'<w:t[^>]*>([^<]*)', p)) for p in re.findall(r'<w:p[ >].*?</w:p>', body, re.S)]
    runs = []
    for r in re.findall(r'<w:r>.*?</w:r>|<w:r [^>]*>.*?</w:r>', x, re.S):
        txt = ''.join(re.findall(r'<w:t[^>]*>([^<]*)', r))
        if not txt.strip(): continue
        col = re.search(r'<w:color w:val="([0-9A-Fa-f]{6})"', r)
        font = re.search(r'<w:rFonts [^>]*w:ascii="([^"]+)"', r)
        runs.append({'text': txt, 'color': int(col.group(1), 16) if col else None, 'font': font.group(1) if font else None})
    styles = ''
    try: styles = zipfile.ZipFile(path).read('word/styles.xml').decode('utf-8')
    except KeyError: pass
    default_fonts = re.findall(r'w:ascii="([^"]+)"', styles)
    # runs of one paragraph touch: a word split across runs (bold from its
    # third letter) is one word in Word — joined with spaces, every such
    # split counted as text.spaced (3147696: 2020 "single letters", ~5 real)
    text = ' '.join(''.join(re.findall(r'<w:t[^>]*>([^<]*)', p)) for p in re.findall(r'<w:p[ >].*?</w:p>', x, re.S))
    return {'tables': tables, 'paras': paras, 'runs': runs, 'default_fonts': default_fonts, 'text': text}


def norm(t):
    t = unicodedata.normalize('NFKC', t)
    t = ''.join(c for c in t if unicodedata.category(c) != 'Mn')   # harakat, combining marks
    return t.lower()


# CJK has no spaces: one character is one "word" — otherwise "4月6日" vs
# "4 月 6 日" (the same text, spaced) scored as lost words (a Japanese
# timetable read 67 %, all its text there)
CJK = r'\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af'
WORD = re.compile(rf'[{CJK}]|[^\W{CJK}]+')
RTL = re.compile(r'[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]')
DIGITS = str.maketrans('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789')


def compare(pdf, dx):
    findings = []
    # tables: match by first-row text overlap
    for pt in pdf['tables']:
        # words of the header row, single letters dropped (a diagonal
        # watermark crossing the table leaves stray letters in MuPDF's cells)
        words = {w for w in pt['first'].lower().split() if len(w) > 1}
        overlap = lambda t: len(words & set(' '.join(sum(t[:3], [])).lower().split()))
        best = max(dx['tables'], key=overlap, default=None)
        # the same table only if most of its header is there — otherwise
        # another table would be "compared" (false alarm, found on the
        # first labelled document: a 3-page DOCX vs a 6-page PDF)
        if best is None or overlap(best) < 0.5 * len(words):
            findings.append({'signal': 'table.unmatched', 'severity': 'info',
                             'detail': f"PDF table p{pt['page']+1} {pt['rows']}×{pt['cols']} — no DOCX table with its header"})
            continue
        rows, cols = len(best), max((len(r) for r in best), default=0)
        if rows != pt['rows'] or cols != pt['cols']:
            findings.append({'signal': 'table.rows', 'severity': 'high',
                             'detail': f"PDF {pt['rows']}×{pt['cols']} → DOCX {rows}×{cols} ('{pt['first'][:40]}')"})
    for t in dx['tables']:
        if len(t) >= 4:
            thin = sum(1 for r in t if sum(1 for c in r if c) <= 1)
            if thin / len(t) > 0.5:
                findings.append({'signal': 'table.smell', 'severity': 'medium', 'detail': f'{thin}/{len(t)} rows with ≤ 1 filled cell'})
    # colour: coloured words in the PDF, and whether those words keep any colour
    colored = [s for s in pdf['spans'] if is_colored(s['color'])]
    if colored:
        dcol = ' '.join(r['text'] for r in dx['runs'] if r['color'] is not None and is_colored(r['color'])).lower()
        kept = sum(1 for s in colored if s['text'].lower() in dcol)
        share = 1 - kept / len(colored)
        if share > 0.3:
            findings.append({'signal': 'color.lost', 'severity': 'medium',
                             'detail': f'{len(colored) - kept}/{len(colored)} coloured PDF spans have no colour in DOCX'})
    # fonts
    dfonts = {r['font'] for r in dx['runs'] if r['font']} | set(dx['default_fonts'])
    if pdf['spans'] and not dfonts:
        findings.append({'signal': 'font.lost', 'severity': 'low', 'detail': 'DOCX names no font at all'})
    mono = [s for s in pdf['spans'] if MONO.search(s['font'])]
    if len(mono) > 3 and not any(MONO.search(f) for f in dfonts):
        findings.append({'signal': 'font.mono', 'severity': 'low', 'detail': f'{len(mono)} monospace PDF spans, no monospace font in DOCX'})
    # paragraphs holding several list items or several fill-in lines
    for p in dx['paras']:
        items = re.findall(r'(?:^|\s)([a-zа-я]\))\s', p)
        blanks = len(re.findall(r'_{10,}', p))
        if len(items) >= 2 or blanks >= 3:
            findings.append({'signal': 'para.smell', 'severity': 'medium',
                             'detail': f'one paragraph: {len(items)} list items, {blanks} fill-in lines — "{p[:50]}…"'})
    # text: words kept, words broken into letters, numbers changed
    # recall on letter 4-grams with all spacing removed: the PDF's own word
    # boundaries can't be trusted (MuPDF glued a Persian line into one
    # "word", our DOCX spaced it correctly — word recall said 49 %). Spacing
    # defects have their own signal (text.spaced).
    grams = lambda t: collections.Counter(t[i:i + 4] for i in range(len(t) - 3))
    letters = lambda t: ''.join(WORD.findall(norm(t)))
    pw, dw = grams(letters(pdf['text'])), grams(letters(dx['text']))
    if sum(pw.values()) >= 120:
        recall = sum(min(c, dw[w]) for w, c in pw.items()) / sum(pw.values())
        if recall < 0.85:
            findings.append({'signal': 'text.recall', 'severity': 'high' if recall < 0.6 else 'medium',
                             'detail': f'{recall:.0%} of the PDF\'s text found in the DOCX'})
    # CJK characters are single by nature ("4 月 6 日" is spacing, not breakage)
    single = lambda t: sum(1 for w in t.split() if len(w) == 1 and w.isalpha() and not re.match(f'[{CJK}]', w))
    ps, ds = single(norm(pdf['text'])), single(norm(dx['text']))
    if ds >= 20 and ds > 3 * max(ps, 5):
        findings.append({'signal': 'text.spaced', 'severity': 'high',
                         'detail': f'{ds} single letters in the DOCX vs {ps} in the PDF — words broken into letters'})
    # only next to right-to-left letters (where the bug lives), and only when
    # the reversed number appears nowhere in the PDF: otherwise "84" and an
    # unrelated "48" elsewhere count — 5 of 7 first findings were that
    near_rtl = lambda t: {m.group(1) for m in re.finditer(r'(\d{2,})', t)
                          if RTL.search(t[max(0, m.start() - 12):m.end() + 12])}
    pt, dt = pdf['text'].translate(DIGITS), dx['text'].translate(DIGITS)
    pn, pall, dn = near_rtl(pt), set(re.findall(r'\d{2,}', pt)), set(re.findall(r'\d{2,}', dt))
    changed = [n for n in pn if n not in dn and n[::-1] in dn and n[::-1] not in pall and n != n[::-1]]
    if changed:
        findings.append({'signal': 'numbers.changed', 'severity': 'high',
                         'detail': f'{len(changed)} numbers appear reversed, e.g. {changed[0]} → {changed[0][::-1]}'})
    # watermark text that became document text
    leaked = [p for p in dx['paras'] if p.strip() and any(m in p for m in pdf['marks']) and len(p.strip()) < 80]
    if len(leaked) >= 3:
        findings.append({'signal': 'watermark.leaked', 'severity': 'medium',
                         'detail': f'{len(leaked)} paragraphs are watermark text, e.g. "{leaked[0].strip()[:40]}"'})
    return findings


def batch(docs_dir, files_dir, out_path, engine='pdf2word'):
    """Every <doc>.pdf with a <doc>.pdf.<engine>.docx in files_dir: one JSON
    line per document with its findings (empty list = clean)."""
    import os
    with open(out_path, 'w') as out:
        for name in sorted(os.listdir(docs_dir)):
            docx = os.path.join(files_dir, f'{name}.{engine}.docx')
            if not name.endswith('.pdf') or not os.path.exists(docx): continue
            try:
                f = compare(pdf_props(os.path.join(docs_dir, name)), docx_props(docx))
            except Exception as e:
                f = [{'signal': 'detector.error', 'severity': 'info', 'detail': str(e)[:120]}]
            out.write(json.dumps({'doc': name, 'engine': engine, 'findings': f}, ensure_ascii=False) + '\n')


if __name__ == '__main__' and sys.argv[1] == '--batch':
    batch(*sys.argv[2:6])
elif __name__ == '__main__':
    pdf = pdf_props(sys.argv[1])
    print(f"PDF: {pdf['pages']} pages, {len(pdf['spans'])} body spans, {len(pdf['tables'])} ruled tables")
    for path in sys.argv[2:]:
        f = compare(pdf, docx_props(path))
        by = collections.Counter(x['signal'] for x in f)
        print(f'\n== {path}: {len(f)} findings {dict(by)}')
        for x in f[:12]: print(f"  [{x['severity']}] {x['signal']}: {x['detail']}")
