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
                                 TableStyle, Image as RLImage)
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


if __name__ == '__main__':
    gen_table_heavy()
    gen_image_heavy()
    gen_formula_heavy()
    gen_simple_clean()
    gen_mixed()
    gen_scanned()
    print(f'Benchmark corpus written to {OUT}')
