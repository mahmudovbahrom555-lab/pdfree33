#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
#
# Generates a small, honestly-synthetic benchmark corpus for pdf2md,
# covering document categories the real arXiv fixtures
# (tests/fixtures/columns/) don't: table-heavy, image-heavy, formula-heavy,
# scanned (image-only, no text layer), a clean single-column baseline, and
# a "mixed" kitchen-sink doc.
#
# These are NOT real-world documents — no financial report/textbook could
# be legally sourced quickly for this. They're labeled 'synthetic' (not
# 'real') throughout scripts/pdf2md_benchmark.mjs's report and never
# presented as if they were genuine. Real-world diversity comes from the 5
# genuine arXiv papers already in the repo; these fill category gaps and
# — because this project built them — give an exact, known ground truth to
# check pdf2md's structural detection against (see pdf2md_benchmark.mjs's
# CORPUS `expect` fields).
#
# Requires: reportlab, matplotlib, pymupdf (all real deps, not vendored —
# run `pip3 install reportlab matplotlib pymupdf` if missing).
#
# Usage: python3 scripts/gen_benchmark_corpus.py [output_dir]
#        (defaults to benchmark_corpus/ at repo root, gitignored — this
#        corpus is regenerated on demand, not committed as binary blobs)

import os
import sys

from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                 TableStyle, Image as RLImage, Frame, PageTemplate)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import fitz  # pymupdf — used only for the scanned.pdf rasterization step

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'benchmark_corpus')
os.makedirs(OUT, exist_ok=True)

styles = getSampleStyleSheet()
h1 = ParagraphStyle('H1x', parent=styles['Heading1'], fontSize=20)
h2 = ParagraphStyle('H2x', parent=styles['Heading2'], fontSize=15)
body = styles['BodyText']

LOREM = ("This section discusses the underlying methodology in detail, "
         "covering the assumptions made during data collection and the "
         "statistical techniques applied to the resulting dataset. ")


def make_chart_png(path, kind):
    fig, ax = plt.subplots(figsize=(4, 3))
    if kind == 'bar':
        ax.bar(['A', 'B', 'C', 'D'], [23, 45, 12, 38])
        ax.set_title('Quarterly results by segment')
    elif kind == 'line':
        ax.plot([1, 2, 3, 4, 5], [2, 5, 3, 8, 6])
        ax.set_title('Trend over time')
    fig.savefig(path, dpi=100)
    plt.close(fig)


