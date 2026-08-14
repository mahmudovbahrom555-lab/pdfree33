# HEIC test fixture — provenance

`sample.heic` is a synthetic 400×300 gradient image, generated entirely locally for this repo —
not sourced from any third party, so no license/attribution question applies.

Generation steps (macOS, reproducible):
```
python3 -c "
from PIL import Image
img = Image.new('RGB', (400, 300))
for x in range(400):
    for y in range(300):
        img.putpixel((x, y), (x % 256, y % 256, (x + y) % 256))
img.save('test_source.png')
"
sips -s format heic test_source.png --out sample.heic
```
`sips` is Apple's own built-in image tool (macOS), used here purely as a HEIC encoder to produce a
genuine, real-codec HEIC file (`file sample.heic` reports "ISO Media, HEIF Image HEVC Main or Main
Still Picture Profile") — not a relabeled JPEG/PNG. Used by `tests/heicDecode.integration.test.js`
to verify `js/heicDecode.js` actually decodes real HEIC bytes via the vendored libheif WASM build,
not just that it recognizes the file extension.
