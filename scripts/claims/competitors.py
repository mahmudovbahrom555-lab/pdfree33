#!/usr/bin/env python3
"""Inventory of competitor names on public pages (owner rule: compare yes, name no).
A sentence is 'compat' when it names a product only as a viewer/format fact (opens in Acrobat, Adobe
PieceInfo, Adobe Scan) — those stay. Everything else is a comparison and goes.
Usage: python3 competitors.py [--list FILE_PREFIX]"""
import re, subprocess, sys, collections
NAMES = (r'\b(?:iLovePDF|ilovepdf|ILovePDF|Smallpdf|SmallPDF|smallpdf|Adobe Acrobat|Acrobat|Adobe|PDF24|Sejda|PDFescape|Soda ?PDF|Foxit'
         r'|Nitro|PDF ?Candy|Stirling(?:-PDF)?|BentoPDF|PDFCraft|Xodo|DocHub|PDFfiller|LightPDF|HiPDF|Wondershare|PDFelement|CleverPDF'
         r'|PDF2Go|pdf2go|Zamzar|CloudConvert|Convertio|ABBYY|Docling|MinerU|LlamaParse|pymupdf4llm|DocuSign|HelloSign|SignNow|CamScanner'
         r'|Marker(?= \(| and| or|,|\'s| scored| v\d|\s*</))\b')
COMPAT = (r'PieceInfo|XMP|Adobe Scan|Microsoft Lens|CamScanner|AcroForm|InDesign|Illustrator|Photoshop|XFA|\bReader\b|Preview|Chrome'
          r'|Adobe-(?:CNS1|GB1|Japan1|Korea1)|Watermark dialog|QPDF|viewer|lector|visionneuse|Betrachter|leitor|visualizzatore|Thumbnails?')
def files():
    fs = subprocess.run(['git', 'ls-files', '--', '*.html', '**/*.html', 'data/content/**', 'data/tools-config.json', 'js/config.js',
                         'js/i18n.js', 'js/locales/*.js', 'scripts/templates/**'], capture_output=True, text=True).stdout.split()
    return [f for f in fs if not f.startswith(('dist/', 'tests/', 'docs/', 'research/', 'packages/', 'embed/')) and f != 'seo-content.html']
def sentences(t):
    t = re.sub(r'(?:href|src)="[^"]*"', '', t); t = re.sub(r'<[^>]+>', ' ', t)
    for s in re.split(r'(?<=[.!?。])\s+|\n', t):
        s = re.sub(r'\s+', ' ', s).strip()
        if s: yield s
def main():
    cmp_, comp = collections.Counter(), collections.Counter()
    pref = sys.argv[sys.argv.index('--list') + 1] if '--list' in sys.argv else None
    for f in files():
        for s in sentences(open(f, encoding='utf-8').read()):
            if not re.search(NAMES, s): continue
            if re.search(COMPAT, s, re.I) and not re.search(r'upload|server|limit|\$|month|tasks?/|per day|free plan|account|cloud', s, re.I):
                comp[f] += 1
                if pref is not None and f.startswith(pref): print('KEEP', f, '|', s[:200])
            else:
                cmp_[f] += 1
                if pref is not None and f.startswith(pref): print('FIX ', f, '|', s[:200])
    if not pref:
        print('comparison sentences', sum(cmp_.values()), 'in', len(cmp_), 'files; compat kept', sum(comp.values()))
        fam = collections.Counter()
        for f, n in cmp_.items():
            k = re.sub(r'^(?:[a-z]{2}(?:-CN)?/)', '<lang>/', f); k = re.sub(r'^data/content/[^/]+/', 'data/content/<lang>/', k)
            fam[k] += n
        for k, n in fam.most_common(80): print(n, k)
if __name__ == '__main__': main()
