#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Draw the RESERVE or the closed HOLDOUT set for PDF->Word (owner, 2026-10-25).

Three sets, never mixed:
  dev      every document already looked at — sample-v1, the slides sample,
           every pinned document (tests/corpus/cloud/sha256.json): thresholds
           are tuned on these
  reserve  a fresh draw with a PUBLIC seed: where a holdout failure is
           diagnosed — its documents may be opened, the holdout's never
  holdout  a fresh draw with a SECRET seed (the `holdout` environment's
           HOLDOUT_SEED, which only the owner knows), excluding dev and
           reserve: final evaluation only, never for picking a parameter

Documents come from the same source as the nightly corpus (Tika metadata of
CC-MAIN-2021-31-PDF-UNTRUNCATED): Chinese, Japanese, Arabic-script and English
files with a text layer (Tika counted tokens) and not encrypted — the metrics
score text-layer reconstruction; scans have no reference.

  python3 scripts/corpus-cloud/pick_holdout.py reserve <out.json> [metadata.csv(.gz) | URL]
  HOLDOUT_SEED=… python3 scripts/corpus-cloud/pick_holdout.py holdout <out.json> [metadata…]

The holdout draw prints counts only — never a document name — and its
output file must never be committed, uploaded as an artifact or printed.
"""
import json, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from pick_sample import SRC, rows  # noqa: E402

CLOUD = os.path.join(HERE, '..', '..', 'tests', 'corpus', 'cloud')
RESERVE_SEED = 'pdfree-reserve-2026-10-27'
QUOTA = {'zh': 60, 'ja': 20, 'ar': 40, 'fa': 15, 'ur': 5, 'en': 60}
LANG = {'cmn': 'zh', 'zho': 'zh', 'yue': 'zh', 'jpn': 'ja', 'ara': 'ar', 'fas': 'fa', 'pes': 'fa', 'urd': 'ur', 'eng': 'en'}


def dev_names():
    names = set(json.load(open(os.path.join(CLOUD, 'sha256.json'))))
    for f in ('sample-v1.json', 'sample-slides-v1.json'):
        names |= {s['file'] for s in json.load(open(os.path.join(CLOUD, f)))['sample']}
    return names


def stratum(r):
    lang = LANG.get(r.get('tika_eval_lang', ''))
    if not lang:
        return None
    if int(r.get('tika_eval_num_tokens') or 0) == 0 or (r.get('encrypted') or '').lower() in ('t', 'true'):
        return None
    return lang


def draw(seed, exclude, src=SRC):
    rng = random.Random(seed)
    pools, seen = {k: [] for k in QUOTA}, {k: 0 for k in QUOTA}
    for r in rows(src):
        name = r.get('file_name', '')
        if not name.endswith('.pdf') or name in exclude:
            continue
        s = stratum(r)
        if s is None:
            continue
        seen[s] += 1
        pool, q = pools[s], QUOTA[s]
        # reservoir sampling; the metadata lists some files on several rows,
        # so a name already drawn is skipped
        if any(i['file'] == name for i in pool):
            continue
        if len(pool) < q:
            pool.append({'file': name, 'stratum': s})
        else:
            j = rng.randrange(seen[s])
            if j < q:
                pool[j] = {'file': name, 'stratum': s}
    return pools, seen


def main():
    kind, out = sys.argv[1], sys.argv[2]
    src = sys.argv[3] if len(sys.argv) > 3 else SRC
    exclude = dev_names()
    if kind == 'reserve':
        seed = RESERVE_SEED
    elif kind == 'holdout':
        seed = os.environ.get('HOLDOUT_SEED')
        if not seed:
            raise SystemExit('HOLDOUT_SEED is not set: the holdout is drawn only inside the holdout environment')
        reserve = os.path.join(CLOUD, 'reserve-v1.json')
        if not os.path.exists(reserve):
            raise SystemExit('no reserve set yet: the holdout is drawn after it, so the two never share a document')
        exclude |= {s['file'] for s in json.load(open(reserve))['sample']}
    else:
        raise SystemExit('reserve or holdout')
    pools, seen = draw(seed, exclude, src)
    sample = sorted((i for p in pools.values() for i in p), key=lambda i: i['file'])
    head = {'source': src, 'population': seen, 'excluded': len(exclude)}
    if kind == 'reserve':
        head['seed'] = seed
    json.dump({**head, 'sample': sample}, open(out, 'w'), indent=1)
    print(f'{kind}: ' + ', '.join(f'{k} {len(v)}' for k, v in pools.items()) + f' (excluded {len(exclude)} already-seen documents)')


if __name__ == '__main__':
    main()
