#!/usr/bin/env python3
"""Add HowTo schema to all tool pages that don't have it."""

import re
from pathlib import Path

BASE = Path(__file__).parent.parent

TOOLS = {
    "compress-pdf": {
        "name": "How to Compress a PDF File",
        "desc": "Reduce the file size of any PDF in seconds — entirely in your browser, no upload required.",
        "url": "https://pdfree.io/compress-pdf/",
        "time": "PT1M",
        "steps": [
            ("Open the Compress PDF tool", "Go to pdfree.io/compress-pdf/ in any modern browser. No account or installation needed."),
            ("Add your PDF file", "Click 'Choose files' or drag and drop your PDF into the drop zone. Files stay on your device — nothing is uploaded."),
            ("Choose compression level", "Select a preset: Light (best quality), Medium (balanced), or Heavy (smallest file). The default Medium setting works well for most documents."),
            ("Compress and download", "Click 'Compress PDF'. Processing takes seconds in your browser. Download the compressed file — it's ready immediately."),
        ]
    },
    "split-pdf": {
        "name": "How to Split a PDF File",
        "desc": "Extract specific pages or split a PDF into individual pages — locally, without uploading.",
        "url": "https://pdfree.io/split-pdf/",
        "time": "PT1M",
        "steps": [
            ("Open the Split PDF tool", "Go to pdfree.io/split-pdf/ in any modern browser. No account needed."),
            ("Upload your PDF", "Click 'Choose files' or drag and drop your PDF. The file stays on your device."),
            ("Select pages to extract", "Enter page ranges (e.g. 1-3, 5, 8-10) or choose to split every page into a separate file."),
            ("Split and download", "Click 'Split PDF'. Your extracted pages download as a ZIP file instantly."),
        ]
    },
    "jpg2pdf": {
        "name": "How to Convert JPG to PDF",
        "desc": "Convert one or multiple JPG or PNG images into a single PDF file — instantly in your browser.",
        "url": "https://pdfree.io/jpg2pdf/",
        "time": "PT1M",
        "steps": [
            ("Open the JPG to PDF tool", "Go to pdfree.io/jpg2pdf/ in any modern browser. No signup required."),
            ("Add your images", "Click 'Choose files' or drag and drop your JPG or PNG images. Add multiple images to combine them into one PDF."),
            ("Arrange the order", "Drag images to set the order they will appear in the PDF."),
            ("Convert and download", "Click 'Convert to PDF'. Your images are combined into a PDF and ready to download instantly."),
        ]
    },
    "pdf2jpg": {
        "name": "How to Convert PDF to JPG",
        "desc": "Export every page of a PDF as a high-quality JPG image — processed locally in your browser.",
        "url": "https://pdfree.io/pdf2jpg/",
        "time": "PT2M",
        "steps": [
            ("Open the PDF to JPG tool", "Go to pdfree.io/pdf2jpg/ in any modern browser."),
            ("Upload your PDF", "Click 'Choose files' or drag and drop your PDF file."),
            ("Choose image quality", "Select the output resolution — higher DPI gives sharper images at larger file sizes."),
            ("Convert and download", "Click 'Convert to JPG'. Each page is exported as a separate JPG and downloaded as a ZIP file."),
        ]
    },
    "watermark-pdf": {
        "name": "How to Add a Watermark to a PDF",
        "desc": "Add text or image watermarks to any PDF — customized position, opacity, and rotation, all locally.",
        "url": "https://pdfree.io/watermark-pdf/",
        "time": "PT2M",
        "steps": [
            ("Open the Watermark PDF tool", "Go to pdfree.io/watermark-pdf/ in any modern browser."),
            ("Upload your PDF", "Click 'Choose files' or drag and drop your PDF."),
            ("Configure the watermark", "Type your watermark text (e.g. 'CONFIDENTIAL', 'DRAFT'). Adjust font size, color, opacity, rotation, and position."),
            ("Apply and download", "Click 'Add Watermark'. The watermarked PDF downloads instantly — processed entirely in your browser."),
        ]
    },
    "protect-pdf": {
        "name": "How to Password Protect a PDF",
        "desc": "Add password encryption to any PDF — your password key never leaves your device.",
        "url": "https://pdfree.io/protect-pdf/",
        "time": "PT1M",
        "steps": [
            ("Open the Protect PDF tool", "Go to pdfree.io/protect-pdf/ in any modern browser."),
            ("Upload your PDF", "Click 'Choose files' or drag and drop your PDF."),
            ("Set a password", "Enter the password you want to use. The encryption happens locally — your password is never sent to any server."),
            ("Protect and download", "Click 'Protect PDF'. The encrypted PDF downloads immediately, ready to share securely."),
        ]
    },
    "redact-pdf": {
        "name": "How to Redact a PDF",
        "desc": "Permanently cover sensitive text, names, or images in a PDF before sharing — done entirely in your browser.",
        "url": "https://pdfree.io/redact-pdf/",
        "time": "PT2M",
        "steps": [
            ("Open the Redact PDF tool", "Go to pdfree.io/redact-pdf/ in any modern browser."),
            ("Upload your PDF", "Click 'Choose files' or drag and drop your PDF."),
            ("Mark areas to redact", "Draw black cover boxes over the content you want to remove — names, addresses, account numbers, or any sensitive information."),
            ("Apply and download", "Click 'Apply Redaction'. The covered areas are permanently hidden in the downloaded PDF."),
        ]
    },
    "rotate-pdf": {
        "name": "How to Rotate Pages in a PDF",
        "desc": "Rotate one page or all pages of a PDF to any orientation — instantly, without uploading.",
        "url": "https://pdfree.io/rotate-pdf/",
        "time": "PT1M",
        "steps": [
            ("Open the Rotate PDF tool", "Go to pdfree.io/rotate-pdf/ in any modern browser."),
            ("Upload your PDF", "Click 'Choose files' or drag and drop your PDF."),
            ("Choose rotation", "Select 90°, 180°, or 270° rotation. Apply to all pages or specific pages only."),
            ("Save and download", "Click 'Rotate PDF'. The corrected PDF downloads instantly."),
        ]
    },
    "metadata-pdf": {
        "name": "How to Edit PDF Metadata",
        "desc": "View and edit the title, author, subject, and keywords of any PDF — privately in your browser.",
        "url": "https://pdfree.io/metadata-pdf/",
        "time": "PT1M",
        "steps": [
            ("Open the Metadata editor", "Go to pdfree.io/metadata-pdf/ in any modern browser."),
            ("Upload your PDF", "Click 'Choose files' or drag and drop your PDF."),
            ("Edit the metadata fields", "Update the title, author, subject, keywords, or creation date. Clear fields to remove metadata entirely."),
            ("Save and download", "Click 'Save Metadata'. The updated PDF downloads with the new metadata embedded."),
        ]
    },
    "pagenum-pdf": {
        "name": "How to Add Page Numbers to a PDF",
        "desc": "Add Arabic, Roman, or alphabetic page numbers to any PDF — customized position and style, locally.",
        "url": "https://pdfree.io/pagenum-pdf/",
        "time": "PT2M",
        "steps": [
            ("Open the Page Numbers tool", "Go to pdfree.io/pagenum-pdf/ in any modern browser."),
            ("Upload your PDF", "Click 'Choose files' or drag and drop your PDF."),
            ("Configure page numbers", "Choose number format (1, 2, 3 or i, ii, iii or A, B, C), position (top or bottom), starting number, and which pages to number."),
            ("Apply and download", "Click 'Add Page Numbers'. The PDF downloads with numbered pages instantly."),
        ]
    },
    "extract-pdf": {
        "name": "How to Extract Pages from a PDF",
        "desc": "Pull specific pages out of any PDF and save them as a new document — no upload, no server.",
        "url": "https://pdfree.io/extract-pdf/",
        "time": "PT1M",
        "steps": [
            ("Open the Extract PDF tool", "Go to pdfree.io/extract-pdf/ in any modern browser."),
            ("Upload your PDF", "Click 'Choose files' or drag and drop your PDF."),
            ("Select pages to extract", "Enter the page numbers or ranges you want to keep (e.g. 2, 4-7, 10)."),
            ("Extract and download", "Click 'Extract Pages'. The selected pages are saved as a new PDF and downloaded instantly."),
        ]
    },
}


