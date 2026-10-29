import sys, os, time, json, zipfile, fitz, numpy as np
sys.path.insert(0, '/tmp/claude-501/paddle/lib')
from rapidocr import RapidOCR, OCRVersion, ModelType, LangDet, LangRec
from xml.sax.saxutils import escape
variant, src, out = sys.argv[1], sys.argv[2], sys.argv[3]
params = {'Det.ocr_version': OCRVersion.PPOCRV5, 'Rec.ocr_version': OCRVersion.PPOCRV5,
          'Det.lang_type': LangDet.CH, 'Rec.lang_type': LangRec.CH, 'Global.log_level': 'error'}
mt = ModelType.SERVER if variant == 'S' else ModelType.MOBILE
params['Det.model_type'] = mt; params['Rec.model_type'] = mt
if variant == 'M4': params['Global.max_side_len'] = 4000
eng = RapidOCR(params=params)
os.makedirs(out + '/files', exist_ok=True); times = {}
for f in sorted(os.listdir(src)):
    if not f.endswith('.pdf'): continue
    d = fitz.open(os.path.join(src, f)); lines = []; t0 = time.time()
    for page in d:
        imgs = page.get_images(full=True)
        pm = fitz.Pixmap(d, imgs[0][0]) if imgs else page.get_pixmap(dpi=300)
        if pm.n - pm.alpha >= 3 or pm.alpha: pm = fitz.Pixmap(fitz.csRGB, pm, 0)
        a = np.frombuffer(pm.samples, np.uint8).reshape(pm.height, pm.width, pm.n)
        if pm.n == 1: a = np.repeat(a, 3, axis=2)
        r = eng(np.ascontiguousarray(a[:, :, ::-1]))
        lines += list(r.txts or [])
    times[f] = round(time.time() - t0, 2)
    body = ''.join(f'<w:p><w:r><w:t xml:space="preserve">{escape(l)}</w:t></w:r></w:p>' for l in lines)
    with zipfile.ZipFile(f'{out}/files/{f}.pdf2word.docx', 'w') as z:
        z.writestr('word/document.xml', f'<w:document xmlns:w="x"><w:body>{body}</w:body></w:document>')
    print(f, times[f], len(lines), flush=True)
json.dump(times, open(out + '/times.json', 'w'))
