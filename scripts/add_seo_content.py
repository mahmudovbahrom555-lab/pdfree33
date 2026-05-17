#!/usr/bin/env python3
"""Replace thin seo-article sections on all 12 tool pages with rich SEO content.

Each page gets:
  - Visible How-to steps (3-4 steps)
  - When-to-use scenarios (4 real scenarios)
  - Competitor comparison table (PDFree vs iLovePDF vs SmallPDF vs Adobe)
  - FAQ section (5-7 questions, visible HTML)
  - Related tools links
"""

import re
from pathlib import Path

BASE = Path(__file__).parent.parent

# ─────────────────────────────────────────────────────────────────────────────
# Content definitions — unique per tool
# ─────────────────────────────────────────────────────────────────────────────

TOOLS = {
    "compress-pdf": {
        "h1": "Compress PDF Online — Reduce File Size Without Losing Quality",
        "intro": "Large PDFs clog email inboxes, fail to upload to web forms, and eat cloud storage. PDFree's compressor removes hidden bloat from your PDF — duplicate objects, embedded thumbnails, over-sized images — entirely inside your browser. Nothing is uploaded.",
        "how_title": "How to Compress a PDF in 3 Steps",
        "steps": [
            ("Choose your file", "Click <strong>Choose files</strong> or drag your PDF into the drop zone. Any file size is accepted — compression happens in your browser, not on a server."),
            ("Pick a compression level", "Select <strong>Light</strong> (5–15% smaller, best quality), <strong>Medium</strong> (30–50%, balanced), or <strong>Heavy</strong> (50–70%, smallest file). Medium works for most emails and web uploads."),
            ("Download the compressed PDF", "Click <strong>Compress PDF</strong>. Processing takes a few seconds. The download starts automatically — your file never left your device."),
        ],
        "when_title": "When to Compress a PDF",
        "scenarios": [
            ("Email attachments", "Most email providers cap attachments at 25MB. Compressing a scan-heavy PDF from 40MB down to 10MB lets you send it without switching to a file-sharing link."),
            ("Web form uploads", "Government portals, job application sites, and legal filing systems often cap uploads at 5–10MB. Compress first to avoid the 'file too large' rejection."),
            ("Saving cloud storage", "If you archive hundreds of PDFs, compressing each one 40–60% adds up to gigabytes of recovered space on Google Drive, Dropbox, or iCloud."),
            ("Faster mobile sharing", "Sending a PDF over WhatsApp, Signal, or iMessage? A 20MB file can take a minute on LTE. Compress to 4MB and it sends instantly."),
        ],
        "comparison_feature": "Max file size (free)",
        "competitors": [
            ("PDFree", "No limit", "No limit", "No upload", "Free forever", True),
            ("iLovePDF", "~25 MB", "Daily limit", "Uploaded to servers", "Free / $6+/mo", False),
            ("SmallPDF", "~15 MB", "2 tasks/day", "Uploaded to servers", "Free / $9+/mo", False),
            ("Adobe Acrobat", "100 MB", "2/month free", "Uploaded to servers", "$19.99/mo", False),
        ],
        "faqs": [
            ("How much does PDF compression reduce file size?", "Typical reduction is 20–70%. PDFs full of high-resolution images (scans, photos, brochures) compress the most. Text-only PDFs see less reduction since text is already stored efficiently. The 'Heavy' preset reduces image quality to 72%, giving the largest size savings."),
            ("Will compression damage the text quality?", "No. Text in PDFs is vector-based and is not affected by image compression. Only raster images embedded in the PDF are recompressed. On the 'Light' setting even images are untouched — only metadata and hidden redundant objects are removed."),
            ("Why does the compressed PDF look the same but is smaller?", "PDFs often contain hidden bloat: page thumbnails Adobe Reader auto-generates, duplicate font tables, embedded color profiles, and metadata strings. PDFree strips these invisible extras. The visible content is identical."),
            ("Can I compress a password-protected PDF?", "PDFree cannot modify encrypted PDFs. You would need to remove the password first using the <a href='/protect-pdf/' style='color:var(--green)'>Protect PDF</a> tool (which can also remove passwords), then compress."),
            ("Is there a file size limit for compression?", "No. PDFree has no upload limit because nothing is uploaded. The only practical limit is your device's available RAM. Most computers comfortably handle PDFs up to several hundred megabytes."),
            ("Does PDFree upload my file to compress it?", "No. Compression runs entirely in your browser using JavaScript. Your PDF is loaded into browser memory, processed locally, and the result is offered as a download. No data is sent to any server."),
        ],
        "related": [
            ("/merge-pdf/", "Merge PDF", "Combine the compressed file with other documents"),
            ("/split-pdf/", "Split PDF", "Extract specific pages before or after compressing"),
            ("/compress-large-pdf-free/", "Compress Large PDF Free", "Dedicated guide for compressing 100MB+ files"),
        ],
    },

    "merge-pdf": {
        "h1": "Merge PDF Files Online — Free, Private, No Upload",
        "intro": "Merging PDFs is one of the most common document tasks — combining a contract with its addenda, assembling a report from multiple sections, or consolidating scanned pages into one file. PDFree does it entirely in your browser, with no upload and no account.",
        "how_title": "How to Merge PDF Files in 3 Steps",
        "steps": [
            ("Add your PDF files", "Click <strong>Choose files</strong> or drag multiple PDFs into the drop zone at once. You can add as many files as you need — there is no limit."),
            ("Arrange the order", "Drag the file cards up or down to set the exact order the pages will appear in the final document. Reorder as many times as you like before proceeding."),
            ("Merge and download", "Click <strong>Merge PDF files</strong>. Processing takes seconds (longer for very large files). The merged PDF downloads directly to your device."),
        ],
        "when_title": "When to Merge PDFs",
        "scenarios": [
            ("Contracts + addenda", "Clients often sign the main agreement and amendments as separate files. Merge them into one PDF before archiving or uploading to a contract management system."),
            ("Academic submissions", "Many university portals accept only one PDF. Combine your cover sheet, paper body, appendices, and bibliography into a single submission file."),
            ("Client reports", "Merge an executive summary, charts, raw data tables, and supporting documentation into a single professional PDF to share with clients."),
            ("Scanned multi-page documents", "If you scanned a multi-page form one page at a time, merge all the individual page PDFs into a single document before submitting."),
        ],
        "comparison_feature": "File size limit (free)",
        "competitors": [
            ("PDFree", "No limit", "No limit", "No upload", "Free forever", True),
            ("iLovePDF", "~25 MB", "Daily limit", "Uploaded to servers", "Free / $6+/mo", False),
            ("SmallPDF", "~5 MB compressed", "2 tasks/day", "Uploaded to servers", "Free / $9+/mo", False),
            ("Adobe Acrobat", "100 MB (paid)", "2/month free", "Uploaded to servers", "$19.99/mo", False),
        ],
        "faqs": [
            ("How many PDF files can I merge at once?", "There is no hard limit. PDFree processes everything in browser memory, so you can merge dozens of files. For very large batches (50+ files or total size 500MB+), close other browser tabs to free up RAM."),
            ("Will the formatting and fonts be preserved after merging?", "Yes. PDFree uses pdf-lib, which copies pages at the PDF object level — fonts, images, vector graphics, and formatting are preserved exactly as in the originals."),
            ("Can I merge password-protected PDFs?", "No. Encrypted PDFs cannot be read or modified without the password. Remove the password first using a PDF tool, then merge."),
            ("Is there a daily limit on how many merges I can do?", "No. Unlike SmallPDF (2 tasks/day free) or iLovePDF (daily limits), PDFree has no usage caps. Merge as many PDFs as you want, as often as you need."),
            ("Does merging upload my files to a server?", "No. Your files are processed entirely in your browser's memory. Nothing is sent to any server. Close the tab and the files are gone from memory — no trace on any server."),
            ("Can I merge PDFs on a phone or tablet?", "Yes. PDFree works in mobile browsers (Chrome for Android, Safari for iOS). Drag and drop is replaced by a file picker, and reordering works by tapping the up/down buttons."),
        ],
        "related": [
            ("/compress-pdf/", "Compress PDF", "Reduce the merged file size if it's too large to send"),
            ("/split-pdf/", "Split PDF", "Extract specific pages from the merged document"),
            ("/merge-large-pdf-files/", "Merge Large PDF Files", "Dedicated guide for files over 100MB"),
        ],
    },

    "split-pdf": {
        "h1": "Split PDF Online — Extract Pages Without Uploading",
        "intro": "A 200-page PDF when you only need pages 12–18. A combined scan when you need individual files. PDFree's split tool lets you select exactly which pages to keep and download them as separate files or a single new PDF — processed locally, no upload.",
        "how_title": "How to Split a PDF in 3 Steps",
        "steps": [
            ("Upload your PDF", "Click <strong>Choose files</strong> or drag your PDF into the drop zone. The page thumbnails render in your browser — nothing is uploaded."),
            ("Select pages to extract", "Click the pages you want to keep, or enter a range like <strong>1-5, 8, 11-15</strong>. Use the quick-select buttons to grab odd pages, even pages, or halves of the document."),
            ("Split and download", "Click <strong>Split PDF</strong>. Choose to get a single merged PDF of your selected pages, or each page as a separate file in a ZIP archive."),
        ],
        "when_title": "When to Split a PDF",
        "scenarios": [
            ("Extract specific pages from a report", "A 60-page annual report, but you only need the financial tables on pages 22–31. Split to extract just those pages for sharing with your accountant."),
            ("Separate a multi-invoice scan", "A single scan contains 12 different invoices. Split each invoice page into its own PDF for uploading to your accounting system."),
            ("Remove the first or last page", "Many PDF exports add a cover page or blank final page. Split to exclude those pages and keep only the actual content."),
            ("Academic — extract a single chapter", "Textbooks shared as single PDFs can be split chapter by chapter for focused reading or printing without printing the entire book."),
        ],
        "comparison_feature": "File size limit (free)",
        "competitors": [
            ("PDFree", "No limit", "No limit", "No upload", "Free forever", True),
            ("iLovePDF", "~25 MB", "Daily limit", "Uploaded to servers", "Free / $6+/mo", False),
            ("SmallPDF", "~15 MB", "2 tasks/day", "Uploaded to servers", "Free / $9+/mo", False),
            ("Adobe Acrobat", "100 MB (paid)", "2/month free", "Uploaded to servers", "$19.99/mo", False),
        ],
        "faqs": [
            ("What page range format does PDFree accept?", "Enter comma-separated pages and ranges: for example <code>1, 3-7, 12, 15-20</code>. Spaces are optional. You can also click individual page thumbnails to select or deselect them visually."),
            ("Can I split a PDF into individual pages?", "Yes. Use the 'Split all pages' option to get every page as its own PDF file. They download as a ZIP archive named with their page numbers."),
            ("What is the difference between Split and Extract?", "Split is designed for selecting and downloading multiple page groups. <a href='/extract-pdf/' style='color:var(--green)'>Extract</a> is a simpler tool focused on pulling out a specific page range into one new PDF. Both do similar things — use whichever fits your workflow."),
            ("Does splitting affect PDF quality?", "No. Pages are copied at the PDF object level — images, fonts, and vector graphics are preserved identically. Splitting does not re-render or re-compress anything."),
            ("Is there a limit on PDF size or page count?", "No server-side limit. The practical limit is your browser's available memory. PDFs with hundreds of pages and high-resolution images may require a few seconds to render thumbnails."),
        ],
        "related": [
            ("/merge-pdf/", "Merge PDF", "Combine the extracted pages with other documents"),
            ("/extract-pdf/", "Extract Pages", "Simpler tool for pulling out a specific page range"),
            ("/rotate-pdf/", "Rotate PDF", "Fix page orientation before or after splitting"),
        ],
    },

    "jpg2pdf": {
        "h1": "Convert JPG to PDF Online — Multiple Images, One File",
        "intro": "Turn one photo or an entire folder of images into a clean PDF document — without uploading to a server, installing software, or creating an account. PDFree converts JPG, PNG, and WebP images to PDF entirely inside your browser.",
        "how_title": "How to Convert JPG to PDF in 3 Steps",
        "steps": [
            ("Add your images", "Click <strong>Choose files</strong> or drag JPG, PNG, or WebP images into the drop zone. Drop multiple images at once to combine them all into a single PDF."),
            ("Arrange the order", "Drag image thumbnails to set the page order they will appear in the PDF. The image shown first in the list becomes page 1."),
            ("Convert and download", "Click <strong>Convert to PDF</strong>. Each image becomes one page. The PDF downloads immediately — original image quality is preserved."),
        ],
        "when_title": "When to Convert Images to PDF",
        "scenarios": [
            ("Submitting scanned documents", "Scanned your passport, utility bill, or ID on your phone? Most submission portals only accept PDF. Convert your JPG scans to a single PDF in seconds."),
            ("Combining receipts for expense reports", "Photograph each receipt, then convert all photos to a single multi-page PDF for your expense report or tax filing."),
            ("Sending a photo portfolio", "Convert a set of work samples or product photos to PDF for a client who needs a downloadable presentation rather than a photo album link."),
            ("Archiving physical documents", "Photos of old letters, forms, or pages from a notebook can be combined into a single PDF for long-term digital archiving."),
        ],
        "comparison_feature": "Image quality",
        "competitors": [
            ("PDFree", "Original quality", "No limit", "No upload", "Free forever", True),
            ("iLovePDF", "Good quality", "Daily limit", "Uploaded to servers", "Free / $6+/mo", False),
            ("SmallPDF", "Compressed", "2 tasks/day", "Uploaded to servers", "Free / $9+/mo", False),
            ("Adobe Acrobat", "Original quality", "2/month free", "Uploaded to servers", "$19.99/mo", False),
        ],
        "faqs": [
            ("What image formats can I convert to PDF?", "PDFree supports JPG/JPEG, PNG, and WebP. Each image becomes one page in the output PDF."),
            ("Will the image quality be reduced?", "No. Images are embedded at their original resolution. The PDF page size is set to match the image dimensions, so there is no scaling or re-compression."),
            ("Can I mix JPG and PNG images in one PDF?", "Yes. Add any combination of JPG, PNG, and WebP files. Each becomes a page in the final PDF regardless of format."),
            ("What page size will the PDF use?", "Each page is sized to exactly match its source image's pixel dimensions at 96 DPI. A 2480×3508 image (A4 at 300 DPI) produces a standard A4-sized page."),
            ("Is there a limit on how many images I can convert?", "No. Add as many images as you need. Processing time scales with total image size — dozens of photos may take 10–20 seconds on slower devices."),
            ("Does the tool upload my images anywhere?", "No. All processing happens in your browser using the pdf-lib JavaScript library. Images are loaded into browser memory and never transmitted."),
        ],
        "related": [
            ("/pdf2jpg/", "PDF to JPG", "Reverse: convert PDF pages back to images"),
            ("/compress-pdf/", "Compress PDF", "Reduce the size of the converted PDF if needed"),
            ("/merge-pdf/", "Merge PDF", "Add more pages to the converted PDF"),
        ],
    },

    "pdf2jpg": {
        "h1": "Convert PDF to JPG Online — Export Pages as Images",
        "intro": "Need a PDF page as an image? PDFree renders every page of your PDF as a high-quality JPG at your chosen resolution — entirely in your browser. No upload, no account, no watermarks on the output.",
        "how_title": "How to Convert PDF to JPG in 3 Steps",
        "steps": [
            ("Upload your PDF", "Click <strong>Choose files</strong> or drag your PDF into the drop zone. The file is loaded into browser memory — not sent to any server."),
            ("Choose the output quality", "Select a DPI setting: <strong>72 DPI</strong> (screen/web), <strong>150 DPI</strong> (balanced), or <strong>300 DPI</strong> (print-quality). Higher DPI = sharper images, larger file sizes."),
            ("Convert and download", "Click <strong>Convert to JPG</strong>. Each page is rendered as a separate JPG. Multiple pages download as a ZIP archive."),
        ],
        "when_title": "When to Convert PDF to JPG",
        "scenarios": [
            ("Embedding a page in a website or presentation", "Websites and PowerPoint files work with images, not PDFs. Convert the PDF page you need to a JPG and insert it directly."),
            ("Sharing on social media", "LinkedIn posts, Instagram, and most social platforms don't support PDF. Convert your infographic, certificate, or report page to JPG for direct sharing."),
            ("Creating a page preview thumbnail", "Many document portals show an image thumbnail of the first page. Generate that thumbnail by converting page 1 of your PDF to JPG."),
            ("Editing PDF content in an image editor", "PDFs can't be opened in Photoshop or GIMP directly. Convert to JPG, edit the image, then convert back to PDF with JPG to PDF."),
        ],
        "comparison_feature": "Max output DPI (free)",
        "competitors": [
            ("PDFree", "300 DPI", "No limit", "No upload", "Free forever", True),
            ("iLovePDF", "150 DPI free", "Daily limit", "Uploaded to servers", "Free / $6+/mo", False),
            ("SmallPDF", "150 DPI free", "2 tasks/day", "Uploaded to servers", "Free / $9+/mo", False),
            ("Adobe Acrobat", "300 DPI", "2/month free", "Uploaded to servers", "$19.99/mo", False),
        ],
        "faqs": [
            ("What DPI should I choose?", "72 DPI is fine for websites and screen display. 150 DPI works for most office uses. Choose 300 DPI when you need print-quality output or want to read small text clearly after conversion."),
            ("Does converting a PDF to JPG lose quality?", "Converting to JPG involves some compression. At 300 DPI the quality is very high and barely distinguishable from the original. Text remains readable. For lossless output, PNG is better — contact us if you need PNG support."),
            ("Will a 10-page PDF produce 10 separate JPG files?", "Yes. Each page becomes one JPG. If your PDF has more than one page, the files are bundled into a ZIP archive for download."),
            ("Can I convert specific pages only?", "The current tool converts all pages. To convert only specific pages, first <a href='/split-pdf/' style='color:var(--green)'>split or extract</a> the pages you need into a new PDF, then convert that PDF to JPG."),
            ("Are my PDF files uploaded to a server?", "No. PDFree uses PDF.js (Mozilla's open-source PDF renderer) running entirely in your browser. Pages are rendered locally and exported as JPG files — nothing leaves your device."),
        ],
        "related": [
            ("/jpg2pdf/", "JPG to PDF", "Reverse: convert JPG images back to PDF"),
            ("/split-pdf/", "Split PDF", "Extract specific pages before converting to JPG"),
            ("/compress-pdf/", "Compress PDF", "Reduce PDF size before exporting pages"),
        ],
    },

    "watermark-pdf": {
        "h1": "Add a Watermark to a PDF Online — Text, Opacity, Rotation",
        "intro": "Add a professional watermark to any PDF — DRAFT, CONFIDENTIAL, your company name, or copyright notice — with full control over font size, color, opacity, and rotation. Everything is done locally in your browser.",
        "how_title": "How to Watermark a PDF in 3 Steps",
        "steps": [
            ("Upload your PDF", "Click <strong>Choose files</strong> or drag your PDF into the drop zone. The document stays on your device throughout the process."),
            ("Configure the watermark", "Type your watermark text (e.g. <em>DRAFT</em>, <em>CONFIDENTIAL</em>, your company name). Set font size, color, opacity (10–100%), and rotation angle. Preview updates in real time."),
            ("Apply and download", "Click <strong>Add Watermark</strong>. The watermark is embedded on every page. The watermarked PDF downloads immediately."),
        ],
        "when_title": "When to Add a PDF Watermark",
        "scenarios": [
            ("Mark documents as DRAFT", "Circulating a document for review? Adding a 'DRAFT' watermark makes it clear the content is not final and prevents recipients from treating it as an authoritative version."),
            ("Confidential internal reports", "Adding 'CONFIDENTIAL' or 'INTERNAL USE ONLY' to financial reports, HR documents, or strategic plans before distributing them internally signals handling requirements."),
            ("Copyright protection for creative work", "Photographers, designers, and writers can add a copyright notice or studio name as a watermark before sending proofs to clients, making unauthorized distribution traceable."),
            ("Branding client deliverables", "Consultants and agencies can add their logo name or website as a light watermark to reports and presentations they deliver to clients."),
        ],
        "comparison_feature": "Watermark customization",
        "competitors": [
            ("PDFree", "Text, opacity, rotation, color, size", "No limit", "No upload", "Free forever", True),
            ("iLovePDF", "Text, basic options", "Daily limit", "Uploaded to servers", "Free / $6+/mo", False),
            ("SmallPDF", "Text only (free)", "2 tasks/day", "Uploaded to servers", "Free / $9+/mo", False),
            ("Adobe Acrobat", "Full control", "2/month free", "Uploaded to servers", "$19.99/mo", False),
        ],
        "faqs": [
            ("Can I remove a watermark from a PDF?", "PDFree adds watermarks but does not remove them from existing PDFs. Watermarks added by PDFree are embedded as page content and cannot be automatically removed by basic tools."),
            ("Can I add an image watermark (logo)?", "Currently PDFree supports text watermarks only. Image/logo watermarks are on the roadmap."),
            ("Will the watermark appear on every page?", "Yes. The watermark is applied to all pages of the PDF by default."),
            ("What does opacity control?", "Opacity of 100% makes the watermark fully opaque (solid, dark). Opacity of 20–30% creates the classic 'ghost' watermark that is visible but doesn't obscure the content underneath. Most use cases work well at 20–40%."),
            ("Can I set the watermark color?", "Yes. You can set any hex color or choose from common presets. Light grey (#CCCCCC at 30% opacity) gives a professional, unobtrusive result."),
        ],
        "related": [
            ("/protect-pdf/", "Protect PDF", "Add a password after watermarking for extra security"),
            ("/redact-pdf/", "Redact PDF", "Permanently cover content instead of marking it"),
            ("/metadata-pdf/", "Edit Metadata", "Remove author metadata before distributing"),
        ],
    },

    "protect-pdf": {
        "h1": "Password Protect a PDF Online — Encrypt Without Uploading",
        "intro": "Add 256-bit AES encryption to any PDF with a password of your choice. The encryption happens entirely in your browser — your password and your document are never sent to any server, not even PDFree's.",
        "how_title": "How to Password Protect a PDF in 3 Steps",
        "steps": [
            ("Upload your PDF", "Click <strong>Choose files</strong> or drag your PDF into the drop zone. The file is loaded into browser memory only."),
            ("Set a strong password", "Type the password you want to use. The stronger the password (12+ characters, mixed case, numbers, symbols), the harder it is to brute-force. The password never leaves your device."),
            ("Protect and download", "Click <strong>Protect PDF</strong>. The encrypted PDF is generated in your browser and downloaded immediately. Share it with confidence — only someone with the password can open it."),
        ],
        "when_title": "When to Password Protect a PDF",
        "scenarios": [
            ("Contracts and legal agreements", "Before emailing a signed contract to a counterparty, add password protection. Share the password by phone or a separate channel to prevent anyone who intercepts the email from reading it."),
            ("Financial statements and tax documents", "Bank statements, tax returns, and payslips contain sensitive personal data. Encrypt them before storing in cloud folders shared with others or sending to accountants."),
            ("Medical and HR records", "Patient records, performance reviews, and HR documents should be restricted to authorized readers. Password encryption adds a layer of access control."),
            ("Sensitive personal documents", "Passport scans, ID copies, and birth certificates are prime targets for identity theft. Encrypt before storing in cloud storage or sending by email."),
        ],
        "comparison_feature": "Encryption standard",
        "competitors": [
            ("PDFree", "256-bit AES", "No limit", "No upload — key stays on device", "Free forever", True),
            ("iLovePDF", "128-bit or 256-bit", "Daily limit", "Uploaded to servers", "Free / $6+/mo", False),
            ("SmallPDF", "Not specified", "2 tasks/day", "Uploaded to servers", "Free / $9+/mo", False),
            ("Adobe Acrobat", "256-bit AES", "2/month free", "Uploaded to servers", "$19.99/mo", False),
        ],
        "faqs": [
            ("What encryption does PDFree use?", "PDFree uses 256-bit AES encryption, the same standard used by banks and government agencies. It is the highest level of PDF encryption defined in the PDF specification (PDF 2.0 / PDF 1.7)."),
            ("Can I remove the password from a protected PDF?", "Yes — upload the encrypted PDF, enter the current password, leave the new password field empty, and save. This produces an unprotected version of the file."),
            ("Will the password-protected PDF open in Adobe Reader?", "Yes. PDFree produces standard-compliant encrypted PDFs that open in Adobe Acrobat, Adobe Reader, macOS Preview, and all modern PDF viewers."),
            ("Is it safe to set the password on PDFree's website?", "Yes. The entire encryption process runs in your browser using pdf-lib. Your password and document are never transmitted to any server — PDFree literally cannot see them."),
            ("Can I set different passwords for opening and editing?", "Currently PDFree sets an owner password that restricts opening the document. Separate user/owner permissions (controlling printing, copying, editing) are on the roadmap."),
        ],
        "related": [
            ("/watermark-pdf/", "Watermark PDF", "Add a visible 'CONFIDENTIAL' stamp before encrypting"),
            ("/redact-pdf/", "Redact PDF", "Permanently remove sensitive content before sharing"),
            ("/metadata-pdf/", "Edit Metadata", "Remove author/creator metadata before protecting"),
        ],
    },

    "redact-pdf": {
        "h1": "Redact a PDF Online — Permanently Remove Sensitive Content",
        "intro": "Draw black boxes over names, account numbers, addresses, or any sensitive information and download a PDF where that content is permanently gone — not just covered with a colored overlay, but removed. Done entirely in your browser.",
        "how_title": "How to Redact a PDF in 3 Steps",
        "steps": [
            ("Upload your PDF", "Click <strong>Choose files</strong> or drag your PDF into the drop zone. Pages render as thumbnails in your browser — nothing is sent to a server."),
            ("Draw redaction boxes", "Click and drag to draw black cover boxes over the content you want to remove — names, addresses, account numbers, phone numbers, or any text or image you need to hide."),
            ("Apply and download", "Click <strong>Apply Redaction</strong>. The boxes are burned into the PDF — the underlying content is replaced, not just covered. Download the redacted file."),
        ],
        "when_title": "When to Redact a PDF",
        "scenarios": [
            ("FOIA and public records requests", "When responding to Freedom of Information requests, redact personally identifiable information (names, SSNs, addresses) from documents before releasing them publicly."),
            ("Legal discovery and court filings", "Courts require redaction of minors' names, Social Security numbers, financial account numbers, and home addresses before filing documents on public dockets."),
            ("Sharing medical records", "Hospitals and clinics often need to share patient records while protecting other patients' or staff members' information that appears on the same page."),
            ("Vendor contracts before distribution", "Remove pricing terms, discount structures, or proprietary rates from contracts before sharing with parties who shouldn't see those terms."),
        ],
        "comparison_feature": "Redaction method",
        "competitors": [
            ("PDFree", "Permanent replacement", "No limit", "No upload", "Free forever", True),
            ("iLovePDF", "Black overlay", "Daily limit", "Uploaded to servers", "Free / $6+/mo", False),
            ("SmallPDF", "Not available free", "—", "Uploaded to servers", "Paid only", False),
            ("Adobe Acrobat", "True redaction", "2/month free", "Uploaded to servers", "$19.99/mo", False),
        ],
        "faqs": [
            ("Is the redaction permanent?", "Yes. PDFree replaces the content under the redaction boxes with a black rectangle at the PDF object level. The original text or image data is not stored elsewhere in the file and cannot be recovered."),
            ("What is the difference between redaction and a black rectangle overlay?", "Some tools draw a black image on top of text but leave the original text accessible in the PDF's underlying data. PDFree removes the content — a security reviewer who extracts the PDF's text stream would find nothing under the redaction box."),
            ("Can I redact multiple pages at once?", "Yes. Navigate between pages using the page buttons and draw boxes on any page. All boxes are applied when you click 'Apply Redaction'."),
            ("Can I undo a redaction after downloading?", "No. Redaction is a one-way operation — that is what makes it secure. If you need to undo, work from the original unredacted file. Keep the original in a secure location until the redacted version is verified correct."),
            ("Does PDFree redact text search content too?", "Yes. The redaction removes the PDF content stream data for the covered area, including any searchable text within the box bounds."),
        ],
        "related": [
            ("/watermark-pdf/", "Watermark PDF", "Add CONFIDENTIAL mark to the redacted document"),
            ("/protect-pdf/", "Protect PDF", "Encrypt the redacted PDF before sharing"),
            ("/metadata-pdf/", "Edit Metadata", "Remove author/creator info before distributing"),
        ],
    },

    "rotate-pdf": {
        "h1": "Rotate PDF Pages Online — Fix Orientation in Seconds",
        "intro": "Pages scanned sideways, mobile photos rotated 90°, or a mixed-orientation document that needs standardizing — PDFree rotates all pages or individual pages to any angle, locally, without uploading.",
        "how_title": "How to Rotate PDF Pages in 3 Steps",
        "steps": [
            ("Upload your PDF", "Click <strong>Choose files</strong> or drag your PDF into the drop zone. Page thumbnails load in your browser."),
            ("Choose rotation", "Select 90° clockwise, 90° counter-clockwise, or 180°. Apply to <strong>all pages</strong> at once, or click individual page thumbnails to rotate only specific pages."),
            ("Save and download", "Click <strong>Rotate PDF</strong>. The corrected PDF downloads instantly — page content, text, and images are unchanged, only the orientation is updated."),
        ],
        "when_title": "When to Rotate PDF Pages",
        "scenarios": [
            ("Scanned documents came out sideways", "Flatbed scanners sometimes feed pages at 90° if the paper is loaded incorrectly. Rotate all pages at once to correct the entire batch."),
            ("Mobile camera scans", "Scanning with your phone in landscape mode produces portrait pages stored sideways. Rotate to fix orientation before sending."),
            ("Mixed-orientation documents", "Some PDFs mix portrait and landscape pages (e.g., a report with landscape-format tables). Rotate individual pages so all pages read naturally."),
            ("Wrong orientation from a PDF export", "Software like Excel or PowerPoint sometimes exports PDF pages in the wrong orientation. Rotate to correct before distributing."),
        ],
        "comparison_feature": "Per-page rotation",
        "competitors": [
            ("PDFree", "All pages or per-page", "No limit", "No upload", "Free forever", True),
            ("iLovePDF", "All pages only (free)", "Daily limit", "Uploaded to servers", "Free / $6+/mo", False),
            ("SmallPDF", "All pages only", "2 tasks/day", "Uploaded to servers", "Free / $9+/mo", False),
            ("Adobe Acrobat", "Per-page control", "2/month free", "Uploaded to servers", "$19.99/mo", False),
        ],
        "faqs": [
            ("Can I rotate only specific pages, not all of them?", "Yes. Click individual page thumbnails to select which pages to rotate. Unselected pages remain in their original orientation. You can also use Select All / Deselect All for quick batch selection."),
            ("Does rotating a PDF reduce image quality?", "No. Rotation is a metadata change in the PDF file. The page content (images, text, vector graphics) is not re-rendered or recompressed. The file size barely changes."),
            ("What rotation angles are available?", "90° clockwise, 90° counter-clockwise (equivalent to 270° clockwise), and 180°. These cover all standard orientation corrections."),
            ("Can I rotate a PDF on my iPhone or Android phone?", "Yes. PDFree works in mobile Safari (iOS) and Chrome for Android. Use the file picker to select your PDF and apply rotation — the result downloads to your device."),
            ("Does rotating preserve hyperlinks and bookmarks?", "Yes. Rotation only changes the page orientation flag in the PDF. All interactive elements (links, bookmarks, form fields) are preserved intact."),
        ],
        "related": [
            ("/split-pdf/", "Split PDF", "Extract specific pages after correcting orientation"),
            ("/merge-pdf/", "Merge PDF", "Combine rotated pages with other documents"),
            ("/compress-pdf/", "Compress PDF", "Reduce file size after rotating many pages"),
        ],
    },

    "metadata-pdf": {
        "h1": "Edit PDF Metadata Online — Remove Author, Fix Title, Clear Data",
        "intro": "Every PDF contains hidden metadata — the author's name, the software used to create it, the creation date, and sometimes the company name. PDFree lets you view and edit all of it privately, without uploading the file.",
        "how_title": "How to Edit PDF Metadata in 3 Steps",
        "steps": [
            ("Upload your PDF", "Click <strong>Choose files</strong> or drag your PDF into the drop zone. The current metadata fields are read and displayed immediately."),
            ("Edit or clear the fields", "Update the <strong>Title</strong>, <strong>Author</strong>, <strong>Subject</strong>, <strong>Keywords</strong>, and <strong>Creator</strong> fields. To remove a field entirely, clear the text — it will be omitted from the output PDF."),
            ("Save and download", "Click <strong>Save Metadata</strong>. The updated PDF downloads with the new metadata embedded. The file content (pages, images, text) is unchanged."),
        ],
        "when_title": "When to Edit PDF Metadata",
        "scenarios": [
            ("Remove the author name before sharing externally", "A PDF created on your work computer may embed your full name and company. Clear the Author field before sending to external parties or publishing publicly."),
            ("Fix incorrect title in document properties", "Reports exported from Word or Excel often carry the wrong title in metadata. Fix it so the correct title appears in PDF readers' title bar and search indexes."),
            ("Clear creation date from confidential documents", "The creation date in metadata can reveal when a document was drafted. Remove it before submitting documents where the creation timeline is sensitive."),
            ("Anonymize documents before publishing", "Academic papers, government documents, or reports submitted for blind review should not contain the author's name or institution in the metadata."),
        ],
        "comparison_feature": "Fields editable (free)",
        "competitors": [
            ("PDFree", "Title, Author, Subject, Keywords, Creator", "No limit", "No upload", "Free forever", True),
            ("iLovePDF", "Not available", "—", "—", "—", False),
            ("SmallPDF", "Not available", "—", "—", "—", False),
            ("Adobe Acrobat", "Full metadata editor", "Paid only", "Uploaded to servers", "$19.99/mo", False),
        ],
        "faqs": [
            ("What metadata fields does PDFree show and edit?", "PDFree reads and writes the standard PDF document information dictionary: Title, Author, Subject, Keywords, Creator (application that created the PDF), and Producer (PDF library used). Modification date is updated automatically on save."),
            ("Does editing metadata change the PDF content or appearance?", "No. Metadata is stored separately from page content. Editing or clearing metadata fields has zero effect on text, images, layout, or any visible element of the document."),
            ("Can I see all the metadata currently in my PDF?", "Yes. When you upload a PDF, PDFree reads and displays all existing metadata values in the form fields. Empty fields mean that data is not present in the file."),
            ("Does removing metadata reduce file size?", "Slightly — metadata is a small part of the PDF structure. The size reduction is negligible for most files but may be a few kilobytes."),
            ("Is there metadata that PDFree cannot edit?", "Yes. XMP metadata packets (extended metadata embedded by some Adobe products) and custom application-specific metadata may not be editable. PDFree edits the standard PDF info dictionary which covers the most common fields."),
        ],
        "related": [
            ("/protect-pdf/", "Protect PDF", "Encrypt the document after cleaning metadata"),
            ("/redact-pdf/", "Redact PDF", "Remove visible sensitive content, not just metadata"),
            ("/watermark-pdf/", "Watermark PDF", "Add branding before distributing the cleaned PDF"),
        ],
    },

    "pagenum-pdf": {
        "h1": "Add Page Numbers to a PDF Online — Custom Format and Position",
        "intro": "Professional documents need page numbers — but not every PDF exporter adds them, and not every format is right for every document type. PDFree lets you add Arabic, Roman, or alphabetic page numbers to any PDF, with full control over position, starting number, and which pages to number.",
        "how_title": "How to Add Page Numbers to a PDF in 3 Steps",
        "steps": [
            ("Upload your PDF", "Click <strong>Choose files</strong> or drag your PDF into the drop zone. The page count is read automatically."),
            ("Configure the numbering", "Choose <strong>format</strong> (1, 2, 3 / i, ii, iii / A, B, C), <strong>position</strong> (bottom center, bottom right, top center, top right), <strong>starting number</strong>, and optionally skip the first page (for cover pages)."),
            ("Apply and download", "Click <strong>Add Page Numbers</strong>. Numbers are embedded as clean text on each page. The PDF downloads immediately."),
        ],
        "when_title": "When to Add Page Numbers to a PDF",
        "scenarios": [
            ("Academic papers and thesis documents", "Universities and journals require numbered pages for reference. If your Word-to-PDF export missed page numbers or numbered from the wrong page, fix it in PDFree."),
            ("Business reports and proposals", "A 30-page proposal without page numbers is unprofessional and hard to navigate in a meeting. Add numbers to the bottom center of every page in seconds."),
            ("Legal documents and contracts", "Contracts often reference specific page numbers ('see page 7, clause 3'). Adding page numbers ensures those references are meaningful and consistent."),
            ("Manuals and instruction documents", "Multi-section manuals benefit from numbering that starts at 1 for each section. Use different formats (1, 2, 3 for body; A, B, C for appendices) on merged documents."),
        ],
        "comparison_feature": "Number formats",
        "competitors": [
            ("PDFree", "Arabic, Roman, Alphabetic + custom start", "No limit", "No upload", "Free forever", True),
            ("iLovePDF", "Arabic only (free)", "Daily limit", "Uploaded to servers", "Free / $6+/mo", False),
            ("SmallPDF", "Not available free", "—", "Uploaded to servers", "Paid only", False),
            ("Adobe Acrobat", "Full control", "Paid only", "Uploaded to servers", "$19.99/mo", False),
        ],
        "faqs": [
            ("Can I start page numbering from a number other than 1?", "Yes. Set any starting number in the 'Start at' field. This is useful for documents where a cover page is page 0, or for chapters that continue numbering from a previous section."),
            ("Can I skip the first page (cover page) from numbering?", "Yes. Enable the 'Skip first page' option. Page 1 (the cover) receives no number, and numbering starts from the second page."),
            ("What number formats are available?", "Arabic numerals (1, 2, 3), lowercase Roman numerals (i, ii, iii), uppercase Roman (I, II, III), lowercase alphabetic (a, b, c), and uppercase alphabetic (A, B, C)."),
            ("Will adding page numbers change the existing content?", "No. Page numbers are added as a new text layer on top of the existing content. The original text, images, and layout underneath are unchanged."),
            ("Can I choose where the page numbers appear?", "Yes. Position options include: bottom center, bottom left, bottom right, top center, top left, and top right."),
        ],
        "related": [
            ("/merge-pdf/", "Merge PDF", "Add page numbers after merging multiple documents"),
            ("/split-pdf/", "Split PDF", "Split a numbered document back into sections"),
            ("/protect-pdf/", "Protect PDF", "Lock the numbered document before distributing"),
        ],
    },

    "extract-pdf": {
        "h1": "Extract Pages from a PDF Online — Save Specific Pages",
        "intro": "Need just pages 3–7 of a 90-page report? PDFree extracts any page range you specify and saves them as a new PDF — without uploading the original file to any server.",
        "how_title": "How to Extract PDF Pages in 3 Steps",
        "steps": [
            ("Upload your PDF", "Click <strong>Choose files</strong> or drag your PDF into the drop zone. The total page count is shown — nothing is uploaded."),
            ("Enter the pages to extract", "Type the pages or ranges you want: <strong>3-7, 12, 15-20</strong>. Or click individual page thumbnails to select visually. Non-selected pages are discarded."),
            ("Extract and download", "Click <strong>Extract Pages</strong>. The selected pages are saved as a new PDF and downloaded immediately. The original file is untouched."),
        ],
        "when_title": "When to Extract PDF Pages",
        "scenarios": [
            ("Save a specific section from a long report", "A 90-page annual report contains the financial tables you need on pages 44–52. Extract those 9 pages into a standalone PDF to share with your finance team."),
            ("Pull out exhibit pages for legal filing", "Legal submissions may need specific exhibits as separate attachments. Extract each exhibit into its own PDF from the full case file."),
            ("Create a portfolio from a larger document", "A design portfolio or photography book in PDF form can have individual project pages extracted as separate showcase files."),
            ("Remove a problematic page before sharing", "A form that ends with a blank page or a misprint can be fixed by extracting all pages except the problematic one into a clean new PDF."),
        ],
        "comparison_feature": "Page selection",
        "competitors": [
            ("PDFree", "Range input + visual click", "No limit", "No upload", "Free forever", True),
            ("iLovePDF", "Range input", "Daily limit", "Uploaded to servers", "Free / $6+/mo", False),
            ("SmallPDF", "Range input", "2 tasks/day", "Uploaded to servers", "Free / $9+/mo", False),
            ("Adobe Acrobat", "Full page panel", "2/month free", "Uploaded to servers", "$19.99/mo", False),
        ],
        "faqs": [
            ("What is the page range format?", "Enter pages and ranges separated by commas: <code>1, 3-7, 12, 15-20</code>. Spaces are optional. Ranges are inclusive — <code>3-7</code> extracts pages 3, 4, 5, 6, and 7."),
            ("What is the difference between Extract and Split?", "<a href='/split-pdf/' style='color:var(--green)'>Split</a> has richer selection options (odd pages, even pages, halves, visual thumbnail selection) and can produce multiple separate files. Extract is simpler — enter a range, get one PDF. Use whichever fits your workflow."),
            ("Will the extracted pages preserve formatting exactly?", "Yes. Pages are copied at the PDF object level — fonts, images, links, and formatting are identical to the originals."),
            ("Can I extract pages from a password-protected PDF?", "No. Encrypted PDFs cannot be modified without the password. Remove the password first, then extract the pages."),
            ("Is there a limit on how many pages I can extract?", "No. You can extract any number of pages from a PDF of any size, as long as your browser has enough memory to hold the file."),
        ],
        "related": [
            ("/split-pdf/", "Split PDF", "More selection options — odd/even pages, multiple output files"),
            ("/merge-pdf/", "Merge PDF", "Combine extracted pages with other documents"),
            ("/compress-pdf/", "Compress PDF", "Reduce file size after extracting image-heavy pages"),
        ],
    },
}