# ── 1. table-heavy.pdf — ground truth: headings=4 (title + 3 sections), tables=2 ──
def gen_table_heavy():
    doc = SimpleDocTemplate(os.path.join(OUT, 'table-heavy.pdf'), pagesize=LETTER)
    story = [Paragraph('Quarterly Financial Summary', h1), Spacer(1, 12)]
    story.append(Paragraph('Revenue by Region', h2))
    data = [['Region', 'Q1', 'Q2', 'Q3', 'Q4']]
    for region in ['North America', 'Europe', 'Asia Pacific', 'Latin America', 'MEA']:
        data.append([region, f'${1200+len(region)*3}k', f'${1350+len(region)*2}k',
                     f'${1180+len(region)*4}k', f'${1420+len(region)*3}k'])
    t = Table(data, hAlign='LEFT')
    t.setStyle(TableStyle([('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
                            ('BACKGROUND', (0, 0), (-1, 0), colors.lightgrey)]))
    story.append(t)
    story.append(Spacer(1, 20))
    story.append(Paragraph('Headcount by Department', h2))
    data2 = [['Department', 'Headcount', 'Open Roles', 'Attrition %']]
    for dept, hc, open_r, attr in [('Engineering', 142, 12, '4.2'), ('Sales', 88, 5, '6.1'),
                                     ('Marketing', 34, 2, '3.5'), ('Support', 56, 4, '5.8'),
                                     ('Finance', 21, 1, '2.1'), ('HR', 15, 0, '1.9')]:
        data2.append([dept, str(hc), str(open_r), attr])
    t2 = Table(data2, hAlign='LEFT')
    t2.setStyle(TableStyle([('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
                             ('BACKGROUND', (0, 0), (-1, 0), colors.lightgrey)]))
    story.append(t2)
    story.append(Spacer(1, 20))
    story.append(Paragraph('Summary', h2))
    story.append(Paragraph(LOREM * 3, body))
    doc.build(story)


# ── 2. image-heavy.pdf — ground truth: headings=3, images=2 ──────────────
def gen_image_heavy():
    bar_png = os.path.join(OUT, '_chart_bar.png')
    line_png = os.path.join(OUT, '_chart_line.png')
    make_chart_png(bar_png, 'bar')
    make_chart_png(line_png, 'line')
    doc = SimpleDocTemplate(os.path.join(OUT, 'image-heavy.pdf'), pagesize=LETTER)
    story = [Paragraph('Visual Report', h1), Spacer(1, 12)]
    story.append(Paragraph('Figure 1: Segment performance', h2))
    story.append(RLImage(bar_png, width=4*inch, height=3*inch))
    story.append(Spacer(1, 16))
    story.append(Paragraph(LOREM, body))
    story.append(Spacer(1, 16))
    story.append(Paragraph('Figure 2: Trend analysis', h2))
    story.append(RLImage(line_png, width=4*inch, height=3*inch))
    story.append(Spacer(1, 16))
    story.append(Paragraph(LOREM * 2, body))
    doc.build(story)
    os.remove(line_png)  # bar_png kept — reused by gen_mixed() below


# ── 3. formula-heavy.pdf — ground truth: headings=0 (known artifact — see
# scripts/pdf2md_benchmark.mjs's own comment on this corpus entry for why),
# images=3 (OCR toggle off in the harness -> image-crop fallback) ─────────
def gen_formula_heavy():
    matplotlib.rcParams['mathtext.fontset'] = 'cm'
    fig = plt.figure(figsize=(8.27, 11.69))
    fig.text(0.5, 0.94, 'Mathematical Foundations', ha='center', fontsize=18)
    fig.text(0.1, 0.86, 'The core relation used throughout this paper is given below.', fontsize=11)
    fig.text(0.5, 0.76, r'$\alpha \times \beta \geq \gamma \pm \infty$', ha='center', fontsize=22)
    fig.text(0.1, 0.66, 'A second identity follows directly from the first.', fontsize=11)
    fig.text(0.5, 0.56, r'$\mu \cdot \nu \neq \sigma \cup \tau$', ha='center', fontsize=22)
    fig.text(0.1, 0.46, 'Finally, we state the closing inequality used in Section 4.', fontsize=11)
    fig.text(0.5, 0.36, r'$\delta \approx \epsilon \leq \zeta \cap \eta$', ha='center', fontsize=22)
    fig.text(0.1, 0.24, 'These three relations together justify the main theorem.', fontsize=11)
    fig.savefig(os.path.join(OUT, 'formula-heavy.pdf'))
    plt.close(fig)


# ── 4. simple-clean.pdf — ground truth: headings=4 (title + 3 sections) ──
def gen_simple_clean():
    doc = SimpleDocTemplate(os.path.join(OUT, 'simple-clean.pdf'), pagesize=LETTER)
    story = [Paragraph('A Clean, Well-Formed Document', h1), Spacer(1, 12)]
    for i in range(1, 4):
        story.append(Paragraph(f'{i}. Section Heading {i}', h2))
        story.append(Paragraph(LOREM * 2, body))
        story.append(Spacer(1, 10))
    doc.build(story)


# ── 5. mixed.pdf (kitchen sink) — ground truth: headings=5, tables=1, images=1 ──
def gen_mixed():
    bar_png = os.path.join(OUT, '_chart_bar.png')
    doc = SimpleDocTemplate(os.path.join(OUT, 'mixed.pdf'), pagesize=LETTER)
    story = [Paragraph('Mixed-Content Report', h1), Spacer(1, 12)]
    story.append(Paragraph('1. Introduction', h2))
    story.append(Paragraph(LOREM * 2, body))
    story.append(Spacer(1, 10))
    story.append(Paragraph('2. Results Table', h2))
    data = [['Metric', 'Value'], ['Accuracy', '94.2%'], ['Precision', '91.8%'], ['Recall', '89.5%']]
    t = Table(data, hAlign='LEFT')
    t.setStyle(TableStyle([('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
                            ('BACKGROUND', (0, 0), (-1, 0), colors.lightgrey)]))
    story.append(t)
    story.append(Spacer(1, 10))
    story.append(Paragraph('3. Supporting Figure', h2))
    story.append(RLImage(bar_png, width=3.5*inch, height=2.6*inch))
    story.append(Spacer(1, 10))
    story.append(Paragraph('4. Conclusion', h2))
    story.append(Paragraph(LOREM, body))
    doc.build(story)
    os.remove(bar_png)


# ── 6. scanned.pdf — real rasterization of a real fixture's page 1, no ───
# text layer at all (genuinely, not simulated) — ground truth: see
# pdf2md_benchmark.mjs's own comment on this corpus entry.
def gen_scanned():
    src_path = os.path.join(ROOT, 'tests', 'fixtures', 'columns', '2608.11433.pdf')
    src = fitz.open(src_path)
    pix = src[0].get_pixmap(dpi=150)
    out = fitz.open()
    out_page = out.new_page(width=pix.width, height=pix.height)
    out_page.insert_image(out_page.rect, pixmap=pix)
    out.save(os.path.join(OUT, 'scanned.pdf'))


# ── 7. magazine-multicolumn.pdf — dense 3-column newsletter layout ───────
# ground truth: headings=4 (masthead title + 3 article headlines). Body
# copy is 10pt; masthead is 26pt (2.6x median, safely clears the 2.2x
# level-1 threshold with margin — no boundary-edge guessing); article
# headlines are bold at the SAME 10pt size as body copy, exercising the
# same-size-but-bold fallback (_isBoldHeadingLine), not the font-ratio path.
# Real column count (3) is within js/pdf2wordColumns.js's own MAX_COLUMNS=3
# ceiling. Heading detection doesn't depend on column-split success (it's
# applied identically whether _emitLines() runs on a whole page or one
# already-split column region), so this ground truth holds regardless of
# whether the masthead-above-columns layout trips the same known,
# already-disclosed column-detection edge case documented in the
# competitive-benchmark memory for 002-two-column-paper.
def gen_magazine_multicolumn():
    body = ParagraphStyle('MagBody', parent=styles['BodyText'], fontSize=10, leading=13)
    headline = ParagraphStyle('MagHeadline', parent=styles['BodyText'], fontSize=10, leading=13,
                               fontName='Helvetica-Bold', spaceAfter=4)
    masthead = ParagraphStyle('Masthead', parent=styles['Heading1'], fontSize=26, alignment=1)

    doc = SimpleDocTemplate(os.path.join(OUT, 'magazine-multicolumn.pdf'), pagesize=LETTER,
                             topMargin=0.6*inch, bottomMargin=0.6*inch,
                             leftMargin=0.5*inch, rightMargin=0.5*inch)
    frame_w = (LETTER[0] - inch) / 3 - 8
    frames = [
        Frame(0.5*inch + i * (frame_w + 12), 0.6*inch, frame_w, LETTER[1] - 2.2*inch, id=f'col{i}')
        for i in range(3)
    ]
    articles = [
        ('Local Council Approves New Park Funding',
         'The city council voted unanimously Tuesday night to approve a $2 million budget for the '
         'renovation of Riverside Park, citing years of resident requests for updated playground '
         'equipment and better walking trails along the eastern bank.'),
        ('School District Announces Summer Programs',
         'Registration opens next week for the district\'s expanded summer enrichment program, which '
         'will offer free morning sessions in science, art, and reading for students entering grades '
         'two through six at all six elementary campuses.'),
        ('Weather Outlook: Warm Week Ahead',
         'Forecasters expect a stretch of clear, unseasonably warm days through the weekend, with '
         'highs climbing into the low eighties by Thursday before a cold front brings scattered '
         'showers back into the region early next week.'),
    ]
    story = []
    for headline_text, body_text in articles:
        story.append(Paragraph(headline_text, headline))
        story.append(Paragraph(body_text, body))
        story.append(Spacer(1, 10))

    def _masthead(canvas, doc_):
        canvas.saveState()
        canvas.setFont('Helvetica-Bold', 26)
        canvas.drawCentredString(LETTER[0] / 2, LETTER[1] - 0.9*inch, 'Community Herald')
        canvas.restoreState()

    doc.addPageTemplates([PageTemplate(id='cols', frames=frames, onPage=_masthead)])
    doc.build(story)


# ── 8. financial-nested-subtotals.pdf — income statement with nested ─────
# subtotal/total rows INSIDE one contiguous table (not a second table) —
# ground truth: headings=1 (title only — every row lives inside the same
# GRID table, so subtotal/total rows never reach heading classification at
# all, matching pdf2mdCore.js's own "table lines never fall through to
# heading/list/paragraph classification" comment), tables=1, images=0.
def gen_financial_nested_subtotals():
    doc = SimpleDocTemplate(os.path.join(OUT, 'financial-nested-subtotals.pdf'), pagesize=LETTER)
    story = [Paragraph('Consolidated Income Statement', h1), Spacer(1, 14)]
    rows = [
        ['Line Item', 'Amount (USD)'],
        ['Revenue — Product Sales', '1,204,500.00'],
        ['Revenue — Service Contracts', '398,220.00'],
        ['Subtotal Revenue', '1,602,720.00'],
        ['Operating Expenses — Salaries', '612,400.00'],
        ['Operating Expenses — Rent', '84,000.00'],
        ['Operating Expenses — Marketing', '96,750.00'],
        ['Subtotal Operating Expenses', '793,150.00'],
        ['Operating Income', '809,570.00'],
        ['Other Income — Interest', '12,300.00'],
        ['Other Expense — Tax Provision', '188,900.00'],
        ['Net Income', '632,970.00'],
    ]
    bold_rows = {3, 7, 8, 11}  # subtotal/total rows, 0-indexed incl. header
    t = Table(rows, hAlign='LEFT', colWidths=[3.4*inch, 1.6*inch])
    style_cmds = [('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
                  ('BACKGROUND', (0, 0), (-1, 0), colors.lightgrey),
                  ('ALIGN', (1, 0), (1, -1), 'RIGHT')]
    for r in bold_rows:
        style_cmds.append(('FONTNAME', (0, r), (-1, r), 'Helvetica-Bold'))
    t.setStyle(TableStyle(style_cmds))
    story.append(t)
    doc.build(story)


# ── 9. contract-nested-clauses.pdf — deeply nested numbered clauses ──────
# ground truth: headings=5 (title + 4 ALL-CAPS "ARTICLE N." headers).
# "ARTICLE N." headers start with a letter, not a digit, so NUMBERED_RE
# ([textLayoutUtils.js]) never matches them — they reach heading
# classification untouched by the numbered-list branch. Sub-clause labels
# ("1.1", "1.1.1") are followed immediately by a second digit
# (NUMBERED_RE's `(?!\d)` lookahead fails on "1.1") so they ALSO skip the
# numbered-list branch, but they're plain-weight body-size text here, so
# they fall through as ordinary paragraph text, not headings or list items
# — a realistic default for this shape (no clause-hierarchy feature exists
# in pdf2md), tested here for "no garbling/dropping", not for a specific
# structural count beyond the 5 real headings.
def gen_contract_nested_clauses():
    title = ParagraphStyle('ContractTitle', parent=styles['Heading1'], fontSize=20, alignment=1)
    article = ParagraphStyle('Article', parent=styles['BodyText'], fontSize=10,
                              fontName='Helvetica-Bold', spaceBefore=10, spaceAfter=4)
    clause_body = styles['BodyText']

    doc = SimpleDocTemplate(os.path.join(OUT, 'contract-nested-clauses.pdf'), pagesize=LETTER)
    story = [Paragraph('SERVICE AGREEMENT', title), Spacer(1, 16)]
    articles = [
        ('ARTICLE 1. DEFINITIONS',
         [('1.1 Definitions.', 'For purposes of this Agreement, "Services" means the consulting '
           'work described in Exhibit A, and "Effective Date" means the date first written above.'),
          ('1.1.1 Interpretation.', 'Headings in this Agreement are for convenience only and do not '
           'affect its interpretation.')]),
        ('ARTICLE 2. PAYMENT TERMS',
         [('2.1 Fees.', 'Client shall pay Consultant the fees set forth in Exhibit B within thirty '
           '(30) days of receipt of a valid invoice.'),
          ('2.1.1 Late Payment.', 'Amounts unpaid after the due date accrue interest at one and a '
           'half percent (1.5%) per month.')]),
        ('ARTICLE 3. TERMINATION',
         [('3.1 Termination for Convenience.', 'Either party may terminate this Agreement upon '
           'thirty (30) days written notice to the other party.'),
          ('3.1.1 Effect of Termination.', 'Upon termination, Client shall pay for all Services '
           'performed through the effective date of termination.')]),
        ('ARTICLE 4. GOVERNING LAW',
         [('4.1 Governing Law.', 'This Agreement is governed by the laws of the State of Delaware, '
           'without regard to its conflict-of-laws principles.')]),
    ]
    for art_title, clauses in articles:
        story.append(Paragraph(art_title, article))
        for clause_label, clause_text in clauses:
            story.append(Paragraph(f'{clause_label} {clause_text}', clause_body))
            story.append(Spacer(1, 6))
    doc.build(story)


# ── 10. captioned-images.pdf — real embedded images with real captions ───
# ground truth: headings=1 (title only), tables=0, images=2. Deliberately
# stresses the footnote/marginal-text separation heuristic
# (pdf2mdCore.js's FOOTNOTE_Y_BAND_FRACTION/FOOTNOTE_FONT_RATIO): Figure 2's
# caption is both small (8pt vs the document's real 10pt item-level median
# — verified directly via pymupdf against the generated PDF, not assumed;
# an earlier draft used 9pt, which measured at a 0.9 ratio, ABOVE the 0.85
# gate and would never have exercised the intended path) AND deliberately
# pushed into the bottom 15% of the page via a Spacer, i.e. it satisfies
# BOTH conditions a real footnote would — this is the realistic "does a
# caption get mistaken for a footnote" case, not a contrived one. Ground
# truth intentionally does NOT assert what happens to that caption's
# paragraph classification (that's exactly the open question this fixture
# exists to surface) — only the count of real IMAGE blocks and the heading
# count, both of which are unaffected either way.
def gen_captioned_images():
    caption = ParagraphStyle('Caption', parent=styles['BodyText'], fontSize=8, leading=10,
                              fontName='Helvetica-Oblique', textColor=colors.grey)
    bar_png = os.path.join(OUT, '_cap_bar.png')
    line_png = os.path.join(OUT, '_cap_line.png')
    make_chart_png(bar_png, 'bar')
    make_chart_png(line_png, 'line')

    doc = SimpleDocTemplate(os.path.join(OUT, 'captioned-images.pdf'), pagesize=LETTER)
    story = [Paragraph('Field Report With Photographs', h1), Spacer(1, 14)]
    story.append(RLImage(bar_png, width=4*inch, height=3*inch))
    story.append(Paragraph('Figure 1: Segment performance recorded during the March site visit, '
                            'shown by business unit.', caption))
    story.append(Spacer(1, 18))
    story.append(Paragraph(LOREM, body))
    # Push Figure 2 + its caption down near the bottom of the page on purpose.
    story.append(Spacer(1, 300))
    story.append(RLImage(line_png, width=4*inch, height=2.2*inch))
    story.append(Paragraph('Figure 2: Trend observed across the same period, plotted weekly.', caption))
    doc.build(story)
    os.remove(bar_png)
    os.remove(line_png)


# ── 11. cjk-heavy.pdf — Chinese-heavy document, REAL embedded system font ─
# (Identity-H encoding via pymupdf), not reportlab's non-embedded standard
# CID font (STSong-Light/UniGB-UCS2-H). The reportlab CID-font path was
# tried FIRST and produced a genuine, 100%-reproducible total
# text-extraction failure in the real browser tool (0 blocks, the "no
# extractable text" fallback fired) — but a follow-up scratchpad test
# proved this is a pdf.js CMap-resource gap specific to NON-embedded,
# predefined-CID-encoded fonts (js/pdf2mdUI.js's getDocument() call passes
# no cMapUrl/cMapPacked, and js/vendor/ bundles no CMap resource files),
# NOT a general CJK problem: the exact same text through a real embedded
# font (macOS's Heiti TC, Identity-H, the encoding real-world Word/LaTeX/
# Google Docs/OCR-layer PDFs actually use) extracted perfectly. That
# non-embedded-CID-font gap is disclosed separately as a real, but
# deliberately not-fixed-this-session, finding — see the final report —
# because a fix would mean adding new resource files under the off-limits
# js/vendor/ directory and touching ~18 other getDocument() call sites
# sitewide, out of proportionate scope for a single conservative fix. This
# fixture instead stays representative of what real users actually upload.
# ground truth: headings=4 (title 20pt + 3 section headers 14pt over a
# 10pt body — 2.0x/1.4x ratios, both already verified safe with margin
# elsewhere in this corpus).
def gen_cjk_heavy():
    import fitz
    FONT = '/System/Library/Fonts/STHeiti Medium.ttc'
    sections = [
        ('第一节：研究背景',
         '近年来，人工智能技术在自然语言处理领域取得了显著进展。大规模预训练语言模型的出现，'
         '使得机器在文本理解、生成和翻译等任务上的表现大幅提升，也带来了新的研究挑战和应用场景。'),
        ('第二节：研究方法',
         '本研究采用对照实验的方法，在多个公开数据集上评估模型性能，并结合人工评审对生成结果的'
         '流畅性、准确性和一致性进行综合分析，力求得出可复现的结论。'),
        ('第三节：结果与讨论',
         '实验结果表明，模型在长文本理解任务上仍存在明显局限，尤其是在跨段落指代消解和逻辑推理'
         '方面。未来工作将聚焦于改进上下文建模能力，并探索更高效的训练策略。'),
    ]
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    y = 60.0
    page.insert_textbox(fitz.Rect(50, y, 562, y + 34), '人工智能与自然语言处理研究',
                         fontsize=20, fontfile=FONT, fontname='F1', align=1)
    y += 60
    for sec_title, sec_body in sections:
        page.insert_textbox(fitz.Rect(50, y, 562, y + 24), sec_title, fontsize=14, fontfile=FONT, fontname='F1')
        y += 28
        deficit = page.insert_textbox(fitz.Rect(50, y, 562, y + 80), sec_body,
                                       fontsize=10, fontfile=FONT, fontname='F1')
        assert deficit >= 0, 'CJK body text overflowed its box — widen the rect'
        y += 90
    doc.save(os.path.join(OUT, 'cjk-heavy.pdf'))


# ── 12. footnotes-and-endnotes.pdf — real per-page footnotes (small font, ─
# genuine bottom-margin Y position, drawn via canvas so the Y coordinate is
# exact and verifiable) PLUS a same-document "Endnotes" section at body
# font size — ground truth: headings=2 (title + "Endnotes" section
# header). Deliberately checks that real per-page footnotes (9pt, ratio
# 0.82 < the 0.85 gate, genuinely inside the bottom-15%-of-page Y band) get
# separated/italicized while same-size-as-body (11pt) endnotes at the
# document's end do NOT get swept into the same treatment even though
# they may also land low on the last page — font-size ratio alone must
# gate this correctly regardless of Y position, per pdf2mdCore.js's own
# two-condition (Y-band AND font-ratio) check.
def gen_footnotes_and_endnotes():
    fn_body = ParagraphStyle('FnBody', parent=styles['BodyText'], fontSize=11, leading=15)
    endnote_style = fn_body  # same size as body prose — must NOT trigger the footnote-font-ratio gate

    footnotes_by_page = {
        1: '1. Silk Road trade volume estimates draw on customs ledgers held in the regional archive.',
        2: '2. See the appendix for the full methodology used to reconstruct seasonal caravan routes.',
    }

    def _footnote(canvas, doc_):
        page_num = canvas.getPageNumber()
        text = footnotes_by_page.get(page_num)
        if not text:
            return
        canvas.saveState()
        canvas.setFont('Helvetica', 9)
        canvas.line(0.75*inch, 1.05*inch, 3*inch, 1.05*inch)
        canvas.drawString(0.75*inch, 0.85*inch, text)
        canvas.restoreState()

    doc = SimpleDocTemplate(os.path.join(OUT, 'footnotes-and-endnotes.pdf'), pagesize=LETTER,
                             bottomMargin=1.3*inch)
    story = [Paragraph('Historical Analysis of Trade Routes', h1), Spacer(1, 14)]
    story.append(Paragraph(
        'Trade along the Silk Road¹ expanded significantly during the period under study, '
        'linking overland caravan routes to Mediterranean and East Asian ports alike. ' + LOREM * 2,
        fn_body))
    story.append(Spacer(1, 500))  # force onto page 2
    story.append(Paragraph(
        'Seasonal patterns in caravan departures² correlate closely with the harvest calendars '
        'documented in regional tax records. ' + LOREM * 2,
        fn_body))
    story.append(Spacer(1, 40))
    story.append(Paragraph('Endnotes', h2))
    story.append(Paragraph('1. Regional Trade Archive, Vol. 3, customs ledgers 1850-1870.', endnote_style))
    story.append(Paragraph('2. Regional Tax Records Office, harvest calendar cross-reference tables.', endnote_style))
    doc.build(story, onFirstPage=_footnote, onLaterPages=_footnote)


if __name__ == '__main__':
    gen_table_heavy()
    gen_image_heavy()
    gen_formula_heavy()
    gen_simple_clean()
    gen_mixed()
    gen_scanned()
    gen_magazine_multicolumn()
    gen_financial_nested_subtotals()
    gen_contract_nested_clauses()
    gen_captioned_images()
    gen_cjk_heavy()
    gen_footnotes_and_endnotes()
    print(f'Benchmark corpus written to {OUT}')
