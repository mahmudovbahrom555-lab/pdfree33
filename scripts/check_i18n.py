#!/usr/bin/env python3
"""
check_i18n.py — Verify all locale files have same keys as i18n.js (EN source of truth).
Exit 0 = OK. Exit 1 = missing or extra keys found.
"""
import sys, re
from pathlib import Path

ROOT = Path(__file__).parent.parent

def extract_keys(text):
    return set(re.findall(r"^\s{2}([a-z_0-9]+):", text, re.MULTILINE))

def main():
    en_text   = (ROOT / "js/i18n.js").read_text(encoding="utf-8")
    en_keys   = extract_keys(en_text)

    locales = {
        "de": ROOT / "js/locales/de.js",
        "es": ROOT / "js/locales/es.js",
        "fr": ROOT / "js/locales/fr.js",
        "pt": ROOT / "js/locales/pt.js",
    }

    errors = []
    for lang, path in locales.items():
        keys = extract_keys(path.read_text(encoding="utf-8"))
        missing = en_keys - keys
        extra   = keys - en_keys
        if missing:
            for k in sorted(missing):
                errors.append(f"  {lang}: missing key  '{k}'")
        if extra:
            for k in sorted(extra):
                errors.append(f"  {lang}: extra key    '{k}'")

    if errors:
        print(f"[check_i18n] FAIL — locale keys out of sync:\n")
        for e in errors: print(e)
        print(f"\nEN has {len(en_keys)} keys. Fix locale files before deploying.")
        sys.exit(1)
    else:
        print(f"[check_i18n] OK — all locales in sync ({len(en_keys)} keys each).")

if __name__ == "__main__":
    main()