# ─────────────────────────────────────────────────────────────────────────────
# HTML builder
# ─────────────────────────────────────────────────────────────────────────────

def build_seo_section(tool_id, d):
    # Steps HTML
    steps_html = ""
    for i, (title, text) in enumerate(d["steps"], 1):
        steps_html += f"""
        <div style="display:flex;gap:16px;align-items:flex-start;margin-bottom:24px;">
          <div style="background:var(--green);color:#fff;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0;">{i}</div>
          <div>
            <strong style="color:var(--text);font-size:15px;">{title}</strong>
            <p style="margin:6px 0 0;font-size:14px;">{text}</p>
          </div>
        </div>"""

    # Scenarios HTML
    scenarios_html = ""
    for title, text in d["scenarios"]:
        scenarios_html += f"""
        <div style="border-left:3px solid var(--green);padding:12px 16px;margin-bottom:16px;background:var(--surface);">
          <strong style="color:var(--text);font-size:15px;">{title}</strong>
          <p style="margin:6px 0 0;font-size:14px;">{text}</p>
        </div>"""

    # Competitor comparison table
    comp_rows = ""
    for name, feat, daily, privacy, price, is_us in d["competitors"]:
        row_bg = "background:var(--green-light);" if is_us else ""
        name_style = "color:var(--green);font-weight:700;" if is_us else "color:var(--text);"
        feat_style = "color:var(--green);font-weight:700;" if is_us else "color:var(--text2);"
        privacy_style = "color:var(--green);font-weight:600;" if is_us else "color:#b45309;"
        comp_rows += f"""
              <tr style="border-bottom:1px solid var(--border);{row_bg}">
                <td style="padding:10px 14px;{name_style}">{name}</td>
                <td style="text-align:center;padding:10px 14px;{feat_style}">{feat}</td>
                <td style="text-align:center;padding:10px 14px;color:var(--text2);">{daily}</td>
                <td style="text-align:center;padding:10px 14px;{privacy_style}">{privacy}</td>
                <td style="text-align:center;padding:10px 14px;color:var(--text2);">{price}</td>
              </tr>"""

    # FAQ HTML
    faqs_html = ""
    for i, (q, a) in enumerate(d["faqs"]):
        border = "border-bottom:1px solid var(--border);padding-bottom:20px;" if i < len(d["faqs"]) - 1 else ""
        faqs_html += f"""
        <div style="{border}margin-bottom:20px;">
          <h3 style="font-size:16px;color:var(--text);margin:0 0 8px;font-weight:600;">{q}</h3>
          <p style="margin:0;font-size:14px;">{a}</p>
        </div>"""

    # Related links HTML
    related_html = ""
    for href, label, desc in d["related"]:
        related_html += f"""
        <li><a href="{href}" style="color:var(--green);font-weight:500;">{label}</a> — {desc}</li>"""

    return f"""  <section class="seo-article" aria-labelledby="seoH1_{tool_id}">
    <div class="seo-article__inner">
      <div class="seo-content" style="max-width:800px;margin:60px auto 40px;padding:0 24px;color:var(--text2);line-height:1.75;">

        <h1 id="seoH1_{tool_id}" style="font-size:clamp(22px,3.5vw,30px);color:var(--text);margin:0 0 16px;font-weight:700;">{d["h1"]}</h1>
        <p style="font-size:15px;margin:0 0 40px;">{d["intro"]}</p>

        <!-- How to use -->
        <h2 style="font-size:22px;color:var(--text);margin:0 0 20px;font-weight:700;">{d["how_title"]}</h2>
        {steps_html}

        <!-- When to use -->
        <h2 style="font-size:22px;color:var(--text);margin:40px 0 16px;font-weight:700;">{d["when_title"]}</h2>
        {scenarios_html}

        <!-- Comparison table -->
        <h2 style="font-size:22px;color:var(--text);margin:48px 0 16px;font-weight:700;">PDFree vs Competitors</h2>
        <div style="overflow-x:auto;margin:0 0 32px;">
          <table style="width:100%;border-collapse:collapse;font-size:14px;min-width:520px;">
            <thead>
              <tr style="border-bottom:2px solid var(--border);">
                <th style="text-align:left;padding:10px 14px;color:var(--text);font-weight:600;">Tool</th>
                <th style="text-align:center;padding:10px 14px;color:var(--text);font-weight:600;">{d["comparison_feature"]}</th>
                <th style="text-align:center;padding:10px 14px;color:var(--text);font-weight:600;">Daily limit</th>
                <th style="text-align:center;padding:10px 14px;color:var(--text);font-weight:600;">Privacy</th>
                <th style="text-align:center;padding:10px 14px;color:var(--text);font-weight:600;">Price</th>
              </tr>
            </thead>
            <tbody>{comp_rows}
            </tbody>
          </table>
        </div>

        <!-- FAQ -->
        <h2 style="font-size:22px;color:var(--text);margin:48px 0 20px;font-weight:700;">Frequently Asked Questions</h2>
        {faqs_html}

        <!-- Related tools -->
        <h2 style="font-size:22px;color:var(--text);margin:48px 0 12px;font-weight:700;">Related Tools</h2>
        <ul style="margin:0 0 40px;padding-left:24px;display:flex;flex-direction:column;gap:8px;">
          {related_html}
        </ul>

      </div>
    </div>
  </section>"""


