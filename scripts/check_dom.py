#!/usr/bin/env python3
"""
check_dom.py — Pre-deploy DOM compatibility validator.

Scans every HTML page that loads app.js and verifies required element IDs
are present. Run before every deploy: python3 scripts/check_dom.py

Exit code 0 = all good. Exit code 1 = missing IDs found.
"""

import sys
import re
from pathlib import Path

ROOT = Path(__file__).parent.parent

# IDs every page that loads app.js must have.
# Home-page sections (hero, trustAlert, etc.) are NOT required — tool pages
# legitimately omit them, and show()/hide() are now null-safe.
REQUIRED_IDS = [
    'logo',
    'toolArea',
    'dropZone',
    'fileInput',
    'chooseFilesBtn',
    'mergeBtn',
    'cancelBtn',
    'fileList',
    'fileCount',
    'progressBar',
    'progressFill',
    'progressLabel',
    'successCard',
    'downloadBtn',
    'toast',
]

def check_file(html_path: Path) -> list[str]:
    text = html_path.read_text(encoding='utf-8', errors='replace')
    # Only check pages that actually load app.js
    if 'app.js' not in text:
        return []
    missing = [rid for rid in REQUIRED_IDS if f'id="{rid}"' not in text]
    return missing

def main():
    errors = []
    html_files = sorted(ROOT.rglob('*.html'))
    checked = 0

    for path in html_files:
        # Skip node_modules, .git, scripts
        parts = path.parts
        if any(p.startswith('.') or p in ('node_modules',) for p in parts):
            continue
        missing = check_file(path)
        if missing:
            rel = path.relative_to(ROOT)
            errors.append((str(rel), missing))
        checked += 1

    if errors:
        print(f'\n[check_dom] FAIL — {len(errors)} page(s) missing required IDs:\n')
        for rel, missing in errors:
            print(f'  {rel}')
            for rid in missing:
                print(f'    ✗  id="{rid}"')
        print(f'\nFix these pages before deploying. ({checked} pages scanned)')
        sys.exit(1)
    else:
        print(f'[check_dom] OK — all {checked} pages pass required-ID check.')
        sys.exit(0)

if __name__ == '__main__':
    main()
