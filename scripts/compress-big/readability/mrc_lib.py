#!/usr/bin/env python3
"""MRC prototype (addendum B): text mask (CCITT G4) + background JPEG + foreground colour,
stencil-masked; plus the text-component statistics the adaptive rule reads. Python only — no
browser path here."""
import io
import numpy as np
import cv2
from PIL import Image, ImageFilter
import pikepdf
from pikepdf import Name, Dictionary, Array

SRC_DPI = 300


def ink_mask(img):
    a = np.asarray(img.convert('RGB')).astype(np.float32)
    gray = 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]
    local = np.asarray(Image.fromarray(gray.astype(np.uint8)).filter(ImageFilter.BoxBlur(15))).astype(np.float32)
    return a, gray, local, (gray < local - 18) & (gray < 200)


def despeckle(mask, min_area):
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    keep = np.zeros(n, bool); keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= min_area
    return keep[lab]


def text_stats(mask):
    """Text-like components at 300 dpi: noise (< 4 px area) and blobs (> 8 % of page height) excluded."""
    H = mask.shape[0]
    n, lab, st, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    h = st[1:, cv2.CC_STAT_HEIGHT]; area = st[1:, cv2.CC_STAT_AREA]
    h = h[(area >= 4) & (h <= 0.08 * H)]
    if len(h) == 0: return {'n': 0, 'h_med': 0, 'h_p10': 0, 'h_p90': 0, 'small_share': 0, 'density': float(mask.mean())}
    return {'n': int(len(h)), 'h_med': float(np.median(h)), 'h_p10': float(np.percentile(h, 10)),
            'h_p90': float(np.percentile(h, 90)), 'small_share': float((h < 12).mean()), 'density': float(mask.mean())}


def g4_stream(pdf, mask_bool):
    im = Image.fromarray(np.where(mask_bool, 0, 255).astype(np.uint8)).convert('1')
    b = io.BytesIO(); im.save(b, 'TIFF', compression='group4', strip_size=1 << 30)
    t = Image.open(io.BytesIO(b.getvalue())); off, cnt = t.tag_v2[273], t.tag_v2[279]
    assert len(off) == 1
    m = pikepdf.Stream(pdf, b.getvalue()[off[0]:off[0] + cnt[0]]); m.Type = Name.XObject; m.Subtype = Name.Image
    m.Width, m.Height = im.size; m.ImageMask = True; m.BitsPerComponent = 1; m.Filter = Name.CCITTFaxDecode
    m.DecodeParms = Dictionary(K=-1, Columns=im.size[0], Rows=im.size[1], BlackIs1=False); m.Decode = Array([1, 0])
    return pdf.make_indirect(m)


def jpeg_stream(pdf, img, q):
    b = io.BytesIO(); img.save(b, 'JPEG', quality=q)
    s = pikepdf.Stream(pdf, b.getvalue()); s.Type = Name.XObject; s.Subtype = Name.Image
    s.Width, s.Height = img.size; s.ColorSpace = Name.DeviceRGB; s.BitsPerComponent = 8; s.Filter = Name.DCTDecode
    return pdf.make_indirect(s)


def mrc_pdf(path, img, page_w, page_h, mask_dpi=300, bg_dpi=100, fg_dpi=75, min_area=4, bg_q=50):
    a, gray, local, ink = ink_mask(img)
    ink = despeckle(ink, min_area) if min_area else ink
    W, H = img.size
    bg = a.copy(); bg[ink] = np.stack([local[ink]] * 3, -1)
    bg_img = Image.fromarray(bg.clip(0, 255).astype(np.uint8)).resize((round(W * bg_dpi / SRC_DPI), round(H * bg_dpi / SRC_DPI)), Image.BILINEAR)
    f = SRC_DPI // fg_dpi if SRC_DPI % fg_dpi == 0 else 4
    hh, ww = H // f * f, W // f * f
    blocks = a[:hh, :ww].reshape(hh // f, f, ww // f, f, 3).transpose(0, 2, 1, 3, 4).reshape(hh // f, ww // f, f * f, 3)
    idx = (blocks @ np.array([0.299, 0.587, 0.114], np.float32)).argmin(-1)
    fg_img = Image.fromarray(np.take_along_axis(blocks, idx[..., None, None].repeat(3, -1), 2)[:, :, 0].clip(0, 255).astype(np.uint8))
    if mask_dpi != SRC_DPI:   # area-average the mask down, keep a pixel if half or more of it is ink
        m = Image.fromarray((ink * 255).astype(np.uint8)).resize((round(W * mask_dpi / SRC_DPI), round(H * mask_dpi / SRC_DPI)), Image.BOX)
        ink = np.asarray(m) >= 128
    pdf = pikepdf.new()
    bgs = jpeg_stream(pdf, bg_img, bg_q)
    fgs = jpeg_stream(pdf, fg_img, 75); fgs.Mask = g4_stream(pdf, ink)
    page = pikepdf.Page(Dictionary(Type=Name.Page, MediaBox=[0, 0, page_w, page_h], Resources=Dictionary(XObject=Dictionary({'/Bg': bgs, '/Fg': fgs}))))
    pdf.pages.append(page)
    pdf.pages[0].obj.Contents = pdf.make_stream(f'q {page_w} 0 0 {page_h} 0 0 cm /Bg Do Q q {page_w} 0 0 {page_h} 0 0 cm /Fg Do Q\n'.encode())
    pdf.save(path)
