#!/usr/bin/env python3
"""C4 checks: every ZIP entry ≤ its input; equals the single-file fix output of the same doc and preset
after blanking /ModDate and the second /ID; where Light grew the file, the entry IS the input.
python3 c4_check.py <out-dir> <preset> <single-dir> <pdf>…"""
import sys, os, zipfile, re, subprocess, tempfile, hashlib
out, preset, single, files = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
def norm(b):
    t = tempfile.mktemp(suffix='.pdf'); s = tempfile.mktemp(suffix='.pdf'); open(s, 'wb').write(b)
    subprocess.run(['qpdf', '--qdf', '--object-streams=disable', '--stream-data=uncompress', s, t], capture_output=True)
    x = open(t, 'rb').read(); os.remove(t); os.remove(s)
    x = re.sub(rb'/ModDate \([^)]*\)', b'/ModDate ()', x); x = re.sub(rb'/ID \[<([0-9a-f]+)><[0-9a-f]+>\]', rb'/ID [<\1><>]', x)
    return hashlib.md5(x).hexdigest()
z = zipfile.ZipFile(os.path.join(out, preset, 'batch.zip')); names = z.namelist(); fails = []
for f in files:
    doc = os.path.basename(f)[:-4]; inp = open(f, 'rb').read()
    entry = next((n for n in names if n.startswith(doc)), None)
    if not entry: fails.append((doc, 'missing in zip', names)); continue
    data = z.read(entry)
    if len(data) > len(inp): fails.append((doc, 'larger than input', len(data), len(inp)))
    sp = os.path.join(single, f'{doc}.{preset}.pdf')
    if os.path.exists(sp):
        sb = open(sp, 'rb').read()
        if sb == inp:
            if data != inp: fails.append((doc, 'single returned the input, batch did not'))
        elif norm(data) != norm(sb): fails.append((doc, 'differs from single-file output'))
    else: fails.append((doc, 'no single-file output to compare', sp))
    print(doc, preset, 'in', len(inp), 'batch', len(data), 'same-as-input', data == inp)
print('C4', preset, 'FAILS' if fails else 'PASS', fails)
