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
# ↓ When adding a new element to index.html that app.js depends on, add it here too.
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

# Tool pages must declare PDFREE_INITIAL_TOOL.
# Excludes: root index.html, language homepages (de/index.html etc.),
# and placeholder pages for unimplemented tools.
LANG_CODES = {'de', 'es', 'fr', 'pt'}
PLACEHOLDER_DIRS = {'annotate-pdf', 'highlight-pdf', 'sign', 'fill', 'annotate'}

def _is_tool_page(path: Path) -> bool:
    rel   = path.relative_to(ROOT)
    parts = rel.parts
    if len(parts) < 2 or rel.name != 'index.html':
        return False
    parent = parts[0]
    # Language homepage: de/index.html — not a tool page
    if parent in LANG_CODES and len(parts) == 2:
        return False
    # Placeholder / unimplemented tool pages
    slug = parts[-2]
    if slug in PLACEHOLDER_DIRS:
        return False
    return True

def check_file(html_path: Path) -> tuple[list[str], list[str]]:
    text = html_path.read_text(encoding='utf-8', errors='replace')
    if 'app.js' not in text:
        return [], []
    missing_ids    = [rid for rid in REQUIRED_IDS if f'id="{rid}"' not in text]
    missing_tool   = []
    if _is_tool_page(html_path) and 'PDFREE_INITIAL_TOOL' not in text:
        missing_tool = ['PDFREE_INITIAL_TOOL not set']
    return missing_ids, missing_tool

def main():
    errors = []
    html_files = sorted(ROOT.rglob('*.html'))
    checked = 0

    for path in html_files:
        parts = path.parts
        if any(p.startswith('.') or p in ('node_modules', 'dist', 'data') for p in parts):
            continue
        missing_ids, missing_tool = check_file(path)
        issues = missing_ids + missing_tool
        if issues:
            rel = path.relative_to(ROOT)
            errors.append((str(rel), issues))
        checked += 1

    if errors:
        print(f'\n[check_dom] FAIL — {len(errors)} page(s) with issues:\n')
        for rel, issues in errors:
            print(f'  {rel}')
            for issue in issues:
                print(f'    ✗  {issue}')
        print(f'\nFix these pages before deploying. ({checked} pages scanned)')
        sys.exit(1)
    else:
        print(f'[check_dom] OK — all {checked} pages pass required-ID check.')
        sys.exit(0)

if __name__ == '__main__':
    main()
