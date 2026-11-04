#!/usr/bin/env python3
"""SUPPLEMENTARY to B3/C2 (not the pre-registered wording): the two outputs are compared after qpdf
normalisation with /ModDate and the second /ID string blanked — two runs of the SAME baseline build
differ only there (checked on 0365285, 2026-11-05). Usage: python3 eval_b3_norm.py <cb-data>"""
import json, os, re, subprocess, sys, hashlib, tempfile
D = sys.argv[1]
xmp = {l.split()[0]: float(l.split()[3]) for l in open(f'{D}/eval_bc.txt') if 'xmp%' in l}
local = {os.path.basename(p)[:-4] for p in open(f'{D}/local10.txt').read().split()}
def norm(p):
    t = tempfile.mktemp(suffix='.pdf')
    subprocess.run(['qpdf', '--qdf', '--object-streams=disable', '--stream-data=uncompress', p, t], capture_output=True)
    b = open(t, 'rb').read(); os.remove(t)
    b = re.sub(rb'/ModDate \([^)]*\)', b'/ModDate ()', b)
    b = re.sub(rb'/ID \[<([0-9a-f]+)><[0-9a-f]+>\]', rb'/ID [<\1><>]', b)
    return hashlib.md5(b).hexdigest()
same = diff = 0; bad = []
for doc in sorted(xmp):
    if xmp[doc] >= 1: continue          # B3 covers documents without such XMP
    for preset in ('auto', 'low', 'medium', 'high'):
        sub = ('local-run', 'fix-local') if doc in local else ('cloud-run', 'fix-cloud')
        bp, fp = f'{D}/{sub[0]}/{doc}.{preset}.pdf', f'{D}/{sub[1]}/{doc}.{preset}.pdf'
        if not (os.path.exists(bp) and os.path.exists(fp)): continue
        if os.path.getsize(bp) > os.path.getsize(f'{D}/' + ('docs/' + doc + '.pdf' if doc not in local else '')) if doc not in local else False: pass
        if norm(bp) == norm(fp): same += 1
        else: diff += 1; bad.append((doc, preset))
print(json.dumps({'identical_after_norm': same, 'different': diff, 'list': bad[:20]}))
