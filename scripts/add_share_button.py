#!/usr/bin/env python3
"""Add <button id="shareBtn"> right after <button id="downloadBtn"> on all pages.

Button is display:none by default — shown via JS only when navigator.canShare({files}) is true.
"""
from pathlib import Path

BASE = Path(__file__).parent.parent

SHARE_BTN = (
    '\n        <button id="shareBtn" class="share-btn" type="button"'
    ' style="display:none" aria-label="Send file via device apps"></button>'
)

OLD_DL = '<button id="downloadBtn" class="download-btn" type="button">⬇ Download</button>'
NEW_DL = OLD_DL + SHARE_BTN


def patch(path: Path) -> bool:
    html = path.read_text(encoding="utf-8")
    if 'id="shareBtn"' in html:
        return False   # already done
    if OLD_DL not in html:
        return False   # different structure
    path.write_text(html.replace(OLD_DL, NEW_DL, 1), encoding="utf-8")
    return True


def main():
    targets = list(BASE.glob("*/index.html")) + [BASE / "index.html"]
    updated = skipped = 0
    for p in sorted(targets):
        if "node_modules" in str(p) or ".git" in str(p):
            continue
        if patch(p):
            print(f"  OK: {p.relative_to(BASE)}")
            updated += 1
        else:
            skipped += 1
    print(f"\nDone: {updated} updated, {skipped} skipped.")


if __name__ == "__main__":
    main()
