#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Injects locale <script> tag before app.js in all localized HTML pages.
# Run from project root: python3 scripts/inject_locales.py

import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent

LANGS = ['de', 'es', 'fr', 'pt']

# Matches: <script type="module" src="(../|../../)js/app.js..."></script>
APP_JS_RE = re.compile(
    r'(<script\s+type="module"\s+src=")(\.\.(?:/\.\.)?/js/app\.js[^"]*">)(</script>)',
    re.IGNORECASE,
)

def inject(html_path: Path, lang: str) -> bool:
    text = html_path.read_text(encoding='utf-8')

    m = APP_JS_RE.search(text)
    if not m:
        print(f'  SKIP (no app.js match): {html_path.relative_to(ROOT)}')
        return False

    prefix = m.group(2).split('js/app.js')[0]  # e.g. '../' or '../../'
    locale_tag = f'<script type="module" src="{prefix}js/locales/{lang}.js"></script>\n  '

    # Don't inject twice
    if f'locales/{lang}.js' in text:
        print(f'  SKIP (already injected): {html_path.relative_to(ROOT)}')
        return False

    new_text = text[:m.start()] + locale_tag + text[m.start():]
    html_path.write_text(new_text, encoding='utf-8')
    print(f'  OK: {html_path.relative_to(ROOT)}')
    return True

def main():
    total = updated = 0
    for lang in LANGS:
        lang_dir = ROOT / lang
        if not lang_dir.is_dir():
            print(f'WARNING: {lang_dir} not found — skipping')
            continue
        for html_file in sorted(lang_dir.rglob('index.html')):
            total += 1
            if inject(html_file, lang):
                updated += 1

    print(f'\nDone: {updated}/{total} files updated.')

if __name__ == '__main__':
    main()
