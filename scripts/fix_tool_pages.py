#!/usr/bin/env python3
"""
fix_tool_pages.py — Fix all 60 tool pages (EN + DE/ES/FR/PT):
  1. Remove display:none from toolArea  → tool visible before JS loads
  2. Add PDFREE_INITIAL_TOOL            → reliable tool detection (no URL parsing)
"""

from pathlib import Path
import re

ROOT = Path(__file__).parent.parent

# Complete slug → tool mapping for all languages
SLUG_TO_TOOL = {
    # English
    'rotate-pdf':    'rotate',
    'merge-pdf':     'merge',
    'compress-pdf':  'compress',
    'split-pdf':     'split',
    'jpg2pdf':       'jpg2pdf',
    'pdf2jpg':       'pdf2jpg',
    'watermark-pdf': 'watermark',
    'pagenum-pdf':   'pagenum',
    'metadata-pdf':  'meta',
    'extract-pdf':   'extract',
    'protect-pdf':   'protect',
    'redact-pdf':    'redact',

    # German (de/)
    'pdf-drehen':          'rotate',
    'pdf-zusammenfuehren': 'merge',
    'pdf-komprimieren':    'compress',
    'pdf-aufteilen':       'split',
    'jpg-zu-pdf':          'jpg2pdf',
    'pdf-zu-jpg':          'pdf2jpg',
    'wasserzeichen-pdf':   'watermark',
    'seitenzahlen-pdf':    'pagenum',
    'pdf-metadaten':       'meta',
    'seiten-extrahieren':  'extract',
    'pdf-schuetzen':       'protect',
    'pdf-schwaerzen':      'redact',

    # Spanish (es/)
    'rotar-pdf':            'rotate',
    'unir-pdf':             'merge',
    'comprimir-pdf':        'compress',
    'dividir-pdf':          'split',
    'jpg-a-pdf':            'jpg2pdf',
    'pdf-a-jpg':            'pdf2jpg',
    'marca-de-agua-pdf':    'watermark',
    'numeros-de-pagina-pdf':'pagenum',
    'metadatos-pdf':        'meta',
    'extraer-pdf':          'extract',
    'proteger-pdf':         'protect',
    'censurar-pdf':         'redact',

    # French (fr/)
    'rotation-pdf':    'rotate',
    'fusionner-pdf':   'merge',
    'compresser-pdf':  'compress',
    'diviser-pdf':     'split',
    'jpg-en-pdf':      'jpg2pdf',
    'pdf-en-jpg':      'pdf2jpg',
    'filigrane-pdf':   'watermark',
    'numerotation-pdf':'pagenum',
    'metadonnees-pdf': 'meta',
    'extraire-pdf':    'extract',
    'proteger-pdf':    'protect',  # same slug as ES — handled by path
    'censurer-pdf':    'redact',

    # Portuguese (pt/)
    'girar-pdf':            'rotate',
    'juntar-pdf':           'merge',
    'dividir-pdf':          'split',   # same as ES
    'jpg-para-pdf':         'jpg2pdf',
    'pdf-para-jpg':         'pdf2jpg',
    'marca-dagua-pdf':      'watermark',
    'numeros-de-pagina-pdf':'pagenum',
    'metadados-pdf':        'meta',
    'extrair-pdf':          'extract',
    'censurar-pdf':         'redact',  # same as ES
}

# PT compress has same slug as ES — handle separately
PT_EXTRA = {
    'comprimir-pdf': 'compress',  # pt/ only (ES has same but both → compress)
}

def fix_page(path: Path, tool: str) -> bool:
    text = path.read_text(encoding='utf-8')
    original = text
    changed = False

    # 1. Remove display:none from toolArea
    new_text = text.replace(
        '<main id="toolArea" class="main-area" style="display:none"',
        '<main id="toolArea" class="main-area"'
    )
    if new_text != text:
        text = new_text
        changed = True

    # 2. Add PDFREE_INITIAL_TOOL before app.js script tag (if not already there)
    if 'PDFREE_INITIAL_TOOL' not in text:
        script_tag = re.search(r'<script[^>]+app\.js[^>]*>', text)
        if script_tag:
            insert = f'<script>window.PDFREE_INITIAL_TOOL = \'{tool}\';</script>\n  '
            text = text[:script_tag.start()] + insert + text[script_tag.start():]
            changed = True

    if changed:
        path.write_text(text, encoding='utf-8')
    return changed

def main():
    fixed = 0
    skipped = 0

    # English tool pages (direct subdirs of root)
    for slug, tool in SLUG_TO_TOOL.items():
        page = ROOT / slug / 'index.html'
        if not page.exists():
            continue
        # Only process English root-level pages here
        if len(page.parts) == len(ROOT.parts) + 2:
            if fix_page(page, tool):
                print(f'  fixed  {page.relative_to(ROOT)}  → {tool}')
                fixed += 1
            else:
                skipped += 1

    # Language pages (de/ es/ fr/ pt/)
    for lang in ['de', 'es', 'fr', 'pt']:
        lang_dir = ROOT / lang
        if not lang_dir.exists():
            continue
        for page in sorted(lang_dir.glob('*/index.html')):
            slug = page.parent.name
            tool = SLUG_TO_TOOL.get(slug) or PT_EXTRA.get(slug)
            if not tool:
                print(f'  SKIP   {page.relative_to(ROOT)}  (no mapping)')
                continue
            if fix_page(page, tool):
                print(f'  fixed  {page.relative_to(ROOT)}  → {tool}')
                fixed += 1
            else:
                skipped += 1

    print(f'\nDone: {fixed} fixed, {skipped} already OK.')

if __name__ == '__main__':
    main()
