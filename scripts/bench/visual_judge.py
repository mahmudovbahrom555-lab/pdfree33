#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""visual_judge.py — how close a converter's Word files look to their PDFs.

Each .docx is printed to PDF with LibreOffice and set beside its source: the
page counts, and the mean grey difference (0-255) of the first pages, both
rendered at the same small size. A working bench for comparing two builds of
PDF→Word on the same documents — not a gate, not a measuring stick
(scripts/quality/ holds those). Lower diff = closer; a ratio far above 1 = a
file that grew pages.

  python3 scripts/bench/visual_judge.py <pdf_dir> <docx_dir> [doc ...] > out.jsonl

<docx_dir> holds <doc>.docx or <doc>.pdf.pdf2word.docx (robust.mjs --save);
with no docs named, every .docx there. One JSON line per document:
{"doc", "src_pages", "docx_pages", "ratio", "diff"} — diff null when
LibreOffice could not print it.
"""
import json, os, shutil, subprocess, sys, tempfile

import fitz  # PyMuPDF

PAGES = 3      # first pages compared
DPI = 40       # small: layout, not glyphs
LO_TIMEOUT = 180


def _stem(name):
    for suffix in ('.pdf.pdf2word.docx', '.pdf2word.docx', '.docx'):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return None


def _grey(page, size=None):
    """The page in grey, at DPI — or stretched to exactly `size` (w, h) px."""
    if size is None:
        return page.get_pixmap(dpi=DPI, colorspace=fitz.csGRAY, alpha=False)
    m = fitz.Matrix(size[0] / page.rect.width, size[1] / page.rect.height)
    return page.get_pixmap(matrix=m, colorspace=fitz.csGRAY, alpha=False)


def _mean_abs(a, b):
    """Mean |a - b| over the pixels both cover, row by row (a ±1 px size off
    by rounding must not shift every later row)."""
    w, h = min(a.width, b.width), min(a.height, b.height)
    sa, sb, total = a.samples, b.samples, 0
    for y in range(h):
        ra, rb = y * a.stride, y * b.stride
        total += sum(abs(sa[ra + x] - sb[rb + x]) for x in range(w))
    return total / (w * h)


def _diff(src, out):
    diffs = []
    for i in range(min(PAGES, len(src))):
        a = _grey(src[i])
        if i >= len(out):
            diffs.append(255 - sum(a.samples) / len(a.samples))   # a missing page: all of the source's ink
            continue
        diffs.append(_mean_abs(a, _grey(out[i], (a.width, a.height))))
    return round(sum(diffs) / len(diffs), 2) if diffs else None


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    pdf_dir, docx_dir, wanted = sys.argv[1], sys.argv[2], set(sys.argv[3:])
    files = {}
    for name in sorted(os.listdir(docx_dir)):
        stem = _stem(name)
        if stem and (not wanted or stem in wanted):
            files[stem] = os.path.join(docx_dir, name)
    soffice = shutil.which('soffice') or shutil.which('libreoffice')
    if not soffice:
        sys.exit('LibreOffice (soffice) not found')
    with tempfile.TemporaryDirectory() as tmp:
        profile = f'file://{tmp}/lo-profile'   # its own profile: runs beside an open LibreOffice
        for stem, docx in files.items():
            src_path = os.path.join(pdf_dir, stem + '.pdf')
            if not os.path.exists(src_path):
                continue
            src = fitz.open(src_path)
            row = {'doc': stem, 'src_pages': len(src), 'docx_pages': None, 'ratio': None, 'diff': None}
            out_dir = os.path.join(tmp, stem)
            os.makedirs(out_dir, exist_ok=True)
            local = os.path.join(out_dir, stem + '.docx')
            shutil.copy(docx, local)
            try:
                subprocess.run([soffice, f'-env:UserInstallation={profile}', '--headless', '--convert-to', 'pdf',
                                '--outdir', out_dir, local], capture_output=True, timeout=LO_TIMEOUT, check=False)
                printed = os.path.join(out_dir, stem + '.pdf')
                if os.path.exists(printed):
                    out = fitz.open(printed)
                    row.update(docx_pages=len(out), ratio=round(len(out) / max(1, len(src)), 2), diff=_diff(src, out))
            except subprocess.TimeoutExpired:
                pass
            print(json.dumps(row), flush=True)


if __name__ == '__main__':
    main()
