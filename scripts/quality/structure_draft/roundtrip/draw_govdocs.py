#!/usr/bin/env python3
"""Fetch the .doc/.docx members of randomly drawn govdocs1 zips (HTTP Range
reads, no full download). Names are printed in the seeded order.

  python3 draw_govdocs.py <out-dir> [zips=6]
"""
import os, random, sys, zipfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../../corpus-cloud'))
from fetch import HttpFile

SEED = 'pdfree-roundtrip-2026-10-28'
BASE = 'https://digitalcorpora.s3.amazonaws.com/corpora/files/govdocs1/zipfiles'

def fetch_zip(out, z, threads=8):
    """A zip's .doc/.docx members, several Range reads at once (one reader
    per thread: a reader keeps its own position)."""
    from concurrent.futures import ThreadPoolExecutor
    import threading
    url = f'{BASE}/{z:03d}.zip'
    members = sorted(m for m in zipfile.ZipFile(HttpFile(url)).namelist() if m.lower().endswith(('.doc', '.docx')))
    local = threading.local()
    def get(m):
        dst = os.path.join(out, os.path.basename(m))
        if os.path.exists(dst): return
        if not hasattr(local, 'zf'): local.zf = zipfile.ZipFile(HttpFile(url))
        data = local.zf.read(m)
        with open(dst + '.part', 'wb') as f: f.write(data)
        os.replace(dst + '.part', dst)
    with ThreadPoolExecutor(threads) as ex: list(ex.map(get, members))
    return [os.path.basename(m) for m in members]

def main(out, nzips=6):
    os.makedirs(out, exist_ok=True)
    rng = random.Random(SEED)
    zips = rng.sample(range(1000), nzips)
    names = []
    for z in zips: names += fetch_zip(out, z)
    rng.shuffle(names)
    open(os.path.join(out, 'order.txt'), 'w').write('\n'.join(names) + '\n')
    print(f'{len(names)} documents from zips {sorted(zips)}')

if __name__ == '__main__':
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 6)
