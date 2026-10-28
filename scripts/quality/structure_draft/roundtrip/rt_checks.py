#!/usr/bin/env python3
"""PLAN.md G2 and G3 on the pilot set.
G2: the truth against itself (must be 100 %, STEDS 1.0); deliberate breaks of
    our DOCX (break_struct.py) caught by STEDS or by the kind's own counter.
G3: generator A's tags (tags.py) against the styles (docx_truth.py): the
    share of aligned blocks whose role agrees, per truth role, and the
    disagreements kept for a hand look.

  python3 rt_checks.py <work-dir> <our-A-out-dir> <broken-dir>
"""
import collections, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.dirname(HERE))
import compare, steds, tags
from rt_score import truth

def sim(a, b):
    g = lambda k: {k[i:i + 3] for i in range(max(1, len(k) - 2))}
    A, B = g(compare.key(a)), g(compare.key(b)); return len(A & B) / (len(A | B) or 1)

ROLE = {'merge': 'para', 'split': 'para', 'demote': 'heading', 'unlist': 'item', 'untable': 'cell'}
COUNTER = {'merge': ('paraMerged', +1), 'split': ('paraSplit', +1), 'demote': ('heading', -1), 'unlist': ('item', -1), 'untable': ('cell', -1)}

def main(work, ours, broken):
    kept = [os.path.splitext(json.loads(l)['doc'])[0] for l in open(f'{work}/prep.jsonl') if json.loads(l).get('kept')]
    # G2 identity
    bad = []
    for d in kept:
        gt = truth(f'{work}/docx/{d}.docx')
        r = compare.score_blocks(gt, None, out=gt); st, _ = steds.steds(gt, gt)
        if any(r[k][0] != r[k][1] for k in ('heading', 'para', 'item', 'cell')) or r['paraMerged'][0] or r['paraSplit'][0] or (st and st['strict'] != 1.0):
            bad.append(d)
    print(f'G2 identity: {len(kept) - len(bad)}/{len(kept)} exact', bad[:5])
    # G2 breaks
    kinds = json.load(open(f'{broken}/kinds.json'))['kinds']
    for kind, docs in kinds.items():
        n = caught = 0; miss = []
        for name, info in docs.items():
            d = name[:-4] if name.endswith('.pdf') else name
            gt = truth(f'{work}/docx/{d}.docx')
            ok = [any(r == ROLE[kind] and sim(t, x) >= 0.9 for r, _, x in gt) for t in info['texts'] if compare.judgeable(compare.key(t))]
            if not ok or not (all(ok) if kind == 'merge' else any(ok)): continue
            A = f'{ours}/{name}.pdf2word.docx'; B = f'{broken}/{kind}/{name}.pdf2word.docx'
            ta, _ = steds.steds(gt, compare.docx_blocks(A)); tb, _ = steds.steds(gt, compare.docx_blocks(B))
            if ta is None: continue
            n += 1
            k, sign = COUNTER[kind]
            sa, sb = compare.score_blocks(gt, A), compare.score_blocks(gt, B)
            fa, fb = sa[k][0] / max(1, sa[k][1]), sb[k][0] / max(1, sb[k][1])
            hit = tb['strict'] < ta['strict'] or (fb > fa if sign > 0 else fb < fa)
            caught += hit
            if not hit: miss.append(d)
        print(f'G2 break {kind:8} caught {caught}/{n}', miss[:4])
    # G3 tags vs styles on generator A
    agree = collections.Counter(); total = collections.Counter(); confusion = collections.Counter(); samples = collections.defaultdict(list)
    for d in kept:
        pdf = f'{work}/A/{d}.pdf'
        gt = truth(f'{work}/docx/{d}.docx')
        tg = [b for b in tags.blocks(pdf) if compare.judgeable(compare.key(b[2]))]
        a = compare.align(gt, tg)
        for (r, _, t), j in zip(gt, a):
            if j is None or j < 0 or r not in ('heading', 'para', 'item', 'cell'): continue
            tr = tg[j][0]; total[r] += 1; agree[r] += tr == r; confusion[(r, tr)] += 1
            if tr != r and len(samples[(r, tr)]) < 6: samples[(r, tr)].append((d, t[:70]))
    for r in total: print(f'G3 {r:8} tags agree {agree[r]}/{total[r]} = {round(100 * agree[r] / total[r], 1)} %')
    print('G3 confusion (styles → tags):', {f'{a}→{b}': v for (a, b), v in confusion.most_common() if a != b})
    json.dump({f'{a}→{b}': v for (a, b), v in samples.items()}, open(f'{work}/g3_samples.json', 'w'), indent=1, ensure_ascii=False)

if __name__ == '__main__':
    main(*sys.argv[1:4])
