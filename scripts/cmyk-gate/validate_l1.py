#!/usr/bin/env python3
"""Is the L1 gate itself right? Run it both ways on the CMYK fixtures (2026-11-05).

  python3 scripts/cmyk-gate/validate_l1.py <work-dir>

Correct L (lossless) — must PASS on every fixture:
  Flate images re-deflated at zlib level 9; JPEG images through jpegtran -optimize -copy all.
Broken on purpose — each must FAIL, on the tests named:
  cmyk-to-rgb        a CMYK image converted to RGB                         T1
  k-gets-cmy         C=M=Y=20 added under pure K (k-only-flate)        T6
  icc-swapped        another CMYK profile in place of the document's       T2
  overprint-removed  /OP /op /OPM dropped (overprint)                      T3+T4
  jpeg-q30           JPEG re-encoded at quality 30                         T6
  reencode-as-L      JPEG decoded and re-encoded at 95, presented as L     T6
  reencode-same-tables  re-encoded with the SAME tables and sampling     T6 (pixels)
  shared-split       one use of the shared image pointed at a copy         T8
  shift-1pt          one placement moved by 1 pt                           T3+T4, T9
"""
import io, os, subprocess, sys, zlib, tempfile, glob
import numpy as np
import pikepdf
from pikepdf import Name
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from l1_gate import gate, is_target, image_uses   # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
FIXTURES = ['photo-jpeg', 'photo-flate', 'k-only', 'k-only-flate', 'rich-black', 'overprint', 'spot', 'transparency',
            'output-intent', 'icc-cmyk', 'shared', 'mixed']


def targets(pdf):
    seen, out = set(), []
    for _, s in image_uses(pdf):
        if is_target(s) and s.objgen not in seen: seen.add(s.objgen); out.append(s)
    return out


def jpeg_pixels(s): return np.asarray(Image.open(io.BytesIO(s.read_raw_bytes())))


def cmyk_image(arr): return Image.frombytes('CMYK', (arr.shape[1], arr.shape[0]), arr.tobytes())


def put_jpeg(s, arr, q):
    b = io.BytesIO(); cmyk_image(arr).save(b, 'JPEG', quality=q)
    s.write(b.getvalue(), filter=Name.DCTDecode)


def good_l(pdf):
    for s in targets(pdf):
        if s.Filter == Name.FlateDecode:
            s.write(zlib.compress(s.read_bytes(), 9), filter=Name.FlateDecode)
        else:
            r = subprocess.run(['jpegtran', '-optimize', '-copy', 'all'], input=s.read_raw_bytes(), capture_output=True)
            if r.returncode == 0: s.write(r.stdout, filter=Name.DCTDecode)   # else left as it is (T10)
            else: good_l.skipped += 1


good_l.skipped = 0


def cmyk_to_rgb(pdf):
    s = targets(pdf)[0]
    arr = jpeg_pixels(s) if s.Filter == Name.DCTDecode else np.frombuffer(s.read_bytes(), np.uint8).reshape(int(s.Height), int(s.Width), 4)
    rgb = np.asarray(cmyk_image(arr).convert('RGB'))
    s.write(zlib.compress(rgb.tobytes(), 9), filter=Name.FlateDecode); s.ColorSpace = Name.DeviceRGB


def k_gets_cmy(pdf):
    s = targets(pdf)[0]
    arr = np.frombuffer(s.read_bytes(), np.uint8).reshape(int(s.Height), int(s.Width), 4).copy() \
        if s.Filter == Name.FlateDecode else jpeg_pixels(s).copy()
    k = (arr[..., 0] == 0) & (arr[..., 1] == 0) & (arr[..., 2] == 0) & (arr[..., 3] > 200)
    assert k.sum() > 1000, f'only {k.sum()} pure-K pixels — the mutation would test nothing'
    arr[k, :3] = 20
    if s.Filter == Name.FlateDecode: s.write(zlib.compress(arr.tobytes(), 9), filter=Name.FlateDecode)
    else: put_jpeg(s, arr, 92)


def icc_swapped(pdf):
    other = glob.glob('/opt/homebrew/Cellar/ghostscript/*/share/ghostscript/iccprofiles/ps_cmyk.icc') \
        + glob.glob('/usr/share/ghostscript/*/iccprofiles/ps_cmyk.icc') + glob.glob('/usr/share/color/icc/ghostscript/ps_cmyk.icc')
    data = open(other[0], 'rb').read()
    for oi in pdf.Root.get('/OutputIntents', []): oi.DestOutputProfile.write(data)
    for o in pdf.objects:
        if isinstance(o, pikepdf.Array) and len(o) == 2 and o[0] == Name.ICCBased: o[1].write(data)
    for _, s in image_uses(pdf):
        cs = s.get('/ColorSpace')
        if isinstance(cs, pikepdf.Array) and cs[0] == Name.ICCBased: cs[1].write(data)


