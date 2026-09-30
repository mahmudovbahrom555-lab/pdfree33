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

Tool-specific inputs/outputs are normalised first, so the same checks apply:
  • merge — the expected original is the input + the fixed reference file,
            concatenated here with MuPDF (what a correct merge must equal)
  • split — a ZIP of per-page PDFs is concatenated back into one document,
            entries ordered by page NUMBER (a plain sort puts page_13 before
            page_4)
  • size is only judged for compress (split output legitimately repeats
            shared resources in every page file)

Text tools (pdf2md) are judged against the original's TEXT (MuPDF), per
build, relative to OLD — see judge_text():
  • recall     — share of the original's words present in the output
                 (markup stripped; CJK counted per character, no spaces there)
  • garbage    — U+FFFD / private-use characters per output character
  • inflation  — output words / original words (duplication)
  • ERI        — the page's own structure score (js/eriScoreMd.js)

Usage: python3 scripts/corpus-diff/check.py [out-dir]   (default corpus-diff-out)
"""
import json
import os
import re
import sys
import unicodedata
import zipfile
from collections import Counter

import fitz

fitz.TOOLS.mupdf_display_errors(False)

OUT = next((a for a in sys.argv[1:] if not a.startswith('-')), 'corpus-diff-out')
VERBOSE = '-v' in sys.argv[1:]
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


def _concat(parts, dest):
    out = fitz.open()
    for part in parts:
        src = _open(part) if isinstance(part, str) else fitz.open(stream=part, filetype='pdf')
        out.insert_pdf(src)
    out.save(dest)
    return dest


def expected_original(entry, runs):
    if runs['tool'] != 'merge':
        return entry['file']
    os.makedirs(os.path.join(OUT, 'expected'), exist_ok=True)
    return _concat([entry['file'], runs['ref']], os.path.join(OUT, 'expected', entry['name'] + '.pdf'))


def output_pdf(entry, side):
    """The side's output as ONE pdf path (a split ZIP is re-joined by page number)."""
    name = entry[side].get('file')
    if entry[side]['status'] != 'ok' or not name:
        return None
    path = os.path.join(OUT, side, name)
    if not name.endswith('.zip'):
        return path
    with zipfile.ZipFile(path) as z:
        members = [m for m in z.namelist() if m.lower().endswith('.pdf')]
        members.sort(key=lambda m: [int(n) for n in re.findall(r'\d+', m)] or [0])
        parts = [z.read(m) for m in members]
    os.makedirs(os.path.join(OUT, side + '-joined'), exist_ok=True)
    return _concat(parts, os.path.join(OUT, side + '-joined', entry['name'] + '.pdf'))


TEXT_TOOLS = {'pdf2md'}
MIN_WORDS = 50                                  # below this the original has no real text layer to hold output to
RECALL_BAD, RECALL_SLACK = 0.85, 0.02
GARBAGE_BAD, GARBAGE_SLACK = 0.005, 0.002
INFLATE_BAD, INFLATE_SLACK = 1.5, 0.1
ERI_SLACK = 5.0
_CJK = r'\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff'
_TOKEN = re.compile(rf'[{_CJK}]|[^\W\d_{_CJK}]{{2,}}|\d+', re.UNICODE)
_GARBAGE = re.compile(r'[\ufffd\ue000-\uf8ff]')


def _words(text):
    return Counter(_TOKEN.findall(unicodedata.normalize('NFKC', text).lower()))


def _markdown_text(path):
    if path.endswith('.zip'):
        with zipfile.ZipFile(path) as z:
            md = z.read('document.md').decode('utf-8', 'replace')
    else:
        md = open(path, encoding='utf-8', errors='replace').read()
    md = re.sub(r'!\[[^\]]*\]\([^)]*\)', ' ', md)          # images: alt text isn't in the original
    md = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', md)       # links: keep the label
    return md


def text_score(orig_words, out_path, eri):
    try:
        md = _markdown_text(out_path)
    except Exception as e:
        return {'error': f'unreadable: {e}'}
    got = _words(md)
    total = sum(orig_words.values())
    return {
        'recall': sum(min(n, got[w]) for w, n in orig_words.items()) / total,
        'garbage': len(_GARBAGE.findall(md)) / max(1, len(md)),
        'inflation': sum(got.values()) / total,
        'eri': (eri or {}).get('eri'),
        'bytes': os.path.getsize(out_path),
    }


