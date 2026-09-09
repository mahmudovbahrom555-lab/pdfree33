#!/usr/bin/env python3
"""
check_vendor_sync.py — Validates js/vendor/pdf-lib.min.js matches the
pinned devDependency version in node_modules.

Why this exists: pdf-lib is a devDependency (used only by the Node test
suite via node_modules) — the file actually shipped to the browser/worker
is a SEPARATE, manually-copied file at js/vendor/pdf-lib.min.js. npm/
Dependabot can bump node_modules/pdf-lib (via package.json's "pdf-lib"
devDependency) with zero visibility into js/vendor/pdf-lib.min.js, which
is not tracked by package-lock.json at all — so the two copies can drift
silently: tests would then run against a DIFFERENT pdf-lib version than
what real users actually get in their browser, and any bug pdf-lib fixed
or introduced in the newer version stays invisible until someone happens
to diff the two files by hand.

This project's workarounds for specific pdf-lib bugs (e.g. handleFill's/
handleFlatten's _cleanDanglingAnnots() in js/worker.js, see memory
flatten_dangling_annots_bug_2026_09 / fill_market_research_radio_annots_
bug_2026_09) are version-specific observations — an update is exactly the
moment those need re-verifying, not blindly trusted to still apply.

If this check fails, update BOTH copies together, don't just silence
the check:
  1. npm install pdf-lib@<new-version>
  2. cp node_modules/pdf-lib/dist/pdf-lib.min.js js/vendor/pdf-lib.min.js
  3. npm test — re-verifies the pdf-lib-bug workarounds still apply
     (or have become harmless no-ops if pdf-lib fixed them upstream)
  4. Live-browser smoke test on the pdf-lib-heavy tools (Fill, Flatten,
     Split, Extract, Protect) before treating the bump as safe.

Run before every deploy: python3 scripts/check_vendor_sync.py
Exit 0 = in sync. Exit 1 = drifted, see message for the fix.
"""

import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent


def _sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    vendor = ROOT / 'js' / 'vendor' / 'pdf-lib.min.js'
    npm    = ROOT / 'node_modules' / 'pdf-lib' / 'dist' / 'pdf-lib.min.js'

    if not vendor.exists():
        print(f'[check_vendor_sync] FAIL — {vendor} not found')
        sys.exit(1)

    if not npm.exists():
        # node_modules not installed (e.g. a doc-only CI step) — nothing
        # to compare against, don't fail a step that never ran `npm ci`.
        print('[check_vendor_sync] SKIP — node_modules/pdf-lib not installed, nothing to compare')
        return

    vendor_hash = _sha256(vendor)
    npm_hash    = _sha256(npm)

    if vendor_hash != npm_hash:
        print('[check_vendor_sync] FAIL — js/vendor/pdf-lib.min.js does not match')
        print('  node_modules/pdf-lib/dist/pdf-lib.min.js (the pinned devDependency version).')
        print('  The two have drifted: the browser is shipping a DIFFERENT pdf-lib build than')
        print('  the one the test suite runs against. Fix:')
        print('    cp node_modules/pdf-lib/dist/pdf-lib.min.js js/vendor/pdf-lib.min.js')
        print('  then run `npm test` and a live-browser smoke pass before committing —')
        print('  see this script\'s own header comment for the full checklist.')
        sys.exit(1)

    print('[check_vendor_sync] OK — js/vendor/pdf-lib.min.js matches node_modules/pdf-lib')


if __name__ == '__main__':
    main()
