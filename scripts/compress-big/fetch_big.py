#!/usr/bin/env python3
"""Fetch large members of the CC-MAIN zips with ONE range request each: the member's
local header + compressed bytes, inflated here (zipfile over HTTP read it in small
pieces — a 60 MB member took forever).
  python3 fetch_big.py <out-dir> name.pdf…
"""
import os, struct, sys, urllib.request, zipfile, zlib
sys.path.insert(0, '/Users/murodjon/pdfree33/pdfree33/scripts/corpus-cloud')
from fetch import HttpFile, zip_url

def get(url, start, end):
    req = urllib.request.Request(url, headers={'Range': f'bytes={start}-{end}'})
    return urllib.request.urlopen(req, timeout=600).read()

def fetch_one(out, name):
    dst = os.path.join(out, name)
    if os.path.exists(dst) and os.path.getsize(dst) > 0: return 'have'
    url = zip_url(name)
    info = next(i for i in zipfile.ZipFile(HttpFile(url)).infolist() if os.path.basename(i.filename) == name)
    head = get(url, info.header_offset, info.header_offset + 29)
    n, m = struct.unpack('<HH', head[26:30])
    start = info.header_offset + 30 + n + m
    data = get(url, start, start + info.compress_size - 1)
    if info.compress_type == zipfile.ZIP_DEFLATED: data = zlib.decompressobj(-15).decompress(data)
    elif info.compress_type != zipfile.ZIP_STORED: raise ValueError(f'method {info.compress_type}')
    if len(data) != info.file_size or zlib.crc32(data) != info.CRC: raise ValueError('size/CRC mismatch')
    open(dst + '.part', 'wb').write(data); os.replace(dst + '.part', dst)
    return f'{len(data) / 2**20:.1f} MB'

if __name__ == '__main__':
    out = sys.argv[1]; os.makedirs(out, exist_ok=True)
    for name in sys.argv[2:]:
        try: print(name, fetch_one(out, name), flush=True)
        except Exception as e: print(name, 'FAILED', str(e)[:80], flush=True)
