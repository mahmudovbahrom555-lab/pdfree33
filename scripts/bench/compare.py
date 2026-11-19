#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""compare.py — two visual_judge.py runs side by side: what changed.

  python3 scripts/bench/compare.py before.jsonl after.jsonl [--min 1.0]

Documents whose page count changed, or whose diff moved by --min or more,
best first; then the totals: mean diff, mean page ratio, pages matching the
source. Documents only one run scored are named, not compared.
"""
import json, sys
from statistics import mean


def load(path):
    rows = {}
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if line:
            d = json.loads(line)
            rows[d['doc']] = d
    return rows


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) != 2:
        sys.exit(__doc__)
    min_move = float(sys.argv[sys.argv.index('--min') + 1]) if '--min' in sys.argv else 1.0
    a, b = load(args[0]), load(args[1])
    both = [d for d in a if d in b and a[d]['diff'] is not None and b[d]['diff'] is not None]
    changed = [d for d in both if a[d]['docx_pages'] != b[d]['docx_pages'] or abs(b[d]['diff'] - a[d]['diff']) >= min_move]
    for d in sorted(changed, key=lambda d: b[d]['diff'] - a[d]['diff']):
        print(f"{d}  src {a[d]['src_pages']}  pages {a[d]['docx_pages']} -> {b[d]['docx_pages']}  diff {a[d]['diff']:.2f} -> {b[d]['diff']:.2f}")
    if both:
        same = lambda r: sum(1 for d in both if r[d]['docx_pages'] == r[d]['src_pages'])
        print(f"\n{len(both)} documents, {len(changed)} changed "
              f"(better {sum(1 for d in changed if b[d]['diff'] < a[d]['diff'])}, worse {sum(1 for d in changed if b[d]['diff'] > a[d]['diff'])})")
        print(f"mean diff {mean(a[d]['diff'] for d in both):.2f} -> {mean(b[d]['diff'] for d in both):.2f}; "
              f"mean page ratio {mean(a[d]['ratio'] for d in both):.2f} -> {mean(b[d]['ratio'] for d in both):.2f}; "
              f"pages = source {same(a)} -> {same(b)}")
    only = sorted(set(a) ^ set(b))
    if only:
        print('scored in one run only:', ' '.join(only))


if __name__ == '__main__':
    main()
