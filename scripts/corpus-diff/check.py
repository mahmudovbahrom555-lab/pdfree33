#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
scripts/corpus-diff/check.py — judge run.mjs's OLD and NEW outputs against
the ORIGINAL, with MuPDF (an engine independent of the site's pdf.js/pdf-lib,
so a bug in those can't hide itself here). Exit 1 if NEW is worse anywhere.

Per input, each output (old and new) is scored against the original:
  • pages       — page count must match
  • images      — every placed image is matched to the original's image at the
                  same spot on the page and compared as a thumbnail. Recompression
                  moves a thumbnail a little; stripes / black / garbage move it a
                  lot. Chosen over page renders alone: a fully garbled chart scored
                  a 0.44 page-render diff at low DPI on 2026-09-30.
  • render      — per-page render diff (catches things that aren't one image,
                  e.g. a broken soft mask making a whole chart vanish)
  • size        — bytes
NEW fails when it: loses an output OLD had; changes the page count; has an
image or page clearly further from the original than OLD's; or is bigger than
an OLD that was itself sound (savings regression).

Usage: python3 scripts/corpus-diff/check.py [out-dir]   (default corpus-diff-out)
"""
import json
import os
import sys

import fitz

fitz.TOOLS.mupdf_display_errors(False)

OUT = sys.argv[1] if len(sys.argv) > 1 else 'corpus-diff-out'
MAX_PAGES = 40
THUMB = 64
IMG_BAD, IMG_SLACK = 25.0, 3.0      # thumbnail mean-abs-diff (0–255)
PAGE_BAD, PAGE_SLACK = 20.0, 3.0    # worst 8×8 tile of the page render, mean-abs-diff (0–255)
GRID = 8
PASSWORDS = ['', 'user']            # tests/corpus/synthetic/encrypted-user-password.pdf
SIZE_SLACK = 1.02                   # +2% (and 2 KB) before a size increase counts


def _mad(a, b):
    return sum(abs(x - y) for x, y in zip(a, b)) / max(1, len(a))


def _worst_tile(pa, pb):
    # Worst tile, not the page mean: uniform JPEG ripple on a noisy photo reads
    # ~4 everywhere, while a vanished chart or garbled region dominates its tiles.
    w, h, n = pa.width, pa.height, pa.n
    a, b = pa.samples, pb.samples
    worst = 0.0
    for ty in range(GRID):
        for tx in range(GRID):
            x0, x1 = tx * w // GRID, (tx + 1) * w // GRID
            y0, y1 = ty * h // GRID, (ty + 1) * h // GRID
            tot = cnt = 0
            for y in range(y0, y1, 2):
                row = (y * w) * n
                for x in range(x0 * n, x1 * n, 2):
                    tot += abs(a[row + x] - b[row + x]); cnt += 1
            worst = max(worst, tot / max(1, cnt))
    return worst


def _open(path):
    d = fitz.open(path)
    if d.needs_pass:
        for pw in PASSWORDS:
            if d.authenticate(pw):
                break
    return d


def _thumb(doc, xref):
    try:
        pm = fitz.Pixmap(doc, xref)
        if pm.alpha:
            pm = fitz.Pixmap(pm, 0)
        if pm.n != 3:
            pm = fitz.Pixmap(fitz.csRGB, pm)
        return fitz.Pixmap(pm, THUMB, THUMB, None).samples
    except Exception:
        return None                 # undecodable


def _placements(page):
    out = {}
    for info in page.get_image_info(xrefs=True):
        if info.get('xref'):
            key = tuple(round(v) for v in info['bbox'])
            out.setdefault(key, info['xref'])
    return out


def score(orig_path, out_path):
    """Distances of an output from the original, or None if unreadable."""
    try:
        o, d = _open(orig_path), _open(out_path)
    except Exception as e:
        return {'error': f'unreadable: {e}'}
    res = {'pages_ok': len(o) == len(d), 'img': [], 'page': [], 'bytes': os.path.getsize(out_path)}
    if not res['pages_ok']:
        return res
    for p in range(min(len(o), MAX_PAGES)):
        po, pd = o[p], d[p]
        po_imgs, pd_imgs = _placements(po), _placements(pd)
        for bbox, xo in po_imgs.items():
            to = _thumb(o, xo)
            if to is None:
                continue                      # original itself undecodable — nothing to hold it to
            xd = pd_imgs.get(bbox)
            td = _thumb(d, xd) if xd else None
            res['img'].append((p + 1, bbox, 255.0 if td is None else _mad(to, td)))
        ro = po.get_pixmap(dpi=60, colorspace=fitz.csRGB, alpha=False)
        rd = pd.get_pixmap(dpi=60, colorspace=fitz.csRGB, alpha=False)
        same = (ro.width, ro.height) == (rd.width, rd.height)
        res['page'].append((p + 1, _worst_tile(ro, rd) if same else 255.0))
    return res


def sound(s):
    """Is this output a faithful copy of the original (images + pages)?"""
    return (s and 'error' not in s and s['pages_ok']
            and all(v < IMG_BAD for *_, v in s['img'])
            and all(v < PAGE_BAD for _, v in s['page']))


def judge(entry):
    orig = entry['file']
    old_p = os.path.join(OUT, 'old', entry['name'] + '.pdf')
    new_p = os.path.join(OUT, 'new', entry['name'] + '.pdf')
    old = score(orig, old_p) if entry['old']['status'] == 'ok' else None
    new = score(orig, new_p) if entry['new']['status'] == 'ok' else None
    fails, notes = [], []

    if old and not new:
        fails.append(f"no output from NEW ({entry['new'].get('reason')}) where OLD produced one")
    if new and 'error' in new:
        fails.append(new['error'])
    if new and 'error' not in new:
        if not new['pages_ok']:
            fails.append('page count changed')
        old_img = {(p, b): v for p, b, v in (old or {}).get('img', [])} if old and 'error' not in old else {}
        for p, b, v in new['img']:
            ref = old_img.get((p, b))
            limit = max(IMG_BAD, (ref if ref is not None else 0) + IMG_SLACK)
            if v >= limit:
                fails.append(f'p{p} image {b}: {v:.1f} from original (old {ref if ref is None else round(ref, 1)})')
        old_pg = dict((old or {}).get('page', [])) if old and 'error' not in old else {}
        for p, v in new['page']:
            ref = old_pg.get(p)
            limit = max(PAGE_BAD, (ref if ref is not None else 0) + PAGE_SLACK)
            if v >= limit:
                fails.append(f'p{p} render: {v:.1f} from original (old {ref if ref is None else round(ref, 1)})')
        if old and sound(old) and new['bytes'] > old['bytes'] * SIZE_SLACK + 2048:
            fails.append(f"bigger than a sound OLD: {old['bytes']} → {new['bytes']} bytes (savings lost)")
    if old and not sound(old) and new and sound(new):
        notes.append('OLD output was corrupted, NEW is sound (fixed)')
    # Broken the SAME way in both builds = a pre-existing bug, not a regression
    # from this change: report it loudly, don't block the deploy on it.
    known = []
    if fails and old and new and not sound(old) and not sound(new):
        old_fails = set(f.split(':')[0] for f in judge_fails_of(old))
        known = [f for f in fails if f.split(':')[0] in old_fails or f == 'page count changed' and not old.get('pages_ok', True)]
        fails = [f for f in fails if f not in known]
    return {
        'name': entry['name'], 'kind': entry['kind'],
        'orig_bytes': os.path.getsize(orig),
        'old': old and old.get('bytes'), 'new': new and new.get('bytes'),
        'old_sound': bool(old and sound(old)), 'new_sound': bool(new and sound(new)),
        'old_status': entry['old'], 'new_status': entry['new'],
        'fails': fails, 'notes': notes, 'known': known,
    }


def judge_fails_of(s):
    """What makes an output unsound on its own (used to spot shared, pre-existing breakage)."""
    out = []
    if 'error' in s:
        out.append(s['error'])
    elif not s['pages_ok']:
        out.append('page count changed')
    else:
        out += [f'p{p} image {b}' for p, b, v in s['img'] if v >= IMG_BAD]
        out += [f'p{p} render' for p, v in s['page'] if v >= PAGE_BAD]
    return out


def main():
    runs = json.load(open(os.path.join(OUT, 'runs.json')))
    results = [judge(e) for e in runs['runs']]
    json.dump(results, open(os.path.join(OUT, 'report.json'), 'w'), indent=1, default=str)

    mb = lambda b: '—' if b is None else f'{b / 1e6:.2f}'
    print(f"corpus-diff [{runs['tool']}]  old={runs['old']}  new={runs['new']}\n")
    print(f"{'input':44} {'orig':>7} {'old':>7} {'new':>7}  old/new sound  result")
    for r in results:
        verdict = 'FAIL' if r['fails'] else ('fixed' if r['notes'] else ('⚠ BROKEN IN BOTH (pre-existing)' if r['known'] else 'ok'))
        if not r['fails'] and r['old'] is None and r['new'] is None:
            verdict = f"ok (no output: {r['new_status'].get('reason', '')[:40]})"
        print(f"{r['name'][:44]:44} {mb(r['orig_bytes']):>7} {mb(r['old']):>7} {mb(r['new']):>7}  "
              f"{'y' if r['old_sound'] else 'n'}/{'y' if r['new_sound'] else 'n'}            {verdict}")
        for f in r['fails']:
            print(f'      ✗ {f}')
        for f in r['known']:
            print(f'      ⚠ {f}')
    failed = [r for r in results if r['fails']]
    print(f"\n{len(results)} inputs · {len(failed)} FAIL · {sum(1 for r in results if r['notes'])} fixed vs old · "
          f"{sum(1 for r in results if r['known'])} broken in both (pre-existing)")
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
