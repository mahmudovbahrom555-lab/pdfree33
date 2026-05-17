#!/usr/bin/env python3
"""Add visible breadcrumb nav to all 12 tool pages.

Inserts right after </nav>, removes the stray </section> that follows it.
Breadcrumb matches the existing BreadcrumbList schema exactly.
"""

from pathlib import Path

BASE = Path(__file__).parent.parent

TOOLS = {
    "compress-pdf":  ("Compress PDF",      "/compress-pdf/"),
    "merge-pdf":     ("Merge PDF",          "/merge-pdf/"),
    "split-pdf":     ("Split PDF",          "/split-pdf/"),
    "jpg2pdf":       ("JPG to PDF",         "/jpg2pdf/"),
    "pdf2jpg":       ("PDF to JPG",         "/pdf2jpg/"),
    "watermark-pdf": ("Watermark PDF",      "/watermark-pdf/"),
    "protect-pdf":   ("Protect PDF",        "/protect-pdf/"),
    "redact-pdf":    ("Redact PDF",         "/redact-pdf/"),
    "rotate-pdf":    ("Rotate PDF",         "/rotate-pdf/"),
    "metadata-pdf":  ("Edit PDF Metadata",  "/metadata-pdf/"),
    "pagenum-pdf":   ("Add Page Numbers",   "/pagenum-pdf/"),
    "extract-pdf":   ("Extract PDF Pages",  "/extract-pdf/"),
}


def breadcrumb_html(label, path):
    return (
        '\n  <nav aria-label="Breadcrumb" style="padding:8px 24px;border-bottom:1px solid var(--border);background:var(--surface);">'
        '\n    <ol style="list-style:none;margin:0;padding:0;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text3);"'
        '\n        itemscope itemtype="https://schema.org/BreadcrumbList">'
        '\n      <li itemprop="itemListElement" itemscope itemtype="https://schema.org/ListItem">'
        '\n        <a href="/" itemprop="item" style="color:var(--green);text-decoration:none;font-weight:500;">'
        '\n          <span itemprop="name">PDFree</span>'
        '\n        </a>'
        '\n        <meta itemprop="position" content="1">'
        '\n      </li>'
        '\n      <li aria-hidden="true" style="color:var(--border);">›</li>'
        f'\n      <li itemprop="itemListElement" itemscope itemtype="https://schema.org/ListItem">'
        f'\n        <a href="{path}" itemprop="item" style="color:var(--text2);text-decoration:none;" aria-current="page">'
        f'\n          <span itemprop="name">{label}</span>'
        '\n        </a>'
        '\n        <meta itemprop="position" content="2">'
        '\n      </li>'
        '\n    </ol>'
        '\n  </nav>'
    )


def main():
    updated = skipped = 0
    for tool_id, (label, path) in TOOLS.items():
        file = BASE / tool_id / "index.html"
        if not file.exists():
            print(f"  SKIP (missing): {tool_id}/")
            skipped += 1
            continue

        html = file.read_text(encoding="utf-8")

        if 'aria-label="Breadcrumb"' in html:
            print(f"  SKIP (already has breadcrumb): {tool_id}/")
            skipped += 1
            continue

        # Replace:  </nav>\n\n</section>\n  with  </nav> + breadcrumb + \n
        # The stray </section> after </nav> is removed in the same step.
        old = "  </nav>\n\n</section>"
        new = "  </nav>" + breadcrumb_html(label, path)

        if old not in html:
            # Try without the blank line between
            old2 = "  </nav>\n</section>"
            new2 = "  </nav>" + breadcrumb_html(label, path)
            if old2 in html:
                html = html.replace(old2, new2, 1)
            else:
                print(f"  WARN (marker not found): {tool_id}/")
                skipped += 1
                continue
        else:
            html = html.replace(old, new, 1)

        file.write_text(html, encoding="utf-8")
        print(f"  OK: {tool_id}/")
        updated += 1

    print(f"\nDone: {updated} updated, {skipped} skipped.")


if __name__ == "__main__":
    main()
