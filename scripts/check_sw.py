#!/usr/bin/env python3
"""
check_sw.py — Validates sw.js STATIC_ASSETS list.

Every URL in STATIC_ASSETS must point to a real file on disk.
A missing file causes cache.addAll() to reject the entire precache list,
silently breaking offline support and first-load caching.

Run before every deploy: python3 scripts/check_sw.py
Exit 0 = all good. Exit 1 = missing files found.
"""

import sys
import re
from pathlib import Path

ROOT = Path(__file__).parent.parent
SW   = ROOT / 'sw.js'


def main():
    text = SW.read_text(encoding='utf-8')

    # Extract the STATIC_ASSETS array block
    m = re.search(r'const STATIC_ASSETS\s*=\s*\[(.*?)\];', text, re.DOTALL)
    if not m:
        print('[check_sw] FAIL — STATIC_ASSETS array not found in sw.js')
        sys.exit(1)

    # Pull out every single-quoted URL string
    urls = re.findall(r"'([^']+)'", m.group(1))

    errors = []
    for url in urls:
        # Strip query string (?v=...) — the base file is what matters
        path_part = url.split('?')[0]
        # '/' maps to index.html
        if path_part == '/':
            file_path = ROOT / 'index.html'
        else:
            file_path = ROOT / path_part.lstrip('/')

        if not file_path.exists():
            errors.append(url)

    if errors:
        print(f'[check_sw] FAIL — {len(errors)} missing file(s) in STATIC_ASSETS:\n')
        for url in errors:
            print(f'  ✗  {url}  →  file not found on disk')
        print('\nRemove or fix these entries in sw.js before deploying.')
        sys.exit(1)
    else:
        print(f'[check_sw] OK — all {len(urls)} STATIC_ASSETS entries exist on disk.')
        sys.exit(0)


if __name__ == '__main__':
    main()
