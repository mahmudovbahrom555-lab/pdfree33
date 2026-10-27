#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""The closed holdout's report: totals only, never a document (2026-10-27).

The same holdout documents converted by two builds — main (base) and the
change under test (candidate) — scored by each language's metric; this prints
how many documents got worse, mixed, better or stopped being scored, per
language, and nothing that names or quotes a document (owner rule: the agent
sees the aggregate only). Exit 1 when anything got worse, mixed or stopped
being scored: a human looks (condition 4 — the holdout is evidence, not a
release permission).

  python3 scripts/quality/holdout_report.py \\
      zh <base.jsonl> <cand.jsonl>  ar <base.jsonl> <cand.jsonl>  en <base.jsonl> <cand.jsonl>
"""
import os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import arabic, chinese, latin  # noqa: E402


def arabic_counts(base_path, cand_path):
    """arabic.py's own rule (worse_on), per document, counted. Documents read
    partly with OCR are left out, as arabic.py's report leaves them out of the
    text-layer totals."""
    _, B = arabic.load(base_path)
    _, N = arabic.load(cand_path)
    worse = mixed = better = lost = gained = ocr = 0
    for d in set(B) & set(N):
        x, y = B[d], N[d]
        sx, sy = x.get('recall') is not None, y.get('recall') is not None
        if sx and not sy:
            lost += 1
        elif sy and not sx:
            gained += 1
        elif sx:
            if x.get('ocrPages') or y.get('ocrPages'):
                ocr += 1
                continue
            w, g = arabic.worse_on(x, y, 0.005), arabic.worse_on(y, x, 0.005)
            if w and g:
                mixed += 1
            elif w:
                worse += 1
            elif g:
                better += 1
    # the change's totals over its text-layer documents (OCR'd ones apart, as above)
    T = [r for r in N.values() if r.get('recall') is not None and not r.get('ocrPages')]
    words = sum(r['words'] for r in T) or 1
    od = [r for r in T if r.get('order') is not None]
    totals = (f"**{len(T)} docs** — words agreed {sum(r['words'] for r in T)}, "
              f"recall {100 * sum(r['recall'] * r['words'] for r in T) / words:.2f} %, "
              f"dots {sum(r['dots'] for r in T)}, reversed {sum(r['reversed'] for r in T)}, "
              f"glued {sum(r['glued'] for r in T)}, numbers missing {sum(r['numbersMissing'] for r in T)} "
              f"of {sum(r.get('numbersAgreed', 0) for r in T)}, "
              f"order {100 * sum(r['order'] * r.get('anchors', 1) for r in od) / max(1, sum(r.get('anchors', 1) for r in od)):.2f} % on {len(od)} docs")
    return {'docs': len(set(B) & set(N)), 'worse': worse, 'mixed': mixed, 'lost': lost,
            'better': better, 'gained': gained, 'note': f'{ocr} read partly with OCR, not judged · {totals}'}


def text_counts(module, base_path, cand_path):
    # exact: the two builds ran on the same documents in one run, where
    # conversions are deterministic — any change is real (chinese.exact)
    text, _ = module.compare(base_path, cand_path, private=True, exact_mode=True)
    line = next(l for l in text.split('\n') if l.startswith('**worse:'))
    nums = [int(t) for t in line.replace(',', ' ').replace('*', ' ').split() if t.isdigit()]
    worse, mixed, lost, better, gained = nums
    docs = int(re.search(r'documents in both: (\d+)', text).group(1))
    return {'docs': docs, 'worse': worse, 'mixed': mixed, 'lost': lost, 'better': better, 'gained': gained,
            'note': text.split('\n\n')[-1].split('\n', 1)[-1].replace('\n', ' · ')}


def main(args):
    rows, fail = [], 0
    for i in range(0, len(args), 3):
        lang, base, cand = args[i:i + 3]
        r = arabic_counts(base, cand) if lang == 'ar' else text_counts(chinese if lang == 'zh' else latin, base, cand)
        fail += r['worse'] + r['mixed'] + r['lost']
        rows.append((lang, r))
    print('## Closed holdout — main vs the change, totals only\n')
    print('| language | documents | worse | mixed | no longer scored | better | newly scored |')
    print('|---|---|---|---|---|---|---|')
    for lang, r in rows:
        print(f"| {lang} | {r['docs']} | {r['worse']} | {r['mixed']} | {r['lost']} | {r['better']} | {r['gained']} |")
    print()
    for lang, r in rows:
        print(f"- {lang}: {r['note']}")
    print('\n' + ('**Something got worse, mixed or stopped being scored: a human looks (diagnose on the reserve set, never here).**'
                  if fail else 'Nothing got worse on the holdout. Evidence, not a release permission.'))
    return 1 if fail else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
