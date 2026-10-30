# Builds the Chinese scan fixtures for tests/e2e/ocr-paddle.e2e.mjs (Pillow + PyMuPDF):
#   python3 tests/fixtures/ppocr/make.py
# An image-only PDF (no text layer): an A4 page at 200 dpi with known text in
# Noto Sans SC — the test checks how much of it PDF→Word gets back. Also the
# same page upside down (the image itself turned, no /Rotate).
import os
import fitz
from PIL import Image, ImageDraw, ImageFont

D = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(D, '..', '..', '..', 'js', 'vendor', 'noto', 'notosanssc-v40.ttf')
LINES = [
    '关于加强城市公共交通服务的通知',
    '各区人民政府，市政府各部门：',
    '为进一步提高城市公共交通服务水平，方便市民出行，',
    '现就有关事项通知如下。一、优化公交线路布局，',
    '缩短乘客候车时间。二、推广电子支付方式，',
    '实现扫码乘车全覆盖。三、加强驾驶员安全培训，',
    '确保运营安全。请各单位认真贯彻落实。',
    '二〇二六年十月三十日',
]
open(os.path.join(D, 'truth.txt'), 'w', encoding='utf-8').write('\n'.join(LINES) + '\n')


def page():
    im = Image.new('L', (1654, 2339), 255)                 # A4 at 200 dpi
    d = ImageDraw.Draw(im)
    big, body = ImageFont.truetype(FONT, 56), ImageFont.truetype(FONT, 40)
    y = 220
    for i, line in enumerate(LINES):
        d.text((160, y), line, font=big if i == 0 else body, fill=0)
        y += 110 if i == 0 else 78
    return im


def pdf(name, im):
    doc = fitz.open()
    p = doc.new_page(width=595.28, height=841.89)
    path = os.path.join(D, name + '.png')
    im.save(path)
    p.insert_image(p.rect, filename=path)
    doc.save(os.path.join(D, name + '.pdf'), deflate=True)
    os.remove(path)


pdf('zh-scan', page())
pdf('zh-scan-upside-down', page().rotate(180))
print({f: os.path.getsize(os.path.join(D, f)) for f in sorted(os.listdir(D))})