def text_sound(s):
    return (s and 'error' not in s and s['recall'] >= RECALL_BAD
            and s['garbage'] <= GARBAGE_BAD and s['inflation'] <= INFLATE_BAD)


def judge_text(entry, runs):
    orig_doc = _open(entry['file'])
    orig_words = _words(''.join(p.get_text() for p in orig_doc))
    paths = {side: (os.path.join(OUT, side, entry[side]['file'])
                    if entry[side]['status'] == 'ok' and entry[side].get('file') else None)
             for side in ('old', 'new')}
    result = {'name': entry['name'], 'kind': entry['kind'], 'orig_bytes': os.path.getsize(entry['file']),
              'fails': [], 'notes': [], 'known': []}
    if sum(orig_words.values()) < MIN_WORDS:
        # No text layer to measure against — only require that NEW still answers where OLD did
        result.update(old=paths['old'] and os.path.getsize(paths['old']), new=paths['new'] and os.path.getsize(paths['new']),
                      old_sound=bool(paths['old']), new_sound=bool(paths['new']), old_status=entry['old'], new_status=entry['new'])
        if paths['old'] and not paths['new']:
            result['fails'].append(f"no output from NEW ({entry['new'].get('reason')}) where OLD produced one")
        return result
    old = text_score(orig_words, paths['old'], entry['old'].get('eri')) if paths['old'] else None
    new = text_score(orig_words, paths['new'], entry['new'].get('eri')) if paths['new'] else None
    fails, notes, known = result['fails'], result['notes'], result['known']

    if old and not new:
        (fails if text_sound(old) else notes).append(
            f"no output from NEW ({entry['new'].get('reason')})" + ('' if text_sound(old) else ' where OLD was unsound'))
    if new and 'error' in new:
        fails.append(new['error'])
    if new and 'error' not in new:
        ref = old if old and 'error' not in old else None
        if new['recall'] < min(RECALL_BAD, (ref['recall'] if ref else 1) - RECALL_SLACK):
            fails.append(f"recall {new['recall']:.3f} (old {ref['recall']:.3f})" if ref else f"recall {new['recall']:.3f}")
        if new['garbage'] > max(GARBAGE_BAD, (ref['garbage'] if ref else 0) + GARBAGE_SLACK):
            fails.append(f"garbage chars {new['garbage']:.4f} (old {ref['garbage']:.4f})" if ref else f"garbage chars {new['garbage']:.4f}")
        if new['inflation'] > max(INFLATE_BAD, (ref['inflation'] if ref else 0) + INFLATE_SLACK):
            fails.append(f"inflation {new['inflation']:.2f} (old {ref['inflation']:.2f})" if ref else f"inflation {new['inflation']:.2f}")
        if ref and ref.get('eri') is not None and new.get('eri') is not None and new['eri'] < ref['eri'] - ERI_SLACK:
            fails.append(f"ERI {new['eri']} (old {ref['eri']})")
    both_errored = (not old and not new
                    and all('error' in (entry[side].get('reason') or '').lower() for side in ('old', 'new')))
    if both_errored:
        known.append(f"tool error in both builds: {(entry['new'].get('reason') or '')[:70]}")
    if fails and old and new and not text_sound(old) and not text_sound(new):
        # same weakness in both builds = pre-existing, not a regression from this change
        known.extend(fails); fails.clear()
    if not known and old and new and 'error' not in old and 'error' not in new \
            and not text_sound(old) and not text_sound(new):
        # Equally bad in both builds is not "ok": it's a pre-existing defect the
        # report must show (e.g. RTL text reversed / glued by pdf2md).
        known.append('below the soundness bar in both builds')
    if old and not text_sound(old) and new and text_sound(new):
        notes.append('OLD output was unsound, NEW is sound (fixed)')
    fmt = lambda s: None if not s or 'error' in s else f"recall {s['recall']:.3f} · garbage {s['garbage']:.4f} · infl {s['inflation']:.2f} · ERI {s['eri']}"
    result.update(old=old and old.get('bytes'), new=new and new.get('bytes'),
                  old_sound=text_sound(old), new_sound=text_sound(new),
                  old_status=entry['old'], new_status=entry['new'],
                  detail={'old': fmt(old), 'new': fmt(new)})
    return result


