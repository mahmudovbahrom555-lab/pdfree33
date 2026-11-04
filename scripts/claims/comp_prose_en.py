#!/usr/bin/env python3
"""English prose: competitor names -> 'cloud PDF tools' / 'other tools'; competitor-specific numbers dropped."""
import re, json, subprocess, sys
R = [
 # OCR blog
 ('Most cloud-based tools (Smallpdf, Sejda) limit free OCR', 'Most cloud-based tools limit free OCR'),
 ("Adobe Acrobat, Smallpdf, and PDF24's web version all require uploading the file to their servers to run OCR, even on their free tiers.", 'Cloud OCR services require uploading the file to their servers to run OCR, even on their free tiers.'),
 ('Most free and paid OCR services — including the OCR features built into Adobe Acrobat, Smallpdf, and PDF24\'s web tools — process your document on their own servers.', 'Most free and paid online OCR services process your document on their own servers.'),
 # compress / merge / word blogs
 ('cloud-based PDF compressors (iLovePDF, Smallpdf, Adobe Compress online) receive', 'cloud-based PDF compressors receive'),
 ("Cloud-based converters like iLovePDF, Smallpdf, or Adobe's online tools upload", 'Cloud-based converters upload'),
 ('Cloud-based PDF mergers (iLovePDF, Smallpdf, Adobe online) upload', 'Cloud-based PDF mergers upload'),
 # fill blog
 ('How to Fill a PDF Form Without Adobe', 'How to Fill a PDF Form Without Paid Software'),
 ('How to fill a PDF form without Adobe', 'How to fill a PDF form without paid software'),
 ('without Adobe Acrobat or any installed software', 'without paid or installed software'),
 ('for free without Adobe Acrobat.', 'for free, without paid software.'),
 ('Adobe Acrobat costs $20–$25/month just to fill and save PDF forms.', 'Paid PDF editors charge a monthly subscription just to fill and save PDF forms.'),
 ("Why Adobe isn't necessary for filling forms", "Why paid software isn't necessary for filling forms"),
 ('Adobe Reader (the free version) can only fill interactive PDF forms', 'Free PDF readers can usually fill only interactive PDF forms'),
 ('Adobe Reader offers nothing.', 'a free reader usually offers nothing.'),
 # sign blog
 ('without DocuSign, Adobe Sign, or any account', 'without an e-signature subscription or any account'),
 ('DocuSign charges $15/month.', 'E-signature services charge a monthly subscription.'),
 ('Adobe Sign requires an Adobe account.', 'Most of them require an account.'),
 ('HelloSign requires a subscription for more than 3 documents.', 'Free plans are limited to a few documents.'),
 ('DocuSign, Adobe Sign, HelloSign, and SignNow all require sign-up, and most hit a paywall after a few free documents per month.', 'E-signature services require sign-up, and most hit a paywall after a few free documents per month.'),
 ('just like any PDF from DocuSign.', 'just like any other signed PDF.'),
 ('Privacy: why PDFree is safer than DocuSign for sensitive contracts', 'Privacy: your contract is not uploaded'),
 ('When you sign with DocuSign or Adobe Sign, your document is uploaded to their cloud.', 'When you sign with an e-signature service, your document is uploaded to their cloud.'),
 ('Why sign with PDFree instead of DocuSign or Adobe?', 'Why sign with PDFree instead of an e-signature service?'),
 # blog index + benchmark headline
 ('PDF to Markdown for AI &amp; RAG — Real Benchmark vs pymupdf4llm, Docling, and Marker', 'PDF to Markdown for AI &amp; RAG — Real Benchmark vs Three Open-Source Converters'),
 ('PDF to Markdown for AI & RAG — Real Benchmark vs pymupdf4llm, Docling, and Marker', 'PDF to Markdown for AI & RAG — Real Benchmark vs Three Open-Source Converters'),
 ('PDF to Markdown for AI &amp; RAG — Real Benchmark vs pymupdf4llm, Docling, Marker', 'PDF to Markdown for AI &amp; RAG — Real Benchmark vs Three Open-Source Converters'),
 ('PDF to Markdown for AI & RAG — Real Benchmark vs pymupdf4llm, Docling, Marker', 'PDF to Markdown for AI & RAG — Real Benchmark vs Three Open-Source Converters'),
 ('Works without Adobe Acrobat, no upload required.', 'Works without paid software, no upload required.'),
 ('PDFree vs Adobe Acrobat, Smallpdf, PDF24, and more — compared on price, upload requirements, and daily limits.', 'PDFree vs typical cloud PDF tools — compared on price, upload requirements, and daily limits.'),
 ('We benchmarked the actual output quality against pymupdf4llm, Docling, and Marker on 7 real documents — 91.6/100, within 1.1 points of Docling.', 'We benchmarked the actual output quality against three widely-used open-source converters on 7 real documents — 91.6/100, within 1.1 points of the best-matching one.'),
 # "without Adobe Acrobat" on tool pages
 ('Can I compare PDFs on iPhone or Mac without Adobe Acrobat?', 'Can I compare PDFs on iPhone or Mac without installing an app?'),
 ('no app download or Adobe Acrobat required', 'no app download or paid software required'),
 ('no upload, no account, no Adobe Acrobat required', 'no upload, no account, no paid software required'),
 ('Can I annotate a PDF without installing Adobe Acrobat?', 'Can I annotate a PDF without installing software?'),
 ('Can I annotate PDF without installing Adobe Acrobat?', 'Can I annotate PDF without installing software?'),
 ('no software installation, no account, no Adobe Acrobat required', 'no software installation, no account, no paid software required'),
 ('Annotate any PDF directly in your browser — no Adobe Acrobat, no software to install, no upload.', 'Annotate any PDF directly in your browser — no paid software, nothing to install, no upload.'),
 ('without installing Adobe Acrobat or any software', 'without installing any software'),
 ('This tool adds one, without needing Acrobat or any desktop software.', 'This tool adds one, without needing desktop software.'),
 # fill FAQ (en content)
 ("How is this different from Adobe's free Fill &amp; Sign?", 'How is this different from free cloud fill-and-sign services?'),
 ("How is this different from Adobe's free Fill & Sign?", 'How is this different from free cloud fill-and-sign services?'),
 ("Adobe's Fill &amp; Sign is free to use for filling and signing your own PDF, but it requires a free Adobe account and uploads your file to Adobe's servers.", 'Free cloud fill-and-sign services usually require an account and upload your file to their servers.'),
 ("Adobe's Fill & Sign is free to use for filling and signing your own PDF, but it requires a free Adobe account and uploads your file to Adobe's servers.", 'Free cloud fill-and-sign services usually require an account and upload your file to their servers.'),
 (" (Adobe's 2-per-month limit only applies if you're sending a document to someone else for their signature, not to filling one yourself.)", ''),
 # resize
 ("Free-tier competitors that offer a similar resize feature typically cap it — Sejda's resize tool, for example, is limited to 3 tasks per hour and 200 pages or 50MB on its free tier.", 'Cloud tools that offer a similar resize feature often cap it on their free tier — by tasks per hour, pages or file size.'),
 # large-file pages: limits
 ('Why does iLovePDF have a 25MB limit for free compression?', 'Why do cloud tools limit file size for free compression?'),
 ('Why does iLovePDF cap free compression at 25MB but PDFree doesn\'t?', 'Why do cloud tools cap free compression but PDFree doesn\'t?'),
 ('iLovePDF compresses files on its servers, which means bandwidth and storage costs.', 'Cloud tools compress files on their servers, which means bandwidth and storage costs.'),
 ('iLovePDF processes files on their servers, creating real bandwidth and compute costs.', 'Cloud tools process files on their servers, creating real bandwidth and compute costs.'),
 ('Unlike SmallPDF (2 tasks per day on the free plan) or iLovePDF (daily limits on free accounts), PDFree lets you', 'Unlike cloud tools with daily limits on their free plans, PDFree lets you'),
 ('Unlike SmallPDF (2 tasks/day free) or iLovePDF (daily limits), PDFree has no daily cap.', 'Unlike cloud tools with daily limits on free plans, PDFree has no daily cap.'),
 ('Unlike SmallPDF (2 tasks/day) or iLovePDF (daily limits), PDFree has no usage restrictions.', 'Unlike cloud tools with daily limits, PDFree has no usage restrictions.'),
 ('Unlike SmallPDF (2 tasks/day free) or iLovePDF (daily limits), PDFree', 'Unlike cloud tools with daily limits on free plans, PDFree'),
 ('Unlike SmallPDF (2/day) or iLovePDF (daily cap), PDFree is unlimited.', 'Unlike cloud tools with daily caps, PDFree is unlimited.'),
 ('Unlike SmallPDF (2 tasks/day on the free plan) or iLovePDF (daily limits), PDFree lets you', 'Unlike cloud tools with daily limits on their free plans, PDFree lets you'),
 ('Why does iLovePDF have a 25MB file size limit?', 'Why do cloud tools have a file size limit?'),
 ('Why does iLovePDF have a 25MB limit but PDFree doesn\'t?', 'Why do cloud tools have a size limit but PDFree doesn\'t?'),
 ('iLovePDF processes files on its servers, which means bandwidth and storage costs.', 'Cloud tools process files on their servers, which means bandwidth and storage costs.'),
 ('iLovePDF processes files on their servers, which creates bandwidth and storage costs.', 'Cloud tools process files on their servers, which creates bandwidth and storage costs.'),
 ('Why is merging large PDFs slow on iLovePDF but fast on PDFree?', 'Why is merging large PDFs slow on cloud tools but fast on PDFree?'),
 ('iLovePDF requires uploading your file to their server, processing it there, and downloading the result', 'Cloud tools require uploading your file to their server, processing it there, and downloading the result'),
 ('Why does iLovePDF have a file size limit for splitting?', 'Why do cloud tools have a file size limit for splitting?'),
 ('iLovePDF uploads your file to their servers, which creates bandwidth costs.', 'Cloud tools upload your file to their servers, which creates bandwidth costs.'),
 ('To control those costs on free plans, tools like iLovePDF cap uploads at around 25MB and SmallPDF limits you to 2 tasks per day.', 'To control those costs on free plans, cloud tools cap upload size or the number of tasks per day.'),
 # merge/secure without upload
 ('How is PDFree different from iLovePDF or SmallPDF?', 'How is PDFree different from cloud PDF tools?'),
 ('How is this different from iLovePDF or SmallPDF?', 'How is this different from cloud PDF tools?'),
 ('iLovePDF and SmallPDF upload your files to their servers for processing and delete them after 1-2 hours.', 'Cloud PDF tools upload your files to their servers for processing and delete them later; how long they keep them varies.'),
 ('iLovePDF and SmallPDF upload your files to their servers, process them there, and delete them after 1–2 hours.', 'Cloud PDF tools upload your files to their servers, process them there, and delete them later; how long they keep them varies.'),
 ('When you use tools like iLovePDF or SmallPDF, your files travel', 'When you use cloud PDF tools, your files travel'),
 ('stores them temporarily (for 1–2 hours), and then deletes them.', 'stores them temporarily, and then deletes them.'),
 ('iLovePDF and SmallPDF upload your files to their servers for processing.', 'Cloud PDF tools upload your files to their servers for processing.'),
]
# list items '<li>iLovePDF: 25MB limit</li>' style — drop the competitor-specific item, keep one neutral line
LIST = [
 (r'(<li[^>]*>)\s*iLovePDF:\s*25\s?MB (?:upload )?limit\s*(</li>)', r'\1Cloud tools: file size caps on free plans\2'),
 (r'\s*<li[^>]*>\s*SmallPDF:\s*2 tasks/day(?: free)?\s*</li>', ''),
 (r'\s*<li[^>]*>\s*Adobe:\s*(?:paid plan required|\$19\.99/month)\s*</li>', ''),
]
def main(write):
    files = subprocess.run(['git', 'ls-files', '--', '*.html', '**/*.html', 'data/content/en/**', ':!dist', ':!tests', ':!docs'], capture_output=True, text=True).stdout.split()
    LOC = ('de/', 'es/', 'fr/', 'pt/', 'it/', 'nl/', 'pl/', 'tr/', 'vi/', 'id/', 'ja/', 'ko/', 'ru/', 'zh/', 'ar/', 'fa/', 'he/', 'ur/', 'bn/', 'hi/', 'data/content/')
    used = set(); n = 0
    for f in files:
        if f.startswith(LOC) and not f.startswith('data/content/en/'): continue
        t = open(f, encoding='utf-8').read(); o = t
        for a, b in R:
            if a in t: t = t.replace(a, b); used.add(a)
        for a, b in LIST:
            t2 = re.sub(a, b, t)
            if t2 != t: used.add(a); t = t2
        if t != o:
            if f.endswith('.html'):
                for m in re.findall(r'<script type="application/ld\+json">(.*?)</script>', t, re.S): json.loads(m)
            if f.endswith('.json'): json.loads(t)
            n += 1
            if write: open(f, 'w', encoding='utf-8').write(t)
    print(n, 'files'); print('unused:', [a[:70] for a, _ in R + LIST if a not in used])
if __name__ == '__main__': main('--write' in sys.argv)
