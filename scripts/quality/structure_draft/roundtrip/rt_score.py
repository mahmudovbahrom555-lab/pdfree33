#!/usr/bin/env python3
"""Round-trip scores: the source DOCX's styles (docx_truth) vs our DOCX of
each generator's PDF, per build. Same counts as the tagged-PDF draft
(compare.score_blocks) and STEDS.

  python3 rt_score.py <work-dir> <build>=<out-dir-pattern-with-{gen}> …
    e.g. main=/tmp/rt/out-{gen}-main  → files under <dir>/files/<stem>.pdf.pdf2word.docx
"""
import collections, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.dirname(HERE))
import compare, steds, docx_truth

KEYS = ('heading', 'para', 'paraMerged', 'paraSplit', 'item', 'cell')

def truth(path):
    return [b for b in docx_truth.blocks(path) if b[0] != 'toc' and compare.judgeable(compare.key(b[2]))]

def run(work, builds):
    kept = [json.loads(l)['doc'] for l in open(f'{work}/prep.jsonl') if json.loads(l).get('kept')]
    rows = collections.defaultdict(list)
    for doc in kept:
        stem = os.path.splitext(doc)[0]
        gt = truth(f'{work}/docx/{stem}.docx')
        for gen in ('A', 'B'):
            for b, pat in builds:
                out = f'{pat.format(gen=gen)}/files/{stem}.pdf.pdf2word.docx'
                if not os.path.exists(out): continue
                r = compare.score_blocks(gt, out)
                st, _ = steds.steds(gt, compare.docx_blocks(out))
                r.update(doc=stem, steds=st['strict'] if st else None)
                rows[(gen, b)].append(r)
    return rows

def macro(rs, k, minn=5):
    v = [r[k][0] / r[k][1] for r in rs if r[k][1] >= minn]
    return (round(100 * sum(v) / len(v), 1), len(v)) if v else None

def report(rows):
    for (gen, b), rs in sorted(rows.items()):
        s = [r['steds'] for r in rs if r['steds'] is not None]
        print(f'\n{gen} {b}: {len(rs)} docs, STEDS {round(sum(s) / len(s), 3) if s else None}')
        for k in KEYS:
            mi = (sum(r[k][0] for r in rs), sum(r[k][1] for r in rs))
            print(f'  {k:11} macro {macro(rs, k)} micro {mi[0]}/{mi[1]} = {round(100 * mi[0] / (mi[1] or 1), 1)} %')

if __name__ == '__main__':
    work = sys.argv[1]
    builds = [a.split('=', 1) for a in sys.argv[2:]]
    rows = run(work, builds)
    json.dump({f'{g}|{b}': v for (g, b), v in rows.items()}, open(f'{work}/scores.json', 'w'))
    report(rows)
