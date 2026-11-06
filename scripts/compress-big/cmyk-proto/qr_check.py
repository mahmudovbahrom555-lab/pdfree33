#!/usr/bin/env python3
"""Stage 4b (b): decode every control QR from a 300-dpi render of each PDF (OpenCV + WeChat).
  python3 qr_check.py <truth.json> <orig.pdf> <D300.pdf> <D200.pdf>"""
import sys, json, collections
import numpy as np, fitz, cv2
truth = json.load(open(sys.argv[1])); files = {'orig': sys.argv[2], 'D300': sys.argv[3], 'D200': sys.argv[4]}
cvq = cv2.QRCodeDetector()   # this OpenCV build has no WeChat module


def decode(d, t):
    x0, y0, x1, y1 = t['bbox']; pm = d[t['page']].get_pixmap(dpi=300, clip=fitz.Rect(x0 - 6, y0 - 6, x1 + 6, y1 + 6), alpha=False)
    g = cv2.cvtColor(np.frombuffer(pm.samples, np.uint8).reshape(pm.height, pm.width, pm.n)[..., :3].copy(), cv2.COLOR_RGB2GRAY)
    g = cv2.copyMakeBorder(g, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=255)
    a = cvq.detectAndDecode(g)[0]
    b = cvq.detectAndDecode(cv2.resize(g, None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST))[0]
    return a, b


res = {k: [] for k in files}
for k, p in files.items():
    with fitz.open(p) as d:
        for t in truth: res[k].append(decode(d, t))
ok_orig = [i for i, t in enumerate(truth) if t['text'] in res['orig'][i]]
import os
for k in ('D300', 'D200'):   # only the codes D actually re-encoded (the guard keeps some images as they were)
    ch = os.path.join(os.path.dirname(sys.argv[1]), f'changed-{k}.json')
    if os.path.exists(ch):
        changed = set(json.load(open(ch))); sub = [i for i in range(len(truth)) if i in changed and truth[i]['text'] in res['orig'][i]]
        bad = [i for i in sub if truth[i]['text'] not in res[k][i]]
        print(f'{k} re-encoded and decodable in the original: {len(sub) - len(bad)}/{len(sub)} same text; failures by (ppi, module px):', dict(collections.Counter((truth[i]['ppi'], truth[i]['module_px']) for i in bad)))
print('codes', len(truth), '| decodable in the original (either decoder):', len(ok_orig), '| dropped:', len(truth) - len(ok_orig))
for k in ('D300', 'D200'):
    fails = [i for i in ok_orig if truth[i]['text'] not in res[k][i]]
    by = collections.Counter((truth[i]['ppi'], truth[i]['module_px']) for i in fails)
    print(f'{k}: same text {len(ok_orig) - len(fails)}/{len(ok_orig)}; failures by (ppi, module px):', dict(by))
    for dec in (0, 1):
        n = sum(1 for i in ok_orig if res['orig'][i][dec] == truth[i]['text'])
        m = sum(1 for i in ok_orig if res['orig'][i][dec] == truth[i]['text'] and res[k][i][dec] == truth[i]['text'])
        print(f'   {"OpenCV 300 dpi" if dec == 0 else "OpenCV 300 dpi ×2"}: {m}/{n} of the codes it reads in the original')
