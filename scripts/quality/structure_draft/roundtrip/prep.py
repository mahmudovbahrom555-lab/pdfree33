#!/usr/bin/env python3
"""Pilot set: source .doc/.docx → DOCX (LibreOffice) → kept by the PLAN.md
rules → generator A (LibreOffice tagged PDF) and B (HTML printed by Chromium).

  python3 prep.py <src-dir> <work-dir> [n=50]
"""
import json, os, subprocess, sys
sys.path.insert(0, os.path.dirname(__file__))
import docx_truth

TAGGED = 'pdf:writer_pdf_Export:{"UseTaggedPDF":{"type":"boolean","value":"true"}}'

def soffice(args, timeout=180):
    return subprocess.run(['soffice', '--headless', *args], capture_output=True, timeout=timeout)

def pages(pdf):
    out = subprocess.run(['pdfinfo', pdf], capture_output=True, text=True).stdout
    return next((int(l.split()[-1]) for l in out.splitlines() if l.startswith('Pages:')), 0)

def main(src, work, n=50):
    for d in ('docx', 'A', 'html', 'B'): os.makedirs(f'{work}/{d}', exist_ok=True)
    order = [l.strip() for l in open(f'{src}/order.txt') if l.strip()]
    log = {json.loads(l)['doc']: json.loads(l) for l in open(f'{work}/prep.jsonl')} if os.path.exists(f'{work}/prep.jsonl') else {}
    kept = [d for d, r in log.items() if r.get('kept')]
    with open(f'{work}/prep.jsonl', 'a') as out:
        for name in order:
            if len(kept) >= n: break
            if name in log or not os.path.exists(f'{src}/{name}'): continue
            stem = os.path.splitext(name)[0]; dx = f'{work}/docx/{stem}.docx'
            row = {'doc': name}
            try:
                if not os.path.exists(dx): soffice(['--convert-to', 'docx', '--outdir', f'{work}/docx', f'{src}/{name}'])
                if not os.path.exists(dx): row['why'] = 'LibreOffice could not open it'
                else:
                    b, looks = docx_truth.blocks(dx, True)
                    h = sum(1 for r, _, _ in b if r == 'heading')
                    paras = sum(1 for r, _, _ in b if r == 'para')
                    row.update(headings=h, unseen=sum(1 for r, _, _ in b if r == 'unseen'), lookalikes=looks, blocks=len(b))
                    if h < 3: row['why'] = 'fewer than 3 styled headings'
                    elif h > paras: row['why'] = 'more headings than paragraphs: heading styles used as formatting'
                    elif looks > h: row['why'] = 'more lookalike headings than styled ones'
                    else:
                        soffice(['--convert-to', TAGGED, '--outdir', f'{work}/A', dx])
                        pa = f'{work}/A/{stem}.pdf'
                        row['pages'] = pages(pa) if os.path.exists(pa) else 0
                        if not row['pages']: row['why'] = 'no PDF from LibreOffice'
                        elif row['pages'] > 40: row['why'] = 'over 40 pages'
                        else:
                            soffice(['--convert-to', 'html:XHTML Writer File:UTF8', '--outdir', f'{work}/html', dx])
                            row['kept'] = True; kept.append(name)
            except subprocess.TimeoutExpired:
                row['why'] = 'LibreOffice timed out'
            out.write(json.dumps(row) + '\n'); out.flush()
    print(f'kept {len(kept)}')

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 50)
