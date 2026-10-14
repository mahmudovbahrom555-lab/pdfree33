#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Cluster a robustness run (scripts/corpus-cloud/robust.mjs) into what to
fix first: every non-ok run gets a signature — tool, outcome, and its
message with numbers, file names and quoted parts blanked — and the
signatures are ranked by how many documents hit them, pains weighted up
(Arabic, Persian, Chinese, scans, damaged files).

  python3 scripts/corpus-cloud/report.py <results.jsonl> [more.jsonl …] > report.md

Raw site messages shown to users ("Page dictionary kids object is not an
array") are flagged: they mean an error nobody classified.
"""
import collections, json, re, sys

PAIN = {'ar': 3, 'fa': 3, 'zh': 3, 'scan': 2, 'damaged': 2}
FRIENDLY = re.compile(r'unusual or corrupted structure|password protected|not a valid PDF|nothing to remove|Try Standard|too large|limit|timed out|ran out of memory', re.I)


def signature(r):
    msg = r.get('reason') or ''
    msg = re.sub(r'"[^"]*"', '"…"', msg)
    msg = re.sub(r'\b\d+(\.\d+)?\b', 'N', msg)
    msg = re.sub(r'\S+\.pdf\b', 'FILE', msg)
    return (r['tool'], r['outcome'], r.get('type') or '', msg[:110])


def main(paths):
    runs = [json.loads(l) for p in paths for l in open(p, encoding='utf-8') if l.strip()]
    by_outcome = collections.Counter(r['outcome'] for r in runs)
    by_tool = collections.defaultdict(collections.Counter)
    for r in runs: by_tool[r['tool']][r['outcome']] += 1
    clusters = collections.defaultdict(list)
    for r in runs:
        if r['outcome'] == 'ok': continue
        clusters[signature(r)].append(r)

    def weight(rs): return sum(PAIN.get(r.get('stratum'), 1) for r in rs)

    docs = len({r['doc'] for r in runs})
    print(f'# Robustness run — {docs} documents, {len(runs)} runs\n')
    print('| outcome | runs |\n|---|---|')
    for k, v in by_outcome.most_common(): print(f'| {k} | {v} |')
    print('\n| tool | ' + ' | '.join(sorted(by_outcome)) + ' |\n|---|' + '---|' * len(by_outcome))
    for t in sorted(by_tool):
        print(f'| {t} | ' + ' | '.join(str(by_tool[t][o]) for o in sorted(by_outcome)) + ' |')
    print('\n## Clusters, worst first (weight = documents, pains ×2–3)\n')
    for i, (sig, rs) in enumerate(sorted(clusters.items(), key=lambda kv: -weight(kv[1]))[:60], 1):
        tool, outcome, typ, msg = sig
        raw = outcome in ('error', 'refused') and msg and not FRIENDLY.search(msg)
        strata = collections.Counter(r.get('stratum') or '?' for r in rs)
        print(f'{i}. **{tool} · {outcome}{" · " + typ if typ else ""}** — {len(rs)} docs, weight {weight(rs)}'
              f'{" · ⚠ raw message shown to users" if raw else ""}')
        print(f'   - `{msg or "(no message)"}`')
        print(f'   - strata: {dict(strata.most_common(5))}; e.g. {", ".join(r["doc"] for r in rs[:4])}')


if __name__ == '__main__':
    main(sys.argv[1:])
