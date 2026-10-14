#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""The same documents through other PDF→Word engines, for the nightly
comparison: <doc>.pdf → <files>/<doc>.pdf.<engine>.docx. Open engines only
(pdf2docx); a hosted competitor needs its own API key and terms, added when
there is one. Each document gets a time limit — a stuck engine must not eat
the night.

pdf2docx breaks on PyMuPDF ≥ 1.25 (Rect.get_area removed) while our
detectors need 1.26 — so it runs from its own interpreter: PDF2DOCX_PYTHON,
a venv with "pymupdf<1.25" pdf2docx (see corpus-nightly.yml).

  PDF2DOCX_PYTHON=venv/bin/python python3 scripts/quality/other_engines.py <docs-dir> <files-dir>
"""
import os, subprocess, sys

TIMEOUT_S = 120
SCRIPT = 'import sys\nfrom pdf2docx import Converter\nc = Converter(sys.argv[1]); c.convert(sys.argv[2]); c.close()'


def main(docs, files):
    os.makedirs(files, exist_ok=True)
    ok = 0
    names = sorted(f for f in os.listdir(docs) if f.lower().endswith('.pdf'))
    for name in names:
        out = os.path.join(files, f'{name}.pdf2docx.docx')
        try:
            subprocess.run([os.environ.get('PDF2DOCX_PYTHON', sys.executable), '-c', SCRIPT, os.path.join(docs, name), out],
                           timeout=TIMEOUT_S, capture_output=True, check=True)
            ok += 1
        except Exception:
            if os.path.exists(out): os.remove(out)
    print(f'pdf2docx: {ok}/{len(names)}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
