#!/usr/bin/env python3
"""Two fixes on all 12 tool pages:
 1. Add 5 missing tools to the nav-links (pdf2jpg, extract, pagenum, redact, rotate)
 2. Replace OG titles with click-worthy alternatives (not word-for-word copies of <title>)
"""
from pathlib import Path

BASE = Path(__file__).parent.parent

# ── New nav-links block (replaces the current 7-item one) ──────────────────
OLD_NAV = """    <div class="nav-links">
      <a href="../merge-pdf/" class="nav-link" data-tool="merge">Merge</a>
      <a href="../split-pdf/" class="nav-link" data-tool="split">Split</a>
      <a href="../compress-pdf/" class="nav-link" data-tool="compress">Compress</a>
      <a href="../jpg2pdf/" class="nav-link" data-tool="jpg2pdf">JPG→PDF</a>
      <a href="../watermark-pdf/" class="nav-link" data-tool="watermark">Watermark</a>
      <a href="../metadata-pdf/" class="nav-link" data-tool="meta">Metadata</a>
      <a href="../protect-pdf/" class="nav-link" data-tool="protect">Protect</a>
    </div>"""

NEW_NAV = """    <div class="nav-links">
      <a href="../merge-pdf/"    class="nav-link" data-tool="merge">Merge</a>
      <a href="../split-pdf/"    class="nav-link" data-tool="split">Split</a>
      <a href="../compress-pdf/" class="nav-link" data-tool="compress">Compress</a>
      <a href="../jpg2pdf/"      class="nav-link" data-tool="jpg2pdf">JPG→PDF</a>
      <a href="../pdf2jpg/"      class="nav-link" data-tool="pdf2jpg">PDF→JPG</a>
      <a href="../extract-pdf/"  class="nav-link" data-tool="extract">Extract</a>
      <a href="../watermark-pdf/" class="nav-link" data-tool="watermark">Watermark</a>
      <a href="../pagenum-pdf/"  class="nav-link" data-tool="pagenum">Page №</a>
      <a href="../metadata-pdf/" class="nav-link" data-tool="meta">Metadata</a>
      <a href="../redact-pdf/"   class="nav-link" data-tool="redact">Redact</a>
      <a href="../rotate-pdf/"   class="nav-link" data-tool="rotate">Rotate</a>
      <a href="../protect-pdf/"  class="nav-link" data-tool="protect">Protect</a>
    </div>"""

# ── OG title rewrites: old content → new content ──────────────────────────
OG_TITLES = {
    "compress-pdf": (
        "Compress PDF Online — Reduce File Size Locally | PDFree",
        "Compress PDF in Your Browser — Files Never Leave Your Device",
    ),
    "merge-pdf": (
        "Merge PDF Files Online — Free, No Upload | PDFree",
        "Merge Unlimited PDFs Free — No Size Limit, No Server Upload",
    ),
    "split-pdf": (
        "Split PDF Online — Extract Pages, No Upload | PDFree",
        "Split PDF & Extract Any Pages — 100% Private, Always Free",
    ),
    "jpg2pdf": (
        "JPG to PDF Converter — Free, No Upload | PDFree",
        "JPG to PDF — Convert Multiple Photos into One File, No Upload",
    ),
    "pdf2jpg": (
        "PDF to JPG Converter — Free, Browser-Based | PDFree",
        "PDF to JPG — Export Every Page as a Sharp Image, No Upload",
    ),
    "watermark-pdf": (
        "Add Watermark to PDF — Free, Private, No Upload | PDFree",
        "Watermark Any PDF — Text, Opacity, Rotation — All Free, Private",
    ),
    "protect-pdf": (
        "Password Protect PDF — AES-256 Encryption, No Upload | PDFree",
        "Encrypt PDF with AES-256 — Your Password Never Reaches Any Server",
    ),
    "redact-pdf": (
        "Redact PDF Online — Remove Sensitive Info Locally | PDFree",
        "Redact PDF Permanently — True Content Removal, Not Just a Cover",
    ),
    "rotate-pdf": (
        "Rotate PDF Pages Online — Free, No Upload | PDFree",
        "Rotate PDF Pages — Fix Sideways Scans in Seconds, No Upload",
    ),
    "metadata-pdf": (
        "Edit PDF Metadata Online — Free, No Upload | PDFree",
        "Remove Your Name from PDFs — Edit Metadata Privately, Free",
    ),
    "pagenum-pdf": (
        "Add Page Numbers to PDF — Free, No Upload | PDFree",
        "Add Page Numbers to Any PDF — Arabic, Roman, ABC — Always Free",
    ),
    "extract-pdf": (
        "Extract Pages from PDF — Free, Private, No Upload | PDFree",
        "Extract Any Pages from PDF — Precise Range, No Upload, Free",
    ),
}


def main():
    nav_updated = og_updated = skipped = 0

    for tool_id in OG_TITLES:
        path = BASE / tool_id / "index.html"
        if not path.exists():
            print(f"  SKIP (missing): {tool_id}/")
            skipped += 1
            continue

        html = path.read_text(encoding="utf-8")
        changed = False

        # 1. Nav
        if OLD_NAV in html:
            html = html.replace(OLD_NAV, NEW_NAV, 1)
            nav_updated += 1
            nav_status = "nav ✓"
        else:
            nav_status = "nav already updated"

        # 2. OG title
        old_og, new_og = OG_TITLES[tool_id]
        old_attr = f'content="{old_og}"'
        new_attr = f'content="{new_og}"'
        if old_attr in html:
            html = html.replace(old_attr, new_attr, 1)
            og_updated += 1
            og_status = "og ✓"
        else:
            og_status = "og already updated / not found"

        path.write_text(html, encoding="utf-8")
        print(f"  {tool_id}/  [{nav_status}]  [{og_status}]")

    print(f"\nDone: {nav_updated} navs updated, {og_updated} OG titles updated, {skipped} skipped.")


if __name__ == "__main__":
    main()
