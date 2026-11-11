#!/usr/bin/env python3
"""Colour checks for CMYK mode D (criteria v0.2, level 2), original vs output, Ghostscript renders.

  python3 d_metrics.py <orig.pdf> <out.pdf> [--dpi 150] [--pages 6]   → one JSON line

- V1 pure K: pixels whose original C = M = Y = 0 and K > 0 (separated plates) — the share where
  the output has any of C, M, Y above 2/255.
- V2/V3 ΔE2000 by 8×8 block: tiff32nc renders → Lab through Ghostscript's default_cmyk.icc
  (a CONDITIONAL measurement profile, flagged); blocks split by the original's luminance
  variance (flat < 4, textured >= 4); mean, p95, max.
- V5 plates: tiffsep plates — mean |Δ| and p99 as % of 255 per C/M/Y/K plate; spot plates by name.
"""
import sys, os, json, glob, subprocess, tempfile, argparse
import numpy as np
from PIL import Image, ImageCms

ICC = (glob.glob('/opt/homebrew/Cellar/ghostscript/*/share/ghostscript/iccprofiles/default_cmyk.icc') + ['/usr/share/color/icc/ghostscript/default_cmyk.icc'])[0]
GS_VERSION = subprocess.run(['gs', '--version'], capture_output=True, text=True).stdout.strip()


def gs(args):
    subprocess.run(['gs', '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER'] + args, check=True, capture_output=True)


def plates(pdf, dpi, pages, tmp, tag):
    out = f'{tmp}/{tag}'
    os.makedirs(out, exist_ok=True)
    gs(['-sDEVICE=tiffsep', f'-r{dpi}', '-sOverprint=simulate', f'-dLastPage={pages}', f'-sOutputFile={out}/p%03d.tif', pdf])
    res = {}
    for f in sorted(glob.glob(f'{out}/p*(*).tif')):
        page = os.path.basename(f)[:4]; plate = os.path.basename(f).split('(')[1].split(')')[0]
        res[(page, plate)] = np.asarray(Image.open(f).convert('L')).astype(np.int16)
    return res


def cmyk_render(pdf, dpi, pages, tmp, tag):
    out = f'{tmp}/{tag}c'
    os.makedirs(out, exist_ok=True)
    gs(['-sDEVICE=tiff32nc', f'-r{dpi}', f'-dLastPage={pages}', f'-sOutputFile={out}/p%03d.tif', pdf])
    return {os.path.basename(f)[:4]: Image.open(f).copy() for f in sorted(glob.glob(f'{out}/p*.tif'))}


# KNOWN BUG (found 2026-11-11, reported to the owner, NOT fixed here on purpose): PIL's LAB stores a and b
# as SIGNED bytes (grey → 0), so '- 128' below is wrong; every ΔE this file produced for D300 needs a
# recompute after the owner's OK. jpx_check.lab() reads them as int8.
def to_lab(cmyk_img):
    t = ImageCms.buildTransform(ICC, ImageCms.createProfile('LAB'), 'CMYK', 'LAB')
    lab = np.asarray(ImageCms.applyTransform(cmyk_img, t)).astype(np.float64)
    L = lab[..., 0] * 100 / 255; a = lab[..., 1] - 128; b = lab[..., 2] - 128
    return np.stack([L, a, b], -1)


def de2000(l1, l2):
    L1, a1, b1 = l1[..., 0], l1[..., 1], l1[..., 2]; L2, a2, b2 = l2[..., 0], l2[..., 1], l2[..., 2]
    C1, C2 = np.hypot(a1, b1), np.hypot(a2, b2); Cm = (C1 + C2) / 2
    G = 0.5 * (1 - np.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p, h2p = np.degrees(np.arctan2(b1, a1p)) % 360, np.degrees(np.arctan2(b2, a2p)) % 360
    dLp, dCp = L2 - L1, C2p - C1p
    dh = h2p - h1p; dh = np.where(dh > 180, dh - 360, np.where(dh < -180, dh + 360, dh)); dh = np.where(C1p * C2p == 0, 0, dh)
    dHp = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dh / 2))
    Lpm, Cpm = (L1 + L2) / 2, (C1p + C2p) / 2
    hs = h1p + h2p; hpm = np.where(C1p * C2p == 0, hs, np.where(np.abs(h1p - h2p) <= 180, hs / 2, np.where(hs < 360, (hs + 360) / 2, (hs - 360) / 2)))
    T = 1 - 0.17 * np.cos(np.radians(hpm - 30)) + 0.24 * np.cos(np.radians(2 * hpm)) + 0.32 * np.cos(np.radians(3 * hpm + 6)) - 0.20 * np.cos(np.radians(4 * hpm - 63))
    SL = 1 + 0.015 * (Lpm - 50) ** 2 / np.sqrt(20 + (Lpm - 50) ** 2); SC = 1 + 0.045 * Cpm; SH = 1 + 0.015 * Cpm * T
    RT = -2 * np.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7)) * np.sin(np.radians(60 * np.exp(-(((hpm - 275) / 25) ** 2))))
    return np.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH))


