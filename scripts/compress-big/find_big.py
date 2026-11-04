#!/usr/bin/env python3
"""Large PDFs in the CC-MAIN-2021-31-PDF-UNTRUNCATED zips, found from each zip's
central directory (no download): seeded random zips, members over a size.
  python3 find_big.py <min-MB> <how-many> <seed> [max-MB]
"""
import os, random, sys, zipfile
sys.path.insert(0, '/Users/murodjon/pdfree33/pdfree33/scripts/corpus-cloud')
from fetch import HttpFile, zip_url

def main(min_mb, want, seed, max_mb=1e9):
    rng = random.Random(seed)
    zips = list(range(8000)); rng.shuffle(zips)
    found = []
    for z in zips:
        url = zip_url(f'{z * 1000:07d}.pdf')
        try: infos = zipfile.ZipFile(HttpFile(url)).infolist()
        except Exception as e: print('skip', url, str(e)[:60], file=sys.stderr); continue
        big = [i for i in infos if i.filename.endswith('.pdf') and min_mb * 2**20 <= i.file_size <= max_mb * 2**20]
        rng.shuffle(big)
        for i in big[:2]:   # at most two per zip: spread over sources
            found.append((os.path.basename(i.filename), i.file_size)); print(os.path.basename(i.filename), round(i.file_size / 2**20, 1), 'MB', flush=True)
        if len(found) >= want: break
    return found

if __name__ == '__main__':
    a = sys.argv[1:]
    main(float(a[0]), int(a[1]), a[2], float(a[3]) if len(a) > 3 else 1e9)