def overprint_removed(pdf):
    for p in pdf.pages:
        for _, g in p.Resources.get('/ExtGState', {}).items():
            for k in ('/OP', '/op', '/OPM'):
                if k in g: del g[k]


def jpeg_q30(pdf):
    s = [t for t in targets(pdf) if t.Filter == Name.DCTDecode][0]; put_jpeg(s, jpeg_pixels(s), 30)


def reencode_as_l(pdf):
    s = [t for t in targets(pdf) if t.Filter == Name.DCTDecode][0]; put_jpeg(s, jpeg_pixels(s), 95)


def reencode_same_tables(pdf):
    # the hardest fake L: same quantization tables and sampling, so DQT/SOF match — only pixels tell
    s = [t for t in targets(pdf) if t.Filter == Name.DCTDecode][0]
    im = Image.open(io.BytesIO(s.read_raw_bytes()))
    b = io.BytesIO(); cmyk_image(np.asarray(im)).save(b, 'JPEG', qtables=im.quantization, subsampling=0)
    s.write(b.getvalue(), filter=Name.DCTDecode)


def shared_split(pdf):
    p = pdf.pages[1]
    old = p.Resources.XObject.Im0
    copy = pdf.make_stream(old.read_raw_bytes())
    for k in old.keys():
        if k != '/Length': copy[k] = old[k]
    p.Resources.XObject.Im0 = copy


def shift_1pt(pdf):
    p = pdf.pages[0]
    c = p.Contents.read_bytes().decode()
    i = c.index(' cm /Im0 Do')
    head, tail = c[:i].rsplit(' ', 2)[0], c[i:]
    x, y = c[:i].rsplit(' ', 2)[1:]
    p.Contents = pdf.make_stream(f'{head} {float(x) + 1:g} {y}{tail}'.encode())


BROKEN = [  # (name, fixture, mutation, tests that must fail)
    ('cmyk-to-rgb', 'photo-jpeg', cmyk_to_rgb, {'T1'}),
    ('k-gets-cmy', 'k-only-flate', k_gets_cmy, {'T6'}),
    ('icc-swapped (OutputIntent)', 'output-intent', icc_swapped, {'T2'}),
    ('icc-swapped (ICCBased image)', 'icc-cmyk', icc_swapped, {'T2'}),
    ('overprint-removed', 'overprint', overprint_removed, {'T3+T4'}),
    ('jpeg-q30', 'photo-jpeg', jpeg_q30, {'T6'}),
    ('reencode-as-L', 'photo-jpeg', reencode_as_l, {'T6'}),
    ('reencode-same-tables', 'photo-jpeg', reencode_same_tables, {'T6'}),
    ('shared-split', 'shared', shared_split, {'T8'}),
    ('shift-1pt', 'photo-flate', shift_1pt, {'T3+T4', 'T9'}),
]


def run(work):
    fx = os.path.join(work, 'fixtures'); os.makedirs(fx, exist_ok=True)
    subprocess.run([sys.executable, os.path.join(ROOT, 'tests/fixtures/compress-cmyk/make.py'), fx], check=True, capture_output=True)
    def variant(fixture, fn, tag):
        out = os.path.join(work, f'{fixture}.{tag}.pdf')
        with pikepdf.open(os.path.join(fx, fixture + '.pdf')) as pdf:
            fn(pdf); pdf.save(out, deterministic_id=True)
        return out
    # --prod = the same file rewritten unchanged by the same writer, as production's output would be
    prod = {f: variant(f, lambda pdf: None, 'prod') for f in FIXTURES}
    bad = 0
    print('— correct L, must PASS')
    for f in FIXTURES:
        r = gate(os.path.join(fx, f + '.pdf'), variant(f, good_l, 'L'), prod=prod[f], mode='L')
        fails = [t for t, v in r.items() if not v['ok']]
        bad += bool(fails)
        print(f"  {'ok  ' if not fails else 'BAD '} {f:14} {'all pass' if not fails else fails}  ({r['T6']['detail']}; {r['T5']['detail'].split(';')[0]})")
        for t in fails: print(f'         {t}: {r[t]["detail"]}')
    print('— broken, must FAIL on the named tests')
    for name, f, fn, want in BROKEN:
        r = gate(os.path.join(fx, f + '.pdf'), variant(f, fn, name.split()[0]), prod=prod[f], mode='L')
        fails = {t for t, v in r.items() if not v['ok']}
        ok = want <= fails
        bad += not ok
        print(f"  {'ok  ' if ok else 'BAD '} {name:30} failed {sorted(fails)}  (expected {sorted(want)})")
        for t in sorted(fails): print(f'         {t}: {r[t]["detail"][:150]}')
    print('\nGATE VALIDATED' if not bad else f'\n{bad} PROBLEM(S)')
    return bad


if __name__ == '__main__':
    sys.exit(1 if run(sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix='cmyk-l1-')) else 0)
