#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Fetch single PDFs out of the CC-MAIN-2021-31-PDF-UNTRUNCATED zips
(Digital Corpora, ~8M PDFs crawled from the web) without downloading the
1.3 GB archives: the zip is read through HTTP Range requests — its central
directory, then only the member asked for.

  python3 scripts/corpus-cloud/fetch.py <out-dir> 0000123.pdf 4031234.pdf …

File 0001234.pdf lives in zip 0001.zip (folder 0000-0999). Documents are
fetched at run time and never committed (size, mixed licences — see
tests/corpus/README.md); only their names and the results are kept.
"""
import io, os, sys, zipfile, urllib.request

BASE = 'https://digitalcorpora.s3.amazonaws.com/corpora/files/CC-MAIN-2021-31-PDF-UNTRUNCATED/zipfiles'


class HttpFile(io.RawIOBase):
    """A read-only, seekable file over HTTP Range requests."""
    def __init__(self, url):
        self.url, self.pos = url, 0
        req = urllib.request.Request(url, method='HEAD')
        with urllib.request.urlopen(req, timeout=60) as r:
            self.size = int(r.headers['Content-Length'])
    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.pos
    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos
    def read(self, n=-1):
        if n is None or n < 0: n = self.size - self.pos
        if n == 0 or self.pos >= self.size: return b''
        end = min(self.size, self.pos + n) - 1
        req = urllib.request.Request(self.url, headers={'Range': f'bytes={self.pos}-{end}'})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    data = r.read()
                break
            except Exception:
                if attempt == 2: raise
        self.pos += len(data)
        return data
    def readinto(self, b):
        data = self.read(len(b)); b[:len(data)] = data; return len(data)


def zip_url(name):
    n = int(name.split('.')[0])
    z = n // 1000
    lo = z // 1000 * 1000
    return f'{BASE}/{lo:04d}-{lo + 999:04d}/{z:04d}.zip'


def fetch(out_dir, names):
    os.makedirs(out_dir, exist_ok=True)
    by_zip = {}
    for name in names: by_zip.setdefault(zip_url(name), []).append(name)
    got = []
    for url, members in by_zip.items():
        zf = zipfile.ZipFile(io.BufferedReader(HttpFile(url), buffer_size=1 << 20))
        index = {os.path.basename(i.filename): i for i in zf.infolist()}
        for name in members:
            info = index.get(name)
            if not info:
                print(f'missing {name} in {url}', file=sys.stderr); continue
            with open(os.path.join(out_dir, name), 'wb') as f:
                f.write(zf.read(info))
            got.append(name)
    return got


if __name__ == '__main__':
    got = fetch(sys.argv[1], sys.argv[2:])
    print(f'fetched {len(got)}/{len(sys.argv) - 2}')
