#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""One table from the detectors' findings (scripts/quality/props.py --batch)
of several engines on the same documents: per signal, how many documents it
fires on, per engine. Only documents every engine converted are counted —
otherwise an engine that fails on hard files looks cleaner than it is.

  python3 scripts/quality/compare_engines.py quality-*.jsonl > quality.md
"""
import collections, json, sys

SIGNALS = ['text.recall', 'numbers.changed', 'text.spaced', 'table.rows', 'table.smell',
           'para.smell', 'watermark.leaked', 'color.lost', 'font.lost', 'font.mono']

rows = [json.loads(l) for p in sys.argv[1:] for l in open(p, encoding='utf-8') if l.strip()]
engines = sorted({r['engine'] for r in rows})
by_doc = collections.defaultdict(dict)
for r in rows: by_doc[r['doc']][r['engine']] = {f['signal'] for f in r['findings']}
common = [d for d, e in by_doc.items() if len(e) == len(engines)]
print(f'# PDF→Word detectors — {len(common)} documents converted by all of: {", ".join(engines)}\n')
print('Each figure: documents the signal fires on (lower is better). A signal is a pointer to check, not a verdict.\n')
print('| signal | ' + ' | '.join(engines) + ' |\n|---|' + '---|' * len(engines))
for s in SIGNALS:
    print(f'| {s} | ' + ' | '.join(str(sum(1 for d in common if s in by_doc[d][e])) for e in engines) + ' |')