# ─────────────────────────────────────────────────────────────────────────────
# File updater — replace <section class="seo-article"...>...</section>
# ─────────────────────────────────────────────────────────────────────────────

def replace_seo_section(html: str, new_section: str) -> tuple[str, bool]:
    """Find and replace the seo-article section. Returns (new_html, changed)."""
    start_marker = '<section class="seo-article"'
    start = html.find(start_marker)
    if start == -1:
        return html, False

    # Walk forward counting <section> / </section> to find the matching close
    depth = 0
    i = start
    end = -1
    while i < len(html):
        if html[i:i+8] == '<section':
            depth += 1
            i += 8
        elif html[i:i+10] == '</section>':
            depth -= 1
            if depth == 0:
                end = i + 10  # include the </section>
                break
            i += 10
        else:
            i += 1

    if end == -1:
        return html, False

    new_html = html[:start] + new_section + html[end:]
    return new_html, True


def main():
    updated = 0
    skipped = 0
    for tool_id, data in TOOLS.items():
        path = BASE / tool_id / "index.html"
        if not path.exists():
            print(f"  SKIP (no file): {tool_id}/")
            skipped += 1
            continue

        html = path.read_text(encoding="utf-8")
        new_section = build_seo_section(tool_id, data)
        new_html, changed = replace_seo_section(html, new_section)

        if not changed:
            print(f"  WARN (seo-article not found): {tool_id}/")
            skipped += 1
            continue

        path.write_text(new_html, encoding="utf-8")
        print(f"  OK: {tool_id}/")
        updated += 1

    print(f"\nDone: {updated} pages updated, {skipped} skipped.")


if __name__ == "__main__":
    main()
