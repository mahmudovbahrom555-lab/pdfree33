#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Pick the documents the nightly robustness run goes through: a stratified,
reproducible sample of CC-MAIN-2021-31-PDF-UNTRUNCATED (Digital Corpora,
~8M web PDFs), read from its Tika metadata — pains first.

Strata follow what our users actually bring (Analytics, 2026-10): Arabic,
Persian, Chinese pages, scans (no text layer), damaged files, forms — then
the other languages we serve, encrypted and very long files, and a random
control group. Each file's language is Tika's own detection (tika_eval_lang,
ISO 639-3); a file with pages but no tokens is taken as a scan.

  python3 scripts/corpus-cloud/pick_sample.py [metadata.csv(.gz) | URL] > sample.json

Default source: the full Tika table on S3, streamed (≈450 MB gzip, never
stored). Same seed → same sample, so nights are comparable.
"""
import csv, gzip, io, json, random, sys, urllib.request

SRC = 'https://digitalcorpora.s3.amazonaws.com/corpora/files/CC-MAIN-2021-31-PDF-UNTRUNCATED/metadata/tika-20230714.csv.gz'
SEED = 2026

# stratum → quota; first match wins, in this order
QUOTA = {
    'ar': 150, 'fa': 100, 'zh': 150, 'scan': 150, 'damaged': 150, 'form': 100,
    'ur': 40, 'ja': 60, 'ko': 50, 'ru': 60, 'tr': 40, 'vi': 40, 'id': 40,
    'encrypted': 40, 'long': 40, 'random': 300,
}
LANG = {'ara': 'ar', 'fas': 'fa', 'pes': 'fa', 'urd': 'ur', 'cmn': 'zh', 'zho': 'zh', 'yue': 'zh',
        'jpn': 'ja', 'kor': 'ko', 'rus': 'ru', 'tur': 'tr', 'vie': 'vi', 'ind': 'id', 'msa': 'id'}


def flag(r, col):
    # Tika writes booleans as 't' / 'f' (not 'true') — checked on the 1k
    # sample: comparing with 'true' silently found no forms at all
    return (r.get(col) or '').lower() in ('t', 'true')


def stratum(r):
    lang = LANG.get(r.get('tika_eval_lang', ''))
    pages = int(r.get('num_pages') or 0)
    tokens = int(r.get('tika_eval_num_tokens') or 0)
    exc = r.get('container_exception') or ''
    if lang in ('ar', 'fa', 'zh'): return lang
    if pages > 0 and tokens == 0 and not flag(r, 'encrypted'): return 'scan'
    # an encrypted file's "exception" is its password, not damage
    if flag(r, 'encrypted') or 'Encrypt' in exc or 'AccessPermission' in exc: return 'encrypted'
    if flag(r, 'pdf_contains_damaged_font') or exc or (r.get('parse_status') or 'OK') != 'OK':
        return 'damaged'
    if flag(r, 'pdf_has_acroform_fields') or flag(r, 'has_xfa'): return 'form'
    if lang: return lang
    if pages > 300: return 'long'
    return 'random'


def rows(src):
    raw = urllib.request.urlopen(src, timeout=600) if src.startswith('http') else open(src, 'rb')
    stream = gzip.GzipFile(fileobj=raw) if src.endswith('.gz') else raw
    text = io.TextIOWrapper(stream, encoding='utf-8-sig', errors='replace', newline='')
    csv.field_size_limit(1 << 30)
    yield from csv.DictReader(text)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else SRC
    rng = random.Random(SEED)
    pools, seen = {k: [] for k in QUOTA}, {k: 0 for k in QUOTA}
    for r in rows(src):
        name = r.get('file_name', '')
        if not name.endswith('.pdf'): continue
        s = stratum(r)
        seen[s] += 1
        item = {'file': name, 'stratum': s, 'lang': r.get('tika_eval_lang', ''), 'pages': int(r.get('num_pages') or 0)}
        pool, q = pools[s], QUOTA[s]
        # reservoir sampling: every file of the stratum equally likely
        if len(pool) < q: pool.append(item)
        else:
            j = rng.randrange(seen[s])
            if j < q: pool[j] = item
    sample = sorted((i for p in pools.values() for i in p), key=lambda i: i['file'])
    json.dump({'source': src, 'seed': SEED, 'population': seen, 'sample': sample}, sys.stdout, indent=1)
    print(file=sys.stderr)
    print('population:', seen, file=sys.stderr)
    print('sampled:', {k: len(v) for k, v in pools.items()}, file=sys.stderr)


if __name__ == '__main__':
    main()
