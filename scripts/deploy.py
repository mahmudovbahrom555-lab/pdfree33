#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Single command before every deploy — bumps all version numbers atomically.
#
# What it does:
#   1. Bumps CACHE_VERSION in sw.js (e.g. v57 → v58)
#   2. Bumps worker.js ?v= in processor.js and sw.js STATIC_ASSETS together
#
# Usage: python3 scripts/deploy.py [--dry-run]

import re
import sys
from pathlib import Path

ROOT    = Path(__file__).parent.parent
DRY_RUN = '--dry-run' in sys.argv


def read(path):
    return path.read_text(encoding='utf-8')


def write(path, text, label):
    if DRY_RUN:
        print(f'  [dry-run] would write {path.relative_to(ROOT)}')
        return
    path.write_text(text, encoding='utf-8')
    print(f'  updated: {path.relative_to(ROOT)}')


def bump_cache_version():
    sw = ROOT / 'sw.js'
    text = read(sw)

    m = re.search(r"CACHE_VERSION\s*=\s*'v(\d+)'", text)
    if not m:
        print('ERROR: CACHE_VERSION not found in sw.js')
        sys.exit(1)

    old_n = int(m.group(1))
    new_n = old_n + 1
    new_text = text.replace(f"'v{old_n}'", f"'v{new_n}'", 1)
    write(sw, new_text, 'CACHE_VERSION')
    print(f'  CACHE_VERSION: v{old_n} → v{new_n}')
    return old_n, new_n


def bump_worker_version():
    proc = ROOT / 'js' / 'processor.js'
    sw   = ROOT / 'sw.js'

    proc_text = read(proc)
    sw_text   = read(sw)

    # Find current worker version in processor.js
    m = re.search(r"worker\.js\?v=(\d+)", proc_text)
    if not m:
        print('ERROR: worker.js?v= not found in processor.js')
        sys.exit(1)

    old_v = int(m.group(1))
    new_v = old_v + 1

    new_proc = proc_text.replace(f'worker.js?v={old_v}', f'worker.js?v={new_v}')
    new_sw   = sw_text.replace(  f'worker.js?v={old_v}', f'worker.js?v={new_v}')

    write(proc, new_proc, 'processor.js')
    write(sw,   new_sw,   'sw.js')
    print(f'  worker.js version: v{old_v} → v{new_v}')


def main():
    print('PDFree deploy version bump:')
    bump_cache_version()
    bump_worker_version()
    if DRY_RUN:
        print('\nDry run — no files changed.')
    else:
        print('\nDone. Now deploy and the SW will invalidate all caches on update.')


if __name__ == '__main__':
    main()