def judge(entry, runs):
    if runs['tool'] in TEXT_TOOLS:
        return judge_text(entry, runs)
    orig = expected_original(entry, runs)
    old_p, new_p = output_pdf(entry, 'old'), output_pdf(entry, 'new')
    old = score(orig, old_p) if old_p else None
    new = score(orig, new_p) if new_p else None
    fails, notes = [], []

    if old and not new:
        if sound(old):
            fails.append(f"no output from NEW ({entry['new'].get('reason')}) where OLD produced a sound one")
        else:
            # Refusing (e.g. "password protected — unlock it first") beats handing
            # back the corrupt file OLD produced.
            notes.append(f"NEW refuses ({entry['new'].get('reason', '')[:60]}) where OLD returned a corrupt file (fixed)")
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
        if runs['tool'] == 'compress' and old and sound(old) and new['bytes'] > old['bytes'] * SIZE_SLACK + 2048:
            fails.append(f"bigger than a sound OLD: {old['bytes']} → {new['bytes']} bytes (savings lost)")
    # Neither build produced anything and the tool reported an ERROR (not a
    # deliberate refusal like "password protected" or "Try Standard") on a PDF
    # MuPDF opens fine: a pre-existing failure — e.g. split erroring on 8 of 9
    # real arXiv papers — that must show up, not pass silently as "no output".
    both_errored = (not old and not new
                    and all('error' in (entry[side].get('reason') or '').lower() for side in ('old', 'new')))
    if both_errored:
        fails_known_error = f"tool error in both builds: {(entry['new'].get('reason') or '')[:70]}"
    if old and not sound(old) and new and sound(new):
        notes.append('OLD output was corrupted, NEW is sound (fixed)')
    if not old and new and sound(new) and 'error' in (entry['old'].get('reason') or '').lower():
        notes.append('OLD errored, NEW produces a sound output (fixed)')
    # Broken the SAME way in both builds = a pre-existing bug, not a regression
    # from this change: report it loudly, don't block the deploy on it.
    known = [fails_known_error] if both_errored else []
    if not fails and old and new and 'error' not in old and 'error' not in new and not sound(old) and not sound(new):
        known.append('unsound in both builds')
    if fails and old and new and not sound(old) and not sound(new):
        old_fails = set(f.split(':')[0] for f in judge_fails_of(old))
        known += [f for f in fails if f.split(':')[0] in old_fails or f == 'page count changed' and not old.get('pages_ok', True)]
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
    results = [judge(e, runs) for e in runs['runs']]
    json.dump(results, open(os.path.join(OUT, 'report.json'), 'w'), indent=1, default=str)

    mb = lambda b: '—' if b is None else f'{b / 1e6:.2f}'
    print(f"corpus-diff [{runs['tool']}]  old={runs['old']}  new={runs['new']}\n")
    print(f"{'input':44} {'orig':>7} {'old':>7} {'new':>7}  old/new sound  result")
    for r in results:
        verdict = 'FAIL' if r['fails'] else ('fixed' if r['notes'] else ('⚠ BROKEN IN BOTH (pre-existing)' if r['known'] else 'ok'))
        if not r['fails'] and not r['known'] and r['old'] is None and r['new'] is None:
            verdict = f"ok (no output: {r['new_status'].get('reason', '')[:40]})"
        print(f"{r['name'][:44]:44} {mb(r['orig_bytes']):>7} {mb(r['old']):>7} {mb(r['new']):>7}  "
              f"{'y' if r['old_sound'] else 'n'}/{'y' if r['new_sound'] else 'n'}            {verdict}")
        if r.get('detail') and (r['fails'] or r['known'] or VERBOSE):
            print(f"      old: {r['detail']['old']}\n      new: {r['detail']['new']}")
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
