import fitz, json, random, numpy as np, cv2, pickle
from c4scan import font_digit_map, fold
import shape
rows = json.load(open('../ar/c4scan3.json'))
bad = [r for r in rows if r['wrong']]
random.seed(7)
items = []
for r in bad:
    doc = fitz.open('../ar/docs/' + r['doc']); got = []
    for pno in r['pages_wrong']:
        page = doc[pno - 1]; byname = {}
        for f in page.get_fonts(full=True): byname.setdefault(f[3].split('+')[-1], f[0])
        for sp in page.get_texttrace():
            xref = byname.get(sp['font']) or byname.get(sp['font'].split('+')[-1])
            fmap, _ = font_digit_map(doc, xref) if xref else (None, None)
            if not fmap: continue
            tv = [fold(chr(c[0])) for c in sp['chars'] if c[0] > 0 and fold(chr(c[0])) is not None]
            gv = [fmap[c[1]] for c in sp['chars'] if c[1] in fmap]
            if tv != gv and sorted(tv) == sorted(gv): continue            # order-only span: another class
            glyphs = []
            for c in sp['chars']:
                fv = fmap.get(c[1]); t = fold(chr(c[0])) if c[0] > 0 else None
                if fv is None: continue
                img, h = shape.page_glyph(page, c[3], sp['bbox'])
                glyphs.append((c, fv, t, img, h))
            if not glyphs: continue
            hmax = max(g[4] for g in glyphs) or 1
            for c, fv, t, img, h in glyphs:
                if t is not None and t != fv and img is not None:
                    got.append({'doc': r['doc'], 'page': pno, 'font': sp['font'], 'text': t, 'fontcmap': fv, 'rel_h': h / hmax, 'img': img,
                                'bbox': c[3], 'span': sp['bbox']})
    random.shuffle(got)
    items += got[:8]
print('calibration items', len(items), 'from', len({i['doc'] for i in items}), 'docs')
pickle.dump(items, open('../c4crops/calib.pkl', 'wb'))
# sheets: show the real glyph at 300 dpi with a little context
for s in range(0, len(items), 30):
    tiles = []
    for k, it in enumerate(items[s:s + 30]):
        doc = fitz.open('../ar/docs/' + it['doc']); page = doc[it['page'] - 1]
        b = it['bbox']; sp = it['span']
        r = fitz.Rect(b[0] - 1, sp[1] - 1, b[2] + 1, sp[3] + 1) & page.rect
        pix = page.get_pixmap(dpi=300, clip=r); im = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w, pix.n)[:, :, :3].copy()
        im = cv2.resize(im, (max(8, int(im.shape[1] * 60 / max(1, im.shape[0]))), 60))
        tile = np.full((70, 200, 3), 255, np.uint8); tile[5:65, 60:60 + min(130, im.shape[1])] = im[:, :130]
        cv2.putText(tile, str(s + k + 1), (2, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
        tiles.append(tile)
    while len(tiles) % 5: tiles.append(np.full((70, 200, 3), 255, np.uint8))
    grid = np.vstack([np.hstack(tiles[i:i + 5]) for i in range(0, len(tiles), 5)])
    cv2.imwrite(f'../c4crops/calib_{s // 30 + 1}.png', grid[:, :, ::-1])