def blocks(arr, k=8):
    h, w = arr.shape[:2]; h, w = h // k * k, w // k * k
    a = arr[:h, :w]
    return a.reshape(h // k, k, w // k, k, *a.shape[2:]).swapaxes(1, 2)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('orig'); ap.add_argument('out'); ap.add_argument('--dpi', type=int, default=150); ap.add_argument('--pages', type=int, default=6)
    a = ap.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        po, pn = plates(a.orig, a.dpi, a.pages, tmp, 'o'), plates(a.out, a.dpi, a.pages, tmp, 'n')
        res = {'gs': GS_VERSION, 'profile': 'default_cmyk.icc (conditional)', 'v5': {}, 'spots_changed': []}
        for plate in ('Cyan', 'Magenta', 'Yellow', 'Black'):
            d = np.concatenate([np.abs(po[(p, plate)] - pn[(p, plate)]).ravel() for (p, pl) in po if pl == plate and (p, plate) in pn] or [np.zeros(1)])
            res['v5'][plate] = {'mean_pct': round(100 * d.mean() / 255, 3), 'p99_pct': round(100 * np.percentile(d, 99) / 255, 2)}
        for (p, pl) in po:
            if pl not in ('Cyan', 'Magenta', 'Yellow', 'Black') and (p, pl) in pn and np.abs(po[(p, pl)] - pn[(p, pl)]).mean() > 0.5:
                res['spots_changed'].append(pl)
        # V1 — tiffsep plates are inverted (255 = no ink)
        bad = tot = 0
        for p in {p for (p, _) in po}:
            if not all((p, x) in po and (p, x) in pn for x in ('Cyan', 'Magenta', 'Yellow', 'Black')): continue
            inkC, inkM, inkY, inkK = (255 - po[(p, x)] for x in ('Cyan', 'Magenta', 'Yellow', 'Black'))
            pure = (inkC == 0) & (inkM == 0) & (inkY == 0) & (inkK > 0)
            nC, nM, nY = (255 - pn[(p, x)] for x in ('Cyan', 'Magenta', 'Yellow'))
            tot += int(pure.sum()); bad += int((pure & ((nC > 2) | (nM > 2) | (nY > 2))).sum())
        res['v1_pure_k_pixels'] = tot; res['v1_violations_pct'] = round(100 * bad / tot, 3) if tot else None
        # V2/V3
        ro, rn = cmyk_render(a.orig, a.dpi, a.pages, tmp, 'o'), cmyk_render(a.out, a.dpi, a.pages, tmp, 'n')
        flat, tex = [], []
        for p in ro:
            if p not in rn or ro[p].size != rn[p].size: continue
            lo, ln = to_lab(ro[p]), to_lab(rn[p])
            de = blocks(de2000(lo, ln)).mean((2, 3))
            var = blocks(lo[..., 0]).std((2, 3))
            flat.append(de[var < 4].ravel()); tex.append(de[var >= 4].ravel())
        for name, arrs in (('v2_flat', flat), ('v3_textured', tex)):
            x = np.concatenate(arrs) if arrs else np.zeros(0)
            res[name] = {'blocks': int(x.size), 'mean': round(float(x.mean()), 3) if x.size else None, 'p95': round(float(np.percentile(x, 95)), 3) if x.size else None, 'max': round(float(x.max()), 2) if x.size else None}
    print(json.dumps({'orig': os.path.basename(a.orig), 'out': os.path.basename(a.out), **res}))


if __name__ == '__main__':
    main()
