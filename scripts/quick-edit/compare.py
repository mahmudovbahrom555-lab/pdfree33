#!/usr/bin/env python3
"""Quick Edit step 0 (QUICKEDIT-PREREG.md, point 3): each saved output against its original.

  python3 compare.py <results.jsonl> <out-dir> <original>…   → one JSON line per document + a summary

- pages: page count, original vs output
- text_kept: share of the original's words (\\w{2,}, NFKC, lower) found in the output
- edit_present: "PDFREE" in the output's text
- layout: pages rendered at 40 dpi (same size: the original's); per page, the share of pixels whose
  difference exceeds 32 in any channel. The edited page is the one whose text gained "PDFREE";
  reported: worst page that was NOT edited, and the edited page as a whole (the box-only figure
  needs the run's box — kept for step 2's own run)
"""
import sys, os, json, re, unicodedata
import numpy as np
import fitz

def words(t):
    return re.findall(r'\w{2,}', unicodedata.normalize('NFKC', t).lower())

def render(page, w, h):
    zoom = min(w / page.rect.width, h / page.rect.height) if page.rect.width else 1
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    a = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)[..., :3].astype(np.int16)
    out = np.full((h, w, 3), 255, np.int16)
    out[:min(h, a.shape[0]), :min(w, a.shape[1])] = a[:h, :w]
    return out

def main(results, outdir, originals):
    orig = {os.path.basename(p)[:-4]: p for p in originals}
    rows = [json.loads(l) for l in open(results)]
    report = []
    for r in rows:
        line = {'doc': r['doc'], 'open': r.get('open'), 'save': r.get('save')}
        outp = os.path.join(outdir, r['doc'] + '.pdf')
        if r.get('save') == 'saved' and os.path.exists(outp) and r['doc'] in orig:
            o, n = fitz.open(orig[r['doc']]), fitz.open(outp)
            line['pages'] = f'{len(o)}→{len(n)}'
            wo = [words(p.get_text()) for p in o]; wn = [words(p.get_text()) for p in n]
            allo = [w for p in wo for w in p]; setn = set(w for p in wn for w in p)
            line['text_kept'] = round(sum(w in setn for w in allo) / max(1, len(allo)), 4)
            ntext = ' '.join(p.get_text() for p in n)
            line['edit_present'] = 'PDFREE' in ntext
            edited = next((i for i, p in enumerate(n) if 'PDFREE' in p.get_text()), None)
            diffs = []
            for i in range(min(len(o), len(n), 40)):
                w, h = int(o[i].rect.width * 40 / 72), int(o[i].rect.height * 40 / 72)
                a, b = render(o[i], w, h), render(n[i], w, h)
                diffs.append(float((np.abs(a - b).max(-1) > 32).mean()))
            others = [d for i, d in enumerate(diffs) if i != edited]
            line['layout_other_pages_max'] = round(max(others), 4) if others else None
            line['layout_edited_page'] = round(diffs[edited], 4) if edited is not None and edited < len(diffs) else None
        report.append(line)
        print(json.dumps(line, ensure_ascii=False))
    opened = [x for x in report if x['open'] == 'opened']
    saved = [x for x in opened if x['save'] == 'saved']
    print('SUMMARY', json.dumps({
        'documents': len(report), 'opened': len(opened), 'saved': len(saved),
        'pages_same': sum(1 for x in saved if x.get('pages', '').split('→')[0] == x.get('pages', '').split('→')[-1]),
        'text_kept_995': sum(1 for x in saved if (x.get('text_kept') or 0) >= 0.995),
        'edit_present': sum(1 for x in saved if x.get('edit_present')),
        'other_pages_under_0.1pct': sum(1 for x in saved if x.get('layout_other_pages_max') is not None and x['layout_other_pages_max'] < 0.001),
    }))

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3:])
