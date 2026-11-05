#!/usr/bin/env python3
"""What CMYK-related content is really in the documents: images by colour space / filter / bytes,
ICC N, OutputIntents, overprint ExtGStates, Separation/DeviceN, transparency groups, soft masks.
python3 cmyk_survey.py <list of pdf paths file> [--compare dir-with-<doc>.<L>.default.pdf]"""
import sys, re, collections, json, fitz
def cs_name(doc, x):
    try:
        k = doc.xref_get_key(x, 'ColorSpace')
    except Exception: return '?'
    t, v = k
    if t == 'xref':
        try: v = doc.xref_object(int(v.split()[0]), compressed=True)
        except Exception: pass
    if 'ICCBased' in v:
        m = re.search(r'(\d+) 0 R', v)
        n = '?'
        if m:
            try: n = doc.xref_get_key(int(m.group(1)), 'N')[1]
            except Exception: pass
        return f'ICC{n}'
    for k in ('DeviceCMYK', 'DeviceRGB', 'DeviceGray', 'Separation', 'DeviceN', 'Indexed', 'Lab', 'CalRGB'):
        if k in v: return k
    return v[:20]
def survey(path):
    doc = fitz.open(path); out = collections.Counter(); size = collections.Counter()
    filt = collections.Counter()
    for x in range(1, doc.xref_length()):
        try:
            if doc.xref_get_key(x, 'Subtype')[1] != '/Image': continue
        except Exception: continue
        cs = cs_name(doc, x); f = doc.xref_get_key(x, 'Filter')[1]
        try: n = len(doc.xref_stream_raw(x))
        except Exception: n = 0
        out[cs] += 1; size[cs] += n; filt[(cs, f)] += n
    raw = open(path, 'rb').read()
    flags = {
        'OutputIntents': raw.count(b'/OutputIntents'),
        'overprint_OP_true': len(re.findall(rb'/OP\s+true', raw)) + len(re.findall(rb'/op\s+true', raw)),
        'OPM1': len(re.findall(rb'/OPM\s+1', raw)),
        'Separation': raw.count(b'/Separation'), 'DeviceN': raw.count(b'/DeviceN'),
        'TransparencyGroup': raw.count(b'/S /Transparency') + raw.count(b'/S/Transparency'),
        'SMask': raw.count(b'/SMask'),
    }
    return out, size, filt, flags
if __name__ == '__main__':
    files = [l.strip() for l in open(sys.argv[1]) if l.strip()]
    tot_n, tot_b, tot_f = collections.Counter(), collections.Counter(), collections.Counter()
    docs_with = collections.Counter(); flagdocs = collections.Counter()
    for p in files:
        try: n, b, f, fl = survey(p)
        except Exception as e: print('ERR', p, e); continue
        tot_n.update(n); tot_b.update(b); tot_f.update(f)
        for k in n: docs_with[k] += 1
        for k, v in fl.items():
            if v: flagdocs[k] += 1
    print('images by colour space: count / MB / documents')
    for k, v in tot_b.most_common(): print(f'  {k:12} {tot_n[k]:6} {v/1e6:8.1f} MB  in {docs_with[k]} docs')
    print('CMYK-ish by filter (MB):')
    for (cs, f), v in tot_f.most_common():
        if cs in ('DeviceCMYK', 'ICC4', 'Separation', 'DeviceN'): print(f'  {cs:12} {f:28} {v/1e6:8.1f}')
    print('documents with:', dict(flagdocs), 'of', len(files))
