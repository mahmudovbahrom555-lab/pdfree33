import fitz, os, sys
for v, dpi, fmt in (('clean', 300, 'png'), ('rough', 150, 'jpg')):
    os.makedirs(v, exist_ok=True)
    for f in sorted(os.listdir('src')):
        d = fitz.open('src/' + f); out = fitz.open()
        for p in d:
            pix = p.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY)
            img = pix.tobytes('png') if fmt == 'png' else pix.tobytes('jpg', jpg_quality=55)
            np = out.new_page(width=p.rect.width, height=p.rect.height); np.insert_image(np.rect, stream=img)
        out.save(f'{v}/{f}')
