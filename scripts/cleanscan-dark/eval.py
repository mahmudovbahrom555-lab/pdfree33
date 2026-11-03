# python3 eval.py <build-dir-prefix: main|new>  → per-page table for S, identity for C
import fitz, json, os, re, subprocess, sys, difflib, tempfile
import numpy as np
from PIL import Image, ImageFilter
B = os.path.dirname(os.path.abspath(__file__))
FIX = '/Users/murodjon/pdfree33/pdfree33/tests/fixtures/clean-scan/dark'
truth = json.load(open(f'{FIX}/truth.json'))
norm = lambda s: re.sub(r'\s+', '', s).lower()

def page_img(pdf):
    d = fitz.open(pdf); x = d.extract_image(d[0].get_images(full=True)[0][0])
    return x['image'], x['ext']

def gray(pdf):
    raw, ext = page_img(pdf)
    p = os.path.join(tempfile.mkdtemp(), 'p.' + ext); open(p, 'wb').write(raw)
    return np.array(Image.open(p).convert('L')), p

def ocr(path, lang):
    return subprocess.run(['tesseract', path, '-', '-l', lang, '--psm', '3'], capture_output=True, text=True).stdout

def recall(t, o):
    t, o = norm(t), norm(o)
    m = difflib.SequenceMatcher(None, t, o, autojunk=False)
    return sum(b.size for b in m.get_matching_blocks()) / max(1, len(t))

def ink_mask(arr, grow=6):
    m = Image.fromarray(((arr < 128) * 255).astype('uint8')).filter(ImageFilter.MaxFilter(2 * grow + 1))
    return np.array(m) > 0

rows = []
for name, tr in truth.items():
    twin, _ = gray(f'{B}/main-T/{name}.keep.pdf')
    twin_ink = ink_mask(twin)
    twin_size = os.path.getsize(f'{B}/main-T/{name}.keep.pdf')
    for build in sys.argv[1:]:
        for keep in ('keep', 'nokeep'):
            f = f'{B}/{build}-S/{name}.{keep}.pdf'
            arr, p = gray(f)
            if arr.shape != twin.shape: arr = np.array(Image.fromarray(arr).resize(twin.shape[::-1]))
            text = ocr(p, tr['lang'])
            white = (arr[~twin_ink] >= 230).mean()
            rows.append(dict(name=name, build=build, keep=keep, recall=round(recall(tr['text'], text), 3),
                             white=round(float(white), 3), size_x=round(os.path.getsize(f) / twin_size, 2)))
            if name == 'mixed-box':
                cap = [l for l in tr['text'].split('\n') if l.strip()]
                rows[-1]['caption'] = round(min(recall(c, text) for c in (cap[0], cap[-1])), 3)
for r in rows: print(r)
json.dump(rows, open(f'{B}/eval-{"-".join(sys.argv[1:])}.json', 'w'), indent=1)
