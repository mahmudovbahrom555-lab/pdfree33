#!/usr/bin/env python3
"""
sync_nav.py — Single source of truth for navigation links.

When you add/remove a tool from the nav, edit NAV_LINKS below,
then run: python3 scripts/sync_nav.py

Updates the <div class="nav-links"> block in ALL HTML pages.
"""

from pathlib import Path
import re

ROOT = Path(__file__).parent.parent

# ── Edit here when nav changes ───────────────────────────────
NAV_LINKS = [
    ("Merge",      "../merge-pdf/",     "merge"),
    ("Split",      "../split-pdf/",     "split"),
    ("Compress",   "../compress-pdf/",  "compress"),
    ("JPG→PDF",    "../jpg2pdf/",       "jpg2pdf"),
    ("PDF→JPG",    "../pdf2jpg/",       "pdf2jpg"),
    ("Watermark",  "../watermark-pdf/", "watermark"),
    ("Page №",     "../pagenum-pdf/",   "pagenum"),
    ("Metadata",   "../metadata-pdf/",  "meta"),
    ("Extract",    "../extract-pdf/",   "extract"),
    ("Redact",     "../redact-pdf/",    "redact"),
    ("Rotate",     "../rotate-pdf/",    "rotate"),
    ("Protect",    "../protect-pdf/",   "protect"),
]

def build_nav_html(links):
    items = "\n".join(
        f'      <a href="{href}" class="nav-link" data-tool="{tool}">{label}</a>'
        for label, href, tool in links
    )
    return f'<div class="nav-links">\n{items}\n    </div>'

NAV_PATTERN = re.compile(
    r'<div class="nav-links">.*?</div>',
    re.DOTALL
)

def main():
    new_nav = build_nav_html(NAV_LINKS)
    updated = 0
    skipped = 0

    for path in sorted(ROOT.rglob("*.html")):
        parts = path.parts
        if any(p.startswith(".") or p == "node_modules" for p in parts):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if 'class="nav-links"' not in text:
            continue
        new_text = NAV_PATTERN.sub(new_nav, text)
        if new_text != text:
            path.write_text(new_text, encoding="utf-8")
            print(f"  updated  {path.relative_to(ROOT)}")
            updated += 1
        else:
            skipped += 1

    print(f"\nDone: {updated} updated, {skipped} already in sync.")

if __name__ == "__main__":
    main()