def build_howto(tool_id, data):
    steps_json = ""
    for i, (name, text) in enumerate(data["steps"], 1):
        comma = "," if i < len(data["steps"]) else ""
        steps_json += f"""      {{
        "@type": "HowToStep",
        "position": {i},
        "name": "{name}",
        "text": "{text}",
        "url": "{data['url']}#step{i}"
      }}{comma}
"""
    return f"""  <script type="application/ld+json">
  {{
    "@context": "https://schema.org",
    "@type": "HowTo",
    "name": "{data['name']}",
    "description": "{data['desc']}",
    "totalTime": "{data['time']}",
    "tool": [{{"@type": "HowToTool", "name": "PDFree — free browser-based PDF tool"}}],
    "step": [
{steps_json}    ]
  }}
  </script>
"""


def main():
    added = 0
    skipped = 0
    for tool_id, data in TOOLS.items():
        path = BASE / tool_id / "index.html"
        if not path.exists():
            print(f"  SKIP (no file): {tool_id}/")
            skipped += 1
            continue

        html = path.read_text(encoding="utf-8")

        if '"@type": "HowTo"' in html:
            print(f"  SKIP (already has HowTo): {tool_id}/")
            skipped += 1
            continue

        # Insert HowTo schema before BreadcrumbList block
        marker = '  <script type="application/ld+json">\n  {\n  "@context": "https://schema.org",\n  "@type": "BreadcrumbList"'
        if marker not in html:
            print(f"  WARN (marker not found): {tool_id}/")
            skipped += 1
            continue

        howto_block = build_howto(tool_id, data)
        html = html.replace(marker, howto_block + marker)
        path.write_text(html, encoding="utf-8")
        print(f"  OK: {tool_id}/")
        added += 1

    print(f"\nDone: {added} pages updated, {skipped} skipped.")


if __name__ == "__main__":
    main()
